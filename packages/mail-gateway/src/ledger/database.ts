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
