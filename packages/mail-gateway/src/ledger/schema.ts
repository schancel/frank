import type { ColumnType, Generated } from 'kysely';

export interface CreditLedgerTable {
  email: string;
  balance: ColumnType<number, number | bigint | undefined, number | bigint>;
  updated_at: ColumnType<number, number | bigint, number | bigint>;
}

export interface TransactionsTable {
  id: string;
  provider: string;
  amount_cents: ColumnType<number, number | undefined, number>;
  credits_added: ColumnType<number, number, number>;
  created_at: ColumnType<number, number | bigint, number | bigint>;
}

export interface PaymentTransactionsTable {
  provider_tx_id: string;
  provider: string;
  sender_email: string;
  credits_added: ColumnType<number, number, number>;
  created_at: ColumnType<number, number | bigint, number | bigint>;
}

export interface ThreadAllowancesTable {
  sender_email: string;
  recipient_frank_addr: string;
  remaining_replies: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<number, number | bigint, number | bigint>;
}

export interface ThreadMappingsTable {
  conversation_id: string;
  frank_message_id: string;
  rfc822_message_id: string;
  in_reply_to_rfc822: string | null;
  subject: string | null;
  sender_address: ColumnType<string | null, string | null | undefined, string | null>;
  to_recipients_json: ColumnType<string | null, string | null | undefined, string | null>;
  cc_recipients_json: ColumnType<string | null, string | null | undefined, string | null>;
  sender_home_relay: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<number, number | bigint, number | bigint>;
}

export interface HeldMessagesTable {
  id: string;
  sender_email: string;
  recipient_address: string;
  dkim_domain: string;
  subject: string;
  raw_rfc822: ColumnType<string | Uint8Array, string | Uint8Array, string | Uint8Array>;
  created_at: ColumnType<number, number | bigint, number | bigint>;
  expires_at: ColumnType<number, number | bigint, number | bigint>;
  status: ColumnType<string, string | undefined, string>;
}

export interface OutboundSpoolTable {
  id: Generated<number>;
  recipient_email: string;
  from_address: string;
  raw_rfc822: string;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<number, number | bigint, number | bigint>;
  max_attempts: ColumnType<number, number | undefined, number>;
  last_error: string | null;
  status: ColumnType<string, string | undefined, string>;
}

export interface GatewayDatabase {
  credit_ledger: CreditLedgerTable;
  transactions: TransactionsTable;
  payment_transactions?: PaymentTransactionsTable;
  thread_allowances: ThreadAllowancesTable;
  thread_mappings: ThreadMappingsTable;
  held_messages: HeldMessagesTable;
  outbound_spool: OutboundSpoolTable;
}

/**
 * Rows of the mail journal tables (format 2; the DDL is private to `mail-journal.ts`), as
 * `node:sqlite` returns them. SQLite only, so they are not part of
 * `GatewayDatabase`: Kysely must not offer them on Postgres.
 */
export interface MailJournalMetaRow {
  id: number;
  format: number;
  chain_identifier: string;
  gateway_account: string;
  frank_cursor_ms: number | null;
  frank_incomplete_floor_ms: number | null;
}

export interface MailThreadRow {
  scope_account: string;
  conversation_id: string;
  origin: 'email' | 'frank';
  created_at: number;
}

export interface MailMessageRow {
  scope_account: string;
  rfc_message_id: string;
  claimed_rfc_id: string | null;
  /** For an inbound row, its `inbound_email` key; for an outbound row, the key of the emitted mail. */
  mail_key: string;
  /** Set on every `frank_to_email` row, null on every `email_to_frank` row. Never compared with a mail key. */
  item_key: string | null;
  /** Set on every `frank_to_email` row (the `frank_inbound` row it was bridged from), null otherwise. */
  payload_digest: string | null;
  frank_message_id: string;
  conversation_id: string;
  direction: 'email_to_frank' | 'frank_to_email';
  in_reply_to: string | null;
  created_at: number;
}

export interface InboundEmailRow {
  scope_account: string;
  mail_key: string;
  rfc_message_id: string;
  sender_email: string;
  data_sha256: string;
  /** Null only when the row is `expired`. */
  raw: Uint8Array | string | null;
  disposition: 'relay' | 'held' | 'released' | 'echo' | 'expired';
  held_message_id: string | null;
  /** Set on every `held` row; cleared when the mail is relayed. */
  expires_at: number | null;
  created_at: number;
}

export interface FrankSendRow {
  slot_id: number;
  source_kind: 'inbound_email' | 'bounce' | 'reject';
  source_key: string;
  frank_message_id: string;
  payload_digest: string | null;
  scope_account: string;
  conversation_id: string;
  stamp_value: string;
  state: 'staged' | 'sending' | 'linked' | 'delivered' | 'held';
  last_refused_at: number | null;
  failed_calls: number;
  next_call_at: number | null;
  hold_reason: string | null;
  created_at: number;
}

export interface FrankInboundRow {
  payload_digest: string;
  scope_account: string | null;
  frank_message_id: string | null;
  conversation_id: string | null;
  received_time: number;
  /** Decimal text in the smallest unit of the journal chain's native asset, as are `budget` and `spent`. */
  stamp_value: string;
  budget: string;
  spent: string;
  disposition: 'bridged' | 'rejected' | 'quarantined' | 'resealed';
  reason: string | null;
}

export interface OutboundJobRow {
  job_id: number;
  scope_account: string;
  /** The identifier the email goes out under: the key of its `mail_message` row. */
  rfc_message_id: string;
  recipient_email: string;
  bounce_token: string;
  signed_rfc822: Uint8Array | string;
  state: 'pending' | 'sent' | 'failed' | 'bounced';
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}
