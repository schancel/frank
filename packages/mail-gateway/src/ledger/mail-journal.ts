/**
 * Mail gateway journal (#1237, #1347; format 9 on the content-hash model).
 *
 * The durable owner of: which email threads exist in a Frank account's scope,
 * which messages have been relayed or bridged there (keyed by content hash),
 * every inbound email the gateway accepted and what became of it, the gateway's
 * own send slots, every Frank message it has bridged or refused, and the
 * outbound email jobs.
 *
 * Scope: every lookup and every key is inside one `scopeAccount`, the Frank
 * account on the Frank side of the thread (lowercase `0x` + 40 hex). A thread is
 * identified by (scope, conversation ID) and a message by (scope, mail key).
 * Subject, peer address and recency are never keys.
 *
 * Content-hash model (#1347): an email is identified by its content hash
 * (`mail_key` / `item_key`). Its row in `mail_message` is never updated or
 * replaced; this module has no UPDATE or DELETE on `mail_message`. The RFC
 * `Message-ID` is a non-unique lookup field used only to find a reply's parent;
 * a reply naming a `Message-ID` that several stored emails carry joins the
 * conversation of the earliest one that was actually relayed. The same email
 * arriving twice (same content hash) is a no-op; two different emails with one
 * `Message-ID` are both delivered. There is no ownership of a `Message-ID`, no
 * renaming, no per-Message-ID claim cap, and no eviction.
 *
 * Two keys (contract section 21.2), both opaque 64-hex values computed by the
 * caller. This module stores and compares them and computes neither.
 *
 * - The **mail key** identifies an inbound delivery or an outbound RFC 5322
 *   message. For an issued inbound mailbox, its delivery key binds the canonical
 *   content mail key to the envelope local part, so two aliases never share a
 *   row or send slot. The canonical content key alone decides whether an
 *   arriving mail is the scope's own outbound mail coming back. The delivery
 *   key supplies synthetic identifiers for ID-less inbound mail.
 * - The **item key** identifies what a Frank user authored, whatever seal it
 *   arrived under. It decides whether a Frank message is a re-seal of one
 *   already bridged.
 *
 * A mail key is only ever compared with a mail key (column `mail_key`) and an
 * item key with an item key (column `item_key`). No statement here compares one
 * column with a value of the other kind.
 *
 * Amounts (`stamp_value`, `budget`, `spent`, and the `unit` a caller passes)
 * are decimal text in the smallest unit of the journal chain's native asset.
 *
 * Atomicity: every operation runs through `CreditLedger.atomic()`. Called on
 * its own, an operation is one `BEGIN IMMEDIATE … COMMIT`. Called inside a
 * caller's `ledger.atomic(() => …)`, it joins that unit, so a stage can commit
 * several operations and its credit decision together or not at all. Every
 * operation reads what it decides on inside the transaction and is safe to
 * repeat: a repeat returns the stored row and writes nothing.
 *
 * Time: every time this module stores or compares comes from the injected
 * clock (`options.now`, default `Date.now`), read once per operation inside its
 * transaction, or from a caller parameter.
 *
 * One process: at open the connection takes SQLite's exclusive locking mode and
 * runs one write transaction, so a second process (or connection) on the same
 * file cannot read or write it.
 *
 * Durability is the ledger connection's: SQLite's rollback journal with
 * `synchronous = FULL` (the defaults; the ledger sets no pragma). A committed
 * operation survives power loss; an uncommitted one is absent after reopen.
 */
import * as crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry';
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
import { MailJournalMigrationError, migrateMailJournalFormat8 } from './mail-journal-format8-migration';
import { isOperationalLocalPart } from '../mailbox/operational-local-parts';
import { isValidWkdHash, wkdHashLocalPart } from '../wkd/wkd';
import type {
  FrankInboundRow,
  FrankSendRow,
  InboundEmailRow,
  MailJournalMetaRow,
  MailMessageRow,
  MailThreadRow,
  OutboundJobRow,
} from './schema';

/**
 * The journal's on-disk format. SQLite only: Postgres is not supported for
 * these tables. They are created by `MailJournal` on its first open, in one
 * transaction with the `mail_journal_meta` row; they are not part of
 * `ensureLedgerSchemaSync` and not part of the Kysely migration.
 *
 * One migration exists, by owner decision for the production volume: a format-8
 * journal is backed up and migrated in place to format 9 at open
 * (`mail-journal-format8-migration.ts`). There is no migration and no reader for
 * any other format, formats 1, 2 and 7 included. A database whose marker is
 * missing or is not `MAIL_JOURNAL_FORMAT` (after that migration) is refused at
 * open and left as it is; the development reset is to archive the SQLite file
 * together with the gateway wallet's stores (they are one unit for backup) and
 * start a new one.
 *
 * Identifier comparison is byte-exact: every key column is TEXT under SQLite's
 * default BINARY collation.
 */
export const MAIL_JOURNAL_FORMAT = 9;

export const MAIL_JOURNAL_TABLES = [
  'mail_journal_meta',
  'mail_thread',
  'issued_mailbox',
  'mail_message',
  'inbound_email',
  'frank_send',
  'frank_inbound',
  'outbound_job',
] as const;

const MAIL_JOURNAL_DDL = `
  CREATE TABLE mail_journal_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    format INTEGER NOT NULL,
    chain_identifier TEXT NOT NULL,
    gateway_account TEXT NOT NULL,
    gateway_domain TEXT NOT NULL,
    frank_cursor_ms INTEGER,
    frank_incomplete_floor_ms INTEGER
  );

  CREATE TABLE mail_thread (
    scope_account TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('email', 'frank')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, conversation_id)
  );

  CREATE TABLE issued_mailbox (
    local_part TEXT PRIMARY KEY,
    scope_account TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (local_part = lower(local_part))
  );
  CREATE INDEX idx_issued_mailbox_owner ON issued_mailbox(scope_account, conversation_id);

  CREATE TABLE mail_message (
    scope_account TEXT NOT NULL,
    mail_key TEXT NOT NULL,
    item_key TEXT,
    rfc_message_id TEXT NOT NULL,
    payload_digest TEXT,
    frank_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('email_to_frank', 'frank_to_email')),
    in_reply_to TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, mail_key),
    CHECK ((direction = 'frank_to_email') = (item_key IS NOT NULL)),
    CHECK ((direction = 'frank_to_email') = (payload_digest IS NOT NULL))
  );
  CREATE INDEX idx_mail_message_rfc ON mail_message(scope_account, rfc_message_id, created_at);
  CREATE INDEX idx_mail_message_frank ON mail_message(scope_account, frank_message_id);
  CREATE UNIQUE INDEX idx_mail_message_item_key ON mail_message(scope_account, item_key)
    WHERE item_key IS NOT NULL;
  CREATE UNIQUE INDEX idx_mail_message_digest ON mail_message(payload_digest)
    WHERE payload_digest IS NOT NULL;

  CREATE TABLE inbound_email (
    scope_account TEXT NOT NULL,
    mail_key TEXT NOT NULL,
    mailbox_local_part TEXT,
    conversation_id TEXT,
    stamp_value TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    data_sha256 TEXT NOT NULL,
    raw BLOB,
    disposition TEXT NOT NULL CHECK (disposition IN ('relay', 'held', 'released', 'echo', 'expired')),
    held_message_id TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, mail_key),
    CHECK (disposition <> 'held' OR expires_at IS NOT NULL),
    CHECK (raw IS NOT NULL OR disposition = 'expired')
  );
  CREATE INDEX idx_inbound_email_expiry ON inbound_email(expires_at) WHERE disposition = 'held';
  CREATE UNIQUE INDEX idx_inbound_email_held ON inbound_email(held_message_id)
    WHERE held_message_id IS NOT NULL;

  CREATE TABLE frank_send (
    slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('inbound_email', 'bounce', 'reject')),
    source_key TEXT NOT NULL,
    frank_message_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT UNIQUE,
    scope_account TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    stamp_value TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'sending', 'linked', 'delivered', 'held')),
    last_refused_at INTEGER,
    failed_calls INTEGER NOT NULL DEFAULT 0,
    next_call_at INTEGER,
    hold_reason TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (source_kind, source_key)
  );

  CREATE TABLE frank_inbound (
    payload_digest TEXT PRIMARY KEY,
    scope_account TEXT,
    frank_message_id TEXT,
    conversation_id TEXT,
    received_time INTEGER NOT NULL,
    stamp_value TEXT NOT NULL,
    budget TEXT NOT NULL,
    spent TEXT NOT NULL DEFAULT '0',
    disposition TEXT NOT NULL CHECK (disposition IN ('bridged', 'rejected', 'quarantined', 'resealed')),
    reason TEXT
  );
  CREATE INDEX idx_frank_inbound_message ON frank_inbound(scope_account, frank_message_id);

  CREATE TABLE outbound_job (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_account TEXT NOT NULL,
    mail_key TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    sender_local_part TEXT NOT NULL,
    bounce_token TEXT NOT NULL UNIQUE,
    signed_rfc822 BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'submitting', 'uncertain', 'sent', 'failed', 'bounced')),
    attempts INTEGER NOT NULL DEFAULT 0,
    submission_started_at INTEGER,
    provider_email_id TEXT UNIQUE,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (scope_account, mail_key, recipient_email),
    FOREIGN KEY (scope_account, mail_key) REFERENCES mail_message(scope_account, mail_key),
    FOREIGN KEY (sender_local_part) REFERENCES issued_mailbox(local_part)
  );
  CREATE INDEX idx_outbound_job_due ON outbound_job(state, next_attempt_at);
`;

