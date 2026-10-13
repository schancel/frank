import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type SecureMessageAuthMode = 'direct' | 'otp' | 'passphrase';

export type SecureLinkPolicy = 'off' | 'subject-tag' | 'when-no-wkd' | 'always';

export interface SecureMessageAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

export interface SecureMessageCleartext {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly senderAddress: string;
  readonly senderDisplayName?: string;
  readonly recipientEmail: string;
  readonly conversationId?: string;
  readonly createdAtMs: number;
  readonly attachments?: readonly SecureMessageAttachment[];
}

export interface SecureMessageRecord {
  readonly tokenId: string;
  readonly senderScope: string;
  readonly senderAddress: string;
  readonly recipientEmail: string;
  readonly conversationId: string;
  readonly authMode: SecureMessageAuthMode;
  readonly ciphertext: Buffer;
  readonly otpHmac?: string;
  readonly otpExpiresAtMs?: number;
  readonly failedAttempts: number;
  readonly readCount: number;
  readonly lastAccessedAtMs?: number;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
}

export interface OnboardingClaimPayload {
  readonly kind: 'secure' | 'pay';
  readonly id: string;
  readonly peerAddress: string;
  readonly email: string;
  readonly conversationId: string;
  readonly subject?: string;
  readonly exp: number;
}

export interface OnboardingClaimedThread {
  readonly kind: 'secure' | 'pay';
  readonly peerAddress: string;
  readonly email: string;
  readonly conversationId: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly createdAt: number;
}

/**
 * Generates an HMAC-SHA256 signed onboarding thread-claim token (`<base64url(payload)>.<base64url(sig)>`).
 */
export function createOnboardingClaimToken(
  payload: OnboardingClaimPayload,
  secret: Uint8Array | string,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret)
    .update(`frank/onboard-claim/v1.${payloadB64}`, 'utf8')
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies an HMAC-SHA256 signed onboarding thread-claim token and checks its expiration.
 */
