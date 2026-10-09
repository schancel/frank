/**
 * Mail gateway journal (#1237, stage G1).
 *
 * The durable owner of: which email threads exist in a Frank account's scope,
 * which message holds each RFC Message-ID there, every inbound email the
 * gateway accepted and what became of it, the gateway's own send slots, every
 * Frank message it has bridged or refused, and the outbound email jobs.
 *
 * Nothing calls this yet. Later stages (G2, G3a, G3b) are its only callers.
 *
 * Scope: every lookup and every key is inside one `scopeAccount`, the Frank
 * account on the Frank side of the thread (lowercase `0x` + 40 hex). A thread is
 * identified by (scope, conversation ID) and a message by (scope, RFC
 * Message-ID). Subject, peer address and recency are never keys.
 *
 * Holder rule (contract section 20): the holder of an identifier is the first
 * message relayed under it in the scope. Its row is never updated or replaced;
 * this module has no UPDATE or DELETE on `mail_message`. A later message with
 * the same identifier and the same content key is the same message. A later
 * message with the same identifier and a different content key is kept as its
 * own row under `<{content key}@contested.{gatewayDomain}>`, with the
 * identifier it claimed in `claimed_rfc_id`.
 *
 * The content key is an opaque 64-hex value computed by the caller (the intake
 * stage for inbound mail, the ingest stage for outbound mail). This module
 * stores and compares it; it does not compute it.
 *
 * Atomicity: every operation runs through `CreditLedger.atomic()`. Called on
 * its own, an operation is one `BEGIN IMMEDIATE … COMMIT`. Called inside a
 * caller's `ledger.atomic(() => …)`, it joins that unit, so a stage can commit
 * several operations and its credit decision together or not at all. Every
 * operation reads what it decides on inside the transaction and is safe to
 * repeat: a repeat returns the stored row and writes nothing.
 *
 * One process: at open the connection takes SQLite's exclusive locking mode and
 * runs one write transaction, so a second process (or connection) on the same
 * file cannot read or write it. Two arrivals therefore never race for a holder; they are
 * serialised on this connection.
 *
 * Durability is the ledger connection's: SQLite's rollback journal with
 * `synchronous = FULL` (the defaults; the ledger sets no pragma). A committed
 * operation survives power loss; an uncommitted one is absent after reopen.
 */
import * as crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { parseMessageId } from '../rfc/message-headers';
import {
  FRANK_INBOUND_REJECT_REASONS,
  FrankInboundRecord,
  FrankInboundRejectReason,
  FrankSendRecord,
  InboundEmailRecord,
  MailMessageRecord,
  MailThreadRecord,
  OutboundJobRecord,
  OutboundJobState,
  StoredMailBytes,
} from '../types';
import type { CreditLedger } from './credit-ledger';
import { MAIL_JOURNAL_DDL, MAIL_JOURNAL_FORMAT, MAIL_JOURNAL_TABLES } from './database';
import type {
  FrankInboundRow,
  FrankSendRow,
  InboundEmailRow,
  MailJournalMetaRow,
  MailMessageRow,
  MailThreadRow,
  OutboundJobRow,
} from './schema';

/** At most this many stored inbound emails may claim one Message-ID in one scope. */
export const MAX_INBOUND_CLAIMS_PER_MESSAGE_ID = 8;

/** The journal cannot be opened on this database. Nothing was created, repaired or reset. */
export class MailJournalOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailJournalOpenError';
  }
}

/** A value was refused at the journal boundary. Nothing was written. It is a caller error, not retryable. */
export class MailJournalArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailJournalArgumentError';
  }
}

/** The stored row does not allow the requested step. Nothing was written. */
export class MailJournalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailJournalStateError';
  }
}

export interface MailJournalOptions {
  /** Registry `id` of the gateway wallet's network (docs/protocol/chains/v1.json), e.g. `monad-testnet`. */
  readonly chainIdentifier: string;
  /** The gateway's own Frank account, lowercase `0x` + 40 hex. */
  readonly gatewayAccount: string;
  /** Lowercase mail domain of this gateway. It names the reserved identifier namespaces. */
  readonly gatewayDomain: string;
  /** Clock for `created_at` columns. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface AdmitInboundEmailInput {
  readonly scopeAccount: string;
  readonly contentKey: string;
  /** The mail's Message-ID, or `noMessageIdFor(contentKey)` when it has no usable one. */
  readonly rfcMessageId: string;
  /** The credit principal: the single `From` address, lowercased. */
  readonly senderEmail: string;
  /** SHA-256 of the DATA bytes, lowercase hex. */
  readonly dataSha256: string;
  /** Inline bytes must hash to `dataSha256`; a blob must be stored under `dataSha256`. */
  readonly raw: StoredMailBytes;
}

export type AdmitInboundEmailResult =
  /** New mail, now durably owned, disposition `held` until it is relayed. */
  | { readonly kind: 'admitted'; readonly email: InboundEmailRecord }
  /** This exact mail was admitted before. Nothing was written. */
  | { readonly kind: 'duplicate'; readonly email: InboundEmailRecord }
  /** The scope's own outbound mail coming back unchanged. Stored once as `echo`; never relayed. */
  | { readonly kind: 'echo'; readonly email: InboundEmailRecord }
  /** Eight different mails already claim this Message-ID in this scope. Nothing was written. */
  | { readonly kind: 'refused'; readonly reason: 'claim_limit' };

export interface RelayInboundEmailInput {
  readonly scopeAccount: string;
  readonly contentKey: string;
  /** Value the gateway will stamp the send with, as decimal text. */
  readonly stampValue: string;
  /** First valid ID of `In-Reply-To`, if any. */
  readonly inReplyTo?: string;
  /** Valid IDs of `References`, in header order. */
  readonly references?: readonly string[];
}

export interface RelayInboundEmailResult {
  /** False when this mail was already relayed: the stored rows are returned and nothing was written. */
  readonly created: boolean;
  /** True when another message holds the claimed Message-ID, so this one lives under a regenerated identifier. */
  readonly contested: boolean;
  readonly email: InboundEmailRecord;
  readonly slot: FrankSendRecord;
  readonly message: MailMessageRecord;
}

interface FrankMessageBase {
  readonly payloadDigest: string;
  readonly receivedTimeMs: number;
  /** The stamp the message carried, in wei, as decimal text. It is the message's whole budget. */
  readonly stampValueWei: string;
}