/** How long an admitted mail may stay `held`, unpaid, before it can be expired: 72 hours. */
export const INBOUND_HOLD_TTL_MS = 72 * 60 * 60 * 1000;

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
  /** Clock for every time the journal stores or compares (`created_at`, `expires_at`). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface AdmitInboundEmailInput {
  readonly scopeAccount: string;
  /** Mail key of the DATA bytes. It is the row key: the same key is the same mail. */
  readonly mailKey: string;
  /** Exact stamp intended when this delivery is accepted; retained while held. */
  readonly stampValue: string;
  /** Envelope recipient for an issued mailbox. Part of the caller's delivery key. */
  readonly mailboxLocalPart?: string;
  /** Immutable conversation assignment of the issued mailbox, including while held. */
  readonly conversationId?: string;
  /** Canonical RFC-content key for echo detection when mailKey includes an envelope recipient. */
  readonly echoMailKey?: string;
  /**
   * The sole valid ID of the `Message-ID` header; undefined when absent or `bad_message_id`.
   * The journal derives the stored identifier: this value, or `noMessageIdFor(mailKey)` when
   * it is undefined or lies in a namespace reserved for identifiers this gateway generates.
   */
  readonly messageIdHeader?: string;
  /** The credit principal: the single `From` address, lowercased. */
  readonly senderEmail: string;
  /** SHA-256 of the DATA bytes, lowercase hex. */
  readonly dataSha256: string;
  /** Inline bytes must hash to `dataSha256`; a blob must be stored under `dataSha256`. */
  readonly raw: StoredMailBytes;
}

export type AdmitInboundEmailResult =
  /**
   * The mail is now durably owned, disposition `held` until it is relayed. `revived` is true
   * when this mail had been admitted before and expired unpaid: it is a new arrival, written
   * again over its expired row.
   */
  | {
      readonly kind: 'admitted';
      readonly email: InboundEmailRecord;
      readonly revived: boolean;
    }
  /** This exact mail is stored and has not expired. Its row was not written. */
  | { readonly kind: 'duplicate'; readonly email: InboundEmailRecord }
  /** The scope's own outbound mail coming back unchanged. Stored once as `echo`; never relayed. */
  | { readonly kind: 'echo'; readonly email: InboundEmailRecord; readonly revived: boolean };

export interface RelayInboundEmailInput {
  readonly scopeAccount: string;
  readonly mailKey: string;
  /** Explicitly issued mailbox conversation. It overrides unrelated RFC reply headers. */
  readonly conversationId?: string;
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
  readonly email: InboundEmailRecord;
  readonly slot: FrankSendRecord;
  readonly message: MailMessageRecord;
}

interface FrankMessageBase {
  readonly payloadDigest: string;
  readonly receivedTimeMs: number;
  /** The stamp the message carried, as decimal text. It is the message's whole budget. */
  readonly stampValue: string;
}

export type RecordFrankMessageInput =
  | (FrankMessageBase & {
      readonly outcome: 'bridged';
      readonly scopeAccount: string;
      readonly frankMessageId: string;
      readonly conversationId: string;
      /** The Message-ID the author chose for the email. */
      readonly rfcMessageId: string;
      /** Item key of the decoded email item. */
      readonly itemKey: string;
      /** Mail key of the rendered RFC 5322 email bytes. */
      readonly mailKey: string;
      readonly inReplyTo?: string;
      /** Reply allowances to cover from the budget: `wanted` units of `unit` each, as many as the stamp covers. */
      readonly replyAllowance?: { readonly unit: string; readonly wanted: number };
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
      /** True when this message opened the conversation in this scope. */
      readonly threadCreated: boolean;
      /** Reply allowances the stamp covered; already debited. */
      readonly allowancesCovered: number;
    }
  | { readonly kind: 'rejected' | 'quarantined'; readonly inbound: FrankInboundRecord }
  /** This payload digest was recorded before. Nothing was written; grant nothing again. */
  | { readonly kind: 'duplicate'; readonly inbound: FrankInboundRecord }
  /**
   * The same authored email under a new seal. `inbound` is this seal's row, written `resealed`
   * with nothing spent; `message` is the first message's. No second email, job or allowance.
   */
  | { readonly kind: 'same_message'; readonly inbound: FrankInboundRecord; readonly message: MailMessageRecord };

export interface AddOutboundJobInput {
  readonly scopeAccount: string;
  /** `message.mailKey` from this unit's `bridged` result: the key of its `mail_message` row. */
  readonly mailKey: string;
  readonly recipientEmail: string;
  /** Issued alias for this exact scoped conversation; replies return through it. */
  readonly senderLocalPart: string;
  readonly signedRfc822: StoredMailBytes;
  readonly nextAttemptAtMs: number;
}

export type AddOutboundJobResult =
  | { readonly kind: 'created' | 'existing'; readonly job: OutboundJobRecord }
  /** A job with this key holds different bytes. It was left as it is and nothing was written. */
  | { readonly kind: 'key_taken'; readonly job: OutboundJobRecord };

/**
 * A notice names only what failed. Its scope, its conversation and the message whose stamp
 * pays for it are read from stored rows. `stampValue` is the value the notice is sent with
 * and `unit` the price debited for it; the journal does not compare the two.
 */
export type StageNoticeInput =
  | { readonly sourceKind: 'bounce'; readonly jobId: number; readonly stampValue: string; readonly unit: string }
  | { readonly sourceKind: 'reject'; readonly payloadDigest: string; readonly stampValue: string; readonly unit: string };

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
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Printable ASCII with one or more `@`, no space; the recipient grammar itself is the ingest stage's.
const ADDRESS = /^[\x21-\x7e]+@[\x21-\x7e]+$/;
const MAILBOX_LOCAL_PART = /^[a-z0-9][a-z0-9_-]{2,31}$/;

const NO_MESSAGE_ID_LABEL = 'no-message-id';

function refuse(what: string): never {
  throw new MailJournalArgumentError(`Mail journal refused ${what}`);
}

function requireMatch(label: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) refuse(`${label}: not in the required form`);
  return value as string;
}

function requireMailboxLocalPart(value: unknown): string {
  if (typeof value !== 'string') refuse('mailbox local part: not a string');
  const canonical = (value as string).trim().toLowerCase();
  if (!MAILBOX_LOCAL_PART.test(canonical) || isOperationalLocalPart(canonical)) {
    refuse('mailbox local part: invalid or reserved');
  }
  return canonical;
}

