import { DatabaseSync } from 'node:sqlite';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import { Pool } from 'pg';
import type { GatewayDatabase } from './schema';

export interface LedgerDbConfig {
  databaseUrl?: string;
  sqlitePath?: string;
  inMemory?: boolean;
}

export type ExtendedGatewayDb = Kysely<GatewayDatabase> & {
  rawDb?: DatabaseSync;
};

export function wrapDatabaseSync(rawDb: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = rawDb.prepare(sql);
      const isReader = stmt.columns().length > 0;
      return {
        reader: isReader,
        run(params: unknown[] = []) {
          const args = Array.isArray(params) ? params : [params];
          return (stmt.run as (...a: any[]) => any)(...args);
        },
        all(params: unknown[] = []) {
          const args = Array.isArray(params) ? params : [params];
          return (stmt.all as (...a: any[]) => any)(...args);
        },
        iterate(params: unknown[] = []) {
          const args = Array.isArray(params) ? params : [params];
          return (stmt.iterate as (...a: any[]) => any)(...args);
        },
        columns() {
          return stmt.columns();
        },
      };
    },
    close() {
      rawDb.close();
    },
  };
}

export const initialMigration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const isPostgres = db.getExecutor().adapter.constructor.name.includes('Postgres');

    // 1. credit_ledger
    await db.schema
      .createTable('credit_ledger')
      .ifNotExists()
      .addColumn('email', 'text', (col) => col.primaryKey())
      .addColumn('balance', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('updated_at', 'bigint', (col) => col.notNull())
      .execute();

    // 2. transactions
    await db.schema
      .createTable('transactions')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('amount_cents', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('credits_added', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'bigint', (col) => col.notNull())
      .execute();

    // 3. payment_transactions (backward compatibility)
    await db.schema
      .createTable('payment_transactions')
      .ifNotExists()
      .addColumn('provider_tx_id', 'text', (col) => col.primaryKey())
      .addColumn('provider', 'text', (col) => col.notNull())
      .addColumn('sender_email', 'text', (col) => col.notNull())
      .addColumn('credits_added', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'bigint', (col) => col.notNull())
      .execute();

    // 4. thread_allowances
    await db.schema
      .createTable('thread_allowances')
      .ifNotExists()
      .addColumn('sender_email', 'text', (col) => col.notNull())
      .addColumn('recipient_frank_addr', 'text', (col) => col.notNull())
      .addColumn('remaining_replies', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('updated_at', 'bigint', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_thread_allowances', ['sender_email', 'recipient_frank_addr'])
      .execute();

    // 5. thread_mappings
    await db.schema
      .createTable('thread_mappings')
      .ifNotExists()
      .addColumn('conversation_id', 'text', (col) => col.notNull())
      .addColumn('frank_message_id', 'text', (col) => col.notNull())
      .addColumn('rfc822_message_id', 'text', (col) => col.notNull())
      .addColumn('in_reply_to_rfc822', 'text')
      .addColumn('subject', 'text')
      .addColumn('sender_address', 'text')
      .addColumn('to_recipients_json', 'text')
      .addColumn('cc_recipients_json', 'text')
      .addColumn('sender_home_relay', 'text')
      .addColumn('created_at', 'bigint', (col) => col.notNull())
      .addPrimaryKeyConstraint('pk_thread_mappings', ['conversation_id', 'frank_message_id'])
      .execute();

    // 6. held_messages
    await db.schema
      .createTable('held_messages')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('sender_email', 'text', (col) => col.notNull())
      .addColumn('recipient_address', 'text', (col) => col.notNull())
      .addColumn('dkim_domain', 'text', (col) => col.notNull())
      .addColumn('subject', 'text', (col) => col.notNull())
      .addColumn('raw_rfc822', isPostgres ? 'bytea' : 'blob', (col) => col.notNull())
      .addColumn('created_at', 'bigint', (col) => col.notNull())
      .addColumn('expires_at', 'bigint', (col) => col.notNull())
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('held'))
      .execute();

    // 7. outbound_spool
    let spool = db.schema.createTable('outbound_spool').ifNotExists();
    if (isPostgres) {
      spool = spool.addColumn('id', 'serial', (col) => col.primaryKey());
    } else {
      spool = spool.addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement());
    }
    await spool
      .addColumn('recipient_email', 'text', (col) => col.notNull())
      .addColumn('from_address', 'text', (col) => col.notNull())
      .addColumn('raw_rfc822', 'text', (col) => col.notNull())
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('next_attempt_at', 'bigint', (col) => col.notNull())
      .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(10))
      .addColumn('last_error', 'text')
      .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('pending'))
      .execute();

    // Indices
    await db.schema
      .createIndex('idx_held_sender')
      .ifNotExists()
      .on('held_messages')
      .columns(['sender_email', 'status'])
      .execute();

    await db.schema
      .createIndex('idx_thread_rfc822')
      .ifNotExists()
      .on('thread_mappings')
      .column('rfc822_message_id')
      .execute();

    await db.schema
      .createIndex('idx_thread_conv')
      .ifNotExists()
      .on('thread_mappings')
      .column('conversation_id')
      .execute();

    await db.schema
      .createIndex('idx_outbound_spool_pending')
      .ifNotExists()
      .on('outbound_spool')
      .columns(['status', 'next_attempt_at'])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('idx_outbound_spool_pending').ifExists().execute();
    await db.schema.dropIndex('idx_thread_conv').ifExists().execute();
    await db.schema.dropIndex('idx_thread_rfc822').ifExists().execute();
    await db.schema.dropIndex('idx_held_sender').ifExists().execute();

    await db.schema.dropTable('outbound_spool').ifExists().execute();
    await db.schema.dropTable('held_messages').ifExists().execute();
    await db.schema.dropTable('thread_mappings').ifExists().execute();
    await db.schema.dropTable('thread_allowances').ifExists().execute();
    await db.schema.dropTable('payment_transactions').ifExists().execute();
    await db.schema.dropTable('transactions').ifExists().execute();
    await db.schema.dropTable('credit_ledger').ifExists().execute();
  },
};

