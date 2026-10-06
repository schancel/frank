import { DatabaseSync } from 'node:sqlite';
import {
  createLedgerDb,
  createLedgerMigrator,
  migrateLedgerDb,
  CreditLedger,
  initialMigration,
} from '../src';
import { GatewayDatabase } from '../src/ledger/schema';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';

describe('Issue #1019: Kysely Dual-Dialect Database Abstraction & Migrations', () => {
  describe('1. Dialect Switching', () => {
    it('creates SQLite dialect by default or with inMemory: true', () => {
      const dbDefault = createLedgerDb();
      expect(dbDefault.getExecutor().adapter.constructor.name).toBe('SqliteAdapter');
      expect(dbDefault.rawDb).toBeDefined();

      const dbMemory = createLedgerDb({ inMemory: true });
      expect(dbMemory.getExecutor().adapter.constructor.name).toBe('SqliteAdapter');
      expect(dbMemory.rawDb).toBeDefined();

      const dbPath = createLedgerDb({ sqlitePath: ':memory:' });
      expect(dbPath.getExecutor().adapter.constructor.name).toBe('SqliteAdapter');
    });

    it('creates Postgres dialect when postgres:// databaseUrl is provided', () => {
      const dbPg = createLedgerDb({
        databaseUrl: 'postgres://frank:secret@localhost:5432/frank_gateway',
      });
      expect(dbPg.getExecutor().adapter.constructor.name).toBe('PostgresAdapter');
      expect(dbPg.rawDb).toBeUndefined();
    });

    it('creates Postgres dialect when postgresql:// databaseUrl is provided', () => {
      const dbPg = createLedgerDb({
        databaseUrl: 'postgresql://frank:secret@localhost:5432/frank_gateway',
      });
      expect(dbPg.getExecutor().adapter.constructor.name).toBe('PostgresAdapter');
      expect(dbPg.rawDb).toBeUndefined();
    });
  });

  describe('2. Programmatic Migrations & Atomic Lock', () => {
    let db: ReturnType<typeof createLedgerDb>;

    beforeEach(() => {
      db = createLedgerDb({ inMemory: true });
    });

    it('runs migrations up, creates atomic lock table, all schema tables, and indices', async () => {
      const result = await migrateLedgerDb(db);
      expect(result.error).toBeUndefined();
      expect(result.results).toBeDefined();
      expect(result.results?.length).toBeGreaterThan(0);
      expect(result.results?.[0].status).toBe('Success');
      expect(result.results?.[0].migrationName).toBe('001_gateway_initial');

      // Verify tables in sqlite_master
      const rawDb = db.rawDb!;
      const tables = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('kysely_migration');
      expect(tableNames).toContain('kysely_migration_lock');
      expect(tableNames).toContain('credit_ledger');
      expect(tableNames).toContain('transactions');
      expect(tableNames).toContain('payment_transactions');
      expect(tableNames).toContain('thread_allowances');
      expect(tableNames).toContain('thread_mappings');
      expect(tableNames).toContain('held_messages');
      expect(tableNames).toContain('outbound_spool');

      // Verify indices
      const indices = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      const indexNames = indices.map((i) => i.name);

      expect(indexNames).toContain('idx_held_sender');
      expect(indexNames).toContain('idx_thread_rfc822');
      expect(indexNames).toContain('idx_outbound_spool_pending');
    });

    it('is idempotent on subsequent migration runs', async () => {
      await migrateLedgerDb(db);
      const secondRun = await migrateLedgerDb(db);
      expect(secondRun.error).toBeUndefined();
      expect(secondRun.results?.length).toBe(0);
    });

    it('rolls back migrations cleanly via migrator.migrateDown()', async () => {
      await migrateLedgerDb(db);
      const migrator = createLedgerMigrator(db);
      const downResult = await migrator.migrateDown();
      expect(downResult.error).toBeUndefined();
      expect(downResult.results?.[0].direction).toBe('Down');

      const rawDb = db.rawDb!;
      const tables = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).not.toContain('credit_ledger');
      expect(tableNames).not.toContain('held_messages');
      expect(tableNames).not.toContain('outbound_spool');
    });
  });

  describe('3. Typed Kysely Queries', () => {
    let db: ReturnType<typeof createLedgerDb>;

    beforeEach(async () => {
      db = createLedgerDb({ inMemory: true });
      await migrateLedgerDb(db);
    });

    it('performs type-safe CRUD operations on credit_ledger', async () => {
      await db
        .insertInto('credit_ledger')
        .values({
          email: 'alice@example.com',
          balance: 10,
          updated_at: Date.now(),
        })
        .execute();

      const user = await db
        .selectFrom('credit_ledger')
        .selectAll()
        .where('email', '=', 'alice@example.com')
        .executeTakeFirst();

      expect(user).toBeDefined();
      expect(Number(user?.balance)).toBe(10);

      await db
        .updateTable('credit_ledger')
        .set({ balance: 25 })
        .where('email', '=', 'alice@example.com')
        .execute();

      const updated = await db
        .selectFrom('credit_ledger')
        .select('balance')
        .where('email', '=', 'alice@example.com')
        .executeTakeFirst();
      expect(Number(updated?.balance)).toBe(25);
    });

    it('performs type-safe auto-increment inserts on outbound_spool', async () => {
      const res1 = await db
        .insertInto('outbound_spool')
        .values({
          recipient_email: 'recipient@domain.com',
          from_address: 'frank@domain.com',
          raw_rfc822: 'From: frank\r\n\r\nHello',
          next_attempt_at: Date.now(),
        })
        .executeTakeFirst();

      expect(res1.insertId).toBeDefined();
      expect(Number(res1.insertId)).toBeGreaterThanOrEqual(1);

      const res2 = await db
        .insertInto('outbound_spool')
        .values({
          recipient_email: 'recipient2@domain.com',
          from_address: 'frank@domain.com',
          raw_rfc822: 'From: frank\r\n\r\nHello 2',
          next_attempt_at: Date.now(),
        })
        .executeTakeFirst();

      expect(Number(res2.insertId)).toBe(Number(res1.insertId) + 1);
    });
  });

  describe('4. CreditLedger with Kysely Backing & Backward Compatibility', () => {
    let ledger: CreditLedger;

    beforeEach(() => {
      ledger = new CreditLedger(':memory:');
    });

    it('supports instantiation from an existing Kysely database instance', () => {
      const customDb = createLedgerDb({ inMemory: true });
      const customLedger = new CreditLedger(customDb);
      expect(customLedger.db).toBe(customDb);
      expect(customLedger.getBalance('any@example.com')).toBe(0);
    });

    it('implements deductCredit, hasReplyAllowance, and consumeReplyAllowance', () => {
      ledger.addCredits('carol@example.com', 5);
      expect(ledger.getBalance('carol@example.com')).toBe(5);

      // Deduct credit
      expect(ledger.deductCredit('carol@example.com', 2)).toBe(true);
      expect(ledger.getBalance('carol@example.com')).toBe(3);

      expect(ledger.deductCredit('carol@example.com', 5)).toBe(false);
      expect(ledger.getBalance('carol@example.com')).toBe(3);

      // Reply allowances
      expect(ledger.hasReplyAllowance('carol@example.com', '0xrecipient')).toBe(false);
      expect(ledger.consumeReplyAllowance('carol@example.com', '0xrecipient')).toBe(false);

      ledger.grantReplyAllowance('carol@example.com', '0xrecipient', 2);
      expect(ledger.hasReplyAllowance('carol@example.com', '0xrecipient')).toBe(true);
      expect(ledger.getThreadAllowance('carol@example.com', '0xrecipient')).toBe(2);

      expect(ledger.consumeReplyAllowance('carol@example.com', '0xrecipient')).toBe(true);
      expect(ledger.getThreadAllowance('carol@example.com', '0xrecipient')).toBe(1);
      expect(ledger.consumeReplyAllowance('carol@example.com', '0xrecipient')).toBe(true);
      expect(ledger.hasReplyAllowance('carol@example.com', '0xrecipient')).toBe(false);
    });

    it('records transactions via recordTransaction and deducts idempotently', () => {
      ledger.recordTransaction({
        id: 'tx_stripe_001',
        provider: 'stripe',
        amountCents: 500,
        creditsAdded: 10,
      });

      // Verification via rawDb/Kysely
      const tx = ledger.db
        .selectFrom('transactions')
        .selectAll()
        .where('id', '=', 'tx_stripe_001')
        .compile();
      const row = (ledger as any).executeGet(tx);
      expect(row).toBeDefined();
      expect(row.provider).toBe('stripe');
      expect(Number(row.amount_cents)).toBe(500);
      expect(Number(row.credits_added)).toBe(10);
    });

    it('supports async methods for all ledger operations', async () => {
      await ledger.addCreditsAsync('dave@example.com', 10);
      expect(await ledger.getBalanceAsync('dave@example.com')).toBe(10);

      expect(await ledger.deductCreditAsync('dave@example.com', 4)).toBe(true);
      expect(await ledger.getBalanceAsync('dave@example.com')).toBe(6);

      await ledger.grantReplyAllowanceAsync('dave@example.com', '0xfrankuser', 3);
      expect(await ledger.getThreadAllowanceAsync('dave@example.com', '0xfrankuser')).toBe(3);
      expect(await ledger.hasReplyAllowanceAsync('dave@example.com', '0xfrankuser')).toBe(true);

      expect(await ledger.consumeCreditAsync('dave@example.com', '0xfrankuser')).toBe(true);
      expect(await ledger.getThreadAllowanceAsync('dave@example.com', '0xfrankuser')).toBe(2);
      expect(await ledger.getBalanceAsync('dave@example.com')).toBe(6);

      // Async thread mapping
      await ledger.recordThreadMappingAsync({
        conversationId: 'conv_123',
        frankMessageId: 'frank_msg_async',
        rfc822MessageId: '<rfc_async@example.com>',
        subject: 'Async Subject',
        createdAtMs: Date.now(),
      });

      const byFrank = await ledger.getThreadMappingByFrankMessageIdAsync('conv_123', 'frank_msg_async');
      expect(byFrank?.rfc822MessageId).toBe('<rfc_async@example.com>');

      const byRfc = await ledger.getThreadMappingByRfc822IdAsync('<rfc_async@example.com>');
      expect(byRfc?.frankMessageId).toBe('frank_msg_async');

      // Async held message
      await ledger.holdMessageAsync({
        id: 'held_async_1',
        senderEmail: 'dave@example.com',
        recipientAddress: '0xfrankuser',
        dkimDomain: 'example.com',
        subject: 'Held Async',
        rawRfc822: new Uint8Array([5, 6, 7]),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 100000,
      });

      const held = await ledger.getHeldMessageAsync('held_async_1');
      expect(held?.subject).toBe('Held Async');

      const released = await ledger.releaseHeldMessageAsync('held_async_1');
      expect(released?.status).toBe('released');

      // Async spool
      const jobId = await ledger.enqueueOutboundSpoolAsync({
        recipientEmail: 'remote@target.com',
        fromAddress: 'sender@frank.org',
        rawRfc822: 'raw email',
      });
      expect(jobId).toBeGreaterThanOrEqual(1);

      const pending = await ledger.getPendingOutboundJobsAsync(Date.now() + 10000);
      expect(pending.length).toBeGreaterThanOrEqual(1);

      await ledger.markOutboundJobSuccessAsync(jobId);
      const finishedJob = await ledger.getOutboundJobAsync(jobId);
      expect(finishedJob?.status).toBe('success');
    });
  });
});