function requireHeldMessageId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    refuse('heldMessageId: empty or too long');
  }
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
    mailKey: row.mail_key,
    itemKey: optional(row.item_key),
    rfcMessageId: row.rfc_message_id,
    payloadDigest: optional(row.payload_digest),
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
    mailKey: row.mail_key,
    mailboxLocalPart: optional(row.mailbox_local_part),
    conversationId: optional(row.conversation_id),
    stampValue: row.stamp_value,
    rfcMessageId: row.rfc_message_id,
    senderEmail: row.sender_email,
    dataSha256: row.data_sha256,
    raw: row.raw === null ? undefined : decodeStoredBytes(row.raw),
    disposition: row.disposition,
    heldMessageId: optional(row.held_message_id),
    expiresAtMs: optional(row.expires_at),
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
    stampValue: row.stamp_value,
    budget: row.budget,
    spent: row.spent,
    disposition: row.disposition,
    reason: optional(row.reason),
  };
}

/** A job row with the facts its `mail_message` row owns. */
type OutboundJobJoinedRow = OutboundJobRow & {
  rfc_message_id: string;
  frank_message_id: string;
  conversation_id: string;
  payload_digest: string;
};

const JOB_SELECT = `
  SELECT j.*, m.rfc_message_id, m.frank_message_id, m.conversation_id, m.payload_digest
    FROM outbound_job j
    JOIN mail_message m ON m.scope_account = j.scope_account AND m.mail_key = j.mail_key`;

function toJob(row: OutboundJobJoinedRow): OutboundJobRecord {
  return {
    jobId: row.job_id,
    scopeAccount: row.scope_account,
    mailKey: row.mail_key,
    rfcMessageId: row.rfc_message_id,
    recipientEmail: row.recipient_email,
    senderLocalPart: row.sender_local_part,
    frankMessageId: row.frank_message_id,
    conversationId: row.conversation_id,
    payloadDigest: row.payload_digest,
    bounceToken: row.bounce_token,
    signedRfc822: decodeStoredBytes(row.signed_rfc822),
    state: row.state,
    attempts: row.attempts,
    submissionStartedAtMs: optional(row.submission_started_at),
    providerEmailId: optional(row.provider_email_id),
    nextAttemptAtMs: row.next_attempt_at,
    lastError: optional(row.last_error),
    createdAtMs: row.created_at,
  };
}

export class MailJournal {
  readonly chainIdentifier: string;
  readonly gatewayAccount: string;
  readonly gatewayDomain: string;
  /** Set when this open migrated a format-8 journal: where the pre-migration copy is, and the rows carried over. */
  readonly format8Migration?: { readonly backupPath: string; readonly rows: Readonly<Record<string, number>> };

  private readonly ledger: CreditLedger;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();

  /** A credit decision and journal transition are atomic only on this exact connection. */
  assertCreditLedger(ledger: CreditLedger): void {
    if (ledger !== this.ledger) {
      throw new MailJournalStateError('Mail journal and credit ledger use different connections');
    }
  }

  /**
   * Opens the journal on the ledger's SQLite connection, in one transaction.
   *
   * - `chainIdentifier` must be an `id` of the protocol chain registry, exactly:
   *   an alias, another spelling or an inherited property name is refused
   *   before any pragma or statement, because the first open stores it for good.
   * - No journal table present: creates all eight and the marker row.
   * - A format-8 journal of this chain, account and domain: backed up next to the file and
   *   migrated to format 9 in one transaction first (`migrateMailJournalFormat8`); a
   *   refused or failed migration throws `MailJournalOpenError` and leaves the file as it was.
   * - Journal tables present: the marker row must exist, say `MAIL_JOURNAL_FORMAT` and name
   *   the same chain identifier, gateway account and domain, and all eight tables must
   *   be there. Anything else throws `MailJournalOpenError` and changes nothing.
   * - A ledger with no SQLite connection (Postgres) is refused.
   * - A refused open leaves the connection as it found it: the busy timeout and
   *   locking mode it read are restored and the file lock it took is released.
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
    // An own-property test on the registry itself. Not `getChainRegistryEntry`: it resolves
    // aliases, and an alias must never be stored. Not a plain index: `constructor` would pass.
    const chainIdentifier: unknown = options.chainIdentifier;
    if (typeof chainIdentifier !== 'string' || !Object.hasOwn(PROTOCOL_CHAINS, chainIdentifier)) {
      refuse('chainIdentifier: not a canonical network identifier of the protocol chain registry');
    }
    this.chainIdentifier = chainIdentifier as string;
    this.gatewayAccount = requireMatch('gatewayAccount', options.gatewayAccount, SCOPE_ACCOUNT);
    this.gatewayDomain = requireMatch('gatewayDomain', options.gatewayDomain, DOMAIN);
    const probe = '0'.repeat(64);
    requireRfcId('gatewayDomain (too long for a synthetic Message-ID)', this.noMessageIdFor(probe));

    const pragma = (name: string): string | number =>
      Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, string | number>)[0];
    const busyTimeoutBefore = Number(pragma('busy_timeout'));
    const lockingModeBefore = String(pragma('locking_mode'));

    db.exec('PRAGMA busy_timeout = 5000');
    // Under the exclusive locking mode the write transaction below takes the file
    // lock and the connection keeps it until it is closed.
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      let migration;
      try {
        migration = migrateMailJournalFormat8(db, {
          format9Ddl: MAIL_JOURNAL_DDL,
          tables: MAIL_JOURNAL_TABLES,
          chainIdentifier: this.chainIdentifier,
          gatewayAccount: this.gatewayAccount,
          gatewayDomain: this.gatewayDomain,
          now: this.now,
        });
      } catch (err) {
        if (err instanceof MailJournalMigrationError) throw new MailJournalOpenError(err.message);
        throw err;
      }
      if (migration.migrated) this.format8Migration = { backupPath: migration.backupPath, rows: migration.rows };
      ledger.atomic(() => this.openOrCreate());
    } catch (err) {
      try {
        db.exec(`PRAGMA busy_timeout = ${busyTimeoutBefore}`);
        if (lockingModeBefore !== 'exclusive') {
          db.exec('PRAGMA locking_mode = NORMAL');
          // Leaving the exclusive mode releases nothing until the file is next accessed, so
          // without this read the connection would keep the write lock it took above.
          db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
        }
      } catch {
        // The refusal is the error the caller needs.
      }
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
        'INSERT INTO mail_journal_meta (id, format, chain_identifier, gateway_account, gateway_domain) VALUES (1, ?, ?, ?, ?)',
        MAIL_JOURNAL_FORMAT,
        this.chainIdentifier,
        this.gatewayAccount,
        this.gatewayDomain
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
    if (meta.chain_identifier !== this.chainIdentifier || meta.gateway_account !== this.gatewayAccount ||
      meta.gateway_domain !== this.gatewayDomain) {
      throw new MailJournalOpenError(
        `Mail journal belongs to chain ${meta.chain_identifier}, gateway account ${meta.gateway_account}, ` +
          `and domain ${meta.gateway_domain}; not ${this.chainIdentifier}, ${this.gatewayAccount}, ` +
          `and ${this.gatewayDomain}. ${reset}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Identifiers
  // -------------------------------------------------------------------------

  /** Synthetic identifier of a mail with no usable Message-ID. The same on every retry of the same mail. */
  noMessageIdFor(mailKey: string): string {
    return `<${requireMatch('mailKey', mailKey, HEX_64)}@${NO_MESSAGE_ID_LABEL}.${this.gatewayDomain}>`;
  }