export const gatewayMigrations: Record<string, Migration> = {
  '001_gateway_initial': initialMigration,
};

export const gatewayMigrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return gatewayMigrations;
  },
};

export function createLedgerMigrator(db: Kysely<GatewayDatabase>): Migrator {
  return new Migrator({
    db,
    provider: gatewayMigrationProvider,
  });
}

export async function migrateLedgerDb(db: Kysely<GatewayDatabase>): Promise<MigrationResultSet> {
  const migrator = createLedgerMigrator(db);
  return migrator.migrateToLatest();
}

export function createLedgerDb(config?: LedgerDbConfig): ExtendedGatewayDb {
  if (
    config?.databaseUrl &&
    (config.databaseUrl.startsWith('postgres://') || config.databaseUrl.startsWith('postgresql://'))
  ) {
    const pool = new Pool({
      connectionString: config.databaseUrl,
    });
    const dialect = new PostgresDialect({
      pool,
    });
    return new Kysely<GatewayDatabase>({
      dialect,
    });
  }

  const dbPath = config?.inMemory ? ':memory:' : (config?.sqlitePath ?? ':memory:');
  const rawDb = new DatabaseSync(dbPath);
  const dialect = new SqliteDialect({
    database: wrapDatabaseSync(rawDb) as any,
  });
  const db = new Kysely<GatewayDatabase>({
    dialect,
  }) as ExtendedGatewayDb;
  db.rawDb = rawDb;
  return db;
}