export type RecordFrankMessageInput =
  | (FrankMessageBase & {
      readonly outcome: 'bridged';
      readonly scopeAccount: string;
      readonly frankMessageId: string;
      readonly conversationId: string;
      /** The Message-ID the author chose for the email. */
      readonly rfcMessageId: string;
      readonly contentKey: string;
      readonly inReplyTo?: string;
      /** Reply allowances to cover from the budget: `wanted` units of `unitWei` each, as many as the stamp covers. */
      readonly replyAllowance?: { readonly unitWei: string; readonly wanted: number };
    })
  | (FrankMessageBase & {
      readonly outcome: 'rejected';
      readonly reason: FrankInboundRejectReason;
      readonly scopeAccount?: string;
      readonly frankMessageId?: string;
      readonly conversationId?: string;
    })
  | (FrankMessageBase & { readonly outcome: 'quarantined'; readonly scopeAccount?: string });

export type RecordFrankMessageResult =
  | {
      readonly kind: 'bridged';
      readonly inbound: FrankInboundRecord;
      readonly message: MailMessageRecord;
      /** True when the authored Message-ID was already held, so the email must go out under `message.rfcMessageId`. */
      readonly contested: boolean;
      /** True when this message opened the conversation in this scope. */
      readonly threadCreated: boolean;
      /** Reply allowances the stamp covered; already debited. */
      readonly allowancesCovered: number;
    }
  | { readonly kind: 'rejected' | 'quarantined'; readonly inbound: FrankInboundRecord }
  /** This payload digest was recorded before. Nothing was written; grant nothing again. */
  | { readonly kind: 'duplicate'; readonly inbound: FrankInboundRecord }
  /** The same email content under a new seal. Nothing was written; no second email. */
  | { readonly kind: 'same_message'; readonly message: MailMessageRecord };

export interface AddOutboundJobInput {
  readonly scopeAccount: string;
  readonly frankMessageId: string;
  readonly conversationId: string;
  readonly recipientEmail: string;
  readonly signedRfc822: StoredMailBytes;
  readonly nextAttemptAtMs: number;
}

export type AddOutboundJobResult =
  | { readonly kind: 'created' | 'existing'; readonly job: OutboundJobRecord }
  /** A job with this key holds different bytes. It was left as it is and nothing was written. */
  | { readonly kind: 'key_taken'; readonly job: OutboundJobRecord };

export interface StageNoticeInput {
  readonly sourceKind: 'bounce' | 'reject';
  /** `bounce`: the job ID as decimal text. `reject`: the refused message's payload digest. */
  readonly sourceKey: string;
  readonly scopeAccount: string;
  readonly conversationId: string;
  readonly stampValue: string;
  /** The Frank message whose stamp must cover this notice, and the price of one notice. */
  readonly cover: { readonly payloadDigest: string; readonly unitWei: string };
}

export type StageNoticeResult =
  | { readonly kind: 'created' | 'existing'; readonly slot: FrankSendRecord }
  /** The message's remaining budget is below one unit. No slot, no debit. */
  | { readonly kind: 'uncovered' };

export type LinkFrankSendResult =
  | { readonly kind: 'linked'; readonly slot: FrankSendRecord }
  /** Another slot holds this digest. The slot is now `held` (`digest_conflict`), never delivered. */
  | { readonly kind: 'held'; readonly slot: FrankSendRecord };

const SCOPE_ACCOUNT = /^0x[0-9a-f]{40}$/;
const FRANK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const CHAIN_IDENTIFIER = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Printable ASCII with one or more `@`, no space; the recipient grammar itself is the ingest stage's.
const ADDRESS = /^[\x21-\x7e]+@[\x21-\x7e]+$/;

const CONTESTED_LABEL = 'contested';
const NO_MESSAGE_ID_LABEL = 'no-message-id';

function refuse(what: string): never {
  throw new MailJournalArgumentError(`Mail journal refused ${what}`);
}

function requireMatch(label: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) refuse(`${label}: not in the required form`);
  return value as string;
}

function requireTime(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    refuse(`${label}: not a non-negative integer of milliseconds`);
  }
  return value as number;
}

/** The value itself must be one whole valid Message-ID, by the landed header module's grammar. */
function requireRfcId(label: string, value: unknown): string {
  if (typeof value !== 'string' || parseMessageId(value) !== value) {
    refuse(`${label}: not a valid Message-ID`);
  }
  return value as string;
}

function requireAddress(label: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 320 ||
    value !== value.toLowerCase() ||
    !ADDRESS.test(value)
  ) {
    refuse(`${label}: not a lowercase address`);
  }
  return value as string;
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requireStoredBytes(label: string, value: StoredMailBytes): string {
  if (value?.kind === 'inline' && value.bytes instanceof Uint8Array) return sha256Hex(value.bytes);
  if (value?.kind === 'blob') return requireMatch(`${label}.sha256`, value.sha256, HEX_64);
  return refuse(`${label}: neither inline bytes nor a blob key`);
}

function encodeStoredBytes(value: StoredMailBytes): Uint8Array | string {
  return value.kind === 'inline' ? value.bytes : `blob://${value.sha256}`;
}

/** Bytes are stored as a BLOB and a blob pointer as TEXT, so mail bytes can never be read as a pointer. */
function decodeStoredBytes(value: Uint8Array | string): StoredMailBytes {
  return typeof value === 'string'
    ? { kind: 'blob', sha256: value.slice('blob://'.length) }
    : { kind: 'inline', bytes: value };
}

function storedDigest(value: Uint8Array | string): string {
  return typeof value === 'string' ? value.slice('blob://'.length) : sha256Hex(value);
}