  /**
   * True when the ID's right-hand side is this gateway's reserved synthetic
   * namespace (compared without regard to case). Such an ID is never accepted
   * as a claim from outside; the caller treats it as unusable.
   */
  isReservedMessageId(rfcMessageId: string): boolean {
    const rhs = rfcMessageId.slice(rfcMessageId.lastIndexOf('@') + 1, -1).toLowerCase();
    return rhs === `${NO_MESSAGE_ID_LABEL}.${this.gatewayDomain}`;
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

  /** Only rows explicitly issued by this journal can resolve inbound SMTP recipients. */
  issuedMailbox(localPart: string): { scopeAccount: string; conversationId?: string } | undefined {
    const canonical = requireMailboxLocalPart(localPart);
    const row = this.get<{ scope_account: string; conversation_id: string | null }>(
      'SELECT scope_account, conversation_id FROM issued_mailbox WHERE local_part = ?',
      canonical
    );
    return row && {
      scopeAccount: row.scope_account,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    };
  }

  /**
   * Resolves an issued mailbox by its 32-character z-base-32 WKD hash (`<hu>`),
   * enabling WKD lookups even when the client omits the `?l=<localPart>` query string.
   */
  issuedMailboxByWkdHash(
    hu: string,
  ): { localPart: string; scopeAccount: string; conversationId?: string } | undefined {
    const normalizedHu = typeof hu === 'string' ? hu.trim().toLowerCase() : '';
    if (!isValidWkdHash(normalizedHu)) return undefined;
    const rows = this.all<{ local_part: string; scope_account: string; conversation_id: string | null }>(
      'SELECT local_part, scope_account, conversation_id FROM issued_mailbox ORDER BY created_at ASC, local_part ASC',
    );
    for (const row of rows) {
      if (wkdHashLocalPart(row.local_part) === normalizedHu) {
        return {
          localPart: row.local_part,
          scopeAccount: row.scope_account,
          ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        };
      }
      if (wkdHashLocalPart(row.scope_account) === normalizedHu) {
        return {
          localPart: row.scope_account,
          scopeAccount: row.scope_account,
        };
      }
      if (wkdHashLocalPart(`u.${row.scope_account}`) === normalizedHu) {
        return {
          localPart: `u.${row.scope_account}`,
          scopeAccount: row.scope_account,
        };
      }
    }
    return undefined;
  }

  /** Explicit, immutable issuance. Repeating the same assignment is safe; changing its owner is refused. */
  issueMailbox(input: { localPart: string; scopeAccount: string; conversationId?: string }): void {
    const localPart = requireMailboxLocalPart(input.localPart);
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const conversation = input.conversationId === undefined
      ? null
      : requireMatch('conversationId', input.conversationId, FRANK_ID);
    this.ledger.atomic(() => {
      const existing = this.get<{ scope_account: string; conversation_id: string | null }>(
        'SELECT scope_account, conversation_id FROM issued_mailbox WHERE local_part = ?',
        localPart
      );
      if (existing) {
        if (existing.scope_account !== scope || existing.conversation_id !== conversation) {
          throw new MailJournalStateError('Mailbox local part is already issued to another owner or conversation');
        }
        return;
      }
      this.run(
        'INSERT INTO issued_mailbox (local_part, scope_account, conversation_id, created_at) VALUES (?, ?, ?, ?)',
        localPart, scope, conversation, this.now()
      );
    });
  }

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
   * Resolves the conversation ID for an inbound reply within `scopeAccount` by matching
   * `In-Reply-To` first, then `References` from last to first against `mail_message`
   * (`rfc_message_id`, `frank_message_id`, or `frank.<conversationId>.<frankMessageId>`).
   */
  findConversationByThreadHeaders(input: {
    readonly scopeAccount: string;
    readonly inReplyTo?: string;
    readonly references?: readonly string[];
  }): string | undefined {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : parseMessageId(input.inReplyTo.trim());
    const references = (input.references ?? [])
      .map((id) => (typeof id === 'string' ? parseMessageId(id.trim()) : undefined))
      .filter((id): id is string => id !== undefined);
    const parent = this.resolveParent(scope, inReplyTo, references);
    return parent?.conversation_id;
  }

  /**
   * The message stored under this mail key in this scope. Never returns another scope's row.
   */
  findMailMessage(scopeAccount: string, mailKey: string): MailMessageRecord | undefined {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('mailKey', mailKey, HEX_64);
    const row = this.messageRow(scopeAccount, mailKey);
    return row && toMessage(row);
  }

  findInboundEmail(scopeAccount: string, mailKey: string): InboundEmailRecord | undefined {
    requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('mailKey', mailKey, HEX_64);
    const row = this.inboundEmailRow(scopeAccount, mailKey);
    return row && toInboundEmail(row);
  }

  /**
   * The inbound email linked to this `held_messages` row, in whatever state it
   * is now: a purchase reads it to learn whether the mail is still `held`
   * (release it) or `expired` (add the credits, release nothing). One read.
   */
  findInboundEmailByHeldMessage(heldMessageId: string): InboundEmailRecord | undefined {
    requireHeldMessageId(heldMessageId);
    const row = this.get<InboundEmailRow>('SELECT * FROM inbound_email WHERE held_message_id = ?', heldMessageId);
    return row && toInboundEmail(row);
  }

  /**
   * Resolves an inbound email by its 64-hex `mail_key` or `held_message_id` for the `/pay/:mailKey`
   * payment portal and `/onboard/claim/:claimToken` endpoint.
   */
  findInboundEmailByKey(mailKeyOrHeldId: string): InboundEmailRecord | undefined {
    const trimmed = typeof mailKeyOrHeldId === 'string' ? mailKeyOrHeldId.trim() : '';
    if (!trimmed) return undefined;
    if (HEX_64.test(trimmed.toLowerCase())) {
      const byKey = this.get<InboundEmailRow>(
        'SELECT * FROM inbound_email WHERE mail_key = ? ORDER BY created_at DESC LIMIT 1',
        trimmed.toLowerCase(),
      );
      if (byKey) return toInboundEmail(byKey);
    }
    const byHeld = this.get<InboundEmailRow>(
      'SELECT * FROM inbound_email WHERE held_message_id = ? LIMIT 1',
      trimmed,
    );
    return byHeld && toInboundEmail(byHeld);
  }

  /** Bounded, stable page for a host to revisit authenticated mail after credit arrives. */
  listHeldInboundEmails(limit = 100, after?: { scopeAccount: string; mailKey: string }): InboundEmailRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) refuse('limit: not an integer from 1 to 1000');
    const scope = after === undefined ? '' : requireMatch('after.scopeAccount', after.scopeAccount, SCOPE_ACCOUNT);
    const key = after === undefined ? '' : requireMatch('after.mailKey', after.mailKey, HEX_64);
    return this.all<InboundEmailRow>(
      `SELECT * FROM inbound_email WHERE disposition = 'held' AND expires_at > ?
         AND (scope_account > ? OR (scope_account = ? AND mail_key > ?))
       ORDER BY scope_account, mail_key LIMIT ?`,
      this.now(), scope, scope, key, limit
    ).map(toInboundEmail);
  }

  /** One atomic credit debit and original-slot creation for a previously held mail. */
  releaseHeldInboundEmail(input: Omit<RelayInboundEmailInput, 'stampValue'>): RelayInboundEmailResult | undefined {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const key = requireMatch('mailKey', input.mailKey, HEX_64);
    return this.ledger.atomic(() => {
      const row = this.inboundEmailRow(scope, key);
      if (!row || row.disposition !== 'held') return undefined;
      if (row.expires_at === null || row.expires_at <= this.now()) {
        this.expireHeldRow(row);
        return undefined;
      }
      if (!this.ledger.consumeCredit(row.sender_email, scope)) return undefined;
      return this.relayInboundEmail({ ...input, stampValue: row.stamp_value });
    });
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
    const row = this.get<OutboundJobJoinedRow>(`${JOB_SELECT} WHERE j.job_id = ?`, jobId);
    return row && toJob(row);
  }

  /** Slots not yet delivered and not held: the backlog the intake stage bounds. */
  countWaitingFrankSends(): number {
    return this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM frank_send WHERE state IN ('staged', 'sending', 'linked')"
    )!.n;
  }

  /** Pending send slots in stable order for a host recovery pass. Never mutates them. */
  listUnfinishedFrankSends(limit = 100, afterSlotId = 0): FrankSendRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      refuse('limit: not an integer from 1 to 1000');
    }
    if (!Number.isSafeInteger(afterSlotId) || afterSlotId < 0) {
      refuse('afterSlotId: not a non-negative integer');
    }
    return this.all<FrankSendRow>(
      "SELECT * FROM frank_send WHERE state IN ('staged', 'sending', 'linked') AND slot_id > ? ORDER BY slot_id LIMIT ?",
      afterSlotId,
      limit
    ).map(toSlot);
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
    return this.all<OutboundJobJoinedRow>(
      `${JOB_SELECT} WHERE j.state = 'pending' AND j.next_attempt_at <= ? ORDER BY j.next_attempt_at, j.job_id LIMIT ?`,
      nowMs,
      limit
    ).map(toJob);
  }

  // -------------------------------------------------------------------------
  // Email → Frank
  // -------------------------------------------------------------------------

  /**
   * Takes durable ownership of an inbound email, keyed by (scope, mail key).
   * One transaction.
   *
   * The stored identifier is `messageIdHeader`, or `noMessageIdFor(mailKey)`
   * when the header is absent or names this gateway's reserved synthetic
   * namespace.
   *
   * In this order:
   *
   * 1. If the same (scope, mail key) is stored as `held` and its expiry has
   *    passed, it is expired now.
   * 2. The same (scope, mail key) is stored and not expired: `duplicate`.
   * 3. The scope has an outbound message with this mail key: the scope's own
   *    mail coming back, stored once as `echo`. The Message-ID it bears is not
   *    consulted.
   * 4. Otherwise stored as `held` for `INBOUND_HOLD_TTL_MS`. It owns no thread
   *    identity until relayed. A mail that had expired is written again over
   *    its own row (`revived`): it was never relayed or paid for, so it is a
   *    new arrival, with the new sender, bytes and expiry, no held-message
   *    link, and its original `created_at`.
   */
  admitInboundEmail(input: AdmitInboundEmailInput): AdmitInboundEmailResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const mailKey = requireMatch('mailKey', input.mailKey, HEX_64);
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);
    const mailboxLocalPart = input.mailboxLocalPart === undefined ? null
      : requireMatch('mailboxLocalPart', input.mailboxLocalPart, /^(?:[a-z0-9][a-z0-9_-]{2,31}|(?:u\.)?0x[0-9a-f]{40})$/);
    const conversationId = input.conversationId === undefined ? null
      : requireMatch('conversationId', input.conversationId, FRANK_ID);
    const echoMailKey = input.echoMailKey === undefined ? mailKey
      : requireMatch('echoMailKey', input.echoMailKey, HEX_64);
    const header =
      input.messageIdHeader === undefined ? undefined : requireRfcId('messageIdHeader', input.messageIdHeader);
    const rfcId =
      header === undefined || this.isReservedMessageId(header) ? this.noMessageIdFor(mailKey) : header;
    const sender = requireAddress('senderEmail', input.senderEmail);
    const dataSha256 = requireMatch('dataSha256', input.dataSha256, HEX_64);
    if (requireStoredBytes('raw', input.raw) !== dataSha256) {
      refuse('raw: the bytes or blob key do not match dataSha256');
    }

    return this.ledger.atomic((): AdmitInboundEmailResult => {
      const now = this.now();
      let stored = this.inboundEmailRow(scope, mailKey);
      if (stored && stored.disposition === 'held' && stored.expires_at !== null && stored.expires_at <= now) {
        this.expireHeldRow(stored);
        stored = this.inboundEmailRow(scope, mailKey);
      }

      if (stored && (stored.mailbox_local_part !== mailboxLocalPart || stored.conversation_id !== conversationId))
        throw new MailJournalStateError('Inbound delivery key has a different mailbox assignment');
      if (stored && stored.disposition !== 'expired') return { kind: 'duplicate', email: toInboundEmail(stored) };

      // Mail key against mail key. An outbound row's item key is never consulted here.
      const echo =
        this.get<{ n: number }>(
          "SELECT 1 AS n FROM mail_message WHERE scope_account = ? AND mail_key = ? AND direction = 'frank_to_email' LIMIT 1",
          scope,
          echoMailKey
        ) !== undefined;

      const disposition = echo ? 'echo' : 'held';
      const expiresAt = echo ? null : now + INBOUND_HOLD_TTL_MS;
      if (stored) {
        this.run(
          `UPDATE inbound_email
              SET rfc_message_id = ?, stamp_value = ?, sender_email = ?, data_sha256 = ?, raw = ?, disposition = ?,
                  held_message_id = NULL, expires_at = ?
            WHERE scope_account = ? AND mail_key = ? AND disposition = 'expired'`,
          rfcId,
          stampValue,
          sender,
          dataSha256,
          encodeStoredBytes(input.raw),
          disposition,
          expiresAt,
          scope,
          mailKey
        );
      } else {
        this.run(
          `INSERT INTO inbound_email
             (scope_account, mail_key, mailbox_local_part, conversation_id, stamp_value, rfc_message_id, sender_email, data_sha256, raw, disposition, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          scope,
          mailKey,
          mailboxLocalPart,
          conversationId,
          stampValue,
          rfcId,
          sender,
          dataSha256,
          encodeStoredBytes(input.raw),
          disposition,
          expiresAt,
          now
        );
      }
      const email = toInboundEmail(this.inboundEmailRow(scope, mailKey)!);
      const revived = stored !== undefined;
      return echo ? { kind: 'echo', email, revived } : { kind: 'admitted', email, revived };
    });
  }

  /**
   * Expires up to `limit` (1..1000) `held` mails whose time has passed, oldest
   * first, for the mails nobody claims again. One transaction: all of them or
   * none. `more` is true when due mails remain.
   *
   * Only a `held` row expires, ever: not `relay`, `released`, `echo` or
   * `expired`. A `held` row has no `mail_message` row and no slot, so no
   * relayed mail can expire.
   */
  expireInboundEmails(limit: number): { expired: number; more: boolean } {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      refuse('limit: not an integer from 1 to 1000');
    }
    return this.ledger.atomic(() => {
      const due = this.all<InboundEmailRow>(
        "SELECT * FROM inbound_email WHERE disposition = 'held' AND expires_at <= ? ORDER BY expires_at, rowid LIMIT ?",
        this.now(),
        limit + 1
      );
      const batch = due.slice(0, limit);
      for (const row of batch) this.expireHeldRow(row);
      return { expired: batch.length, more: due.length > limit };
    });
  }

  /**
   * Links an unfunded inbound email to its `held_messages` row. One
   * transaction, one row. A repeat with the same ID writes nothing; a different
   * ID, a mail that is not `held`, or an ID another mail is linked to (now or
   * before it expired) is refused: one purchase must release one mail.
   */
  holdInboundEmail(scopeAccount: string, mailKey: string, heldMessageId: string): InboundEmailRecord {
    const scope = requireMatch('scopeAccount', scopeAccount, SCOPE_ACCOUNT);
    requireMatch('mailKey', mailKey, HEX_64);
    requireHeldMessageId(heldMessageId);
    return this.ledger.atomic(() => {
      const row = this.inboundEmailRow(scope, mailKey);
      if (!row) throw new MailJournalStateError('No inbound email with this scope and mail key');
      if (row.held_message_id === heldMessageId) return toInboundEmail(row);
      if (row.disposition !== 'held' || row.held_message_id !== null) {
        throw new MailJournalStateError(
          `Inbound email is ${row.disposition}${row.held_message_id === null ? '' : ' under another held message'}; not changed`
        );
      }
      if (this.get('SELECT 1 AS n FROM inbound_email WHERE held_message_id = ?', heldMessageId)) {
        throw new MailJournalStateError('Another inbound email is linked to this held message; not changed');
      }
      this.run(
        'UPDATE inbound_email SET held_message_id = ? WHERE scope_account = ? AND mail_key = ?',
        heldMessageId,
        scope,
        mailKey
      );
      return toInboundEmail(this.inboundEmailRow(scope, mailKey)!);
    });
  }

  /**
   * Relays an admitted inbound email: funded at intake, or released later. One
   * transaction writing, together or not at all: the send slot (`staged`, with
   * a fresh random Frank message ID), the `mail_message` row, the `mail_thread`
   * row for a new root, and the mail's disposition (`relay`, or `released` if
   * it had been held) with its expiry cleared.
   *
   * - Parent: the earliest relayed message in this scope matching `inReplyTo`;
   *   if none, the first hit scanning `references` from last to first; if none,
   *   a new root whose conversation ID is the slot's message ID.
   * - Repeat: a mail already relayed returns its stored rows, `created: false`.
   * - An `echo` or `expired` mail is never relayed. Expiry is the transition,
   *   not the clock: a mail still `held` is relayed whatever its `expires_at`.
   */
  relayInboundEmail(input: RelayInboundEmailInput): RelayInboundEmailResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const mailKey = requireMatch('mailKey', input.mailKey, HEX_64);
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);
    const issuedConversationId = input.conversationId === undefined
      ? undefined : requireMatch('conversationId', input.conversationId, FRANK_ID);
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : requireRfcId('inReplyTo', input.inReplyTo);
    const references = (input.references ?? []).map((id, i) => requireRfcId(`references[${i}]`, id));
    const sourceKey = `${scope}:${mailKey}`;

    return this.ledger.atomic((): RelayInboundEmailResult => {
      const email = this.inboundEmailRow(scope, mailKey);
      if (!email) throw new MailJournalStateError('No inbound email with this scope and mail key');
      if (stampValue !== email.stamp_value)
        throw new MailJournalStateError('Inbound send stamp differs from admitted intent');
      if (issuedConversationId && email.conversation_id && issuedConversationId !== email.conversation_id)
        throw new MailJournalStateError('Issued mailbox conversation differs from stored inbound email');

      const existing = this.slotBySource('inbound_email', sourceKey);
      if (existing) {
        const message = this.messageRow(scope, mailKey);
        if (!message || message.direction !== 'email_to_frank' || message.frank_message_id !== existing.frank_message_id) {
          throw new MailJournalStateError('Send slot has no mail_message row');
        }
        return {
          created: false,
          email: toInboundEmail(email),
          slot: toSlot(existing),
          message: toMessage(message),
        };
      }
      if (email.disposition !== 'held') {
        throw new MailJournalStateError(`Inbound email is ${email.disposition}; it cannot be relayed`);
      }
      if (this.messageRow(scope, mailKey)) {
        throw new MailJournalStateError('Another message is stored under this mail key in this scope');
      }

      const resolvedParent = this.resolveParent(scope, inReplyTo, references);
      const assignedConversationId = email.conversation_id ?? issuedConversationId;
      const parent = assignedConversationId && resolvedParent?.conversation_id !== assignedConversationId
        ? undefined : resolvedParent;
      const frankMessageId = randomFrankId();
      const conversationId = assignedConversationId ?? parent?.conversation_id ?? frankMessageId;
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
        mail_key: mailKey,
        item_key: null,
        rfc_message_id: email.rfc_message_id,
        payload_digest: null,
        frank_message_id: frankMessageId,
        conversation_id: conversationId,
        direction: 'email_to_frank',
        in_reply_to: inReplyTo ?? null,
        created_at: now,
      });
      if (!this.get('SELECT 1 AS n FROM mail_thread WHERE scope_account = ? AND conversation_id = ?', scope, conversationId)) {
        this.run(
          "INSERT INTO mail_thread (scope_account, conversation_id, origin, created_at) VALUES (?, ?, 'email', ?)",
          scope,
          conversationId,
          now
        );
      }
      this.run(
        'UPDATE inbound_email SET disposition = ?, expires_at = NULL WHERE scope_account = ? AND mail_key = ?',
        email.held_message_id === null ? 'relay' : 'released',
        scope,
        mailKey
      );

      return {
        created: true,
        email: toInboundEmail(this.inboundEmailRow(scope, mailKey)!),
        slot: toSlot(this.slotBySource('inbound_email', sourceKey)!),
        message: toMessage(this.messageRow(scope, mailKey)!),
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
   * In this order, inside the transaction:
   *
   * 1. The digest is stored: `duplicate`, nothing written.
   * 2. If the scope already has an outbound `mail_message` with `itemKey`, this
   *    is a re-seal. It writes one `frank_inbound` row (`resealed`, with its
   *    stamp as budget and nothing spent) and nothing else: `same_message`.
   * 3. If another `mail_message` row already uses `mailKey` in this scope, it
   *    throws `MailJournalStateError`.
   * 4. Otherwise the rows are written and `replyAllowance` debits as many whole
   *    units as the budget covers, at most `wanted`: `bridged`.
   *
   * An authored Message-ID in a reserved namespace is refused; the caller
   * records such a message as `rejected`.
   */
  recordFrankMessage(input: RecordFrankMessageInput): RecordFrankMessageResult {
    const digest = requireMatch('payloadDigest', input.payloadDigest, HEX_64);
    const receivedTime = requireTime('receivedTimeMs', input.receivedTimeMs);
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);

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
      } else if (input.outcome !== 'quarantined') {
        refuse('outcome: not bridged, rejected or quarantined');
      }
      const outcome = input.outcome;
      return this.ledger.atomic((): RecordFrankMessageResult => {
        const stored = this.frankInboundRow(digest);
        if (stored) return { kind: 'duplicate', inbound: toFrankInbound(stored) };
        this.insertFrankInbound({
          payload_digest: digest,
          scope_account: scope,
          frank_message_id: frankMessageId,
          conversation_id: conversationId,
          received_time: receivedTime,
          stamp_value: stampValue,
          budget: stampValue,
          spent: '0',
          disposition: outcome,
          reason,
        });
        return { kind: outcome, inbound: toFrankInbound(this.frankInboundRow(digest)!) };
      });
    }

    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const frankMessageId = requireMatch('frankMessageId', input.frankMessageId, FRANK_ID);
    const conversationId = requireMatch('conversationId', input.conversationId, FRANK_ID);
    const rfcId = requireRfcId('rfcMessageId', input.rfcMessageId);
    if (this.isReservedMessageId(rfcId)) {
      refuse('rfcMessageId: it is in a namespace reserved for identifiers this gateway generates');
    }
    const itemKey = requireMatch('itemKey', input.itemKey, HEX_64);
    const mailKey = requireMatch('mailKey', input.mailKey, HEX_64);
    const inReplyTo =
      input.inReplyTo === undefined ? undefined : requireRfcId('inReplyTo', input.inReplyTo);
    let unit = 0n;
    let wanted = 0;
    if (input.replyAllowance !== undefined) {
      unit = BigInt(requireMatch('replyAllowance.unit', input.replyAllowance.unit, DECIMAL));
      wanted = input.replyAllowance.wanted;
      if (unit <= 0n) refuse('replyAllowance.unit: must be positive');
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > 3) refuse('replyAllowance.wanted: not 0 to 3');
    }

    return this.ledger.atomic((): RecordFrankMessageResult => {
      const stored = this.frankInboundRow(digest);
      if (stored) return { kind: 'duplicate', inbound: toFrankInbound(stored) };

      // Item key against item key only. A row's mail key is never consulted here.
      const first = this.messageRowByItemKey(scope, itemKey);
      if (first) {
        this.insertFrankInbound({
          payload_digest: digest,
          scope_account: scope,
          frank_message_id: frankMessageId,
          conversation_id: conversationId,
          received_time: receivedTime,
          stamp_value: stampValue,
          budget: stampValue,
          spent: '0',
          disposition: 'resealed',
          reason: null,
        });
        return {
          kind: 'same_message',
          inbound: toFrankInbound(this.frankInboundRow(digest)!),
          message: toMessage(first),
        };
      }

      if (this.messageRow(scope, mailKey)) {
        throw new MailJournalStateError(
          'A different message is stored under this mail key in this scope; nothing was written'
        );
      }

      const budget = BigInt(stampValue);
      let covered = 0;
      while (covered < wanted && unit * BigInt(covered + 1) <= budget) covered++;
      const now = this.now();

      this.insertFrankInbound({
        payload_digest: digest,
        scope_account: scope,
        frank_message_id: frankMessageId,
        conversation_id: conversationId,
        received_time: receivedTime,
        stamp_value: stampValue,
        budget: stampValue,
        spent: (unit * BigInt(covered)).toString(),
        disposition: 'bridged',
        reason: null,
      });
      this.insertMessage({
        scope_account: scope,
        mail_key: mailKey,
        item_key: itemKey,
        rfc_message_id: rfcId,
        payload_digest: digest,
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
        message: toMessage(this.messageRow(scope, mailKey)!),
        threadCreated,
        allowancesCovered: covered,
      };
    });
  }

  /**
   * Adds one recipient's email job for a bridged message, `pending`, with a
   * fresh random bounce token. One transaction, at most one row.
   *
   * The key is (scope, the message's mail key, recipient). The scope must have
   * an outbound `mail_message` under that mail key; a job for a mail key with
   * no message, an inbound message, or another scope's message is refused. A
   * stored job with the same bytes is `existing`. A stored job with other bytes
   * is `key_taken`: it is never overwritten.
   *
   * Two messages that bear one sealed Frank message ID or one RFC Message-ID
   * have two `mail_message` rows under two mail keys, so each gets its own job
   * to the same recipient.
   */
  addOutboundJob(input: AddOutboundJobInput): AddOutboundJobResult {
    const scope = requireMatch('scopeAccount', input.scopeAccount, SCOPE_ACCOUNT);
    const mailKey = requireMatch('mailKey', input.mailKey, HEX_64);
    const recipient = requireAddress('recipientEmail', input.recipientEmail);
    const senderLocalPart = requireMailboxLocalPart(input.senderLocalPart);
    const digest = requireStoredBytes('signedRfc822', input.signedRfc822);
    const nextAttemptAt = requireTime('nextAttemptAtMs', input.nextAttemptAtMs);

    return this.ledger.atomic((): AddOutboundJobResult => {
      const message = this.messageRow(scope, mailKey);
      if (message?.direction !== 'frank_to_email') {
        throw new MailJournalStateError('No bridged message under this mail key in this scope');
      }
      const issued = this.issuedMailbox(senderLocalPart);
      if (issued?.scopeAccount !== scope || issued.conversationId !== message.conversation_id) {
        throw new MailJournalStateError('Outbound sender must be an issued alias for this conversation');
      }
      const key = [scope, mailKey, recipient] as const;
      const select = `${JOB_SELECT} WHERE j.scope_account = ? AND j.mail_key = ? AND j.recipient_email = ?`;
      const stored = this.get<OutboundJobJoinedRow>(select, ...key);
      if (stored) {
        const same = storedDigest(stored.signed_rfc822) === digest && stored.sender_local_part === senderLocalPart;
        return { kind: same ? 'existing' : 'key_taken', job: toJob(stored) };
      }
      this.run(
        `INSERT INTO outbound_job
           (scope_account, mail_key, recipient_email, sender_local_part, bounce_token, signed_rfc822,
            state, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ...key,
        senderLocalPart,
        crypto.randomBytes(16).toString('hex'),
        encodeStoredBytes(input.signedRfc822),
        nextAttemptAt,
        this.now()
      );
      return { kind: 'created', job: toJob(this.get<OutboundJobJoinedRow>(select, ...key)!) };
    });
  }

  /** Persist the externally visible send attempt before handing bytes to any provider. */
  claimOutboundJob(jobId: number): OutboundJobRecord {
    return this.ledger.atomic(() => {
      const job = this.jobRow(jobId);
      if (job.state !== 'pending')
        throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; it cannot be claimed again`);
      this.run("UPDATE outbound_job SET state = 'submitting', submission_started_at = ? WHERE job_id = ?", this.now(), job.job_id);
      return toJob(this.jobRow(jobId));
    });
  }

  /** `submitting` → `sent` after the provider confirms acceptance. */
  markOutboundJobSent(jobId: number): OutboundJobRecord {
    return this.moveJob(jobId, 'sent', ['submitting'], (job) =>
      this.run("UPDATE outbound_job SET state = 'sent', attempts = attempts + 1 WHERE job_id = ?", job.job_id)
    );
  }

  /** Positive provider evidence settles an ambiguous SMTP attempt without resending it. */
  confirmOutboundJobAccepted(jobId: number, providerEmailId: string): OutboundJobRecord {
    const id = requireMatch('providerEmailId', providerEmailId, /^[a-zA-Z0-9-]{1,128}$/);
    return this.ledger.atomic(() => {
      const job = this.jobRow(jobId);
      if (job.state !== 'submitting' && job.state !== 'uncertain') {
        if (job.state === 'sent' && job.provider_email_id === id) return toJob(job);
        throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; provider acceptance cannot change it`);
      }
      this.run(
        "UPDATE outbound_job SET state = 'sent', provider_email_id = ?, attempts = CASE WHEN state = 'submitting' THEN attempts + 1 ELSE attempts END WHERE job_id = ?",
        id,
        jobId
      );
      return toJob(this.jobRow(jobId));
    });
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
      if (job.state !== 'submitting') {
        throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; not changed`);
      }
      this.run(
        "UPDATE outbound_job SET state = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ?, submission_started_at = NULL WHERE job_id = ?",
        nextAttemptAtMs,
        String(error),
        jobId
      );
      return toJob(this.jobRow(jobId));
    });
  }

  /** `submitting` → `failed` after explicit permanent provider rejection. */
  markOutboundJobFailed(jobId: number, error: string): OutboundJobRecord {
    return this.moveJob(jobId, 'failed', ['submitting'], (job) =>
      this.run(
        "UPDATE outbound_job SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE job_id = ?",
        String(error),
        job.job_id
      )
    );
  }

  /** Ambiguous outcome: never automatically retry this job, even after a restart. */
  markOutboundJobUncertain(jobId: number, error: string): OutboundJobRecord {
    return this.moveJob(jobId, 'uncertain', ['submitting'], (job) =>
      this.run("UPDATE outbound_job SET state = 'uncertain', attempts = attempts + 1, last_error = ? WHERE job_id = ?", String(error), job.job_id)
    );
  }

  /** Operator reconciliation queue; `submitting` includes crashes during provider calls. */
  listUncertainOutboundJobs(limit = 100, afterJobId = 0): OutboundJobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) refuse('limit: not an integer from 1 to 1000');
    if (!Number.isSafeInteger(afterJobId) || afterJobId < 0) refuse('afterJobId: not a nonnegative integer');
    return this.all<OutboundJobJoinedRow>(
      `${JOB_SELECT} WHERE j.state IN ('submitting', 'uncertain') AND j.job_id > ? ORDER BY j.job_id LIMIT ?`, afterJobId, limit
    ).map(toJob);
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
      if (job.state === 'pending' || job.state === 'submitting' || job.state === 'uncertain' || job.state === 'sent') {
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
   * the stamp of the Frank message that caused it. One transaction writing,
   * together or not at all: the debit on `frank_inbound.spent` and the slot.
   *
   * The caller names only the job or the refused digest. Everything else is
   * read from stored rows, in this order; a refusal writes nothing:
   *
   * - `bounce`: the job must exist and be `failed` or `bounced`. The notice goes
   *   to the job's scope, in its message's conversation, and is paid by the
   *   Frank message that message was bridged from, which must be `bridged` in
   *   that scope. The slot's source key is the job ID.
   * - `reject`: the Frank message must be recorded `rejected` with a scope. The
   *   notice goes to that scope, in the message's conversation or, if it has
   *   none, as a new root under the slot's own message ID, and is paid by that
   *   message. The slot's source key is the digest. A `quarantined` message
   *   never gets a notice.
   * - A slot for (source kind, source key) exists: `existing`, no debit.
   * - The paying message's remaining budget is below one `unit`: `uncovered`.
   * - Otherwise the debit and the slot, together.
   */
  stageNotice(input: StageNoticeInput): StageNoticeResult {
    const sourceKind: unknown = input?.sourceKind;
    if (sourceKind !== 'bounce' && sourceKind !== 'reject') refuse('sourceKind: not a notice');
    let jobId = 0;
    let rejectedDigest = '';
    if (input.sourceKind === 'bounce') {
      if (typeof input.jobId !== 'number' || !Number.isSafeInteger(input.jobId) || input.jobId < 1) {
        refuse('jobId: not a positive integer');
      }
      jobId = input.jobId;
    } else {
      rejectedDigest = requireMatch('payloadDigest', input.payloadDigest, HEX_64);
    }
    const stampValue = requireMatch('stampValue', input.stampValue, DECIMAL);
    const unit = BigInt(requireMatch('unit', input.unit, DECIMAL));
    if (unit <= 0n) refuse('unit: must be positive');

    return this.ledger.atomic((): StageNoticeResult => {
      let sourceKey: string;
      let scope: string;
      let conversationId: string | null;
      let cover: FrankInboundRow;

      if (input.sourceKind === 'bounce') {
        const job = this.jobRow(jobId);
        if (job.state !== 'failed' && job.state !== 'bounced') {
          throw new MailJournalStateError(`Outbound job ${jobId} is ${job.state}; it has not failed, so it gets no notice`);
        }
        const message = this.messageRow(job.scope_account, job.mail_key);
        if (message?.direction !== 'frank_to_email' || message.payload_digest === null) {
          throw new MailJournalStateError(`Outbound job ${jobId} has no outbound message row`);
        }
        const bridged = this.frankInboundRow(message.payload_digest);
        if (bridged?.disposition !== 'bridged' || bridged.scope_account !== job.scope_account) {
          throw new MailJournalStateError(`Outbound job ${jobId} has no bridged Frank message in its scope`);
        }
        sourceKey = String(jobId);
        scope = job.scope_account;
        conversationId = message.conversation_id;
        cover = bridged;
      } else {
        const rejected = this.frankInboundRow(rejectedDigest);
        if (!rejected) throw new MailJournalStateError('No recorded Frank message with this payload digest');
        if (rejected.disposition !== 'rejected') {
          throw new MailJournalStateError(`The Frank message is ${rejected.disposition}, not rejected; it gets no notice`);
        }
        if (rejected.scope_account === null) {
          throw new MailJournalStateError('The rejected Frank message has no scope, so there is nobody to notify');
        }
        sourceKey = rejectedDigest;
        scope = rejected.scope_account;
        conversationId = rejected.conversation_id;
        cover = rejected;
      }

      const existing = this.slotBySource(input.sourceKind, sourceKey);
      if (existing) return { kind: 'existing', slot: toSlot(existing) };

      const spent = BigInt(cover.spent) + unit;
      if (spent > BigInt(cover.budget)) return { kind: 'uncovered' };

      const frankMessageId = randomFrankId();
      this.run('UPDATE frank_inbound SET spent = ? WHERE payload_digest = ?', spent.toString(), cover.payload_digest);
      this.run(
        `INSERT INTO frank_send
           (source_kind, source_key, frank_message_id, scope_account, conversation_id, stamp_value, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'staged', ?)`,
        input.sourceKind,
        sourceKey,
        frankMessageId,
        scope,
        conversationId ?? frankMessageId,
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
      const row = this.findParentMessage(scope, inReplyTo);
      if (row) return row;
    }
    for (let i = references.length - 1; i >= 0; i--) {
      const row = this.findParentMessage(scope, references[i]);
      if (row) return row;
    }
    return undefined;
  }

  private findParentMessage(scope: string, candidateId: string): MailMessageRow | undefined {
    const exact = this.get<MailMessageRow>(
      'SELECT * FROM mail_message WHERE scope_account = ? AND rfc_message_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
      scope,
      candidateId,
    );
    if (exact) return exact;

    const inner =
      candidateId.startsWith('<') && candidateId.endsWith('>')
        ? candidateId.slice(1, -1)
        : candidateId;
    const atIndex = inner.lastIndexOf('@');
    if (atIndex <= 0) return undefined;
    const localPart = inner.slice(0, atIndex).toLowerCase();

    if (FRANK_ID.test(localPart)) {
      const byFrankId = this.get<MailMessageRow>(
        'SELECT * FROM mail_message WHERE scope_account = ? AND frank_message_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
        scope,
        localPart,
      );
      if (byFrankId) return byFrankId;
      const byConvId = this.get<MailMessageRow>(
        'SELECT * FROM mail_message WHERE scope_account = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        scope,
        localPart,
      );
      if (byConvId) return byConvId;
    }

    const compositeMatch = localPart.match(
      /^frank\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/,
    );
    if (compositeMatch) {
      const convId = compositeMatch[1];
      const msgId = compositeMatch[2];
      if (msgId) {
        const byFrankId = this.get<MailMessageRow>(
          'SELECT * FROM mail_message WHERE scope_account = ? AND frank_message_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1',
          scope,
          msgId,
        );
        if (byFrankId) return byFrankId;
      }
      const byConvId = this.get<MailMessageRow>(
        'SELECT * FROM mail_message WHERE scope_account = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        scope,
        convId,
      );
      if (byConvId) return byConvId;
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

  private messageRow(scope: string, mailKey: string): MailMessageRow | undefined {
    return this.get<MailMessageRow>(
      'SELECT * FROM mail_message WHERE scope_account = ? AND mail_key = ?',
      scope,
      mailKey
    );
  }

  private messageRowByItemKey(scope: string, itemKey: string): MailMessageRow | undefined {
    return this.get<MailMessageRow>(
      "SELECT * FROM mail_message WHERE scope_account = ? AND item_key = ? AND direction = 'frank_to_email'",
      scope,
      itemKey
    );
  }

  private inboundEmailRow(scope: string, mailKey: string): InboundEmailRow | undefined {
    return this.get<InboundEmailRow>(
      'SELECT * FROM inbound_email WHERE scope_account = ? AND mail_key = ?',
      scope,
      mailKey
    );
  }

  /**
   * The one place a mail expires: `held` → `expired`, its bytes dropped, and its
   * `held_messages` row (the pay page's view of it) marked expired in the same
   * unit. The key, sender, hash, held-message link and times stay as the record
   * that the mail was accepted and never paid for. The statement itself is
   * restricted to `held`, so nothing relayed can be changed by it.
   */
  private expireHeldRow(row: InboundEmailRow): void {
    const changed = this.run(
      "UPDATE inbound_email SET disposition = 'expired', raw = NULL WHERE scope_account = ? AND mail_key = ? AND disposition = 'held'",
      row.scope_account,
      row.mail_key
    );
    if (changed !== 1) throw new MailJournalStateError('Inbound email is no longer held; it was not expired');
    if (row.held_message_id !== null) this.ledger.expireHeldMessage(row.held_message_id);
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

  private jobRow(jobId: number): OutboundJobJoinedRow {
    const row = this.get<OutboundJobJoinedRow>(`${JOB_SELECT} WHERE j.job_id = ?`, jobId);
    if (!row) throw new MailJournalStateError(`No outbound job ${String(jobId)}`);
    return row;
  }

  /** The only writer of `mail_message`. A plain INSERT: a taken key throws and the unit rolls back. */
  private insertMessage(row: MailMessageRow): void {
    this.run(
      `INSERT INTO mail_message
         (scope_account, mail_key, item_key, rfc_message_id, payload_digest, frank_message_id,
          conversation_id, direction, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.scope_account,
      row.mail_key,
      row.item_key,
      row.rfc_message_id,
      row.payload_digest,
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
         (payload_digest, scope_account, frank_message_id, conversation_id, received_time, stamp_value,
          budget, spent, disposition, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.payload_digest,
      row.scope_account,
      row.frank_message_id,
      row.conversation_id,
      row.received_time,
      row.stamp_value,
      row.budget,
      row.spent,
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
