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
