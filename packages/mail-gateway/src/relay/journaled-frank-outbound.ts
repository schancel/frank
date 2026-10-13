import * as crypto from 'node:crypto';
import type { EmailItem } from '@frank/cashweb/types/messages';
import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../ledger/credit-ledger';
import { MailJournal } from '../ledger/mail-journal';
import { isOperationalLocalPart } from '../mailbox/operational-local-parts';
import { canonicalEmailAddress } from '../mta/outbound-delivery';
import { emailItemKey, mailKey } from '../rfc/mail-keys';
import { assertHeaderValue, parseMessageId } from '../rfc/message-headers';
import type { FrankInboundRejectReason } from '../types';
import { wkdHashLocalPart } from '../wkd/wkd';

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_SUBJECT_BYTES = 600;
const MAX_DISPLAY_NAME_BYTES = 256;
const USERNAME_LOCAL_PART = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const REPLY_ALIAS_LOCAL_PART = /^m[0-9a-f]{30}$/;

function encodedSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let part = '';
  for (const character of subject) {
    if (Buffer.byteLength(part + character, 'utf8') > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
      part = '';
    }
    part += character;
  }
  if (part) words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

function formatFromHeader(fromAddress: string, displayName?: string): string {
  const trimmedName = displayName?.trim();
  if (!trimmedName) return fromAddress;
  assertHeaderValue(trimmedName);
  if (Buffer.byteLength(trimmedName, 'utf8') > MAX_DISPLAY_NAME_BYTES) {
    throw new Error('Sender display name is too long');
  }
  if (/^[\x20-\x7e]+$/.test(trimmedName)) {
    const escaped = trimmedName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}" <${fromAddress}>`;
  }
  return `${encodedSubject(trimmedName)} <${fromAddress}>`;
}

function isSafe7BitBody(normalizedBody: string): boolean {
  if (!/^[\x09\x20-\x7e\r\n]*$/.test(normalizedBody)) return false;
  const lines = normalizedBody.split('\r\n');
  return lines.every((line) => line.length <= 76 && !line.startsWith('.') && !/^from /i.test(line));
}

function isValidSenderUsername(localPart: string): boolean {
  const canonical = localPart.trim().toLowerCase();
  return (
    USERNAME_LOCAL_PART.test(canonical) &&
    !isOperationalLocalPart(canonical) &&
    !REPLY_ALIAS_LOCAL_PART.test(canonical)
  );
}

/** Deterministic local-part fallback encoding the sender's canonical 0x account address. */
export function userIdFallbackLocalPart(scopeAccount: string): string {
  return `u.${scopeAccount.trim().toLowerCase()}`;
}

/** A private, account-root-derived salt makes aliases stable across gateway replicas. */
export function replyAlias(salt: Uint8Array, scopeAccount: string, conversationId: string): string {
  if (salt.byteLength !== 32) throw new Error('Reply-alias salt must be 32 bytes');
  return 'm' + crypto.createHmac('sha256', salt)
    .update('frank/mail-reply-alias/v1\0')
    .update(scopeAccount.toLowerCase()).update('\0').update(conversationId)
    .digest('hex').slice(0, 30);
}

