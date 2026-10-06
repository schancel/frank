import { DatabaseSync } from 'node:sqlite';
import { HeldMessageRecord, ThreadMappingRecord, OutboundSpoolJob } from '../types';

export class CreditLedger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
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

      CREATE TABLE IF NOT EXISTS thread_mappings (
        conversation_id TEXT NOT NULL,
        frank_message_id TEXT NOT NULL,
        rfc822_message_id TEXT NOT NULL,
        in_reply_to_rfc822 TEXT,
        subject TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_outbound_spool_pending ON outbound_spool(status, next_attempt_at);
    `);
  }

  getBalance(email: string): number {
    const canonical = email.toLowerCase().trim();
    const query = this.db.prepare('SELECT balance FROM credit_ledger WHERE email = ?');
    const row = query.get(canonical) as { balance: number } | undefined;
    return row ? row.balance : 0;
  }

  getThreadAllowance(senderEmail: string, recipientAddress: string): number {
    const query = this.db.prepare(
      'SELECT remaining_replies FROM thread_allowances WHERE sender_email = ? AND recipient_frank_addr = ?'
    );
    const row = query.get(
      senderEmail.toLowerCase().trim(),
      recipientAddress.toLowerCase().trim()
    ) as { remaining_replies: number } | undefined;
    return row ? row.remaining_replies : 0;
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
      // Check deduplication
      const existing = this.db
        .prepare('SELECT provider_tx_id FROM payment_transactions WHERE provider_tx_id = ?')
        .get(providerTxId);
      if (existing) {
        return; // Idempotent duplicate
      }
      this.db
        .prepare(
          'INSERT INTO payment_transactions (provider_tx_id, provider, sender_email, credits_added, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(providerTxId, provider, canonical, amount, now);
    }

    this.db
      .prepare(
        `INSERT INTO credit_ledger (email, balance, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at`
      )
      .run(canonical, amount, now);
  }

  grantReplyAllowance(senderEmail: string, recipientAddress: string, count: number = 3): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO thread_allowances (sender_email, recipient_frank_addr, remaining_replies, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sender_email, recipient_frank_addr) DO UPDATE SET
           remaining_replies = remaining_replies + excluded.remaining_replies,
           updated_at = excluded.updated_at`
      )
      .run(senderEmail.toLowerCase().trim(), recipientAddress.toLowerCase().trim(), count, now);
  }

  /**
   * Attempts to consume 1 delivery credit.
   * Priority:
   * 1. Consumes a thread-scoped reply allowance if one exists.
   * 2. Else consumes a purchased global credit.
   * Returns true if credit was available and consumed; false otherwise.
   */
  consumeCredit(senderEmail: string, recipientAddress: string): boolean {
    const canonicalSender = senderEmail.toLowerCase().trim();
    const canonicalRecipient = recipientAddress.toLowerCase().trim();
    const now = Date.now();

    // 1. Check thread allowance
    const allowance = this.getThreadAllowance(canonicalSender, canonicalRecipient);
    if (allowance > 0) {
      this.db
        .prepare(
          'UPDATE thread_allowances SET remaining_replies = remaining_replies - 1, updated_at = ? WHERE sender_email = ? AND recipient_frank_addr = ?'
        )
        .run(now, canonicalSender, canonicalRecipient);
      return true;
    }

    // 2. Check purchased credits
    const balance = this.getBalance(canonicalSender);
    if (balance > 0) {
      this.db
        .prepare('UPDATE credit_ledger SET balance = balance - 1, updated_at = ? WHERE email = ?')
        .run(now, canonicalSender);
      return true;
    }

    return false;
  }

  holdMessage(record: Omit<HeldMessageRecord, 'status'>): void {
    this.db
      .prepare(
        `INSERT INTO held_messages (id, sender_email, recipient_address, dkim_domain, subject, raw_rfc822, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held')`
      )
      .run(
        record.id,
        record.senderEmail.toLowerCase().trim(),
        record.recipientAddress.toLowerCase().trim(),
        record.dkimDomain.toLowerCase().trim(),
        record.subject,
        record.rawRfc822,
        record.createdAtMs,
        record.expiresAtMs
      );
  }

  getHeldMessage(id: string): HeldMessageRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, sender_email, recipient_address, dkim_domain, subject, raw_rfc822, created_at, expires_at, status FROM held_messages WHERE id = ?'
      )
      .get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      senderEmail: row.sender_email,
      recipientAddress: row.recipient_address,
      dkimDomain: row.dkim_domain,
      subject: row.subject,
      rawRfc822: row.raw_rfc822,
      createdAtMs: row.created_at,
      expiresAtMs: row.expires_at,
      status: row.status,
    };
  }

  findLatestHeldMessage(
    senderEmail: string,
    recipientAddress?: string
  ): HeldMessageRecord | undefined {
    const canonicalSender = senderEmail.toLowerCase().trim();
    let sql =
      "SELECT id, sender_email, recipient_address, dkim_domain, subject, raw_rfc822, created_at, expires_at, status FROM held_messages WHERE sender_email = ? AND status = 'held'";
    const params: any[] = [canonicalSender];
    if (recipientAddress) {
      sql += ' AND recipient_address = ?';
      params.push(recipientAddress.toLowerCase().trim());
    }
    sql += ' ORDER BY created_at DESC LIMIT 1';
    const row = this.db.prepare(sql).get(...params) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      senderEmail: row.sender_email,
      recipientAddress: row.recipient_address,
      dkimDomain: row.dkim_domain,
      subject: row.subject,
      rawRfc822: row.raw_rfc822,
      createdAtMs: row.created_at,
      expiresAtMs: row.expires_at,
      status: row.status,
    };
  }

  releaseHeldMessage(id: string): HeldMessageRecord | undefined {
    const msg = this.getHeldMessage(id);
    if (!msg || msg.status !== 'held') return undefined;

    this.db.prepare("UPDATE held_messages SET status = 'released' WHERE id = ?").run(id);
    return { ...msg, status: 'released' };
  }

  purgeExpiredHeldMessages(): number {
    const now = Date.now();
    const result = this.db
      .prepare("UPDATE held_messages SET status = 'expired' WHERE expires_at < ? AND status = 'held'")
      .run(now);
    return Number(result.changes);
  }

  recordThreadMapping(mapping: ThreadMappingRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_mappings (conversation_id, frank_message_id, rfc822_message_id, in_reply_to_rfc822, subject, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        mapping.conversationId,
        mapping.frankMessageId,
        mapping.rfc822MessageId,
        mapping.inReplyToRfc822 ?? null,
        mapping.subject ?? null,
        mapping.createdAtMs
      );
  }

  getThreadMappingByFrankMessageId(
    conversationId: string,
    frankMessageId: string
  ): ThreadMappingRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT conversation_id, frank_message_id, rfc822_message_id, in_reply_to_rfc822, subject, created_at FROM thread_mappings WHERE conversation_id = ? AND frank_message_id = ?'
      )
      .get(conversationId, frankMessageId) as any;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      frankMessageId: row.frank_message_id,
      rfc822MessageId: row.rfc822_message_id,
      inReplyToRfc822: row.in_reply_to_rfc822 ?? undefined,
      subject: row.subject ?? undefined,
      createdAtMs: row.created_at,
    };
  }

  getThreadMappingByRfc822Id(rfc822MessageId: string): ThreadMappingRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT conversation_id, frank_message_id, rfc822_message_id, in_reply_to_rfc822, subject, created_at FROM thread_mappings WHERE rfc822_message_id = ?'
      )
      .get(rfc822MessageId) as any;
    if (!row) return undefined;
    return {
      conversationId: row.conversation_id,
      frankMessageId: row.frank_message_id,
      rfc822MessageId: row.rfc822_message_id,
      inReplyToRfc822: row.in_reply_to_rfc822 ?? undefined,
      subject: row.subject ?? undefined,
      createdAtMs: row.created_at,
    };
  }

  enqueueOutboundSpool(params: {
    recipientEmail: string;
    fromAddress: string;
    rawRfc822: string;
    nextAttemptAt?: number;
    maxAttempts?: number;
  }): number {
    const nextAttempt = params.nextAttemptAt ?? Date.now();
    const maxAttempts = params.maxAttempts ?? 10;
    const result = this.db
      .prepare(
        `INSERT INTO outbound_spool (recipient_email, from_address, raw_rfc822, attempts, next_attempt_at, max_attempts, last_error, status)
         VALUES (?, ?, ?, 0, ?, ?, NULL, 'pending')`
      )
      .run(
        params.recipientEmail.toLowerCase().trim(),
        params.fromAddress.toLowerCase().trim(),
        params.rawRfc822,
        nextAttempt,
        maxAttempts
      );
    return Number(result.lastInsertRowid);
  }

  getPendingOutboundJobs(nowMs: number, limit: number = 50): OutboundSpoolJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, recipient_email, from_address, raw_rfc822, attempts, next_attempt_at, max_attempts, last_error, status
         FROM outbound_spool
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as any[];

    return rows.map((r) => ({
      id: Number(r.id),
      recipientEmail: r.recipient_email,
      fromAddress: r.from_address,
      rawRfc822: r.raw_rfc822,
      attempts: Number(r.attempts),
      nextAttemptAt: Number(r.next_attempt_at),
      maxAttempts: Number(r.max_attempts),
      lastError: r.last_error ?? undefined,
      status: r.status,
    }));
  }

  markOutboundJobSuccess(id: number): void {
    this.db
      .prepare("UPDATE outbound_spool SET status = 'success' WHERE id = ?")
      .run(id);
  }

  markOutboundJobFailed(
    id: number,
    error: string,
    nowMs: number,
    backoffMs: number
  ): boolean {
    const row = this.db
      .prepare('SELECT id, attempts, max_attempts FROM outbound_spool WHERE id = ?')
      .get(id) as { id: number; attempts: number; max_attempts: number } | undefined;

    if (!row) {
      return false;
    }

    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.max_attempts) {
      this.db
        .prepare(
          "UPDATE outbound_spool SET attempts = ?, last_error = ?, status = 'failed' WHERE id = ?"
        )
        .run(newAttempts, error, id);
      return false;
    } else {
      const nextAttemptAt = nowMs + backoffMs;
      this.db
        .prepare(
          'UPDATE outbound_spool SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?'
        )
        .run(newAttempts, nextAttemptAt, error, id);
      return true;
    }
  }

  getOutboundJob(id: number): OutboundSpoolJob | undefined {
    const row = this.db
      .prepare(
        'SELECT id, recipient_email, from_address, raw_rfc822, attempts, next_attempt_at, max_attempts, last_error, status FROM outbound_spool WHERE id = ?'
      )
      .get(id) as any;
    if (!row) return undefined;
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

  findSpoolJobByRecipient(recipientEmail: string): OutboundSpoolJob | undefined {
    const row = this.db
      .prepare(
        'SELECT id, recipient_email, from_address, raw_rfc822, attempts, next_attempt_at, max_attempts, last_error, status FROM outbound_spool WHERE recipient_email = ? ORDER BY id DESC LIMIT 1'
      )
      .get(recipientEmail.toLowerCase().trim()) as any;
    if (!row) return undefined;
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

  findFrankSenderForRecipient(recipientEmail: string): string | undefined {
    const canonical = recipientEmail.toLowerCase().trim();
    // 1. Check thread_allowances (stores external sender_email -> recipient_frank_addr)
    const allowanceRow = this.db
      .prepare(
        'SELECT recipient_frank_addr FROM thread_allowances WHERE sender_email = ? ORDER BY updated_at DESC LIMIT 1'
      )
      .get(canonical) as { recipient_frank_addr: string } | undefined;
    if (allowanceRow) {
      return allowanceRow.recipient_frank_addr;
    }

    // 2. Check outbound_spool
    const spoolRow = this.db
      .prepare(
        'SELECT from_address FROM outbound_spool WHERE recipient_email = ? ORDER BY id DESC LIMIT 1'
      )
      .get(canonical) as { from_address: string } | undefined;
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }

  findFrankSenderByRfc822Id(rfc822MessageId: string): string | undefined {
    // 1. Check thread mappings
    const thread = this.getThreadMappingByRfc822Id(rfc822MessageId);
    if (thread) {
      const allowanceRow = this.db
        .prepare('SELECT recipient_frank_addr FROM thread_allowances ORDER BY updated_at DESC LIMIT 1')
        .get() as { recipient_frank_addr: string } | undefined;
      if (allowanceRow) {
        return allowanceRow.recipient_frank_addr;
      }
    }

    // 2. Check outbound_spool for raw_rfc822 containing message-id
    const spoolRow = this.db
      .prepare(
        "SELECT from_address FROM outbound_spool WHERE raw_rfc822 LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1"
      )
      .get(rfc822MessageId) as { from_address: string } | undefined;
    if (spoolRow) {
      return spoolRow.from_address.split('@')[0];
    }

    return undefined;
  }
}