export function ensureLedgerSchemaSync(rawDb: DatabaseSync): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      email TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_allowances (
      sender_email TEXT NOT NULL,
      recipient_frank_addr TEXT NOT NULL,
      remaining_replies INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (sender_email, recipient_frank_addr)
    );

    CREATE TABLE IF NOT EXISTS held_messages (
      id TEXT PRIMARY KEY,
      sender_email TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      dkim_domain TEXT NOT NULL,
      subject TEXT NOT NULL,
      raw_rfc822 BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT CHECK(status IN ('held', 'released', 'expired')) NOT NULL DEFAULT 'held'
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      provider_tx_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      credits_added INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      credits_added INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_mappings (
      conversation_id TEXT NOT NULL,
      frank_message_id TEXT NOT NULL,
      rfc822_message_id TEXT NOT NULL,
      in_reply_to_rfc822 TEXT,
      subject TEXT,
      sender_address TEXT,
      to_recipients_json TEXT,
      cc_recipients_json TEXT,
      sender_home_relay TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, frank_message_id)
    );

    CREATE TABLE IF NOT EXISTS outbound_spool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL,
      from_address TEXT NOT NULL,
      raw_rfc822 TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL DEFAULT 10,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_held_sender ON held_messages(sender_email, status);
    CREATE INDEX IF NOT EXISTS idx_thread_rfc822 ON thread_mappings(rfc822_message_id);
    CREATE INDEX IF NOT EXISTS idx_thread_conv ON thread_mappings(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_spool_pending ON outbound_spool(status, next_attempt_at);
  `);
}

/**
 * Mail gateway journal (#1237, stage G1). SQLite only: Postgres is not supported
 * for these tables. They are created by `MailJournal` on its first open, in one
 * transaction with the `mail_journal_meta` row; they are not part of
 * `ensureLedgerSchemaSync` and not part of the Kysely migration.
 *
 * There is no migration and no reader for any other shape. A database whose
 * marker is missing or is not `MAIL_JOURNAL_FORMAT` is refused at open; the
 * development reset is to archive the SQLite file together with the gateway
 * wallet's stores (they are one unit for backup) and start a new one.
 *
 * Identifier comparison is byte-exact: every key column is TEXT under SQLite's
 * default BINARY collation.
 */
export const MAIL_JOURNAL_FORMAT = 1;

export const MAIL_JOURNAL_TABLES = [
  'mail_journal_meta',
  'mail_thread',
  'mail_message',
  'inbound_email',
  'frank_send',
  'frank_inbound',
  'outbound_job',
] as const;

export const MAIL_JOURNAL_DDL = `
  CREATE TABLE mail_journal_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    format INTEGER NOT NULL,
    chain_identifier TEXT NOT NULL,
    gateway_account TEXT NOT NULL,
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

  CREATE TABLE mail_message (
    scope_account TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    claimed_rfc_id TEXT,
    content_key TEXT NOT NULL,
    frank_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('email_to_frank', 'frank_to_email')),
    in_reply_to TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, rfc_message_id)
  );
  CREATE INDEX idx_mail_message_frank ON mail_message(scope_account, frank_message_id);

  CREATE TABLE inbound_email (
    scope_account TEXT NOT NULL,
    content_key TEXT NOT NULL,
    rfc_message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    data_sha256 TEXT NOT NULL,
    raw BLOB NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('relay', 'held', 'released', 'echo')),
    held_message_id TEXT,
    duplicate_mismatches INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, content_key)
  );
  CREATE INDEX idx_inbound_email_claim ON inbound_email(scope_account, rfc_message_id);

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
    stamp_value_wei TEXT NOT NULL,
    budget_wei TEXT NOT NULL,
    spent_wei TEXT NOT NULL DEFAULT '0',
    disposition TEXT NOT NULL CHECK (disposition IN ('bridged', 'rejected', 'quarantined')),
    reason TEXT
  );
  CREATE INDEX idx_frank_inbound_message ON frank_inbound(scope_account, frank_message_id);

  CREATE TABLE outbound_job (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_account TEXT NOT NULL,
    frank_message_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    bounce_token TEXT NOT NULL UNIQUE,
    signed_rfc822 BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'bounced')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (scope_account, frank_message_id, recipient_email)
  );
  CREATE INDEX idx_outbound_job_due ON outbound_job(state, next_attempt_at);
`;
