import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';
import { CompiledQuery, Kysely } from 'kysely';
import { HeldMessageRecord, OutboundSpoolJob, ThreadMappingRecord } from '../types';
import { BlobStore, BLOB_OFFLOAD_THRESHOLD_BYTES } from '../storage/blob-store';
import { LocalFsBlobStore } from '../storage/local-fs-blob-store';
import {
  createLedgerDb,
  ensureLedgerSchemaSync,
  ExtendedGatewayDb,
  LedgerDbConfig,
} from './database';
import { GatewayDatabase } from './schema';

export { BLOB_OFFLOAD_THRESHOLD_BYTES };

export type CreditLedgerInit = string | LedgerDbConfig | Kysely<GatewayDatabase>;

export class CreditLedger {
  public readonly db: Kysely<GatewayDatabase>;
  public readonly kysely: Kysely<GatewayDatabase>;
  readonly blobStore: BlobStore;
  private readonly rawDb?: DatabaseSync;

  constructor(
    init: CreditLedgerInit = ':memory:',
    blobStoreOrOptions?: BlobStore | { blobStore?: BlobStore }
  ) {
    let dbPath = ':memory:';
    if (typeof init === 'string') {
      dbPath = init;
      const isPostgres =
        init.startsWith('postgres://') || init.startsWith('postgresql://');
      const db = createLedgerDb(
        isPostgres ? { databaseUrl: init } : { sqlitePath: init }
      );
      this.db = db;
      this.kysely = db;
      this.rawDb = db.rawDb;
    } else if ('selectFrom' in init) {
      this.db = init;
      this.kysely = init;
      this.rawDb = (init as ExtendedGatewayDb).rawDb;
    } else {
      if (init.sqlitePath) dbPath = init.sqlitePath;
      const db = createLedgerDb(init);
      this.db = db;
      this.kysely = db;
      this.rawDb = db.rawDb;
    }

    const store =
      blobStoreOrOptions && 'put' in blobStoreOrOptions
        ? blobStoreOrOptions
        : blobStoreOrOptions?.blobStore;
    this.blobStore = store ?? new LocalFsBlobStore({ inMemory: dbPath === ':memory:' });

    if (this.rawDb) {
      ensureLedgerSchemaSync(this.rawDb);
    }
  }

  /** The ledger's SQLite connection, or undefined on Postgres. The ledger keeps ownership of it. */
  get sqlite(): DatabaseSync | undefined {
    return this.rawDb;
  }

  private atomicDepth = 0;
  private atomicFailed = false;

