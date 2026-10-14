import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  assertHeaderValue,
  parseMessageId,
  parseMessageIdList,
  readHeaderSection,
  renderThreadHeaders,
  singleLineHeaderText,
} from '../rfc/message-headers';
import { buildOnboardingDeepLink } from '../secure-link/secure-message-portal';
import { extractEmailAddress, parseRawRfc822 } from '../smtp/smtp-listener';
import type { BlobStore } from '../storage/blob-store';
import type { InboundEmailRecord, StoredMailBytes } from '../types';
import type { OutboundMailPort } from './journaled-outbound-worker';

export const DEFAULT_AUTO_REPLY_RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

const AUTOMATED_LOCAL_PARTS = new Set([
  'postmaster',
  'mailer-daemon',
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'dontreply',
  'daemon',
  'autoresponder',
  'autoreply',
  'auto-reply',
  'auto_reply',
  'bounce',
  'bounces',
]);

export type AutoReplySuppressionReason =
  | 'invalid_sender'
  | 'own_domain'
  | 'automated_sender'
  | 'empty_return_path'
  | 'automated_return_path'
  | 'auto_submitted'
  | 'precedence_bulk'
  | 'x_auto_response_suppress'
  | 'mailing_list'
  | 'x_loop'
  | 'already_processed'
  | 'rate_limited';

export interface HeldMailSource {
  listHeldInboundEmails(
    limit?: number,
    after?: { scopeAccount: string; mailKey: string },
  ): InboundEmailRecord[];
  findInboundEmail?(scopeAccount: string, mailKey: string): InboundEmailRecord | undefined;
}

export interface HeldEmailAutoReplyRecord {
  readonly scopeAccount: string;
  readonly mailKey: string;
  readonly senderEmail: string;
  readonly rfcMessageId: string;
  readonly replyMessageId: string;
  readonly status: 'sent' | 'suppressed' | 'submitting' | 'uncertain';
  readonly reason?: string;
  readonly sentAtMs: number;
}

function isAutomatedOrOwnAddress(address: string, gatewayDomain: string): AutoReplySuppressionReason | undefined {
  const normalized = address.trim().toLowerCase();
  const atIdx = normalized.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === normalized.length - 1) {
    return 'invalid_sender';
  }
  const localPart = normalized.slice(0, atIdx);
  const domainPart = normalized.slice(atIdx + 1);
  const targetDomain = gatewayDomain.trim().toLowerCase();

  if (domainPart === targetDomain || domainPart.endsWith(`.${targetDomain}`)) {
    return 'own_domain';
  }

  const baseLocal = localPart.split('+')[0] ?? localPart;
  if (
    AUTOMATED_LOCAL_PARTS.has(localPart) ||
    AUTOMATED_LOCAL_PARTS.has(baseLocal) ||
    localPart.startsWith('bounce+') ||
    localPart.startsWith('bounces+') ||
    localPart.startsWith('noreply+') ||
    localPart.startsWith('no-reply+') ||
    localPart.includes('mailer-daemon') ||
    localPart.includes('donotreply') ||
    localPart.includes('do-not-reply') ||
    localPart.includes('noreply')
  ) {
    return 'automated_sender';
  }

  return undefined;
}

/**
 * Evaluates RFC 3834 loop & backscatter suppression rules for an inbound email.
 */
