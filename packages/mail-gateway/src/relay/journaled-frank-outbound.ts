import * as crypto from 'node:crypto';
import type { EmailItem } from '@frank/cashweb/types/messages';
import type { DirectMessageReceived } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../ledger/credit-ledger';
import { MailJournal } from '../ledger/mail-journal';
import { canonicalEmailAddress } from '../mta/outbound-delivery';
import { emailItemKey, mailKey } from '../rfc/mail-keys';
import { assertHeaderValue, parseMessageId } from '../rfc/message-headers';
import type { FrankInboundRejectReason } from '../types';

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_SUBJECT_BYTES = 600;

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

/** A private, account-root-derived salt makes aliases stable across gateway replicas. */
export function replyAlias(salt: Uint8Array, scopeAccount: string, conversationId: string): string {
  if (salt.byteLength !== 32) throw new Error('Reply-alias salt must be 32 bytes');
  return 'm' + crypto.createHmac('sha256', salt)
    .update('frank/mail-reply-alias/v1\0')
    .update(scopeAccount.toLowerCase()).update('\0').update(conversationId)
    .digest('hex').slice(0, 30);
}

function renderMail(item: EmailItem, rfcMessageId: string, sender: string, recipient: string, receivedTime: number): Uint8Array {
  const subject = item.subject.trim();
  assertHeaderValue(subject);
  if (Buffer.byteLength(subject, 'utf8') > MAX_SUBJECT_BYTES) throw new Error('Email subject is too long');
  const mailSubject = encodedSubject(subject);
  const body = Buffer.from(item.textBody.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64');
  const foldedBody = body.match(/.{1,76}/g)?.join('\r\n') ?? '';
  const headers = [
    `From: ${sender}`,
    `Reply-To: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${mailSubject}`,
    `Date: ${new Date(receivedTime).toUTCString()}`,
    `Message-ID: ${rfcMessageId}`,
    ...(item.inReplyTo ? [`In-Reply-To: ${item.inReplyTo}`] : []),
    ...(item.references?.length ? [`References: ${item.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${foldedBody}\r\n`, 'utf8');
}

export interface JournaledFrankOutboundOptions {
  readonly journal: MailJournal;
  readonly ledger: CreditLedger;
  readonly gatewayDomain: string;
  readonly mailboxSalt: Uint8Array;
  readonly maxNewThreadsPerDay?: number;
  readonly now?: () => number;
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
    const sender = `${alias}@${this.domain}`;
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
      bytes = renderMail(item, first.rfcMessageId, sender, recipient, message.receivedTime);
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