  /**
   * Runs `fn` as one SQLite write transaction (`BEGIN IMMEDIATE` … `COMMIT`).
   *
   * - Any throw, including one from `COMMIT`, rolls the whole unit back.
   * - `fn` must be synchronous. A returned promise is refused and rolled back:
   *   a later `await` would otherwise run after the commit, outside the unit.
   * - A call made inside `fn` joins the enclosing unit; it does not commit on
   *   its own. If a joined call throws, the enclosing unit can no longer
   *   commit, even if the caller catches the error.
   * - Every value a decision rests on must be read inside `fn`.
   */
  atomic<T>(fn: () => T): T {
    const db = this.rawDb;
    if (!db) throw new Error('atomic() is only supported on SQLite DatabaseSync');

    const run = (): T => {
      const result = fn();
      if (result !== null && typeof (result as { then?: unknown } | undefined)?.then === 'function') {
        Promise.resolve(result).catch(() => undefined);
        throw new Error('atomic() callback returned a promise; the unit must be synchronous');
      }
      return result;
    };

    if (this.atomicDepth > 0) {
      this.atomicDepth++;
      try {
        return run();
      } catch (err) {
        this.atomicFailed = true;
        throw err;
      } finally {
        this.atomicDepth--;
      }
    }

    db.exec('BEGIN IMMEDIATE');
    this.atomicDepth = 1;
    this.atomicFailed = false;
    try {
      const result = run();
      if (this.atomicFailed) {
        throw new Error('atomic(): a joined unit failed, so the enclosing unit was rolled back');
      }
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        // The first error is the one the caller needs; SQLite has already ended the transaction.
      }
      throw err;
    } finally {
      this.atomicDepth = 0;
      this.atomicFailed = false;
    }
  }

  private executeGet<T = unknown>(compiled: CompiledQuery): T | undefined {
    if (this.rawDb) {
      const stmt = this.rawDb.prepare(compiled.sql);
      return (stmt.get as (...args: any[]) => any)(...(compiled.parameters as any[])) as
        | T
        | undefined;
    }
    throw new Error('Synchronous query execution is only supported on SQLite DatabaseSync');
  }

  private executeAll<T = unknown>(compiled: CompiledQuery): T[] {
    if (this.rawDb) {
      const stmt = this.rawDb.prepare(compiled.sql);
      return (stmt.all as (...args: any[]) => any)(...(compiled.parameters as any[])) as T[];
    }
    throw new Error('Synchronous query execution is only supported on SQLite DatabaseSync');
  }

  private executeRun(
    compiled: CompiledQuery
  ): { changes: number | bigint; lastInsertRowid: number | bigint } {
    if (this.rawDb) {
      const stmt = this.rawDb.prepare(compiled.sql);
      return (stmt.run as (...args: any[]) => any)(...(compiled.parameters as any[]));
    }
    throw new Error('Synchronous query execution is only supported on SQLite DatabaseSync');
  }

  private mapHeldMessageRow(row: any): HeldMessageRecord {
    let rawRfc822: Uint8Array;
    if (row.raw_rfc822 instanceof Uint8Array) {
      rawRfc822 = row.raw_rfc822;
    } else if (typeof row.raw_rfc822 === 'string') {
      rawRfc822 = Buffer.from(row.raw_rfc822, 'utf-8');
    } else {
      rawRfc822 = new Uint8Array(row.raw_rfc822);
    }
    return {
      id: row.id,
      senderEmail: row.sender_email,
      recipientAddress: row.recipient_address,
      dkimDomain: row.dkim_domain,
      subject: row.subject,
      rawRfc822,
      createdAtMs: Number(row.created_at),
      expiresAtMs: Number(row.expires_at),
      status: row.status,
    };
  }

  private mapThreadMappingRow(row: any): ThreadMappingRecord {
    return {
      conversationId: row.conversation_id,
      frankMessageId: row.frank_message_id,
      rfc822MessageId: row.rfc822_message_id,
      inReplyToRfc822: row.in_reply_to_rfc822 ?? undefined,
      subject: row.subject ?? undefined,
      senderAddress: row.sender_address ?? undefined,
      toRecipientsJson: row.to_recipients_json ?? undefined,
      ccRecipientsJson: row.cc_recipients_json ?? undefined,
      senderHomeRelay: row.sender_home_relay ?? undefined,
      createdAtMs: Number(row.created_at),
    };
  }

  private mapOutboundJobRow(row: any): OutboundSpoolJob {
    return {
      id: Number(row.id),
      recipientEmail: row.recipient_email,
      fromAddress: row.from_address,
      rawRfc822: row.raw_rfc822,
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      maxAttempts: Number(row.max_attempts),
      lastError: row.last_error ?? undefined,
      status: row.status,
    };
  }

  getBalance(email: string): number {
    const canonical = email.toLowerCase().trim();
    const compiled = this.db
      .selectFrom('credit_ledger')
      .select('balance')
      .where('email', '=', canonical)
      .compile();
    const row = this.executeGet<{ balance: number }>(compiled);
    return row ? Number(row.balance) : 0;
  }

  async getBalanceAsync(email: string): Promise<number> {
    const canonical = email.toLowerCase().trim();
    const row = await this.db
      .selectFrom('credit_ledger')
      .select('balance')
      .where('email', '=', canonical)
      .executeTakeFirst();
    return row ? Number(row.balance) : 0;
  }

  getThreadAllowance(senderEmail: string, recipientAddress: string): number {
    const compiled = this.db
      .selectFrom('thread_allowances')
      .select('remaining_replies')
      .where('sender_email', '=', senderEmail.toLowerCase().trim())
      .where('recipient_frank_addr', '=', recipientAddress.toLowerCase().trim())
      .compile();
    const row = this.executeGet<{ remaining_replies: number }>(compiled);
    return row ? Number(row.remaining_replies) : 0;
  }

  async getThreadAllowanceAsync(senderEmail: string, recipientAddress: string): Promise<number> {
    const row = await this.db
      .selectFrom('thread_allowances')
      .select('remaining_replies')
      .where('sender_email', '=', senderEmail.toLowerCase().trim())
      .where('recipient_frank_addr', '=', recipientAddress.toLowerCase().trim())
      .executeTakeFirst();
    return row ? Number(row.remaining_replies) : 0;
  }

  addCredits(
    email: string,
    amount: number,
    providerTxId?: string,
    provider: string = 'manual'
  ): void {
    const canonical = email.toLowerCase().trim();
    const now = Date.now();

    if (providerTxId) {
      const existingCompiled = this.db
        .selectFrom('transactions')
        .select('id')
        .where('id', '=', providerTxId)
        .compile();
      const existing = this.executeGet(existingCompiled);
      if (existing) {
        return; // Idempotent duplicate
      }

      const txCompiled = this.db
        .insertInto('transactions')
        .values({
          id: providerTxId,
          provider,
          amount_cents: 0,
          credits_added: amount,
          created_at: now,
        })
        .compile();
      this.executeRun(txCompiled);

      if (this.rawDb) {
        const ptCompiled = this.db
          .insertInto('payment_transactions' as any)
          .values({
            provider_tx_id: providerTxId,
            provider,
            sender_email: canonical,
            credits_added: amount,
            created_at: now,
          } as any)
          .compile();
        this.executeRun(ptCompiled);
      }
    }

    const ledgerCompiled = this.db
      .insertInto('credit_ledger')
      .values({
        email: canonical,
        balance: amount,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet((eb) => ({
          balance: eb('credit_ledger.balance', '+', eb.ref('excluded.balance')),
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .compile();
    this.executeRun(ledgerCompiled);
  }

  async addCreditsAsync(
    email: string,
    amount: number,
    providerTxId?: string,
    provider: string = 'manual'
  ): Promise<void> {
    const canonical = email.toLowerCase().trim();
    const now = Date.now();

    if (providerTxId) {
      const existing = await this.db
        .selectFrom('transactions')
        .select('id')
        .where('id', '=', providerTxId)
        .executeTakeFirst();
      if (existing) {
        return;
      }

      await this.db
        .insertInto('transactions')
        .values({
          id: providerTxId,
          provider,
          amount_cents: 0,
          credits_added: amount,
          created_at: now,
        })
        .execute();
    }

    await this.db
      .insertInto('credit_ledger')
      .values({
        email: canonical,
        balance: amount,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet((eb) => ({
          balance: eb('credit_ledger.balance', '+', eb.ref('excluded.balance')),
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .execute();
  }

  deductCredit(email: string, amount: number = 1): boolean {
    const canonical = email.toLowerCase().trim();
    const balance = this.getBalance(canonical);
    if (balance >= amount) {
      const now = Date.now();
      const compiled = this.db
        .updateTable('credit_ledger')
        .set({
          balance: balance - amount,
          updated_at: now,
        })
        .where('email', '=', canonical)
        .compile();
      this.executeRun(compiled);
      return true;
    }
    return false;
  }

  async deductCreditAsync(email: string, amount: number = 1): Promise<boolean> {
    const canonical = email.toLowerCase().trim();
    const balance = await this.getBalanceAsync(canonical);
    if (balance >= amount) {
      const now = Date.now();
      await this.db
        .updateTable('credit_ledger')
        .set({
          balance: balance - amount,
          updated_at: now,
        })
        .where('email', '=', canonical)
        .execute();
      return true;
    }
    return false;
  }

  hasReplyAllowance(senderEmail: string, recipientAddress: string): boolean {
    return this.getThreadAllowance(senderEmail, recipientAddress) > 0;
  }

  async hasReplyAllowanceAsync(
    senderEmail: string,
    recipientAddress: string
  ): Promise<boolean> {
    const allowance = await this.getThreadAllowanceAsync(senderEmail, recipientAddress);
    return allowance > 0;
  }

  consumeReplyAllowance(senderEmail: string, recipientAddress: string): boolean {
    const allowance = this.getThreadAllowance(senderEmail, recipientAddress);
    if (allowance > 0) {
      const now = Date.now();
      const canonicalSender = senderEmail.toLowerCase().trim();
      const canonicalRecipient = recipientAddress.toLowerCase().trim();
      const compiled = this.db
        .updateTable('thread_allowances')
        .set({
          remaining_replies: allowance - 1,
          updated_at: now,
        })
        .where('sender_email', '=', canonicalSender)
        .where('recipient_frank_addr', '=', canonicalRecipient)
        .compile();
      this.executeRun(compiled);
      return true;
    }
    return false;
  }

  async consumeReplyAllowanceAsync(
    senderEmail: string,
    recipientAddress: string
  ): Promise<boolean> {
    const allowance = await this.getThreadAllowanceAsync(senderEmail, recipientAddress);
    if (allowance > 0) {
      const now = Date.now();
      const canonicalSender = senderEmail.toLowerCase().trim();
      const canonicalRecipient = recipientAddress.toLowerCase().trim();
      await this.db
        .updateTable('thread_allowances')
        .set({
          remaining_replies: allowance - 1,
          updated_at: now,
        })
        .where('sender_email', '=', canonicalSender)
        .where('recipient_frank_addr', '=', canonicalRecipient)
        .execute();
      return true;
    }
    return false;
  }

  grantReplyAllowance(senderEmail: string, recipientAddress: string, count: number = 3): void {
    const now = Date.now();
    const canonicalSender = senderEmail.toLowerCase().trim();
    const canonicalRecipient = recipientAddress.toLowerCase().trim();
    const compiled = this.db
      .insertInto('thread_allowances')
      .values({
        sender_email: canonicalSender,
        recipient_frank_addr: canonicalRecipient,
        remaining_replies: count,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['sender_email', 'recipient_frank_addr']).doUpdateSet((eb) => ({
          remaining_replies: eb(
            'thread_allowances.remaining_replies',
            '+',
            eb.ref('excluded.remaining_replies')
          ),
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .compile();
    this.executeRun(compiled);
  }

  async grantReplyAllowanceAsync(
    senderEmail: string,
    recipientAddress: string,
    count: number = 3
  ): Promise<void> {
    const now = Date.now();
    const canonicalSender = senderEmail.toLowerCase().trim();
    const canonicalRecipient = recipientAddress.toLowerCase().trim();
    await this.db
      .insertInto('thread_allowances')
      .values({
        sender_email: canonicalSender,
        recipient_frank_addr: canonicalRecipient,
        remaining_replies: count,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['sender_email', 'recipient_frank_addr']).doUpdateSet((eb) => ({
          remaining_replies: eb(
            'thread_allowances.remaining_replies',
            '+',
            eb.ref('excluded.remaining_replies')
          ),
          updated_at: eb.ref('excluded.updated_at'),
        }))
      )
      .execute();
  }

  consumeCredit(senderEmail: string, recipientAddress: string): boolean {
    if (this.consumeReplyAllowance(senderEmail, recipientAddress)) {
      return true;
    }
    return this.deductCredit(senderEmail, 1);
  }

  async consumeCreditAsync(senderEmail: string, recipientAddress: string): Promise<boolean> {
    if (await this.consumeReplyAllowanceAsync(senderEmail, recipientAddress)) {
      return true;
    }
    return this.deductCreditAsync(senderEmail, 1);
  }

  recordTransaction(params: {
    id: string;
    provider: string;
    amountCents?: number;
    amount_cents?: number;
    creditsAdded?: number;
    credits_added?: number;
    createdAt?: number;
    created_at?: number;
  }): void {
    const amount = params.amountCents ?? params.amount_cents ?? 0;
    const credits = params.creditsAdded ?? params.credits_added ?? 0;
    const created = params.createdAt ?? params.created_at ?? Date.now();
    const compiled = this.db
      .insertInto('transactions')
      .values({
        id: params.id,
        provider: params.provider,
        amount_cents: amount,
        credits_added: credits,
        created_at: created,
      })
      .compile();
    this.executeRun(compiled);
  }

  async recordTransactionAsync(params: {
    id: string;
    provider: string;
    amountCents?: number;
    amount_cents?: number;
    creditsAdded?: number;
    credits_added?: number;
    createdAt?: number;
    created_at?: number;
  }): Promise<void> {
    const amount = params.amountCents ?? params.amount_cents ?? 0;
    const credits = params.creditsAdded ?? params.credits_added ?? 0;
    const created = params.createdAt ?? params.created_at ?? Date.now();
    await this.db
      .insertInto('transactions')
      .values({
        id: params.id,
        provider: params.provider,
        amount_cents: amount,
        credits_added: credits,
        created_at: created,
      })
      .execute();
  }

  async holdMessage(record: Omit<HeldMessageRecord, 'status'>): Promise<void> {
    let rawToStore: Uint8Array = record.rawRfc822;

    if (
      this.blobStore &&
      record.rawRfc822.byteLength > BLOB_OFFLOAD_THRESHOLD_BYTES
    ) {
      const key = `held/${record.id}.eml`;
      await this.blobStore.put(key, record.rawRfc822);
      rawToStore = Buffer.from(`blob://${key}`, 'utf-8');
    }

    const compiled = this.db
      .insertInto('held_messages')
      .values({
        id: record.id,
        sender_email: record.senderEmail.toLowerCase().trim(),
        recipient_address: record.recipientAddress.toLowerCase().trim(),
        dkim_domain: record.dkimDomain.toLowerCase().trim(),
        subject: record.subject,
        raw_rfc822: rawToStore,
        created_at: record.createdAtMs,
        expires_at: record.expiresAtMs,
        status: 'held',
      })
      .compile();
    this.executeRun(compiled);
  }

  async holdMessageAsync(record: Omit<HeldMessageRecord, 'status'>): Promise<void> {
    return this.holdMessage(record);
  }

  getHeldMessage(id: string): HeldMessageRecord | undefined {
    const compiled = this.db
      .selectFrom('held_messages')
      .selectAll()
      .where('id', '=', id)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapHeldMessageRow(row);
  }

  async getHeldMessageAsync(id: string): Promise<HeldMessageRecord | undefined> {
    const row = await this.db
      .selectFrom('held_messages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapHeldMessageRow(row);
  }

  findLatestHeldMessage(
    senderEmail: string,
    recipientAddress?: string
  ): HeldMessageRecord | undefined {
    let query = this.db
      .selectFrom('held_messages')
      .selectAll()
      .where('sender_email', '=', senderEmail.toLowerCase().trim())
      .where('status', '=', 'held');

    if (recipientAddress) {
      query = query.where('recipient_address', '=', recipientAddress.toLowerCase().trim());
    }

    const compiled = query.orderBy('created_at', 'desc').limit(1).compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapHeldMessageRow(row);
  }

  getHeldMessageCount(status: string = 'held'): number {
    try {
      if (this.rawDb) {
        const stmt = this.rawDb.prepare('SELECT COUNT(*) as count FROM held_messages WHERE status = ?');
        const row = stmt.get(status) as any;
        return Number(row?.count ?? 0);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  getPendingSpoolCount(): number {
    try {
      if (this.rawDb) {
        const stmt = this.rawDb.prepare('SELECT COUNT(*) as count FROM outbound_spool WHERE status = ?');
        const row = stmt.get('pending') as any;
        return Number(row?.count ?? 0);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  async findLatestHeldMessageAsync(
    senderEmail: string,
    recipientAddress?: string
  ): Promise<HeldMessageRecord | undefined> {
    let query = this.db
      .selectFrom('held_messages')
      .selectAll()
      .where('sender_email', '=', senderEmail.toLowerCase().trim())
      .where('status', '=', 'held');

    if (recipientAddress) {
      query = query.where('recipient_address', '=', recipientAddress.toLowerCase().trim());
    }

    const row = await query.orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (!row) return undefined;
    return this.mapHeldMessageRow(row);
  }

  releaseHeldMessage(id: string): HeldMessageRecord | undefined {
    const msg = this.getHeldMessage(id);
    if (!msg || msg.status !== 'held') return undefined;

    const compiled = this.db
      .updateTable('held_messages')
      .set({ status: 'released' })
      .where('id', '=', id)
      .compile();
    this.executeRun(compiled);
    return { ...msg, status: 'released' };
  }

  async releaseHeldMessageAsync(id: string): Promise<HeldMessageRecord | undefined> {
    const msg = await this.getHeldMessageAsync(id);
    if (!msg || msg.status !== 'held') return undefined;

    await this.db
      .updateTable('held_messages')
      .set({ status: 'released' })
      .where('id', '=', id)
      .execute();
    return { ...msg, status: 'released' };
  }

  purgeExpiredHeldMessages(): number {
    const now = Date.now();
    const compiled = this.db
      .updateTable('held_messages')
      .set({ status: 'expired' })
      .where('expires_at', '<', now)
      .where('status', '=', 'held')
      .compile();
    const result = this.executeRun(compiled);
    return Number(result.changes);
  }

  async purgeExpiredHeldMessagesAsync(): Promise<number> {
    const now = Date.now();
    const result = await this.db
      .updateTable('held_messages')
      .set({ status: 'expired' })
      .where('expires_at', '<', now)
      .where('status', '=', 'held')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  recordThreadMapping(mapping: ThreadMappingRecord): void {
    const compiled = this.db
      .insertInto('thread_mappings')
      .values({
        conversation_id: mapping.conversationId,
        frank_message_id: mapping.frankMessageId,
        rfc822_message_id: mapping.rfc822MessageId,
        in_reply_to_rfc822: mapping.inReplyToRfc822 ?? null,
        subject: mapping.subject ?? null,
        sender_address: mapping.senderAddress ?? null,
        to_recipients_json: mapping.toRecipientsJson ?? null,
        cc_recipients_json: mapping.ccRecipientsJson ?? null,
        sender_home_relay: mapping.senderHomeRelay ?? null,
        created_at: mapping.createdAtMs,
      })
      .onConflict((oc) =>
        oc.columns(['conversation_id', 'frank_message_id']).doUpdateSet((eb) => ({
          rfc822_message_id: eb.ref('excluded.rfc822_message_id'),
          in_reply_to_rfc822: eb.ref('excluded.in_reply_to_rfc822'),
          subject: eb.ref('excluded.subject'),
          sender_address: eb.ref('excluded.sender_address'),
          to_recipients_json: eb.ref('excluded.to_recipients_json'),
          cc_recipients_json: eb.ref('excluded.cc_recipients_json'),
          sender_home_relay: eb.ref('excluded.sender_home_relay'),
          created_at: eb.ref('excluded.created_at'),
        }))
      )
      .compile();
    this.executeRun(compiled);
  }

  async recordThreadMappingAsync(mapping: ThreadMappingRecord): Promise<void> {
    await this.db
      .insertInto('thread_mappings')
      .values({
        conversation_id: mapping.conversationId,
        frank_message_id: mapping.frankMessageId,
        rfc822_message_id: mapping.rfc822MessageId,
        in_reply_to_rfc822: mapping.inReplyToRfc822 ?? null,
        subject: mapping.subject ?? null,
        sender_address: mapping.senderAddress ?? null,
        to_recipients_json: mapping.toRecipientsJson ?? null,
        cc_recipients_json: mapping.ccRecipientsJson ?? null,
        sender_home_relay: mapping.senderHomeRelay ?? null,
        created_at: mapping.createdAtMs,
      })
      .onConflict((oc) =>
        oc.columns(['conversation_id', 'frank_message_id']).doUpdateSet((eb) => ({
          rfc822_message_id: eb.ref('excluded.rfc822_message_id'),
          in_reply_to_rfc822: eb.ref('excluded.in_reply_to_rfc822'),
          subject: eb.ref('excluded.subject'),
          sender_address: eb.ref('excluded.sender_address'),
          to_recipients_json: eb.ref('excluded.to_recipients_json'),
          cc_recipients_json: eb.ref('excluded.cc_recipients_json'),
          sender_home_relay: eb.ref('excluded.sender_home_relay'),
          created_at: eb.ref('excluded.created_at'),
        }))
      )
      .execute();
  }

  getThreadMappingByFrankMessageId(
    conversationId: string,
    frankMessageId: string
  ): ThreadMappingRecord | undefined {
    const compiled = this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('frank_message_id', '=', frankMessageId)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  async getThreadMappingByFrankMessageIdAsync(
    conversationId: string,
    frankMessageId: string
  ): Promise<ThreadMappingRecord | undefined> {
    const row = await this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('frank_message_id', '=', frankMessageId)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  getThreadMappingByRfc822Id(rfc822MessageId: string): ThreadMappingRecord | undefined {
    const compiled = this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('rfc822_message_id', '=', rfc822MessageId)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  async getThreadMappingByRfc822IdAsync(
    rfc822MessageId: string
  ): Promise<ThreadMappingRecord | undefined> {
    const row = await this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('rfc822_message_id', '=', rfc822MessageId)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  getLatestThreadMappingByConversationId(
    conversationId: string
  ): ThreadMappingRecord | undefined {
    const compiled = this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  async getLatestThreadMappingByConversationIdAsync(
    conversationId: string
  ): Promise<ThreadMappingRecord | undefined> {
    const row = await this.db
      .selectFrom('thread_mappings')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapThreadMappingRow(row);
  }

  countInitiatedThreadsInPast24Hours(frankSenderAddress: string): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const compiled = this.db
      .selectFrom('thread_mappings')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('sender_address', '=', frankSenderAddress)
      .where('created_at', '>=', cutoff)
      .compile();
    const row = this.executeGet<{ total: number | bigint }>(compiled);
    return Number(row?.total ?? 0);
  }

  async countInitiatedThreadsInPast24HoursAsync(frankSenderAddress: string): Promise<number> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const row = await this.db
      .selectFrom('thread_mappings')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('sender_address', '=', frankSenderAddress)
      .where('created_at', '>=', cutoff)
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async enqueueOutboundSpool(params: {
    recipientEmail: string;
    fromAddress: string;
    rawRfc822: string;
    nextAttemptAt?: number;
    maxAttempts?: number;
  }): Promise<number> {
    const nextAttempt = params.nextAttemptAt ?? Date.now();
    const maxAttempts = params.maxAttempts ?? 10;
    let rawToStore = params.rawRfc822;

    if (
      this.blobStore &&
      Buffer.byteLength(params.rawRfc822, 'utf-8') > BLOB_OFFLOAD_THRESHOLD_BYTES
    ) {
      const key = `spool/${Date.now()}_${crypto.randomUUID()}.eml`;
      await this.blobStore.put(key, params.rawRfc822);
      rawToStore = `blob://${key}`;
    }

    const compiled = this.db
      .insertInto('outbound_spool')
      .values({
        recipient_email: params.recipientEmail.toLowerCase().trim(),
        from_address: params.fromAddress.toLowerCase().trim(),
        raw_rfc822: rawToStore,
        attempts: 0,
        next_attempt_at: nextAttempt,
        max_attempts: maxAttempts,
        last_error: null,
        status: 'pending',
      })
      .compile();
    const result = this.executeRun(compiled);
    return Number(result.lastInsertRowid);
  }

  async enqueueOutboundSpoolAsync(params: {
    recipientEmail: string;
    fromAddress: string;
    rawRfc822: string;
    nextAttemptAt?: number;
    maxAttempts?: number;
  }): Promise<number> {
    return this.enqueueOutboundSpool(params);
  }

  async resolvePayload(rawOrPointer: string | Uint8Array): Promise<string> {
    const text =
      typeof rawOrPointer === 'string'
        ? rawOrPointer
        : new TextDecoder('utf-8').decode(rawOrPointer);

    if (text.startsWith('blob://')) {
      const key = text.slice('blob://'.length);
      const data = await this.blobStore.get(key);
      if (!data) {
        throw new Error(`Blob not found for pointer: ${text}`);
      }
      return new TextDecoder('utf-8').decode(data);
    }

    return text;
  }

  getPendingOutboundJobs(nowMs: number, limit: number = 50): OutboundSpoolJob[] {
    const compiled = this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', nowMs)
      .orderBy('next_attempt_at', 'asc')
      .limit(limit)
      .compile();
    const rows = this.executeAll<any>(compiled);
    return rows.map((r) => this.mapOutboundJobRow(r));
  }

  async getPendingOutboundJobsAsync(
    nowMs: number,
    limit: number = 50
  ): Promise<OutboundSpoolJob[]> {
    const rows = await this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', nowMs)
      .orderBy('next_attempt_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => this.mapOutboundJobRow(r));
  }

  markOutboundJobSuccess(id: number): void {
    const compiled = this.db
      .updateTable('outbound_spool')
      .set({ status: 'success' })
      .where('id', '=', id)
      .compile();
    this.executeRun(compiled);
  }

  async markOutboundJobSuccessAsync(id: number): Promise<void> {
    await this.db
      .updateTable('outbound_spool')
      .set({ status: 'success' })
      .where('id', '=', id)
      .execute();
  }

  markOutboundJobFailed(
    id: number,
    error: string,
    nowMs: number,
    backoffMs: number
  ): boolean {
    const compiled = this.db
      .selectFrom('outbound_spool')
      .select(['id', 'attempts', 'max_attempts'])
      .where('id', '=', id)
      .compile();
    const row = this.executeGet<{ id: number; attempts: number; max_attempts: number }>(
      compiled
    );

    if (!row) {
      return false;
    }

    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.max_attempts) {
      const updateCompiled = this.db
        .updateTable('outbound_spool')
        .set({
          attempts: newAttempts,
          last_error: error,
          status: 'failed',
        })
        .where('id', '=', id)
        .compile();
      this.executeRun(updateCompiled);
      return false;
    } else {
      const nextAttemptAt = nowMs + backoffMs;
      const updateCompiled = this.db
        .updateTable('outbound_spool')
        .set({
          attempts: newAttempts,
          next_attempt_at: nextAttemptAt,
          last_error: error,
        })
        .where('id', '=', id)
        .compile();
      this.executeRun(updateCompiled);
      return true;
    }
  }

  async markOutboundJobFailedAsync(
    id: number,
    error: string,
    nowMs: number,
    backoffMs: number
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('outbound_spool')
      .select(['id', 'attempts', 'max_attempts'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      return false;
    }

    const newAttempts = Number(row.attempts) + 1;
    if (newAttempts >= Number(row.max_attempts)) {
      await this.db
        .updateTable('outbound_spool')
        .set({
          attempts: newAttempts,
          last_error: error,
          status: 'failed',
        })
        .where('id', '=', id)
        .execute();
      return false;
    } else {
      const nextAttemptAt = nowMs + backoffMs;
      await this.db
        .updateTable('outbound_spool')
        .set({
          attempts: newAttempts,
          next_attempt_at: nextAttemptAt,
          last_error: error,
        })
        .where('id', '=', id)
        .execute();
      return true;
    }
  }

  getOutboundJob(id: number): OutboundSpoolJob | undefined {
    const compiled = this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('id', '=', id)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapOutboundJobRow(row);
  }

  async getOutboundJobAsync(id: number): Promise<OutboundSpoolJob | undefined> {
    const row = await this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapOutboundJobRow(row);
  }

  findSpoolJobByRecipient(recipientEmail: string): OutboundSpoolJob | undefined {
    const compiled = this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('recipient_email', '=', recipientEmail.toLowerCase().trim())
      .orderBy('id', 'desc')
      .limit(1)
      .compile();
    const row = this.executeGet<any>(compiled);
    if (!row) return undefined;
    return this.mapOutboundJobRow(row);
  }

  async findSpoolJobByRecipientAsync(
    recipientEmail: string
  ): Promise<OutboundSpoolJob | undefined> {
    const row = await this.db
      .selectFrom('outbound_spool')
      .selectAll()
      .where('recipient_email', '=', recipientEmail.toLowerCase().trim())
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.mapOutboundJobRow(row);
  }

  findFrankSenderForRecipient(recipientEmail: string): string | undefined {
    const canonical = recipientEmail.toLowerCase().trim();
    const allowanceCompiled = this.db
      .selectFrom('thread_allowances')
      .select('recipient_frank_addr')
      .where('sender_email', '=', canonical)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .compile();
    const allowanceRow = this.executeGet<{ recipient_frank_addr: string }>(allowanceCompiled);
    if (allowanceRow) {
      return allowanceRow.recipient_frank_addr;
    }

    const spoolCompiled = this.db
      .selectFrom('outbound_spool')
      .select('from_address')
      .where('recipient_email', '=', canonical)
      .orderBy('id', 'desc')
      .limit(1)
      .compile();
    const spoolRow = this.executeGet<{ from_address: string }>(spoolCompiled);
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }

  async findFrankSenderForRecipientAsync(recipientEmail: string): Promise<string | undefined> {
    const canonical = recipientEmail.toLowerCase().trim();
    const allowanceRow = await this.db
      .selectFrom('thread_allowances')
      .select('recipient_frank_addr')
      .where('sender_email', '=', canonical)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (allowanceRow) {
      return allowanceRow.recipient_frank_addr;
    }

    const spoolRow = await this.db
      .selectFrom('outbound_spool')
      .select('from_address')
      .where('recipient_email', '=', canonical)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }

  findFrankSenderByRfc822Id(rfc822MessageId: string): string | undefined {
    const thread = this.getThreadMappingByRfc822Id(rfc822MessageId);
    if (thread) {
      const allowanceCompiled = this.db
        .selectFrom('thread_allowances')
        .select('recipient_frank_addr')
        .orderBy('updated_at', 'desc')
        .limit(1)
        .compile();
      const allowanceRow = this.executeGet<{ recipient_frank_addr: string }>(allowanceCompiled);
      if (allowanceRow) {
        return allowanceRow.recipient_frank_addr;
      }
    }

    const spoolCompiled = this.db
      .selectFrom('outbound_spool')
      .select('from_address')
      .where('raw_rfc822', 'like', `%${rfc822MessageId}%`)
      .orderBy('id', 'desc')
      .limit(1)
      .compile();
    const spoolRow = this.executeGet<{ from_address: string }>(spoolCompiled);
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }

  async findFrankSenderByRfc822IdAsync(rfc822MessageId: string): Promise<string | undefined> {
    const thread = await this.getThreadMappingByRfc822IdAsync(rfc822MessageId);
    if (thread) {
      const allowanceRow = await this.db
        .selectFrom('thread_allowances')
        .select('recipient_frank_addr')
        .orderBy('updated_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (allowanceRow) {
        return allowanceRow.recipient_frank_addr;
      }
    }

    const spoolRow = await this.db
      .selectFrom('outbound_spool')
      .select('from_address')
      .where('raw_rfc822', 'like', `%${rfc822MessageId}%`)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }
}