export function verifyOnboardingClaimToken(
  claimToken: string,
  secret: Uint8Array | string,
  nowMs = Date.now(),
): OnboardingClaimPayload | undefined {
  if (typeof claimToken !== 'string') return undefined;
  const dotIdx = claimToken.indexOf('.');
  if (dotIdx <= 0 || dotIdx === claimToken.length - 1) return undefined;
  const payloadB64 = claimToken.slice(0, dotIdx);
  const sigB64 = claimToken.slice(dotIdx + 1);
  const expectedSigB64 = crypto
    .createHmac('sha256', typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret)
    .update(`frank/onboard-claim/v1.${payloadB64}`, 'utf8')
    .digest('base64url');
  const expectedBuf = Buffer.from(expectedSigB64, 'utf8');
  const actualBuf = Buffer.from(sigB64, 'utf8');
  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as OnboardingClaimPayload;
    if (
      (parsed.kind !== 'secure' && parsed.kind !== 'pay') ||
      typeof parsed.id !== 'string' ||
      typeof parsed.peerAddress !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.conversationId !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= nowMs
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Builds the client-generated self-custodial onboarding deep link (`/#/onboard?peer=...&email=...&conversationId=...&claim=...`).
 */
export function buildOnboardingDeepLink(params: {
  readonly frankAppUrl: string;
  readonly payload: OnboardingClaimPayload;
  readonly secret: Uint8Array | string;
}): { readonly url: string; readonly claimToken: string } {
  const claimToken = createOnboardingClaimToken(params.payload, params.secret);
  const base = params.frankAppUrl.replace(/\/+$/, '');
  const query = new URLSearchParams({
    peer: params.payload.peerAddress,
    email: params.payload.email,
    conversationId: params.payload.conversationId,
    claim: claimToken,
    ...(params.payload.subject ? { subject: params.payload.subject } : {}),
  });
  return {
    url: `${base}/#/onboard?${query.toString()}`,
    claimToken,
  };
}

export interface SecureMessageAccessEvent {
  readonly type: 'otp-requested' | 'unlocked' | 'failed-attempt' | 'locked';
  readonly tokenId: string;
  readonly senderScope: string;
  readonly senderAddress: string;
  readonly recipientEmail: string;
  readonly authMode: SecureMessageAuthMode;
  readonly readCount: number;
  readonly failedAttempts: number;
  readonly timestampMs: number;
}

export const DEFAULT_SECURE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_SECURE_LINK_VERIFY_ATTEMPTS = 5;

const TOKEN_ID_REGEX = /^[0-9a-f]{64}$/;
const ENVELOPE_VERSION = 0x01;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;

function deriveEncryptionKey(params: {
  masterSecret: Uint8Array;
  tokenId: string;
  salt: Uint8Array;
  passphrase?: string;
}): Buffer {
  if (params.passphrase !== undefined && params.passphrase.length > 0) {
    const passKey = crypto.scryptSync(
      Buffer.from(params.passphrase, 'utf8'),
      params.salt,
      32,
    );
    const hkdfBytes = crypto.hkdfSync(
      'sha256',
      passKey,
      params.masterSecret,
      Buffer.from(`frank/secure-message/passphrase/v1/${params.tokenId}`, 'utf8'),
      32,
    );
    return Buffer.from(hkdfBytes);
  }
  const hkdfBytes = crypto.hkdfSync(
    'sha256',
    params.masterSecret,
    params.salt,
    Buffer.from(`frank/secure-message/server/v1/${params.tokenId}`, 'utf8'),
    32,
  );
  return Buffer.from(hkdfBytes);
}

/**
 * Encrypts a `SecureMessageCleartext` payload using AES-256-GCM bound to `tokenId` as AAD.
 */
export function encryptSecureMessagePayload(params: {
  cleartext: SecureMessageCleartext;
  masterSecret: Uint8Array;
  tokenId: string;
  passphrase?: string;
}): Buffer {
  if (params.masterSecret.byteLength < 16) {
    throw new Error('Secure message masterSecret must be at least 16 bytes');
  }
  if (!TOKEN_ID_REGEX.test(params.tokenId)) {
    throw new Error('Secure message tokenId must be 64 lowercase hex characters');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveEncryptionKey({
    masterSecret: params.masterSecret,
    tokenId: params.tokenId,
    salt,
    passphrase: params.passphrase,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(params.tokenId, 'utf8'));
  const plaintextBytes = Buffer.from(JSON.stringify(params.cleartext), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), salt, iv, authTag, encrypted]);
}

/**
 * Decrypts and authenticates an AES-256-GCM encrypted `SecureMessageCleartext` payload.
 */
export function decryptSecureMessagePayload(params: {
  ciphertext: Uint8Array;
  masterSecret: Uint8Array;
  tokenId: string;
  passphrase?: string;
}): SecureMessageCleartext {
  const buf = Buffer.from(params.ciphertext);
  if (buf.length < HEADER_BYTES || buf[0] !== ENVELOPE_VERSION) {
    throw new Error('Invalid secure message ciphertext envelope');
  }
  const salt = buf.subarray(1, 1 + SALT_BYTES);
  const iv = buf.subarray(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const authTag = buf.subarray(1 + SALT_BYTES + IV_BYTES, HEADER_BYTES);
  const encrypted = buf.subarray(HEADER_BYTES);

  const key = deriveEncryptionKey({
    masterSecret: params.masterSecret,
    tokenId: params.tokenId,
    salt,
    passphrase: params.passphrase,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(params.tokenId, 'utf8'));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as SecureMessageCleartext;
}

/**
 * Masks an email address for display on the challenge screen (e.g. `alice@gmail.com` -> `a***@gmail.com`).
 */
export function maskEmailAddress(email: string): string {
  const trimmed = email.trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0) return '***';
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parses an email subject for optional `[Secure]`, `[Encrypted]`, `[Secure:direct]`,
 * `[Secure:otp]`, or `[Secure:<passphrase>]` directives.
 */
export function parseSubjectSecureDirective(subject: string): {
  triggered: boolean;
  cleanSubject: string;
  authMode?: SecureMessageAuthMode;
  passphrase?: string;
} {
  const match = subject.match(/^\s*\[(?:secure|encrypted)(?::([^\]]+))?\]\s*/i);
  if (!match) {
    return { triggered: false, cleanSubject: subject };
  }
  const stripped = subject.slice(match[0].length).trim();
  const cleanSubject = stripped.length > 0 ? stripped : 'Secure Message';
  const directiveArg = match[1]?.trim();
  if (!directiveArg) {
    return { triggered: true, cleanSubject };
  }
  const lowerArg = directiveArg.toLowerCase();
  if (lowerArg === 'direct') {
    return { triggered: true, cleanSubject, authMode: 'direct' };
  }
  if (lowerArg === 'otp') {
    return { triggered: true, cleanSubject, authMode: 'otp' };
  }
  return {
    triggered: true,
    cleanSubject,
    authMode: 'passphrase',
    passphrase: directiveArg,
  };
}

/**
 * Builds the neutral outbound notification email body sent to external recipients without WKD.
 */
export function renderSecureLinkNotificationEmail(params: {
  gatewayDomain: string;
  tokenId: string;
  senderAddress: string;
  senderDisplayName?: string;
  authMode: SecureMessageAuthMode;
  expiresAtMs: number;
}): string {
  const senderLabel = params.senderDisplayName
    ? `${params.senderDisplayName} <${params.senderAddress}>`
    : params.senderAddress;
  const url = `https://${params.gatewayDomain}/secure/${params.tokenId}`;
  const authDescription =
    params.authMode === 'passphrase'
      ? 'This message is protected with an out-of-band passphrase shared by the sender.'
      : params.authMode === 'otp'
        ? 'To protect your privacy, you will be prompted for a one-time verification code sent to this email address.'
        : 'Click the button on the secure portal page to decrypt and view your message over TLS.';

  return [
    `You have received a secure, encrypted message from ${senderLabel}.`,
    '',
    'View your secure message at:',
    url,
    '',
    authDescription,
    `Expires: ${new Date(params.expiresAtMs).toUTCString()}`,
  ].join('\r\n');
}

interface SecureMessageRow {
  token_id: string;
  sender_scope: string;
  sender_address: string;
  recipient_email: string;
  conversation_id: string;
  auth_mode: SecureMessageAuthMode;
  ciphertext: Uint8Array;
  otp_hmac: string | null;
  otp_expires_at_ms: number | null;
  failed_attempts: number;
  read_count: number;
  last_accessed_at_ms: number | null;
  expires_at_ms: number;
  created_at_ms: number;
}

const PORTAL_SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};

const CLAIM_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
};

export interface SecureMessagePortalOptions {
  readonly gatewayDomain: string;
  readonly masterSecret: Uint8Array;
  readonly frankAppUrl?: string;
  readonly dbPath?: string;
  readonly database?: DatabaseSync;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly otpTtlMs?: number;
  readonly maxVerifyAttempts?: number;
  readonly sendOtpEmail?: (params: {
    readonly to: string;
    readonly otp: string;
    readonly tokenId: string;
    readonly senderAddress: string;
    readonly expiresAtMs: number;
  }) => Promise<void>;
  readonly onAccessEvent?: (event: SecureMessageAccessEvent) => void | Promise<void>;
  readonly resolveClaimedPayThread?: (
    payload: OnboardingClaimPayload,
  ) => Promise<OnboardingClaimedThread | undefined> | OnboardingClaimedThread | undefined;
}

export interface SecurePortalHttpRequest {
  readonly pathname: string;
  readonly method: string;
  readonly body?: string;
}

export interface SecurePortalHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Encrypted message store and HTTP portal for external recipients on providers without WKD support.
 */
export class SecureMessagePortal {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly domain: string;
  private readonly frankAppUrl: string;
  private readonly masterSecret: Buffer;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly otpTtlMs: number;
  private readonly maxVerifyAttempts: number;
  private readonly sendOtpEmail?: SecureMessagePortalOptions['sendOtpEmail'];
  private readonly onAccessEvent?: SecureMessagePortalOptions['onAccessEvent'];
  private readonly resolveClaimedPayThread?: SecureMessagePortalOptions['resolveClaimedPayThread'];

  constructor(options: SecureMessagePortalOptions) {
    if (options.masterSecret.byteLength < 16) {
      throw new Error('SecureMessagePortal masterSecret must be at least 16 bytes');
    }
    this.domain = options.gatewayDomain.trim().toLowerCase();
    this.frankAppUrl = (options.frankAppUrl?.trim() || `https://${this.domain}`).replace(/\/+$/, '');
    this.masterSecret = Buffer.from(options.masterSecret);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SECURE_LINK_TTL_MS;
    this.otpTtlMs = options.otpTtlMs ?? DEFAULT_OTP_TTL_MS;
    this.maxVerifyAttempts = options.maxVerifyAttempts ?? MAX_SECURE_LINK_VERIFY_ATTEMPTS;
    this.sendOtpEmail = options.sendOtpEmail;
    this.onAccessEvent = options.onAccessEvent;
    this.resolveClaimedPayThread = options.resolveClaimedPayThread;

    if (options.database) {
      this.db = options.database;
      this.ownsDb = false;
    } else {
      this.db = new DatabaseSync(options.dbPath ?? ':memory:');
      this.ownsDb = true;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secure_message_portal (
        token_id TEXT PRIMARY KEY,
        sender_scope TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('direct', 'otp', 'passphrase')),
        ciphertext BLOB NOT NULL,
        otp_hmac TEXT,
        otp_expires_at_ms INTEGER,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        read_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  private computeOtpHmac(tokenId: string, otp: string): string {
    return crypto
      .createHmac('sha256', this.masterSecret)
      .update(`frank/secure-message-otp/v1\0${tokenId}\0${otp.trim()}`)
      .digest('hex');
  }

  private toRecord(row: SecureMessageRow): SecureMessageRecord {
    return {
      tokenId: row.token_id,
      senderScope: row.sender_scope,
      senderAddress: row.sender_address,
      recipientEmail: row.recipient_email,
      conversationId: row.conversation_id,
      authMode: row.auth_mode,
      ciphertext: Buffer.from(row.ciphertext),
      ...(row.otp_hmac !== null ? { otpHmac: row.otp_hmac } : {}),
      ...(row.otp_expires_at_ms !== null ? { otpExpiresAtMs: row.otp_expires_at_ms } : {}),
      failedAttempts: row.failed_attempts,
      readCount: row.read_count,
      ...(row.last_accessed_at_ms !== null ? { lastAccessedAtMs: row.last_accessed_at_ms } : {}),
      expiresAtMs: row.expires_at_ms,
      createdAtMs: row.created_at_ms,
    };
  }

  /**
   * Encrypts and stores a message in the portal, returning the generated 256-bit `tokenId` and metadata.
   */
  createSecureMessage(input: {
    readonly senderScope: string;
    readonly cleartext: SecureMessageCleartext;
    readonly authMode?: SecureMessageAuthMode;
    readonly passphrase?: string;
    readonly expiresAtMs?: number;
  }): SecureMessageRecord {
    const authMode: SecureMessageAuthMode =
      input.passphrase && input.passphrase.length > 0
        ? 'passphrase'
        : (input.authMode ?? 'otp');
    if (authMode === 'passphrase' && (!input.passphrase || input.passphrase.length === 0)) {
      throw new Error('Passphrase is required when authMode is passphrase');
    }

    const tokenId = crypto.randomBytes(32).toString('hex');
    const nowMs = this.now();
    const expiresAtMs = input.expiresAtMs ?? nowMs + this.ttlMs;
    const conversationId = input.cleartext.conversationId ?? '';
    const ciphertext = encryptSecureMessagePayload({
      cleartext: input.cleartext,
      masterSecret: this.masterSecret,
      tokenId,
      passphrase: authMode === 'passphrase' ? input.passphrase : undefined,
    });

    this.db
      .prepare(
        `INSERT INTO secure_message_portal (
          token_id, sender_scope, sender_address, recipient_email, conversation_id, auth_mode,
          ciphertext, otp_hmac, otp_expires_at_ms, failed_attempts, read_count,
          last_accessed_at_ms, expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, ?, ?)`,
      )
      .run(
        tokenId,
        input.senderScope.toLowerCase(),
        input.cleartext.senderAddress,
        input.cleartext.recipientEmail.toLowerCase(),
        conversationId,
        authMode,
        ciphertext,
        expiresAtMs,
        nowMs,
      );

    return this.getSecureMessage(tokenId)!;
  }

  getSecureMessage(tokenId: string): SecureMessageRecord | undefined {
    if (!TOKEN_ID_REGEX.test(tokenId)) return undefined;
    const row = this.db
      .prepare('SELECT * FROM secure_message_portal WHERE token_id = ?')
      .get(tokenId) as SecureMessageRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  /**
   * Generates a 6-digit OTP for an `'otp'`-mode message, persists its HMAC, and sends it to the recipient.
   */
  async issueOtp(tokenId: string): Promise<{ otp: string; expiresAtMs: number } | undefined> {
    const record = this.getSecureMessage(tokenId);
    const nowMs = this.now();
    if (!record || record.expiresAtMs <= nowMs) return undefined;
    if (record.failedAttempts >= this.maxVerifyAttempts) return undefined;
    if (record.authMode !== 'otp') return undefined;

    const otp = String(crypto.randomInt(100_000, 1_000_000));
    const otpHmac = this.computeOtpHmac(tokenId, otp);
    const otpExpiresAtMs = nowMs + this.otpTtlMs;

    this.db
      .prepare(
        'UPDATE secure_message_portal SET otp_hmac = ?, otp_expires_at_ms = ? WHERE token_id = ?',
      )
      .run(otpHmac, otpExpiresAtMs, tokenId);

    if (this.sendOtpEmail) {
      await this.sendOtpEmail({
        to: record.recipientEmail,
        otp,
        tokenId,
        senderAddress: record.senderAddress,
        expiresAtMs: otpExpiresAtMs,
      });
    }
    await this.emitEvent('otp-requested', record);
    return { otp, expiresAtMs: otpExpiresAtMs };
  }

  /**
   * Verifies credentials (`otp` or `passphrase`, or 1-click POST for `'direct'`) and decrypts the message in memory.
   */
  async verifyAndDecrypt(
    tokenId: string,
    credentials?: { readonly otp?: string; readonly passphrase?: string },
  ): Promise<
    | { readonly kind: 'unlocked'; readonly cleartext: SecureMessageCleartext; readonly record: SecureMessageRecord }
    | { readonly kind: 'not_found' | 'expired' | 'locked' | 'invalid_credentials' }
  > {
    const record = this.getSecureMessage(tokenId);
    const nowMs = this.now();
    if (!record) return { kind: 'not_found' };
    if (record.expiresAtMs <= nowMs) return { kind: 'expired' };
    if (record.failedAttempts >= this.maxVerifyAttempts) {
      return { kind: 'locked' };
    }

    if (record.authMode === 'otp') {
      const candidateOtp = credentials?.otp?.trim() ?? '';
      if (
        !record.otpHmac ||
        !record.otpExpiresAtMs ||
        record.otpExpiresAtMs <= nowMs ||
        !/^[0-9]{6}$/.test(candidateOtp)
      ) {
        return this.recordFailedAttempt(record);
      }
      const expectedBuf = Buffer.from(record.otpHmac, 'hex');
      const actualBuf = Buffer.from(this.computeOtpHmac(tokenId, candidateOtp), 'hex');
      if (
        expectedBuf.length !== actualBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, actualBuf)
      ) {
        return this.recordFailedAttempt(record);
      }
    }

    let cleartext: SecureMessageCleartext;
    try {
      cleartext = decryptSecureMessagePayload({
        ciphertext: record.ciphertext,
        masterSecret: this.masterSecret,
        tokenId,
        passphrase: record.authMode === 'passphrase' ? (credentials?.passphrase ?? '') : undefined,
      });
    } catch {
      return this.recordFailedAttempt(record);
    }

    this.db
      .prepare(
        `UPDATE secure_message_portal
            SET read_count = read_count + 1,
                last_accessed_at_ms = ?,
                otp_hmac = NULL,
                otp_expires_at_ms = NULL
          WHERE token_id = ?`,
      )
      .run(nowMs, tokenId);

    const updated = this.getSecureMessage(tokenId)!;
    await this.emitEvent('unlocked', updated);
    return { kind: 'unlocked', cleartext, record: updated };
  }

  private async recordFailedAttempt(
    record: SecureMessageRecord,
  ): Promise<{ readonly kind: 'invalid_credentials' | 'locked' }> {
    this.db
      .prepare(
        'UPDATE secure_message_portal SET failed_attempts = failed_attempts + 1 WHERE token_id = ?',
      )
      .run(record.tokenId);
    const updated = this.getSecureMessage(record.tokenId)!;
    if (updated.failedAttempts >= this.maxVerifyAttempts) {
      await this.emitEvent('locked', updated);
      return { kind: 'locked' };
    }
    await this.emitEvent('failed-attempt', updated);
    return { kind: 'invalid_credentials' };
  }

  private async emitEvent(
    type: SecureMessageAccessEvent['type'],
    record: SecureMessageRecord,
  ): Promise<void> {
    if (!this.onAccessEvent) return;
    try {
      await this.onAccessEvent({
        type,
        tokenId: record.tokenId,
        senderScope: record.senderScope,
        senderAddress: record.senderAddress,
        recipientEmail: record.recipientEmail,
        authMode: record.authMode,
        readCount: record.readCount,
        failedAttempts: record.failedAttempts,
        timestampMs: this.now(),
      });
    } catch {
      // Notification hook failure must not break portal rendering
    }
  }

  /**
   * Verifies an onboarding `claimToken` (`kind: 'secure' | 'pay'`) and returns the claimed thread context
   * so a newly generated self-custodial Frank account in the browser can import the message and continue
   * the same `conversationId` thread directly over Frank E2EE.
   */
  async claimThread(claimToken: string): Promise<OnboardingClaimedThread | undefined> {
    const payload = verifyOnboardingClaimToken(claimToken, this.masterSecret, this.now());
    if (!payload) return undefined;

    if (payload.kind === 'secure') {
      const record = this.getSecureMessage(payload.id);
      const nowMs = this.now();
      if (!record || record.expiresAtMs <= nowMs) return undefined;
      if (record.failedAttempts >= this.maxVerifyAttempts) return undefined;

      if (record.authMode !== 'passphrase') {
        try {
          const cleartext = decryptSecureMessagePayload({
            ciphertext: record.ciphertext,
            masterSecret: this.masterSecret,
            tokenId: record.tokenId,
          });
          return {
            kind: 'secure',
            peerAddress: record.senderScope,
            email: record.recipientEmail,
            conversationId:
              cleartext.conversationId || record.conversationId || payload.conversationId,
            subject: cleartext.subject,
            textBody: cleartext.textBody,
            ...(cleartext.htmlBody ? { htmlBody: cleartext.htmlBody } : {}),
            createdAt: cleartext.createdAtMs,
          };
        } catch {
          return undefined;
        }
      }

      return {
        kind: 'secure',
        peerAddress: record.senderScope,
        email: record.recipientEmail,
        conversationId: record.conversationId || payload.conversationId,
        subject: payload.subject ?? 'Encrypted Message',
        textBody: '',
        createdAt: record.createdAtMs,
      };
    }

    if (this.resolveClaimedPayThread) {
      const resolved = await this.resolveClaimedPayThread(payload);
      if (resolved) return resolved;
    }

    return {
      kind: 'pay',
      peerAddress: payload.peerAddress,
      email: payload.email,
      conversationId: payload.conversationId,
      subject: payload.subject ?? 'Held Message',
      textBody: '',
      createdAt: this.now(),
    };
  }

  /**
   * Handles HTTP requests under `/secure/:tokenId`, `/secure/:tokenId/request-otp`, `/secure/:tokenId/verify`,
   * and `/onboard/claim/:claimToken`.
   */
  async handleHttpRequest(
    req: SecurePortalHttpRequest,
  ): Promise<SecurePortalHttpResponse | undefined> {
    if (req.pathname.startsWith('/onboard/claim/')) {
      const rawToken = req.pathname.slice('/onboard/claim/'.length).replace(/^\/+|\/+$/g, '');
      const method = req.method.toUpperCase();
      if (method === 'OPTIONS') {
        return {
          status: 204,
          headers: CLAIM_CORS_HEADERS,
          body: '',
        };
      }
      if (method !== 'GET') {
        return {
          status: 405,
          headers: { ...CLAIM_CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'Method Not Allowed' }),
        };
      }
      let decodedToken = rawToken;
      try {
        decodedToken = decodeURIComponent(rawToken);
      } catch {
        // Keep rawToken if malformed URI component
      }
      const claimed = await this.claimThread(decodedToken);
      if (!claimed) {
        return {
          status: 404,
          headers: { ...CLAIM_CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'Invalid or expired onboarding claim token' }),
        };
      }
      return {
        status: 200,
        headers: { ...CLAIM_CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(claimed),
      };
    }

    if (!req.pathname.startsWith('/secure/')) return undefined;
    const suffix = req.pathname.slice('/secure/'.length);
    const segments = suffix.split('/').filter((s) => s.length > 0);
    if (segments.length === 0 || segments.length > 2) {
      return {
        status: 404,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderErrorPage('Secure Message Not Found', 'The requested secure link is invalid.'),
      };
    }

    const tokenId = segments[0].toLowerCase();
    const action = segments[1];
    const record = this.getSecureMessage(tokenId);
    const nowMs = this.now();

    if (!record) {
      return {
        status: 404,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderErrorPage(
          'Secure Message Not Found',
          'This secure message does not exist or has been removed.',
        ),
      };
    }
    if (record.expiresAtMs <= nowMs) {
      return {
        status: 410,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderErrorPage(
          'Secure Message Expired',
          'This encrypted message has passed its expiration time and can no longer be decrypted.',
        ),
      };
    }
    if (record.failedAttempts >= this.maxVerifyAttempts) {
      return {
        status: 429,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderErrorPage(
          'Secure Message Locked',
          'Too many failed verification attempts. This secure message has been locked to prevent brute-force access.',
        ),
      };
    }

    const method = req.method.toUpperCase();

    if (!action) {
      if (method !== 'GET') {
        return {
          status: 405,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderErrorPage('Method Not Allowed', 'Expected GET request.'),
        };
      }
      return {
        status: 200,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderChallengePage(record, { otpSent: false }),
      };
    }

    if (action === 'request-otp') {
      if (method !== 'POST') {
        return {
          status: 405,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderErrorPage('Method Not Allowed', 'Expected POST request.'),
        };
      }
      if (record.authMode !== 'otp') {
        return {
          status: 400,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderErrorPage('Invalid Action', 'This message does not use email OTP verification.'),
        };
      }
      await this.issueOtp(tokenId);
      const updated = this.getSecureMessage(tokenId)!;
      return {
        status: 200,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderChallengePage(updated, { otpSent: true }),
      };
    }

    if (action === 'verify') {
      if (method !== 'POST') {
        return {
          status: 405,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderErrorPage('Method Not Allowed', 'Expected POST request.'),
        };
      }
      const params = new URLSearchParams(req.body ?? '');
      const otp = params.get('otp') ?? undefined;
      const passphrase = params.get('passphrase') ?? undefined;
      const outcome = await this.verifyAndDecrypt(tokenId, { otp, passphrase });

      if (outcome.kind === 'unlocked') {
        return {
          status: 200,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderDecryptedMessagePage(outcome.record, outcome.cleartext),
        };
      }
      if (outcome.kind === 'locked') {
        return {
          status: 429,
          headers: PORTAL_SECURITY_HEADERS,
          body: this.renderErrorPage(
            'Secure Message Locked',
            'Too many failed verification attempts. This secure message has been locked.',
          ),
        };
      }
      const updated = this.getSecureMessage(tokenId)!;
      return {
        status: 401,
        headers: PORTAL_SECURITY_HEADERS,
        body: this.renderChallengePage(updated, {
          otpSent: record.authMode === 'otp',
          errorMessage:
            record.authMode === 'passphrase'
              ? 'Invalid passphrase. Please try again.'
              : 'Invalid or expired verification code. Please try again.',
        }),
      };
    }

    return {
      status: 404,
      headers: PORTAL_SECURITY_HEADERS,
      body: this.renderErrorPage('Not Found', 'Unknown secure portal route.'),
    };
  }

  private renderOnboardingCta(record: SecureMessageRecord, subject?: string): string {
    const conversationId = record.conversationId || `conv_${record.tokenId.slice(0, 16)}`;
    const { url: onboardingUrl } = buildOnboardingDeepLink({
      frankAppUrl: this.frankAppUrl,
      secret: this.masterSecret,
      payload: {
        kind: 'secure',
        id: record.tokenId,
        peerAddress: record.senderScope,
        email: record.recipientEmail,
        conversationId,
        ...(subject ? { subject } : {}),
        exp: record.expiresAtMs,
      },
    });
    const senderHandle = escapeHtml(record.senderAddress.split('@')[0] || record.senderAddress);
    return `
    <div class="onboarding-card">
      <div class="onboarding-header">
        <span class="pill pill-accent">Get a Free Native Frank Account</span>
        <span class="pill pill-subtle">Zero-Knowledge &bull; Self-Custodial</span>
      </div>
      <h2>Want end-to-end encrypted replies without email links?</h2>
      <p>Create a free, self-custodial Frank account in 10 seconds to message <strong>@${senderHandle}</strong> directly with native end-to-end encryption and instant payments.</p>
      <a class="cta-btn" href="${escapeHtml(onboardingUrl)}" rel="noopener noreferrer">Create Free Frank Account &amp; Connect &rarr;</a>
    </div>`;
  }

  private renderSharedStyles(): string {
    return `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #090d16 75%);
      color: #f8fafc;
      min-height: 100vh;
      margin: 0;
      padding: 2.5rem 1.25rem;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .shell { max-width: 680px; width: 100%; display: flex; flex-direction: column; gap: 1.25rem; }
    .card {
      width: 100%;
      background: rgba(30, 41, 59, 0.82);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 16px;
      padding: 2.25rem;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .badge-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; align-items: center; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.7rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .pill-primary { background: rgba(56, 189, 248, 0.14); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .pill-success { background: rgba(34, 197, 94, 0.14); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .pill-accent { background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); }
    .pill-subtle { background: rgba(148, 163, 184, 0.12); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.2); }
    h1 { font-size: 1.45rem; font-weight: 700; margin: 0 0 0.5rem 0; color: #f8fafc; letter-spacing: -0.01em; }
    h2 { font-size: 1.1rem; font-weight: 600; margin: 0.5rem 0; color: #f8fafc; }
    p { color: #cbd5e1; line-height: 1.6; margin: 0.5rem 0 1rem 0; font-size: 0.95rem; }
    .meta {
      font-size: 0.875rem;
      color: #94a3b8;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 10px;
      padding: 0.9rem 1.1rem;
      margin: 1rem 0 1.25rem 0;
      line-height: 1.6;
    }
    .error {
      background: rgba(127, 29, 29, 0.65);
      border: 1px solid rgba(248, 113, 113, 0.4);
      color: #fecaca;
      padding: 0.8rem 1rem;
      border-radius: 10px;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    input {
      width: 100%;
      padding: 0.85rem 1rem;
      border-radius: 10px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f8fafc;
      font-size: 1rem;
      margin-bottom: 1rem;
      outline: none;
    }
    input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
    button {
      width: 100%;
      padding: 0.85rem 1.25rem;
      border-radius: 10px;
      border: none;
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #ffffff;
      font-weight: 600;
      font-size: 0.98rem;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
    }
    button:hover { background: linear-gradient(135deg, #0369a1 0%, #1d4ed8 100%); }
    pre.body {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.65;
      color: #f1f5f9;
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 12px;
      padding: 1.25rem;
      margin: 0;
    }
    .attachments { margin-top: 1.5rem; border-top: 1px solid rgba(148, 163, 184, 0.16); padding-top: 1rem; }
    .attachments ul { padding-left: 1.25rem; margin: 0.5rem 0 0 0; }
    .onboarding-card {
      width: 100%;
      background: linear-gradient(145deg, rgba(30, 27, 75, 0.78) 0%, rgba(15, 23, 42, 0.9) 100%);
      border: 1px solid rgba(168, 85, 247, 0.32);
      border-radius: 16px;
      padding: 1.75rem 2rem;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }
    .onboarding-header { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.6rem; }
    .cta-btn {
      display: inline-block;
      margin-top: 0.35rem;
      padding: 0.75rem 1.35rem;
      border-radius: 10px;
      background: linear-gradient(135deg, #9333ea 0%, #4f46e5 100%);
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.92rem;
      box-shadow: 0 4px 14px rgba(147, 51, 234, 0.35);
    }
    a { color: #38bdf8; }
    `;
  }

  private renderChallengePage(
    record: SecureMessageRecord,
    state: { otpSent: boolean; errorMessage?: string },
  ): string {
    const maskedRecipient = escapeHtml(maskEmailAddress(record.recipientEmail));
    const sender = escapeHtml(record.senderAddress);
    const errorBanner = state.errorMessage
      ? `<div class="error">${escapeHtml(state.errorMessage)}</div>`
      : '';

    let formHtml = '';
    if (record.authMode === 'direct') {
      formHtml = `
        <p>Click below to decrypt and view your message over an encrypted TLS session.</p>
        <form method="POST" action="/secure/${record.tokenId}/verify">
          <button type="submit">View Secure Message</button>
        </form>
      `;
    } else if (record.authMode === 'passphrase') {
      formHtml = `
        <p>Enter the out-of-band passphrase shared by <strong>${sender}</strong> to decrypt this message.</p>
        <form method="POST" action="/secure/${record.tokenId}/verify">
          <input type="password" name="passphrase" placeholder="Enter passphrase" required autocomplete="off" />
          <button type="submit">Decrypt &amp; View Message</button>
        </form>
      `;
    } else if (!state.otpSent) {
      formHtml = `
        <p>To verify ownership of <strong>${maskedRecipient}</strong>, request a 6-digit verification code.</p>
        <form method="POST" action="/secure/${record.tokenId}/request-otp">
          <button type="submit">Send 6-Digit Verification Code</button>
        </form>
      `;
    } else {
      formHtml = `
        <p>A 6-digit verification code was sent to <strong>${maskedRecipient}</strong>. Enter it below to unlock your message:</p>
        <form method="POST" action="/secure/${record.tokenId}/verify">
          <input type="text" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code" required autocomplete="one-time-code" />
          <button type="submit">Verify &amp; Decrypt Message</button>
        </form>
      `;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Secure Message Portal — ${escapeHtml(this.domain)}</title>
  <style>${this.renderSharedStyles()}</style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="badge-row">
        <span class="pill pill-primary">End-to-End Encrypted</span>
        <span class="pill pill-subtle">AES-256-GCM</span>
        <span class="pill pill-subtle">Zero-Knowledge Gateway</span>
      </div>
      <h1>Encrypted Message from ${sender}</h1>
      <div class="meta">Recipient: ${maskedRecipient} &bull; Expires: ${escapeHtml(new Date(record.expiresAtMs).toUTCString())}</div>
      ${errorBanner}
      ${formHtml}
    </div>
    ${this.renderOnboardingCta(record)}
  </div>
</body>
</html>`;
  }

  private renderDecryptedMessagePage(
    record: SecureMessageRecord,
    cleartext: SecureMessageCleartext,
  ): string {
    const senderLabel = cleartext.senderDisplayName
      ? `${cleartext.senderDisplayName} <${cleartext.senderAddress}>`
      : cleartext.senderAddress;
    const attachmentsHtml =
      cleartext.attachments && cleartext.attachments.length > 0
        ? `<div class="attachments"><h3>Attachments (${cleartext.attachments.length})</h3><ul>` +
          cleartext.attachments
            .map(
              (att) =>
                `<li><a download="${escapeHtml(att.filename)}" href="data:${escapeHtml(att.contentType)};base64,${escapeHtml(att.contentBase64)}">${escapeHtml(att.filename)}</a></li>`,
            )
            .join('') +
          '</ul></div>'
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(cleartext.subject)} — Secure Message</title>
  <style>${this.renderSharedStyles()}</style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="badge-row">
        <span class="pill pill-success">Decrypted in Memory</span>
        <span class="pill pill-primary">AES-256-GCM Verified</span>
        <span class="pill pill-subtle">Verified Sender</span>
      </div>
      <h1>${escapeHtml(cleartext.subject)}</h1>
      <div class="meta">
        <div><strong>From:</strong> ${escapeHtml(senderLabel)}</div>
        <div><strong>To:</strong> ${escapeHtml(cleartext.recipientEmail)}</div>
        <div><strong>Date:</strong> ${escapeHtml(new Date(cleartext.createdAtMs).toUTCString())}</div>
        <div><strong>Access count:</strong> ${record.readCount}</div>
      </div>
      <pre class="body">${escapeHtml(cleartext.textBody)}</pre>
      ${attachmentsHtml}
    </div>
    ${this.renderOnboardingCta(record, cleartext.subject)}
  </div>
</body>
</html>`;
  }

  private renderErrorPage(title: string, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${this.renderSharedStyles()}</style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <h1 style="color: #f87171;">${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </div>
  </div>
</body>
</html>`;
  }
}