function renderMail(
  item: EmailItem,
  rfcMessageId: string,
  fromHeader: string,
  replyToAddress: string,
  recipient: string,
  receivedTime: number,
  openPgpUrl?: string,
  overrideTextBody?: string,
): Uint8Array {
  const subject = item.subject.trim();
  assertHeaderValue(subject);
  if (Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES) throw new Error('Email subject is too long');
  const mailSubject = encodedSubject(subject);
  const bodySource = overrideTextBody ?? item.textBody;
  const normalizedBody = bodySource.replace(/\r?\n/g, '\r\n');
  const use7Bit = isSafe7BitBody(normalizedBody);
  const transferEncoding = use7Bit ? '7bit' : 'base64';
  const renderedBody = use7Bit
    ? normalizedBody
    : (Buffer.from(normalizedBody, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '');
  const headers = [
    `From: ${fromHeader}`,
    `Reply-To: ${replyToAddress}`,
    `To: ${recipient}`,
    `Subject: ${mailSubject}`,
    `Date: ${new Date(receivedTime).toUTCString()}`,
    `Message-ID: ${rfcMessageId}`,
    ...(item.inReplyTo ? [`In-Reply-To: ${item.inReplyTo}`] : []),
    ...(item.references?.length ? [`References: ${item.references.join(' ')}`] : []),
    ...(openPgpUrl ? [`OpenPGP: url=${openPgpUrl}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${transferEncoding}`,
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${renderedBody}\r\n`, 'utf8');
}

export interface JournaledFrankOutboundOptions {
  readonly journal: MailJournal;
  readonly ledger: CreditLedger;
  readonly gatewayDomain: string;
  readonly mailboxSalt: Uint8Array;
  readonly maxNewThreadsPerDay?: number;
  readonly now?: () => number;
  readonly resolveSenderUsername?: (scopeAccount: string) => Promise<string | undefined>;
  readonly useUserIdFallback?: boolean;
  readonly discoverRecipientWkdKey?: (
    address: string,
  ) => Promise<{ keyBytes: Uint8Array; url: string } | undefined>;
  readonly encryptBodyWithOpenPgp?: (
    plaintext: string,
    recipientKeys: Uint8Array[],
  ) => Promise<string>;
}

/**
 * Handles one validated Frank email item without network effects. Message disposition,
 * issued reply alias and exact outbound bytes commit together before mailbox cursor advance.
 */
export class JournaledFrankOutbound {
  private readonly journal: MailJournal;
  private readonly ledger: CreditLedger;
  private readonly domain: string;
  private readonly salt: Uint8Array;
  private readonly maxNewThreadsPerDay: number;
  private readonly now: () => number;
  private readonly resolveSenderUsername?: (scopeAccount: string) => Promise<string | undefined>;
  private readonly useUserIdFallback: boolean;
  private readonly discoverRecipientWkdKey?: (
    address: string,
  ) => Promise<{ keyBytes: Uint8Array; url: string } | undefined>;
  private readonly encryptBodyWithOpenPgp?: (
    plaintext: string,
    recipientKeys: Uint8Array[],
  ) => Promise<string>;

  constructor(options: JournaledFrankOutboundOptions) {
    this.journal = options.journal;
    this.ledger = options.ledger;
    this.journal.assertCreditLedger(this.ledger);
    this.domain = options.gatewayDomain.toLowerCase();
    if (this.domain !== this.journal.gatewayDomain) throw new Error('Mail journal domain differs');
    if (options.mailboxSalt.byteLength !== 32) throw new Error('Reply-alias salt must be 32 bytes');
    this.salt = Uint8Array.from(options.mailboxSalt);
    this.maxNewThreadsPerDay = options.maxNewThreadsPerDay ?? 5;
    if (!Number.isSafeInteger(this.maxNewThreadsPerDay) || this.maxNewThreadsPerDay < 0)
      throw new Error('Invalid new-thread quota');
    this.now = options.now ?? Date.now;
    this.resolveSenderUsername = options.resolveSenderUsername;
    this.useUserIdFallback = options.useUserIdFallback ?? Boolean(options.resolveSenderUsername);
    this.discoverRecipientWkdKey = options.discoverRecipientWkdKey;
    this.encryptBodyWithOpenPgp = options.encryptBodyWithOpenPgp;
  }

  private async resolveFromLocalPart(item: EmailItem, scope: string, alias: string): Promise<string> {
    if (this.resolveSenderUsername) {
      try {
        const resolved = await this.resolveSenderUsername(scope);
        if (resolved && isValidSenderUsername(resolved)) {
          return resolved.trim().toLowerCase();
        }
      } catch {
        // Fall through to item.from or deterministic user ID fallback.
      }
    }

    const rawFromAddress = typeof item.from?.address === 'string' ? item.from.address.trim().toLowerCase() : '';
    if (rawFromAddress) {
      const atIndex = rawFromAddress.indexOf('@');
      if (atIndex !== -1) {
        const localPart = rawFromAddress.slice(0, atIndex);
        const domainPart = rawFromAddress.slice(atIndex + 1);
        if (domainPart === this.domain) {
          if (isValidSenderUsername(localPart)) return localPart;
          if (localPart === scope || localPart === userIdFallbackLocalPart(scope)) {
            return userIdFallbackLocalPart(scope);
          }
        }
      } else if (isValidSenderUsername(rawFromAddress)) {
        return rawFromAddress;
      }
    }

    return this.useUserIdFallback ? userIdFallbackLocalPart(scope) : alias;
  }

  async handle(message: DirectMessageReceived): Promise<void> {
    const digest = message.payloadDigest;
    if (!HEX_64.test(digest)) throw new Error('Frank payload digest is invalid');
    const scope = message.senderAddress.raw.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(scope)) throw new Error('Frank sender address is invalid');
    if (message.recipientAddress.raw.toLowerCase() !== this.journal.gatewayAccount)
      throw new Error('Frank message belongs to a different gateway');
    const stampValue = message.stampValueWei.toString();
    const base = { payloadDigest: digest, receivedTimeMs: message.receivedTime, stampValue };
    const reject = (reason: FrankInboundRejectReason) => {
      this.journal.recordFrankMessage({ ...base, outcome: 'rejected', reason, scopeAccount: scope });
    };
    const emails = message.items.filter((item): item is EmailItem => item.type === 'email');
    if (emails.length !== 1) return reject(emails.length ? 'multiple_email_items' : 'no_email_item');
    const item = emails[0];
    const conversationId = message.conversationId;
    if (!message.messageId || !conversationId) return reject('no_sealed_identity');
    if (typeof item.messageId !== 'string' || parseMessageId(item.messageId) !== item.messageId ||
      this.journal.isReservedMessageId(item.messageId))
      return reject('bad_message_id');
    if (item.inReplyTo !== undefined &&
      (typeof item.inReplyTo !== 'string' || parseMessageId(item.inReplyTo) !== item.inReplyTo))
      return reject('bad_in_reply_to');
    if (item.references !== undefined &&
      (!Array.isArray(item.references) || item.references.some(id => typeof id !== 'string' || parseMessageId(id) !== id)))
      return reject('bad_reference');
    if (typeof item.subject !== 'string' || typeof item.textBody !== 'string') return reject('header_unsafe');
    if (!Array.isArray(item.to) || item.to.length !== 1 ||
      (item.cc !== undefined && (!Array.isArray(item.cc) || item.cc.length > 0)) ||
      (item.bcc !== undefined && (!Array.isArray(item.bcc) || item.bcc.length > 0)) ||
      (item.attachments !== undefined && (!Array.isArray(item.attachments) || item.attachments.length > 0)) ||
      item.htmlBody || item.replyTo)
      return reject('bad_recipient');
    const recipient = canonicalEmailAddress(item.to[0]?.address);
    if (!recipient) return reject('bad_recipient');
    const alias = replyAlias(this.salt, scope, conversationId);
    const replyToAddress = `${alias}@${this.domain}`;
    const fromLocalPart = await this.resolveFromLocalPart(item, scope, alias);
    const fromAddress = `${fromLocalPart}@${this.domain}`;
    const openPgpUrl = `https://${this.domain}/.well-known/openpgpkey/hu/${wkdHashLocalPart(fromLocalPart)}?l=${encodeURIComponent(fromLocalPart)}`;
    let effectiveBody: string | undefined;
    if (this.discoverRecipientWkdKey) {
      try {
        const wkdKey = await this.discoverRecipientWkdKey(recipient);
        if (wkdKey && this.encryptBodyWithOpenPgp) {
          effectiveBody = await this.encryptBodyWithOpenPgp(item.textBody, [wkdKey.keyBytes]);
        }
      } catch {
        // WKD discovery or optional encryption failure falls back to standard delivery.
      }
    }
    const input = {
      ...base,
      outcome: 'bridged' as const,
      scopeAccount: scope,
      frankMessageId: message.messageId,
      conversationId,
      authoredMessageId: item.messageId,
      itemKey: emailItemKey(item),
      ...(item.inReplyTo ? { inReplyTo: item.inReplyTo } : {}),
    };
    const first = this.journal.recordFrankMessage(input);
    if (first.kind === 'duplicate' || first.kind === 'same_message') return;
    if (first.kind !== 'needs_render') throw new Error('Unexpected Frank mail disposition');
    let bytes: Uint8Array;
    try {
      const fromHeader = formatFromHeader(fromAddress, item.from?.name);
      bytes = renderMail(
        item,
        first.rfcMessageId,
        fromHeader,
        replyToAddress,
        recipient,
        message.receivedTime,
        openPgpUrl,
        effectiveBody,
      );
    } catch {
      return reject('header_unsafe');
    }
    this.ledger.atomic(() => {
      if (!this.journal.findMailThread(scope, conversationId) &&
        this.journal.countFrankRootsSince(scope, Math.max(0, this.now() - 86_400_000)) >= this.maxNewThreadsPerDay) {
        reject('quota');
        return;
      }
      this.journal.issueMailbox({ localPart: alias, scopeAccount: scope, conversationId });
      if (isValidSenderUsername(fromLocalPart) && !this.journal.issuedMailbox(fromLocalPart)) {
        this.journal.issueMailbox({ localPart: fromLocalPart, scopeAccount: scope });
      }
      const recorded = this.journal.recordFrankMessage({
        ...input,
        emitted: { rfcMessageId: first.rfcMessageId, mailKey: mailKey(bytes) },
      });
      if (recorded.kind === 'duplicate' || recorded.kind === 'same_message') return;
      if (recorded.kind !== 'bridged') throw new Error('Frank mail did not bridge');
      const job = this.journal.addOutboundJob({
        scopeAccount: scope,
        rfcMessageId: recorded.message.rfcMessageId,
        recipientEmail: recipient,
        senderLocalPart: alias,
        signedRfc822: { kind: 'inline', bytes },
        nextAttemptAtMs: this.now(),
      });
      if (job.kind === 'key_taken') throw new Error('Outbound mail job already holds different bytes');
    });
  }
}