function randomFrankId(): string {
  const h = crypto.randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function toThread(row: MailThreadRow): MailThreadRecord {
  return {
    scopeAccount: row.scope_account,
    conversationId: row.conversation_id,
    origin: row.origin,
    createdAtMs: row.created_at,
  };
}

function toMessage(row: MailMessageRow): MailMessageRecord {
  return {
    scopeAccount: row.scope_account,
    rfcMessageId: row.rfc_message_id,
    claimedRfcId: optional(row.claimed_rfc_id),
    contentKey: row.content_key,
    frankMessageId: row.frank_message_id,
    conversationId: row.conversation_id,
    direction: row.direction,
    inReplyTo: optional(row.in_reply_to),
    createdAtMs: row.created_at,
  };
}

function toInboundEmail(row: InboundEmailRow): InboundEmailRecord {
  return {
    scopeAccount: row.scope_account,
    contentKey: row.content_key,
    rfcMessageId: row.rfc_message_id,
    senderEmail: row.sender_email,
    dataSha256: row.data_sha256,
    raw: decodeStoredBytes(row.raw),
    disposition: row.disposition,
    heldMessageId: optional(row.held_message_id),
    createdAtMs: row.created_at,
  };
}

function toSlot(row: FrankSendRow): FrankSendRecord {
  return {
    slotId: row.slot_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    frankMessageId: row.frank_message_id,
    payloadDigest: optional(row.payload_digest),
    scopeAccount: row.scope_account,
    conversationId: row.conversation_id,
    stampValue: row.stamp_value,
    state: row.state,
    lastRefusedAtMs: optional(row.last_refused_at),
    failedCalls: row.failed_calls,
    nextCallAtMs: optional(row.next_call_at),
    holdReason: optional(row.hold_reason),
    createdAtMs: row.created_at,
  };
}

function toFrankInbound(row: FrankInboundRow): FrankInboundRecord {
  return {
    payloadDigest: row.payload_digest,
    scopeAccount: optional(row.scope_account),
    frankMessageId: optional(row.frank_message_id),
    conversationId: optional(row.conversation_id),
    receivedTimeMs: row.received_time,
    stampValueWei: row.stamp_value_wei,
    budgetWei: row.budget_wei,
    spentWei: row.spent_wei,
    disposition: row.disposition,
    reason: optional(row.reason),
  };
}

function toJob(row: OutboundJobRow): OutboundJobRecord {
  return {
    jobId: row.job_id,
    scopeAccount: row.scope_account,
    frankMessageId: row.frank_message_id,
    recipientEmail: row.recipient_email,
    conversationId: row.conversation_id,
    bounceToken: row.bounce_token,
    signedRfc822: decodeStoredBytes(row.signed_rfc822),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at,
    lastError: optional(row.last_error),
    createdAtMs: row.created_at,
  };
}

export class MailJournal {
  readonly chainIdentifier: string;
  readonly gatewayAccount: string;
  readonly gatewayDomain: string;

  private readonly ledger: CreditLedger;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();

  /**
   * Opens the journal on the ledger's SQLite connection, in one transaction.
   *
   * - No journal table present: creates all seven and the marker row.
   * - Journal tables present: the marker row must exist, say format 1 and name
   *   the same chain identifier and gateway account, and all seven tables must
   *   be there. Anything else throws `MailJournalOpenError` and changes nothing.
   * - A ledger with no SQLite connection (Postgres) is refused.
   */
  constructor(ledger: CreditLedger, options: MailJournalOptions) {
    const db = ledger.sqlite;
    if (!db) {
      throw new MailJournalOpenError(
        'The mail journal needs the SQLite ledger. Postgres is not supported for the mail gateway.'
      );
    }
    this.ledger = ledger;
    this.db = db;
    this.now = options.now ?? Date.now;
    this.chainIdentifier = requireMatch('chainIdentifier', options.chainIdentifier, CHAIN_IDENTIFIER);
    this.gatewayAccount = requireMatch('gatewayAccount', options.gatewayAccount, SCOPE_ACCOUNT);
    this.gatewayDomain = requireMatch('gatewayDomain', options.gatewayDomain, DOMAIN);
    const probe = '0'.repeat(64);
    requireRfcId('gatewayDomain (too long for a regenerated Message-ID)', this.contestedIdFor(probe));
    requireRfcId('gatewayDomain (too long for a synthetic Message-ID)', this.noMessageIdFor(probe));

    db.exec('PRAGMA busy_timeout = 5000');
    // Under the exclusive locking mode the write transaction below takes the file
    // lock and the connection keeps it until it is closed.
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      ledger.atomic(() => this.openOrCreate());
    } catch (err) {
      db.exec('PRAGMA locking_mode = NORMAL');
      throw err;
    }
  }

  private openOrCreate(): void {
    const present = this.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${MAIL_JOURNAL_TABLES.map(() => '?').join(', ')})`,
      ...MAIL_JOURNAL_TABLES
    ).map((row) => row.name);

    if (present.length === 0) {
      this.db.exec(MAIL_JOURNAL_DDL);
      this.run(
        'INSERT INTO mail_journal_meta (id, format, chain_identifier, gateway_account) VALUES (1, ?, ?, ?)',
        MAIL_JOURNAL_FORMAT,
        this.chainIdentifier,
        this.gatewayAccount
      );
      return;
    }

    const reset =
      'Nothing was changed. Archive this database together with the gateway wallet stores and start a new one, or run the build that wrote it.';
    const metas = present.includes('mail_journal_meta')
      ? this.all<MailJournalMetaRow>('SELECT * FROM mail_journal_meta')
      : [];
    if (metas.length !== 1) {
      throw new MailJournalOpenError(
        `Mail journal tables exist (${present.join(', ')}) but the format marker is missing. ${reset}`
      );
    }
    const meta = metas[0];
    if (meta.format !== MAIL_JOURNAL_FORMAT) {
      throw new MailJournalOpenError(
        `Mail journal format ${String(meta.format)} is not supported; this build reads format ${MAIL_JOURNAL_FORMAT} only. ${reset}`
      );
    }
    const missing = MAIL_JOURNAL_TABLES.filter((name) => !present.includes(name));
    if (missing.length > 0) {
      throw new MailJournalOpenError(`Mail journal is missing tables (${missing.join(', ')}). ${reset}`);
    }
    if (meta.chain_identifier !== this.chainIdentifier || meta.gateway_account !== this.gatewayAccount) {
      throw new MailJournalOpenError(
        `Mail journal belongs to chain ${meta.chain_identifier} and gateway account ${meta.gateway_account}, ` +
          `not ${this.chainIdentifier} and ${this.gatewayAccount}. ${reset}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Identifiers
  // -------------------------------------------------------------------------

  /** Regenerated local identifier of a contested message. The same on every retry of the same content. */
  contestedIdFor(contentKey: string): string {
    return `<${requireMatch('contentKey', contentKey, HEX_64)}@${CONTESTED_LABEL}.${this.gatewayDomain}>`;
  }

  /** Synthetic identifier of a mail with no usable Message-ID. The same on every retry of the same content. */
  noMessageIdFor(contentKey: string): string {
    return `<${requireMatch('contentKey', contentKey, HEX_64)}@${NO_MESSAGE_ID_LABEL}.${this.gatewayDomain}>`;
  }

  /**
   * True when the ID's right-hand side is one of this gateway's two reserved
   * namespaces (compared without regard to case). Such an ID is never accepted
   * as a claim from outside; the caller treats it as unusable.
   */
  isReservedMessageId(rfcMessageId: string): boolean {
    const rhs = rfcMessageId.slice(rfcMessageId.lastIndexOf('@') + 1, -1).toLowerCase();
    return (
      rhs === `${CONTESTED_LABEL}.${this.gatewayDomain}` ||
      rhs === `${NO_MESSAGE_ID_LABEL}.${this.gatewayDomain}`
    );
  }

  // -------------------------------------------------------------------------
  // Mailbox cursor
  // -------------------------------------------------------------------------

  /** One read. Undefined until a cursor was stored. */
  frankCursor(): { cursorMs?: number; incompleteFloorMs?: number } {
    const meta = this.get<MailJournalMetaRow>('SELECT * FROM mail_journal_meta WHERE id = 1')!;
    return {
      cursorMs: optional(meta.frank_cursor_ms),
      incompleteFloorMs: optional(meta.frank_incomplete_floor_ms),
    };
  }

  /**
   * One statement. Stores the inclusive cursor and the timestamp the last fetch
   * reported incomplete, if any. A cursor past that floor is refused.
   */
  setFrankCursor(cursorMs: number, incompleteFloorMs?: number): void {
    requireTime('cursorMs', cursorMs);
    if (incompleteFloorMs !== undefined) {
      requireTime('incompleteFloorMs', incompleteFloorMs);
      if (cursorMs > incompleteFloorMs) refuse('cursorMs: past the incomplete floor');
    }
    this.ledger.atomic(() => {
      this.run(
        'UPDATE mail_journal_meta SET frank_cursor_ms = ?, frank_incomplete_floor_ms = ? WHERE id = 1',
        cursorMs,
        incompleteFloorMs ?? null
      );
    });
  }

  // -------------------------------------------------------------------------
  // Reads (one statement each)
  // -------------------------------------------------------------------------

  findMailThread(scopeAccount: string, conversationId: string): MailThreadRecord | undefined {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('conversationId', conversationId, FRANK_ID);
    const row = this.get<MailThreadRow>(
      'SELECT * FROM mail_thread WHERE scope_account = ? AND conversation_id = ?',
      scopeAccount,
      conversationId
    );
    return row && toThread(row);
  }

  /**
   * The message known by this identifier in this scope: the holder of a
   * Message-ID, or a contested message by its regenerated identifier. Never
   * returns another scope's row.
   */
  findMailMessage(scopeAccount: string, rfcMessageId: string): MailMessageRecord | undefined {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireRfcId('rfcMessageId', rfcMessageId);
    const row = this.messageRow(scopeAccount, rfcMessageId);
    return row && toMessage(row);
  }

  findInboundEmail(scopeAccount: string, contentKey: string): InboundEmailRecord | undefined {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('contentKey', contentKey, HEX_64);
    const row = this.inboundEmailRow(scopeAccount, contentKey);
    return row && toInboundEmail(row);
  }

  findFrankInbound(payloadDigest: string): FrankInboundRecord | undefined {
    requireMatch('payloadDigest', payloadDigest, HEX_64);
    const row = this.frankInboundRow(payloadDigest);
    return row && toFrankInbound(row);
  }

  findFrankSend(slotId: number): FrankSendRecord | undefined {
    const row = this.get<FrankSendRow>('SELECT * FROM frank_send WHERE slot_id = ?', slotId);
    return row && toSlot(row);
  }

  findOutboundJob(jobId: number): OutboundJobRecord | undefined {
    const row = this.get<OutboundJobRow>('SELECT * FROM outbound_job WHERE job_id = ?', jobId);
    return row && toJob(row);
  }

  /** Slots not yet delivered and not held: the backlog the intake stage bounds. */
  countWaitingFrankSends(): number {
    return this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM frank_send WHERE state IN ('staged', 'sending', 'linked')"
    )!.n;
  }

  /** Conversations a Frank user opened in this scope at or after `sinceMs`: the quota's count. */
  countFrankRootsSince(scopeAccount: string, sinceMs: number): number {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireTime('sinceMs', sinceMs);
    return this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mail_thread WHERE scope_account = ? AND origin = 'frank' AND created_at >= ?",
      scopeAccount,
      sinceMs
    )!.n;
  }

  countOutboundJobs(state: OutboundJobState): number {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbound_job WHERE state = ?', state)!.n;
  }

  /** Pending jobs due at `nowMs`, oldest due first. */
  listDueOutboundJobs(nowMs: number, limit: number): OutboundJobRecord[] {
    requireTime('nowMs', nowMs);
    requireTime('limit', limit);
    return this.all<OutboundJobRow>(
      "SELECT * FROM outbound_job WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, job_id LIMIT ?",
      nowMs,
      limit
    ).map(toJob);
  }

  // -------------------------------------------------------------------------
  // Email → Frank
  // -------------------------------------------------------------------------

  /**
   * Takes durable ownership of an inbound email, keyed by (scope, content key).
   * One transaction; at most one row written.
   *
   * 1. The same (scope, content key) is stored: `duplicate`, nothing written.
   * 2. The scope's own outbound message holds this Message-ID with the same
   *    content key: stored once as `echo`.
   * 3. Eight stored mails already claim this Message-ID in this scope:
   *    `refused`, nothing written. The caller answers before any credit.
   * 4. Otherwise stored as `held`. It owns no thread identity until relayed.
   *
   * A Message-ID in a reserved namespace is refused unless it is exactly
   * `noMessageIdFor(contentKey)`.
   */
  admitInboundEmail(input: AdmitInboundEmailInput): AdmitInboundEmailResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const contentKey = requireMatch('contentKey', input.contentKey, HEX_64);
    const rfcId = requireRfcId('rfcMessageId', input.rfcMessageId);
    if (this.isReservedMessageId(rfcId) && rfcId !== this.noMessageIdFor(contentKey)) {
      refuse('rfcMessageId: it is in a namespace reserved for identifiers this gateway generates');
    }
    const sender = requireAddress('senderEmail', input.senderEmail);
    const dataSha256 = requireMatch('dataSha256', input.dataSha256, HEX_64);
    if (requireStoredBytes('raw', input.raw) !== dataSha256) {
      refuse('raw: the bytes or blob key do not match dataSha256');
    }

    return this.ledger.atomic((): AdmitInboundEmailResult => {
      const stored = this.inboundEmailRow(scope, contentKey);
      if (stored) return { kind: 'duplicate', email: toInboundEmail(stored) };

      const holder = this.messageRow(scope, rfcId);
      const echo = holder?.direction === 'frank_to_email' && holder.content_key === contentKey;
      if (!echo) {
        const claims = this.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM inbound_email WHERE scope_account = ? AND rfc_message_id = ?',
          scope,
          rfcId
        )!.n;
        if (claims >= MAX_INBOUND_CLAIMS_PER_MESSAGE_ID) return { kind: 'refused', reason: 'claim_limit' };
      }

      this.run(
        `INSERT INTO inbound_email
           (scope_account, content_key, rfc_message_id, sender_email, data_sha256, raw, disposition, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        scope,
        contentKey,
        rfcId,
        sender,
        dataSha256,
        encodeStoredBytes(input.raw),
        echo ? 'echo' : 'held',
        this.now()
      );
      const email = toInboundEmail(this.inboundEmailRow(scope, contentKey)!);
      return { kind: echo ? 'echo' : 'admitted', email };
    });
  }

  /**
   * Links an unfunded inbound email to its `held_messages` row. One
   * transaction, one row. A repeat with the same ID writes nothing; a different
   * ID, or a mail that is not `held`, is refused.
   */
  holdInboundEmail(scopeAccount: string, contentKey: string, heldMessageId: string): InboundEmailRecord {
    const scope = requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('contentKey', contentKey, HEX_64);
    if (typeof heldMessageId !== 'string' || heldMessageId.length === 0 || heldMessageId.length > 128) {
      refuse('heldMessageId: empty or too long');
    }
    return this.ledger.atomic(() => {
      const row = this.inboundEmailRow(scope, contentKey);
      if (!row) throw new MailJournalStateError('No inbound email with this scope and content key');
      if (row.held_message_id === heldMessageId) return toInboundEmail(row);
      if (row.disposition !== 'held' || row.held_message_id !== null) {
        throw new MailJournalStateError(
          `Inbound email is ${row.disposition}${row.held_message_id === null ? '' : ' under another held message'}; not changed`
        );
      }
      this.run(
        'UPDATE inbound_email SET held_message_id = ? WHERE scope_account = ? AND content_key = ?',
        heldMessageId,
        scope,
        contentKey
      );
      return toInboundEmail(this.inboundEmailRow(scope, contentKey)!);
    });
  }

  /**
   * Relays an admitted inbound email: funded at intake, or released later. One
   * transaction writing, together or not at all: the send slot (`staged`, with
   * a fresh random Frank message ID), the `mail_message` row, the `mail_thread`
   * row for a new root, and the mail's disposition (`relay`, or `released` if
   * it had been held).
   *
   * - Parent: the message in this scope named by `inReplyTo`; if none, the
   *   first hit scanning `references` from last to first; if none, a new root
   *   whose conversation ID is the slot's message ID.
   * - Holder: if no message holds the mail's Message-ID in this scope, this
   *   one does. Otherwise it is contested and is stored under
   *   `contestedIdFor(contentKey)` with `claimedRfcId`; the holder's row is not
   *   touched, and a contested mail joins the holder's conversation only if its
   *   own headers name it.
   * - Repeat: a mail already relayed returns its stored rows, `created: false`.
   * - An `echo` is never relayed.
   */
  relayInboundEmail(input: RelayInboundEmailInput): RelayInboundEmailResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const contentKey = requireMatch('contentKey', input.contentKey, HEX_64);
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : requireRfcId('inReplyTo', input.inReplyTo);
    const references = (input.references ?? []).map((id, i) => requireRfcId(`references[${i}]`, id));
    const sourceKey = `${scope}:${contentKey}`;

    return this.ledger.atomic((): RelayInboundEmailResult => {
      const email = this.inboundEmailRow(scope, contentKey);
      if (!email) throw new MailJournalStateError('No inbound email with this scope and content key');

      const existing = this.slotBySource('inbound_email', sourceKey);
      if (existing) {
        const message = this.get<MailMessageRow>(
          "SELECT * FROM mail_message WHERE scope_account = ? AND frank_message_id = ? AND direction = 'email_to_frank'",
          scope,
          existing.frank_message_id
        );
        if (!message) throw new MailJournalStateError('Send slot has no mail_message row');
        return {
          created: false,
          contested: message.claimed_rfc_id !== null,
          email: toInboundEmail(email),
          slot: toSlot(existing),
          message: toMessage(message),
        };
      }
      if (email.disposition !== 'held') {
        throw new MailJournalStateError(`Inbound email is ${email.disposition}; it cannot be relayed`);
      }

      const parent = this.resolveParent(scope, inReplyTo, references);
      const frankMessageId = randomFrankId();
      const conversationId = parent?.conversation_id ?? frankMessageId;
      const contested = this.messageRow(scope, email.rfc_message_id) !== undefined;
      const rfcId = contested ? this.contestedIdFor(contentKey) : email.rfc_message_id;
      const now = this.now();

      this.run(
        `INSERT INTO frank_send
           (source_kind, source_key, frank_message_id, scope_account, conversation_id, stamp_value, state, created_at)
         VALUES ('inbound_email', ?, ?, ?, ?, ?, 'staged', ?)`,
        sourceKey,
        frankMessageId,
        scope,
        conversationId,
        stampValue,
        now
      );
      this.insertMessage({
        scope_account: scope,
        rfc_message_id: rfcId,
        claimed_rfc_id: contested ? email.rfc_message_id : null,
        content_key: contentKey,
        frank_message_id: frankMessageId,
        conversation_id: conversationId,
        direction: 'email_to_frank',
        in_reply_to: inReplyTo ?? null,
        created_at: now,
      });
      if (!parent) {
        this.run(
          "INSERT INTO mail_thread (scope_account, conversation_id, origin, created_at) VALUES (?, ?, 'email', ?)",
          scope,
          conversationId,
          now
        );
      }
      this.run(
        'UPDATE inbound_email SET disposition = ? WHERE scope_account = ? AND content_key = ?',
        email.held_message_id === null ? 'relay' : 'released',
        scope,
        contentKey
      );

      return {
        created: true,
        contested,
        email: toInboundEmail(this.inboundEmailRow(scope, contentKey)!),
        slot: toSlot(this.slotBySource('inbound_email', sourceKey)!),
        message: toMessage(this.messageRow(scope, rfcId)!),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Frank → email
  // -------------------------------------------------------------------------

  /**
   * Records one fetched Frank message, keyed by payload digest. One transaction
   * writing, together or not at all: the `frank_inbound` row and, for a bridged
   * message, its `mail_message` row and the `mail_thread` row if the
   * conversation is new in the scope.
   *
   * - The digest is stored: `duplicate`, nothing written.
   * - Bridged, and the scope already has an outbound message with this
   *   Message-ID and this content key (the same email under a new seal):
   *   `same_message`, nothing written.
   * - Bridged, and nothing holds the authored Message-ID: this message holds it.
   * - Bridged, and the authored Message-ID is held by a message with other
   *   content (either direction): stored under `contestedIdFor(contentKey)`
   *   with `claimedRfcId`; the email goes out under that identifier. The
   *   holder's row is not touched.
   * - The message's budget is its stamp. `replyAllowance` debits as many whole
   *   units as the budget covers, at most `wanted`, in this same transaction.
   *
   * An authored Message-ID in a reserved namespace is refused; the caller
   * records such a message as `rejected`.
   */
  recordFrankMessage(input: RecordFrankMessageInput): RecordFrankMessageResult {
    const digest = requireMatch('payloadDigest', input.payloadDigest, HEX_64);
    const receivedTime = requireTime('receivedTimeMs', input.receivedTimeMs);
    const stampValueWei = requireMatch('stampValueWei', input.stampValueWei, DECIMAL);

    if (input.outcome !== 'bridged') {
      const scope =
        input.scopeAccount === undefined
          ? null
          : requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
      let frankMessageId: string | null = null;
      let conversationId: string | null = null;
      let reason: string | null = null;
      if (input.outcome === 'rejected') {
        if (!FRANK_INBOUND_REJECT_REASONS.includes(input.reason)) refuse('reason: not a known rejection reason');
        reason = input.reason;
        if (input.frankMessageId !== undefined) {
          frankMessageId = requireMatch('frankMessageId', input.frankMessageId, FRANK_ID);
        }
        if (input.conversationId !== undefined) {
          conversationId = requireMatch('conversationId', input.conversationId, FRANK_ID);
        }
      }
      return this.ledger.atomic((): RecordFrankMessageResult => {
        const stored = this.frankInboundRow(digest);
        if (stored) return { kind: 'duplicate', inbound: toFrankInbound(stored) };
        this.insertFrankInbound({
          payload_digest: digest,
          scope_account: scope,
          frank_message_id: frankMessageId,
          conversation_id: conversationId,
          received_time: receivedTime,
          stamp_value_wei: stampValueWei,
          budget_wei: stampValueWei,
          spent_wei: '0',
          disposition: input.outcome,
          reason,
        });
        return { kind: input.outcome, inbound: toFrankInbound(this.frankInboundRow(digest)!) };
      });
    }

    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const frankMessageId = requireMatch('frankMessageId', input.frankMessageId, FRANK_ID);
    const conversationId = requireMatch('conversationId', input.conversationId, FRANK_ID);
    const authoredId = requireRfcId('rfcMessageId', input.rfcMessageId);
    if (this.isReservedMessageId(authoredId)) {
      refuse('rfcMessageId: it is in a namespace reserved for identifiers this gateway generates');
    }
    const contentKey = requireMatch('contentKey', input.contentKey, HEX_64);
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : requireRfcId('inReplyTo', input.inReplyTo);
    let unitWei = 0n;
    let wanted = 0;
    if (input.replyAllowance !== undefined) {
      unitWei = BigInt(requireMatch('replyAllowance.unitWei', input.replyAllowance.unitWei, DECIMAL));
      wanted = input.replyAllowance.wanted;
      if (unitWei <= 0n) refuse('replyAllowance.unitWei: must be positive');
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > 3) refuse('replyAllowance.wanted: not 0 to 3');
    }

    return this.ledger.atomic((): RecordFrankMessageResult => {
      const stored = this.frankInboundRow(digest);
      if (stored) return { kind: 'duplicate', inbound: toFrankInbound(stored) };

      const holder = this.messageRow(scope, authoredId);
      if (holder?.direction === 'frank_to_email' && holder.content_key === contentKey) {
        return { kind: 'same_message', message: toMessage(holder) };
      }
      const contested = holder !== undefined;
      const rfcId = contested ? this.contestedIdFor(contentKey) : authoredId;
      if (contested) {
        const earlier = this.messageRow(scope, rfcId);
        if (earlier) return { kind: 'same_message', message: toMessage(earlier) };
      }

      const budget = BigInt(stampValueWei);
      let covered = 0;
      while (covered < wanted && unitWei * BigInt(covered + 1) <= budget) covered++;
      const now = this.now();

      this.insertFrankInbound({
        payload_digest: digest,
        scope_account: scope,
        frank_message_id: frankMessageId,
        conversation_id: conversationId,
        received_time: receivedTime,
        stamp_value_wei: stampValueWei,
        budget_wei: stampValueWei,
        spent_wei: (unitWei * BigInt(covered)).toString(),
        disposition: 'bridged',
        reason: null,
      });
      this.insertMessage({
        scope_account: scope,
        rfc_message_id: rfcId,
        claimed_rfc_id: contested ? authoredId : null,
        content_key: contentKey,
        frank_message_id: frankMessageId,
        conversation_id: conversationId,
        direction: 'frank_to_email',
        in_reply_to: inReplyTo ?? null,
        created_at: now,
      });
      const threadCreated =
        this.run(
          "INSERT OR IGNORE INTO mail_thread (scope_account, conversation_id, origin, created_at) VALUES (?, ?, 'frank', ?)",
          scope,
          conversationId,
          now
        ) === 1;

      return {
        kind: 'bridged',
        inbound: toFrankInbound(this.frankInboundRow(digest)!),
        message: toMessage(this.messageRow(scope, rfcId)!),
        contested,
        threadCreated,
        allowancesCovered: covered,
      };
    });
  }

  /**
   * Adds one recipient's email job for a bridged message, `pending`, with a
   * fresh random bounce token. One transaction, at most one row.
   *
   * The key is (scope, Frank message ID, recipient). A stored job with the same
   * bytes is `existing`. A stored job with other bytes is `key_taken`: it is
   * never overwritten. The scope must have an outbound `mail_message` for this
   * Frank message ID; a job for an unrecorded message is refused.
   */
  addOutboundJob(input: AddOutboundJobInput): AddOutboundJobResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const frankMessageId = requireMatch('frankMessageId', input.frankMessageId, FRANK_ID);
    const conversationId = requireMatch('conversationId', input.conversationId, FRANK_ID);
    const recipient = requireAddress('recipientEmail', input.recipientEmail);
    const digest = requireStoredBytes('signedRfc822', input.signedRfc822);
    const nextAttemptAt = requireTime('nextAttemptAtMs', input.nextAttemptAtMs);

    return this.ledger.atomic((): AddOutboundJobResult => {
      const key = [scope, frankMessageId, recipient] as const;
      const select =
        'SELECT * FROM outbound_job WHERE scope_account = ? AND frank_message_id = ? AND recipient_email = ?';
      const stored = this.get<OutboundJobRow>(select, ...key);
      if (stored) {
        const same = storedDigest(stored.signed_rfc822) === digest;
        return { kind: same ? 'existing' : 'key_taken', job: toJob(stored) };
      }
      const recorded = this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM mail_message WHERE scope_account = ? AND frank_message_id = ? AND direction = 'frank_to_email'",
        scope,
        frankMessageId
      )!.n;
      if (recorded === 0) {
        throw new MailJournalStateError('No bridged message with this scope and Frank message ID');
      }
      this.run(
        `INSERT INTO outbound_job
           (scope_account, frank_message_id, recipient_email, conversation_id, bounce_token, signed_rfc822,
            state, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ...key,
        conversationId,
        crypto.randomBytes(16).toString('hex'),
        encodeStoredBytes(input.signedRfc822),
        nextAttemptAt,
        this.now()
      );
      return { kind: 'created', job: toJob(this.get<OutboundJobRow>(select, ...key)!) };
    });
  }

  /** `pending` → `sent`, counting the attempt. One transaction. Already `sent`: nothing written. */
  markOutboundJobSent(jobId: number): OutboundJobRecord {
    return this.moveJob(jobId, 'sent', ['pending'], (job) =>
      this.run("UPDATE outbound_job SET state = 'sent', attempts = attempts + 1 WHERE job_id = ?", job.job_id)
    );
  }

  /**
   * A temporary failure: stays `pending`, counts the attempt, stores the next
   * time and the error. One transaction. Not repeat-safe by itself: each call
   * is one attempt.
   */
  deferOutboundJob(jobId: number, nextAttemptAtMs: number, error: string): OutboundJobRecord {
    requireTime('nextAttemptAtMs', nextAttemptAtMs);
    return this.ledger.atomic(() => {
      const job = this.jobRow(jobId);
      if (job.state !== 'pending') {
        throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; not changed`);
      }
      this.run(
        'UPDATE outbound_job SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE job_id = ?',
        nextAttemptAtMs,
        String(error),
        jobId
      );
      return toJob(this.jobRow(jobId));
    });
  }

  /** `pending` → `failed`, counting the attempt. One transaction. Already `failed`: nothing written. */
  markOutboundJobFailed(jobId: number, error: string): OutboundJobRecord {
    return this.moveJob(jobId, 'failed', ['pending'], (job) =>
      this.run(
        "UPDATE outbound_job SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE job_id = ?",
        String(error),
        job.job_id
      )
    );
  }

  /**
   * A bounce addressed to this token: `pending` or `sent` → `bounced`. One
   * transaction. An unknown token returns undefined and changes nothing. A job
   * already `bounced` or `failed` is returned unchanged.
   */
  markOutboundJobBounced(bounceToken: string): OutboundJobRecord | undefined {
    if (typeof bounceToken !== 'string' || !HEX_32.test(bounceToken)) return undefined;
    return this.ledger.atomic(() => {
      const job = this.get<OutboundJobRow>('SELECT * FROM outbound_job WHERE bounce_token = ?', bounceToken);
      if (!job) return undefined;
      if (job.state === 'pending' || job.state === 'sent') {
        this.run("UPDATE outbound_job SET state = 'bounced' WHERE job_id = ?", job.job_id);
      }
      return toJob(this.jobRow(job.job_id));
    });
  }

  // -------------------------------------------------------------------------
  // Send slots
  // -------------------------------------------------------------------------

  /**
   * Stages the one notice slot for a failed job or a refused message, paid from
   * the causing message's budget. One transaction writing, together or not at
   * all: the debit on `frank_inbound.spent_wei` and the slot.
   *
   * - A slot for (source kind, source key) exists: `existing`, no debit.
   * - The message's remaining budget is below one unit: `uncovered`, nothing written.
   */
  stageNotice(input: StageNoticeInput): StageNoticeResult {
    if (input.sourceKind !== 'bounce' && input.sourceKind !== 'reject') refuse('sourceKind: not a notice');
    const sourceKey = requireMatch(
      'sourceKey',
      input.sourceKey,
      input.sourceKind === 'bounce' ? /^[1-9][0-9]{0,15}$/ : HEX_64
    );
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const conversationId = requireMatch('conversationId', input.conversationId, FRANK_ID);
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);
    const coverDigest = requireMatch('cover.payloadDigest', input.cover?.payloadDigest, HEX_64);
    const unitWei = BigInt(requireMatch('cover.unitWei', input.cover?.unitWei, DECIMAL));
    if (unitWei <= 0n) refuse('cover.unitWei: must be positive');

    return this.ledger.atomic((): StageNoticeResult => {
      const existing = this.slotBySource(input.sourceKind, sourceKey);
      if (existing) return { kind: 'existing', slot: toSlot(existing) };

      const cause = this.frankInboundRow(coverDigest);
      if (!cause) throw new MailJournalStateError('No recorded Frank message with the covering payload digest');
      const spent = BigInt(cause.spent_wei) + unitWei;
      if (spent > BigInt(cause.budget_wei)) return { kind: 'uncovered' };

      this.run('UPDATE frank_inbound SET spent_wei = ? WHERE payload_digest = ?', spent.toString(), coverDigest);
      this.run(
        `INSERT INTO frank_send
           (source_kind, source_key, frank_message_id, scope_account, conversation_id, stamp_value, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'staged', ?)`,
        input.sourceKind,
        sourceKey,
        randomFrankId(),
        scope,
        conversationId,
        stampValue,
        this.now()
      );
      return { kind: 'created', slot: toSlot(this.slotBySource(input.sourceKind, sourceKey)!) };
    });
  }

  /** `staged` → `sending`, written before the wallet is entered. One transaction. Already `sending`: nothing written. */
  markFrankSendSending(slotId: number): FrankSendRecord {
    return this.moveSlot(slotId, 'sending', ['staged'], () =>
      this.run("UPDATE frank_send SET state = 'sending' WHERE slot_id = ?", slotId)
    );
  }

  /**
   * Gives a `sending` slot its payload digest: → `linked`. One transaction.
   *
   * - The slot already has this digest: nothing written.
   * - Another slot holds this digest: this slot becomes `held` with reason
   *   `digest_conflict`. It is never treated as delivered.
   * - The slot has a different digest, or is not `sending`: refused. A stored
   *   digest is never replaced.
   */
  linkFrankSend(slotId: number, payloadDigest: string): LinkFrankSendResult {
    const digest = requireMatch('payloadDigest', payloadDigest, HEX_64);
    return this.ledger.atomic((): LinkFrankSendResult => {
      const slot = this.slotRow(slotId);
      if (slot.payload_digest === digest) return { kind: 'linked', slot: toSlot(slot) };
      if (slot.state === 'held' && slot.hold_reason === 'digest_conflict') {
        return { kind: 'held', slot: toSlot(slot) };
      }
      if (slot.payload_digest !== null || slot.state !== 'sending') {
        throw new MailJournalStateError(`Send slot ${slotId} is ${slot.state}; its digest was not changed`);
      }
      const other = this.get<FrankSendRow>('SELECT * FROM frank_send WHERE payload_digest = ?', digest);
      if (other) {
        this.run(
          "UPDATE frank_send SET state = 'held', hold_reason = 'digest_conflict' WHERE slot_id = ?",
          slotId
        );
        return { kind: 'held', slot: toSlot(this.slotRow(slotId)) };
      }
      this.run("UPDATE frank_send SET state = 'linked', payload_digest = ? WHERE slot_id = ?", digest, slotId);
      return { kind: 'linked', slot: toSlot(this.slotRow(slotId)) };
    });
  }

  /** `linked` → `delivered`. One transaction. Already `delivered`: nothing written. */
  markFrankSendDelivered(slotId: number): FrankSendRecord {
    return this.moveSlot(slotId, 'delivered', ['linked'], () =>
      this.run("UPDATE frank_send SET state = 'delivered' WHERE slot_id = ?", slotId)
    );
  }

  /**
   * Any undelivered state → `held`, with a reason. One transaction. Already
   * `held`: nothing written and the first reason stands. A delivered slot is refused.
   */
  holdFrankSend(slotId: number, reason: string): FrankSendRecord {
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)) {
      refuse('reason: not a short lowercase label');
    }
    return this.moveSlot(slotId, 'held', ['staged', 'sending', 'linked'], () =>
      this.run("UPDATE frank_send SET state = 'held', hold_reason = ? WHERE slot_id = ?", reason, slotId)
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** 7.1 rule 2: `In-Reply-To` first, then `References` from last to first, within the scope only. */
  private resolveParent(
    scope: string,
    inReplyTo: string | undefined,
    references: readonly string[]
  ): MailMessageRow | undefined {
    if (inReplyTo !== undefined) {
      const row = this.messageRow(scope, inReplyTo);
      if (row) return row;
    }
    for (let i = references.length - 1; i >= 0; i--) {
      const row = this.messageRow(scope, references[i]);
      if (row) return row;
    }
    return undefined;
  }

  private moveJob(
    jobId: number,
    to: OutboundJobState,
    from: readonly OutboundJobState[],
    write: (job: OutboundJobRow) => unknown
  ): OutboundJobRecord {
    return this.ledger.atomic(() => {
      const job = this.jobRow(jobId);
      if (job.state === to) return toJob(job);
      if (!from.includes(job.state)) {
        throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; it cannot become ${to}`);
      }
      write(job);
      return toJob(this.jobRow(jobId));
    });
  }

  private moveSlot(
    slotId: number,
    to: FrankSendRow['state'],
    from: readonly FrankSendRow['state'][],
    write: () => unknown
  ): FrankSendRecord {
    return this.ledger.atomic(() => {
      const slot = this.slotRow(slotId);
      if (slot.state === to) return toSlot(slot);
      if (!from.includes(slot.state)) {
        throw new MailJournalStateError(`Send slot ${slotId} is ${slot.state}; it cannot become ${to}`);
      }
      write();
      return toSlot(this.slotRow(slotId));
    });
  }

  private messageRow(scope: string, rfcMessageId: string): MailMessageRow | undefined {
    return this.get<MailMessageRow>(
      'SELECT * FROM mail_message WHERE scope_account = ? AND rfc_message_id = ?',
      scope,
      rfcMessageId
    );
  }

  private inboundEmailRow(scope: string, contentKey: string): InboundEmailRow | undefined {
    return this.get<InboundEmailRow>(
      'SELECT * FROM inbound_email WHERE scope_account = ? AND content_key = ?',
      scope,
      contentKey
    );
  }

  private frankInboundRow(payloadDigest: string): FrankInboundRow | undefined {
    return this.get<FrankInboundRow>('SELECT * FROM frank_inbound WHERE payload_digest = ?', payloadDigest);
  }

  private slotBySource(kind: string, key: string): FrankSendRow | undefined {
    return this.get<FrankSendRow>(
      'SELECT * FROM frank_send WHERE source_kind = ? AND source_key = ?',
      kind,
      key
    );
  }

  private slotRow(slotId: number): FrankSendRow {
    const row = this.get<FrankSendRow>('SELECT * FROM frank_send WHERE slot_id = ?', slotId);
    if (!row) throw new MailJournalStateError(`No send slot ${String(slotId)}`);
    return row;
  }

  private jobRow(jobId: number): OutboundJobRow {
    const row = this.get<OutboundJobRow>('SELECT * FROM outbound_job WHERE job_id = ?', jobId);
    if (!row) throw new MailJournalStateError(`No outbound job ${String(jobId)}`);
    return row;
  }

  /** The only writer of `mail_message`. A plain INSERT: a taken key throws and the unit rolls back. */
  private insertMessage(row: MailMessageRow): void {
    this.run(
      `INSERT INTO mail_message
         (scope_account, rfc_message_id, claimed_rfc_id, content_key, frank_message_id, conversation_id,
          direction, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.scope_account,
      row.rfc_message_id,
      row.claimed_rfc_id,
      row.content_key,
      row.frank_message_id,
      row.conversation_id,
      row.direction,
      row.in_reply_to,
      row.created_at
    );
  }

  private insertFrankInbound(row: FrankInboundRow): void {
    this.run(
      `INSERT INTO frank_inbound
         (payload_digest, scope_account, frank_message_id, conversation_id, received_time, stamp_value_wei,
          budget_wei, spent_wei, disposition, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.payload_digest,
      row.scope_account,
      row.frank_message_id,
      row.conversation_id,
      row.received_time,
      row.stamp_value_wei,
      row.budget_wei,
      row.spent_wei,
      row.disposition,
      row.reason
    );
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** Returns the number of rows changed. */
  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }
}