export function shouldSuppressHeldAutoReply(params: {
  readonly senderEmail: string;
  readonly gatewayDomain: string;
  readonly rawRfc822: Uint8Array;
}): { readonly suppress: boolean; readonly reason?: AutoReplySuppressionReason } {
  const senderReason = isAutomatedOrOwnAddress(params.senderEmail, params.gatewayDomain);
  if (senderReason) {
    return { suppress: true, reason: senderReason };
  }

  const { fields } = readHeaderSection(params.rawRfc822);
  const targetDomain = params.gatewayDomain.trim().toLowerCase();

  for (const [name, rawValue] of fields) {
    const trimmed = rawValue.trim();
    const lower = trimmed.toLowerCase();

    if (name === 'return-path') {
      if (trimmed === '<>' || /^<\s*>$/.test(trimmed) || trimmed === '') {
        return { suppress: true, reason: 'empty_return_path' };
      }
      const returnAddr = extractEmailAddress(trimmed);
      if (!returnAddr) {
        return { suppress: true, reason: 'empty_return_path' };
      }
      const returnReason = isAutomatedOrOwnAddress(returnAddr, targetDomain);
      if (returnReason) {
        return { suppress: true, reason: 'automated_return_path' };
      }
    }

    if (name === 'auto-submitted') {
      const token = lower.split(';')[0]?.trim() ?? '';
      if (token.length > 0 && token !== 'no') {
        return { suppress: true, reason: 'auto_submitted' };
      }
    }

    if (name === 'precedence') {
      if (
        lower === 'bulk' ||
        lower === 'list' ||
        lower === 'junk' ||
        lower === 'auto_reply' ||
        lower === 'auto-reply'
      ) {
        return { suppress: true, reason: 'precedence_bulk' };
      }
    }

    if (name === 'x-auto-response-suppress') {
      if (lower.length > 0 && lower !== 'none') {
        return { suppress: true, reason: 'x_auto_response_suppress' };
      }
    }

    if (name === 'list-id' || name === 'list-unsubscribe') {
      if (lower.length > 0) {
        return { suppress: true, reason: 'mailing_list' };
      }
    }

    if (name === 'x-loop') {
      if (lower.includes(targetDomain)) {
        return { suppress: true, reason: 'x_loop' };
      }
    }
  }

  return { suppress: false };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodeHeaderSubject(subject: string): string {
  const clean = singleLineHeaderText(subject);
  assertHeaderValue(clean);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let part = '';
  for (const ch of clean) {
    if (Buffer.byteLength(part + ch, 'utf8') > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
      part = '';
    }
    part += ch;
  }
  if (part) {
    words.push(`=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
  }
  return words.join('\r\n ');
}

export interface RenderHeldChallengeEmailInput {
  readonly gatewayDomain: string;
  readonly senderEmail: string;
  readonly recipientDisplay: string;
  readonly recipientEmail: string;
  readonly scopeAccount: string;
  readonly originalSubject: string;
  readonly originalMessageId?: string;
  readonly originalReferences?: readonly string[];
  readonly replyMessageId: string;
  readonly onboardingUrl: string;
  readonly payUrl: string;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}

export function renderHeldChallengeEmail(input: RenderHeldChallengeEmailInput): {
  readonly fromAddress: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly rawRfc822: Uint8Array;
} {
  const domain = input.gatewayDomain.trim().toLowerCase();
  const fromAddress = `postmaster@${domain}`;
  const cleanOrigSubject = singleLineHeaderText(input.originalSubject || '').trim();
  const hasRealSubject =
    cleanOrigSubject.length > 0 && cleanOrigSubject.toLowerCase() !== '(no subject)';
  const strippedRe = cleanOrigSubject.replace(/^(?:re:\s*)+/i, '').trim();
  const subject = hasRealSubject
    ? `Re: ${strippedRe} [Delivery paused — stamp or verification required]`
    : `Delivery to ${input.recipientDisplay} paused — stamp or verification required`;

  const displaySubject = hasRealSubject ? cleanOrigSubject : '(No Subject)';
  const expiresUtc = new Date(input.expiresAtMs).toUTCString();

  const textBody = [
    `Your email to ${input.recipientDisplay} (${input.recipientEmail}) is safely held and awaiting verification.`,
    '',
    `Subject: ${displaySubject}`,
    `Recipient: ${input.recipientEmail} (${input.scopeAccount})`,
    `Held Until: ${expiresUtc}`,
    '',
    `Why was my email paused?`,
    `${input.recipientDisplay} uses Frank (${domain}) cryptographic postage (attention stamps) to reduce unwanted email.`,
    '',
    `Use the delivery portal to add postage, or open Frank to continue the conversation:`,
    '',
    `Option 1: Open Frank Account Setup`,
    `${input.onboardingUrl}`,
    `Set up a self-custodial Frank account in your browser to continue the conversation with ${input.recipientDisplay}. Creating an account does not release this held email; add postage through the delivery portal.`,
    '',
    `Option 2: Stamp & Deliver This Email via the Web Portal`,
    `${input.payUrl}`,
    `Open the delivery portal to view the held email status and available postage options.`,
    '',
    `Already know ${input.recipientDisplay}?`,
    `If ${input.recipientDisplay} approves your address from their Screener queue or replies to you, your held email and all future replies in this thread are delivered automatically for free.`,
  ].join('\r\n');

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.06);">
    <div style="background:linear-gradient(135deg,#1e1b4b 0%,#0f172a 100%);padding:24px 28px;color:#f8fafc;">
      <div style="display:inline-block;padding:4px 10px;border-radius:9999px;background:rgba(251,191,36,0.18);border:1px solid rgba(251,191,36,0.45);color:#fde68a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:10px;">
        Delivery Paused &bull; Action Required
      </div>
      <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">
        Postage Required to Deliver Your Email
      </h1>
      <p style="margin:6px 0 0 0;font-size:14px;color:#cbd5e1;">
        Your message to <strong style="color:#ffffff;">${escapeHtml(input.recipientEmail)}</strong> is safely held in the Frank Gateway queue.
      </p>
    </div>

    <div style="padding:24px 28px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#334155;">
        <div style="margin-bottom:4px;"><strong style="color:#0f172a;">To:</strong> ${escapeHtml(input.recipientEmail)}</div>
        <div style="margin-bottom:4px;"><strong style="color:#0f172a;">Subject:</strong> ${escapeHtml(displaySubject)}</div>
        <div><strong style="color:#0f172a;">Held Until:</strong> ${escapeHtml(expiresUtc)}</div>
      </div>

      <p style="margin:0 0 18px 0;font-size:14px;color:#334155;">
        <strong>${escapeHtml(input.recipientDisplay)}</strong> uses <strong>Frank / Signet</strong> cryptographic postage (stamps) to reduce unwanted email. Add postage through the delivery portal, or open Frank to continue the conversation:
      </p>

      <div style="background:linear-gradient(145deg,#1e1b4b 0%,#0f172a 100%);border:1px solid rgba(168,85,247,0.4);border-radius:14px;padding:20px;margin-bottom:16px;color:#f8fafc;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#d8b4fe;margin-bottom:6px;">
          Option 1 &bull; Frank Account Setup
        </div>
        <div style="font-size:16px;font-weight:700;color:#ffffff;margin-bottom:6px;">
          Set Up Your Self-Custodial Frank Account
        </div>
        <p style="margin:0 0 14px 0;font-size:13px;color:#cbd5e1;">
          Set up a self-custodial Frank wallet in your browser to continue the conversation with <strong>${escapeHtml(input.recipientDisplay)}</strong>.
        </p>
        <a href="${escapeHtml(input.onboardingUrl)}" style="display:inline-block;background:linear-gradient(135deg,#9333ea 0%,#4f46e5 100%);color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px;">
          Open Frank Account Setup &rarr;
        </a>
      </div>

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:20px;margin-bottom:18px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#1d4ed8;margin-bottom:6px;">
          Option 2 &bull; No Account Needed
        </div>
        <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">
          Stamp &amp; Deliver This Email via the Web Portal
        </div>
        <p style="margin:0 0 14px 0;font-size:13px;color:#1e3a8a;">
          Release and deliver this individual email directly from your browser without creating a Frank account.
        </p>
        <a href="${escapeHtml(input.payUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px;">
          Open Delivery &amp; Stamp Portal &rarr;
        </a>
      </div>

      <p style="margin:0;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:14px;">
        <strong>Already know ${escapeHtml(input.recipientDisplay)}?</strong> If they approve your address from their Screener queue or reply to you, your held email and future replies in this thread will be delivered automatically.
      </p>
    </div>
  </div>
</body>
</html>`;

  const boundary = `frank-autoreply-${crypto.randomBytes(12).toString('hex')}`;
  const textBase64 = Buffer.from(textBody, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const htmlBase64 = Buffer.from(htmlBody, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';

  const validOrigMsgId =
    input.originalMessageId && parseMessageId(input.originalMessageId) === input.originalMessageId
      ? input.originalMessageId
      : undefined;
  const refs: string[] = [];
  for (const ref of input.originalReferences ?? []) {
    if (parseMessageId(ref) === ref && !refs.includes(ref)) {
      refs.push(ref);
    }
  }
  if (validOrigMsgId && !refs.includes(validOrigMsgId)) {
    refs.push(validOrigMsgId);
  }

  const safeDisplay = singleLineHeaderText(input.recipientDisplay).replace(/["\\]/g, '');
  const headers = [
    `From: "Frank Gateway (${safeDisplay})" <${fromAddress}>`,
    `Reply-To: ${input.recipientEmail}`,
    `To: ${input.senderEmail}`,
    `Subject: ${encodeHeaderSubject(subject)}`,
    `Date: ${new Date(input.nowMs).toUTCString()}`,
    ...renderThreadHeaders({
      messageId: input.replyMessageId,
      inReplyTo: validOrigMsgId,
      references: refs,
    }).trimEnd().split('\r\n'),
    'Auto-Submitted: auto-replied',
    'Precedence: bulk',
    'X-Auto-Response-Suppress: All',
    `X-Loop: ${domain}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const mime = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    textBase64,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBase64,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return {
    fromAddress,
    recipientEmail: input.senderEmail,
    subject,
    textBody,
    htmlBody,
    rawRfc822: Buffer.from(mime, 'utf8'),
  };
}

export interface HeldEmailAutoResponderOptions {
  readonly journal: HeldMailSource;
  readonly port: OutboundMailPort;
  readonly gatewayDomain: string;
  readonly onboardingSecret: Uint8Array | string;
  readonly frankAppUrl?: string;
  readonly publicGatewayUrl?: string;
  readonly blobStore?: BlobStore;
  readonly dbPath?: string;
  readonly database?: DatabaseSync;
  readonly resolveRecipientUsername?: (scopeAccount: string) => Promise<string | undefined>;
  readonly rateLimitWindowMs?: number;
  readonly now?: () => number;
}

/**
 * RFC 3834-compliant auto-responder for unpaid inbound emails held in the gateway queue.
 * Sends at most one threaded payment & self-custodial onboarding challenge email per held mail
 * (and rate-limits per sender + recipient scope), while suppressing loops, bounces, and bulk mail.
 */
export class HeldEmailAutoResponder {
  private readonly journal: HeldMailSource;
  private readonly port: OutboundMailPort;
  private readonly domain: string;
  private readonly onboardingSecret: Buffer | string;
  private readonly frankAppUrl: string;
  private readonly publicGatewayUrl: string;
  private readonly blobStore?: BlobStore;
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly resolveRecipientUsername?: (scopeAccount: string) => Promise<string | undefined>;
  private readonly rateLimitWindowMs: number;
  private readonly now: () => number;
  private heldAfter?: { scopeAccount: string; mailKey: string };

  constructor(options: HeldEmailAutoResponderOptions) {
    this.journal = options.journal;
    this.port = options.port;
    this.domain = options.gatewayDomain.trim().toLowerCase();
    this.onboardingSecret =
      options.onboardingSecret instanceof Uint8Array
        ? Buffer.from(options.onboardingSecret)
        : options.onboardingSecret;
    this.frankAppUrl = (options.frankAppUrl?.trim() || `https://${this.domain}`).replace(/\/+$/, '');
    this.publicGatewayUrl = (options.publicGatewayUrl?.trim() || this.frankAppUrl).replace(/\/+$/, '');
    this.blobStore = options.blobStore;
    this.resolveRecipientUsername = options.resolveRecipientUsername;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_AUTO_REPLY_RATE_LIMIT_MS;
    this.now = options.now ?? Date.now;

    if (options.database) {
      this.db = options.database;
      this.ownsDb = false;
    } else {
      this.db = new DatabaseSync(options.dbPath ?? ':memory:');
      this.ownsDb = true;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS held_email_auto_reply (
        scope_account TEXT NOT NULL,
        mail_key TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        rfc_message_id TEXT NOT NULL,
        reply_message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'suppressed', 'submitting', 'uncertain')),
        reason TEXT,
        raw_rfc822 BLOB,
        sent_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_account, mail_key)
      );
      CREATE INDEX IF NOT EXISTS idx_held_auto_reply_sender_scope
        ON held_email_auto_reply(sender_email, scope_account, sent_at_ms);
    `);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  getRecord(scopeAccount: string, mailKey: string): HeldEmailAutoReplyRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT scope_account, mail_key, sender_email, rfc_message_id, reply_message_id, status, reason, sent_at_ms FROM held_email_auto_reply WHERE scope_account = ? AND mail_key = ?',
      )
      .get(scopeAccount.toLowerCase(), mailKey.toLowerCase()) as
      | {
          scope_account: string;
          mail_key: string;
          sender_email: string;
          rfc_message_id: string;
          reply_message_id: string;
          status: 'sent' | 'suppressed' | 'submitting' | 'uncertain';
          reason: string | null;
          sent_at_ms: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      scopeAccount: row.scope_account,
      mailKey: row.mail_key,
      senderEmail: row.sender_email,
      rfcMessageId: row.rfc_message_id,
      replyMessageId: row.reply_message_id,
      status: row.status,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      sentAtMs: row.sent_at_ms,
    };
  }

  private recordOutcome(record: HeldEmailAutoReplyRecord): void {
    this.db
      .prepare(
        `INSERT INTO held_email_auto_reply
          (scope_account, mail_key, sender_email, rfc_message_id, reply_message_id, status, reason, sent_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope_account, mail_key) DO UPDATE SET status = excluded.status, reason = excluded.reason, sent_at_ms = excluded.sent_at_ms
         WHERE excluded.status = 'sent' AND held_email_auto_reply.status = 'submitting'`,
      )
      .run(
        record.scopeAccount.toLowerCase(),
        record.mailKey.toLowerCase(),
        record.senderEmail.toLowerCase(),
        record.rfcMessageId,
        record.replyMessageId,
        record.status,
        record.reason ?? null,
        record.sentAtMs,
      );
  }

  private isRecentlySentToSender(
    senderEmail: string,
    scopeAccount: string,
    nowMs: number,
  ): boolean {
    if (this.rateLimitWindowMs <= 0) return false;
    const cutoff = nowMs - this.rateLimitWindowMs;
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM held_email_auto_reply
          WHERE sender_email = ? AND scope_account = ? AND status IN ('sent', 'submitting', 'uncertain') AND sent_at_ms > ?
          LIMIT 1`,
      )
      .get(senderEmail.toLowerCase(), scopeAccount.toLowerCase(), cutoff) as
      | { found: number }
      | undefined;
    return row !== undefined;
  }

  private async resolveBytes(stored: StoredMailBytes): Promise<Uint8Array> {
    if (stored.kind === 'inline') return stored.bytes;
    const bytes = await this.blobStore?.get(stored.sha256);
    if (!bytes) {
      throw new Error('Stored held mail blob is missing');
    }
    return bytes;
  }

  private async resolveRecipientLabel(email: InboundEmailRecord): Promise<{
    recipientDisplay: string;
    recipientEmail: string;
  }> {
    const localPart = email.mailboxLocalPart?.trim().toLowerCase();
    if (localPart && !/^m[0-9a-f]{30}$/.test(localPart)) {
      return {
        recipientDisplay: `${localPart}@${this.domain}`,
        recipientEmail: `${localPart}@${this.domain}`,
      };
    }
    if (this.resolveRecipientUsername) {
      try {
        const username = await this.resolveRecipientUsername(email.scopeAccount);
        if (username && /^[a-z0-9][a-z0-9_-]{2,31}$/.test(username.trim().toLowerCase())) {
          const clean = username.trim().toLowerCase();
          return {
            recipientDisplay: `${clean}@${this.domain}`,
            recipientEmail: `${localPart ?? clean}@${this.domain}`,
          };
        }
      } catch {
        // Fall through to address fallback
      }
    }
    const fallbackLocal = localPart ?? email.scopeAccount.toLowerCase();
    return {
      recipientDisplay: `${fallbackLocal}@${this.domain}`,
      recipientEmail: `${fallbackLocal}@${this.domain}`,
    };
  }

  /**
   * Evaluates and sends (or suppresses) the payment & onboarding challenge email for a single held record.
   */
  async processHeldEmail(
    email: InboundEmailRecord,
  ): Promise<{ readonly status: 'sent' | 'suppressed' | 'skipped'; readonly reason?: string }> {
    if (email.disposition !== 'held') {
      return { status: 'skipped', reason: 'not_held' };
    }
    const existing = this.getRecord(email.scopeAccount, email.mailKey);
    if (existing?.status === 'submitting' || existing?.status === 'uncertain') {
      throw new Error('Held auto-reply acceptance is uncertain; reconcile before retry');
    }
    if (existing) {
      return { status: 'skipped', reason: 'already_processed' };
    }
    if (!email.raw) {
      return { status: 'skipped', reason: 'missing_raw' };
    }

    const nowMs = this.now();
    if (email.expiresAtMs !== undefined && email.expiresAtMs <= nowMs) {
      return { status: 'skipped', reason: 'expired' };
    }

    const rawBytes = await this.resolveBytes(email.raw);
    const replyMessageId = `<autoreply.${email.mailKey.slice(0, 32)}@${this.domain}>`;

    const suppression = shouldSuppressHeldAutoReply({
      senderEmail: email.senderEmail,
      gatewayDomain: this.domain,
      rawRfc822: rawBytes,
    });
    if (suppression.suppress) {
      this.recordOutcome({
        scopeAccount: email.scopeAccount,
        mailKey: email.mailKey,
        senderEmail: email.senderEmail,
        rfcMessageId: email.rfcMessageId,
        replyMessageId,
        status: 'suppressed',
        reason: suppression.reason,
        sentAtMs: nowMs,
      });
      return { status: 'suppressed', reason: suppression.reason };
    }

    if (this.isRecentlySentToSender(email.senderEmail, email.scopeAccount, nowMs)) {
      this.recordOutcome({
        scopeAccount: email.scopeAccount,
        mailKey: email.mailKey,
        senderEmail: email.senderEmail,
        rfcMessageId: email.rfcMessageId,
        replyMessageId,
        status: 'suppressed',
        reason: 'rate_limited',
        sentAtMs: nowMs,
      });
      return { status: 'suppressed', reason: 'rate_limited' };
    }

    const parsed = parseRawRfc822(rawBytes, email.senderEmail, email.scopeAccount);
    const { fields } = readHeaderSection(rawBytes);
    const rawRefs = fields
      .filter(([name]) => name === 'references')
      .flatMap(([, val]) => parseMessageIdList(val));
    const { recipientDisplay, recipientEmail } = await this.resolveRecipientLabel(email);
    const expiresAtMs = email.expiresAtMs ?? email.createdAtMs + 72 * 60 * 60 * 1000;
    const heldId = email.heldMessageId ?? email.mailKey;

    const cleanSubject =
      parsed.subject && parsed.subject !== '(No Subject)'
        ? singleLineHeaderText(parsed.subject)
        : 'Held Email';

    // Only the journal may assign a conversation. A root held email has no
    // assignment yet; generic account setup must not invent a routing identity.
    const onboardingUrl = email.conversationId ? buildOnboardingDeepLink({
      frankAppUrl: this.frankAppUrl,
      secret: this.onboardingSecret,
      payload: {
        kind: 'pay',
        id: heldId,
        peerAddress: email.scopeAccount,
        email: email.senderEmail,
        conversationId: email.conversationId,
        subject: cleanSubject,
        exp: expiresAtMs,
      },
    }).url : `${this.frankAppUrl}/#/onboard?email=${encodeURIComponent(email.senderEmail)}`;
    const payUrl = `${this.publicGatewayUrl}/pay/${encodeURIComponent(heldId)}`;

    const rendered = renderHeldChallengeEmail({
      gatewayDomain: this.domain,
      senderEmail: email.senderEmail,
      recipientDisplay,
      recipientEmail,
      scopeAccount: email.scopeAccount,
      originalSubject: parsed.subject,
      originalMessageId: email.rfcMessageId,
      originalReferences: rawRefs,
      replyMessageId,
      onboardingUrl,
      payUrl,
      expiresAtMs,
      nowMs,
    });

    // Claim synchronously after all preparation awaits. The durable attempt blocks
    // competing dispatchers and restart retries when provider acceptance is unknown.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.getRecord(email.scopeAccount, email.mailKey)) {
        return { status: 'skipped', reason: 'already_processed' };
      }
      if (this.isRecentlySentToSender(email.senderEmail, email.scopeAccount, nowMs)) {
        return { status: 'skipped', reason: 'rate_limited' };
      }
      this.db.prepare(`INSERT INTO held_email_auto_reply
        (scope_account, mail_key, sender_email, rfc_message_id, reply_message_id, status, sent_at_ms, raw_rfc822)
        VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?)`)
        .run(email.scopeAccount.toLowerCase(), email.mailKey.toLowerCase(),
          email.senderEmail.toLowerCase(), email.rfcMessageId, replyMessageId, nowMs, rendered.rawRfc822);
    } finally {
      this.db.exec('COMMIT');
    }
    try {
      await this.port.submit({
        // RFC 3834: automatic responses use a null SMTP reverse path.
        fromAddress: '',
        recipientEmail: rendered.recipientEmail,
        signedRfc822: rendered.rawRfc822,
      });
    } catch (error) {
      this.db.prepare(`UPDATE held_email_auto_reply SET status = 'uncertain', reason = ?
        WHERE scope_account = ? AND mail_key = ?`)
        .run(error instanceof Error ? error.message : String(error), email.scopeAccount.toLowerCase(), email.mailKey.toLowerCase());
      throw error;
    }

    this.recordOutcome({
      scopeAccount: email.scopeAccount,
      mailKey: email.mailKey,
      senderEmail: email.senderEmail,
      rfcMessageId: email.rfcMessageId,
      replyMessageId,
      status: 'sent',
      sentAtMs: nowMs,
    });

    return { status: 'sent' };
  }

  /**
   * Scans held inbound emails in the journal and dispatches any pending challenge auto-replies.
   */
  async processHeldEmails(limit = 100): Promise<{
    readonly sent: number;
    readonly suppressed: number;
    readonly skipped: number;
    readonly errors: Array<{ readonly scopeAccount: string; readonly mailKey: string; readonly error: string }>;
  }> {
    const heldList = this.journal.listHeldInboundEmails(limit, this.heldAfter);
    const last = heldList.at(-1);
    this.heldAfter = last ? { scopeAccount: last.scopeAccount, mailKey: last.mailKey } : undefined;
    let sent = 0;
    let suppressed = 0;
    let skipped = 0;
    const errors: Array<{ scopeAccount: string; mailKey: string; error: string }> = [];

    for (const email of heldList) {
      try {
        const res = await this.processHeldEmail(email);
        if (res.status === 'sent') sent += 1;
        else if (res.status === 'suppressed') suppressed += 1;
        else skipped += 1;
      } catch (err) {
        errors.push({
          scopeAccount: email.scopeAccount,
          mailKey: email.mailKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { sent, suppressed, skipped, errors };
  }
}
