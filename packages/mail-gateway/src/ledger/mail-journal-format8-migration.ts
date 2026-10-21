/**
 * The one migration the mail journal has: format 8 to format 9 (#1347 content-hash model),
 * in place, in one SQLite transaction, after a backup copy of the file.
 *
 * The owner asked for this migration once, for the production gateway volume written
 * before format 9 landed. It is the only exception to "no migration and no reader for
 * any other format": every other format, 7 and below included, is still refused at open.
 *
 * Schema mapping, format 8 to format 9:
 *
 * - `mail_message`: the key changes from (scope_account, rfc_message_id) to
 *   (scope_account, mail_key), with a new unique (scope_account, item_key) index on
 *   outbound rows and a lookup index on (scope_account, rfc_message_id, created_at);
 *   `claimed_rfc_id` is gone. Every row is copied in its original rowid order (format 9
 *   breaks parent-lookup ties by rowid), with `rfc_message_id` set to the Message-ID the
 *   email actually carried:
 *   - an inbound row (`email_to_frank`) that format 8 stored as contested, under
 *     `<mailKey@contested.{domain}>`, gets back its real Message-ID, `claimed_rfc_id`,
 *     which must equal the `rfc_message_id` of its `inbound_email` row;
 *   - an outbound row (`frank_to_email`) keeps its `rfc_message_id`. A contested outbound
 *     email was rendered, signed and sent under `<itemKey@contested.{domain}>`, so that is
 *     the Message-ID it carries and the one replies name. The Message-ID its author chose
 *     (`claimed_rfc_id`) was never on the wire; format 9 has no column for it, and it
 *     remains in the backup copy;
 *   - every other column is copied unchanged.
 * - `outbound_job`: `rfc_message_id` becomes `mail_key`, the mail key of the
 *   `mail_message` row the job referenced by (scope, rfc_message_id). The unique key and
 *   the foreign key follow. `job_id`, every other column and the AUTOINCREMENT sequence
 *   are kept.
 * - `inbound_email`: rows unchanged; the index `idx_inbound_email_claim` (the per-Message-ID
 *   claim cap that format 9 removed) is dropped.
 * - `mail_journal_meta`, `mail_thread`, `issued_mailbox`, `frank_send`, `frank_inbound`:
 *   unchanged (same DDL in both formats). The marker becomes format 9.
 *
 * Fail closed: the migration runs only on a database whose journal schema is exactly the
 * format-8 DDL and whose marker names this gateway's chain, account and domain. Any row it
 * cannot carry over faithfully (two messages with one mail key or one item key in a scope,
 * a contested inbound message whose real Message-ID cannot be confirmed, a job whose
 * message is missing or not outbound) aborts it before any write, with an error naming
 * the rows. A failure after the first write rolls the whole transaction back. Afterwards
 * the row count of every journal table, the foreign keys and the exact format-9 schema
 * are checked inside the transaction before it commits.
 *
 * Backup: before the first write, under SQLite's exclusive file lock (`BEGIN EXCLUSIVE`,
 * so no other connection can be writing), the database file is copied byte for byte to
 * `<file>.format8-backup-<UTC timestamp>` next to it, flushed to disk, and its hash checked
 * against the file. The backup is kept whatever happens next.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The format-8 journal DDL, verbatim from the last format-8 build (1760e3031^). */
const FORMAT_8_DDL = `
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
    rfc_message_id TEXT NOT NULL,
    claimed_rfc_id TEXT,
    mail_key TEXT NOT NULL,
    item_key TEXT,
    payload_digest TEXT,
    frank_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('email_to_frank', 'frank_to_email')),
    in_reply_to TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope_account, rfc_message_id),
    CHECK ((direction = 'frank_to_email') = (item_key IS NOT NULL)),
    CHECK ((direction = 'frank_to_email') = (payload_digest IS NOT NULL))
  );
  CREATE INDEX idx_mail_message_frank ON mail_message(scope_account, frank_message_id);
  CREATE INDEX idx_mail_message_mail_key ON mail_message(scope_account, mail_key);
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
  CREATE INDEX idx_inbound_email_claim ON inbound_email(scope_account, rfc_message_id);
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
    rfc_message_id TEXT NOT NULL,
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
    UNIQUE (scope_account, rfc_message_id, recipient_email),
    FOREIGN KEY (scope_account, rfc_message_id) REFERENCES mail_message(scope_account, rfc_message_id),
    FOREIGN KEY (sender_local_part) REFERENCES issued_mailbox(local_part)
  );
  CREATE INDEX idx_outbound_job_due ON outbound_job(state, next_attempt_at);
`;

/** The one older journal format an open migrates (to `MAIL_JOURNAL_FORMAT`) instead of refusing. */
export const MIGRATED_MAIL_JOURNAL_FORMAT = 8;

/** The format-8 migration refused or failed. The database file is as it was before the open. */
export class MailJournalMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailJournalMigrationError';
  }
}

export interface MailJournalFormat8MigrationOptions {
  /** The format-9 DDL the journal creates a new database with. */
  readonly format9Ddl: string;
  readonly tables: readonly string[];
  readonly chainIdentifier: string;
  readonly gatewayAccount: string;
  readonly gatewayDomain: string;
  readonly now: () => number;
}

export type MailJournalFormat8MigrationResult =
  | { readonly migrated: false }
  | { readonly migrated: true; readonly backupPath: string; readonly rows: Readonly<Record<string, number>> };

/** Tables whose DDL differs between the two formats; each is rebuilt. */
const REBUILT_TABLES = ['mail_message', 'outbound_job'] as const;
/** Format-8 indexes on the rebuilt tables and the dropped claim index. */
const FORMAT_8_DROPPED_INDEXES = [
  'idx_mail_message_frank',
  'idx_mail_message_mail_key',
  'idx_mail_message_digest',
  'idx_outbound_job_due',
  'idx_inbound_email_claim',
] as const;
/** Rows named in a refusal, per kind; the total is always given. */
const NAMED_ROWS_LIMIT = 20;

type Row = Record<string, unknown>;

function all(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function get(db: DatabaseSync, sql: string, ...params: Array<string | number>): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function statements(ddl: string): string[] {
  return ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The journal objects of a schema, as SQLite stores them, in a stable order. */
function journalSchema(db: DatabaseSync, tables: readonly string[]): string {
  const rows = all(
    db,
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE tbl_name IN (${tables.map(() => '?').join(', ')})
      ORDER BY type, name`,
    ...tables
  );
  return JSON.stringify(rows);
}

function schemaOf(ddl: string, tables: readonly string[]): string {
  const scratch = new DatabaseSync(':memory:');
  try {
    scratch.exec(ddl);
    return journalSchema(scratch, tables);
  } finally {
    scratch.close();
  }
}

function differingObjects(actual: string, expected: string): string[] {
  const key = (r: Row): string => `${String(r.type)} ${String(r.name)}`;
  const a = new Map((JSON.parse(actual) as Row[]).map((r) => [key(r), JSON.stringify(r)]));
  const e = new Map((JSON.parse(expected) as Row[]).map((r) => [key(r), JSON.stringify(r)]));
  return [...new Set([...a.keys(), ...e.keys()])].filter((k) => a.get(k) !== e.get(k)).sort();
}

function describeRows(kind: string, rows: Row[]): string {
  const shown = rows.slice(0, NAMED_ROWS_LIMIT).map((r) => JSON.stringify(r));
  const more = rows.length > NAMED_ROWS_LIMIT ? `; and ${rows.length - NAMED_ROWS_LIMIT} more` : '';
  return `${kind} (${rows.length}): ${shown.join('; ')}${more}`;
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fsyncPath(target: string, flags: string): void {
  const fd = fs.openSync(target, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function backupStamp(ms: number): string {
  // 2026-10-20T12:34:56.789Z -> 20261020T123456789Z
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/** Rows format 9 cannot hold faithfully. Read-only; run inside the migration transaction. */
function unconvertibleRows(db: DatabaseSync): string[] {
  const problems: string[] = [];
  const add = (kind: string, rows: Row[]): void => {
    if (rows.length > 0) problems.push(describeRows(kind, rows));
  };
  add(
    'mail_message rows sharing one (scope_account, mail_key), the format-9 primary key',
    all(
      db,
      `SELECT scope_account, mail_key, json_group_array(rfc_message_id) AS rfc_message_ids
         FROM mail_message GROUP BY scope_account, mail_key HAVING COUNT(*) > 1
        ORDER BY scope_account, mail_key`
    )
  );
  add(
    'mail_message rows sharing one (scope_account, item_key), unique in format 9',
    all(
      db,
      `SELECT scope_account, item_key, json_group_array(rfc_message_id) AS rfc_message_ids
         FROM mail_message WHERE item_key IS NOT NULL
        GROUP BY scope_account, item_key HAVING COUNT(*) > 1
        ORDER BY scope_account, item_key`
    )
  );
  add(
    'contested inbound mail_message rows whose real Message-ID is not confirmed by their inbound_email row',
    all(
      db,
      `SELECT m.scope_account, m.rfc_message_id, m.claimed_rfc_id, m.mail_key,
              e.rfc_message_id AS inbound_email_rfc_message_id
         FROM mail_message m
         LEFT JOIN inbound_email e ON e.scope_account = m.scope_account AND e.mail_key = m.mail_key
        WHERE m.direction = 'email_to_frank' AND m.claimed_rfc_id IS NOT NULL
          AND (e.rfc_message_id IS NULL OR e.rfc_message_id <> m.claimed_rfc_id)
        ORDER BY m.rowid`
    )
  );
  add(
    'outbound_job rows with no outbound mail_message under their (scope_account, rfc_message_id)',
    all(
      db,
      `SELECT j.job_id, j.scope_account, j.rfc_message_id, m.direction
         FROM outbound_job j
         LEFT JOIN mail_message m ON m.scope_account = j.scope_account AND m.rfc_message_id = j.rfc_message_id
        WHERE m.direction IS NOT 'frank_to_email'
        ORDER BY j.job_id`
    )
  );
  return problems;
}

/**
 * If the database holds a format-8 mail journal, backs it up and migrates it to format 9 in
 * one transaction; otherwise changes nothing and returns `{ migrated: false }`, leaving the
 * format check to the journal's open. Must be called on the journal's connection outside any
 * transaction, after it has taken the exclusive locking mode.
 */
export function migrateMailJournalFormat8(
  db: DatabaseSync,
  options: MailJournalFormat8MigrationOptions
): MailJournalFormat8MigrationResult {
  const hasMeta = get(db, "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'mail_journal_meta'");
  if (!hasMeta) return { migrated: false };
  const metas = all(db, 'SELECT * FROM mail_journal_meta');
  if (metas.length !== 1 || metas[0].format !== 8) return { migrated: false };

  const nothing = 'Nothing was changed; the journal was not migrated.';
  const meta = metas[0];
  if (
    meta.chain_identifier !== options.chainIdentifier ||
    meta.gateway_account !== options.gatewayAccount ||
    meta.gateway_domain !== options.gatewayDomain
  ) {
    throw new MailJournalMigrationError(
      `Mail journal format 8 belongs to chain ${String(meta.chain_identifier)}, gateway account ` +
        `${String(meta.gateway_account)}, and domain ${String(meta.gateway_domain)}; not ${options.chainIdentifier}, ` +
        `${options.gatewayAccount}, and ${options.gatewayDomain}. ${nothing}`
    );
  }
  const differs = differingObjects(journalSchema(db, options.tables), schemaOf(FORMAT_8_DDL, options.tables));
  if (differs.length > 0) {
    throw new MailJournalMigrationError(
      `Mail journal is marked format 8 but its schema is not the format-8 schema (differs: ${differs.join(', ')}). ${nothing}`
    );
  }
  if (db.isTransaction) {
    throw new MailJournalMigrationError(`Mail journal format 8 migration must not run inside a transaction. ${nothing}`);
  }
  const main = all(db, 'PRAGMA database_list').find((r) => r.name === 'main');
  const file = typeof main?.file === 'string' ? main.file : '';
  if (file === '') {
    throw new MailJournalMigrationError(`Mail journal format 8 is not in a file, so it cannot be backed up. ${nothing}`);
  }
  const journalMode = String(Object.values(get(db, 'PRAGMA journal_mode') ?? {})[0]).toLowerCase();
  if (!['delete', 'truncate', 'persist'].includes(journalMode)) {
    throw new MailJournalMigrationError(
      `Mail journal format 8 uses journal_mode ${journalMode}; the migration needs a rollback journal for its file backup. ${nothing}`
    );
  }

  // Selected from the format-9 DDL, so the rebuilt tables are created by the same text as a new journal's.
  const rebuilt = statements(options.format9Ddl).filter((s) =>
    REBUILT_TABLES.some((t) => s.startsWith(`CREATE TABLE ${t} (`) || new RegExp(`^CREATE (UNIQUE )?INDEX \\w+ ON ${t}\\(`).test(s))
  );
  if (rebuilt.length !== 7) {
    throw new MailJournalMigrationError(
      `The format-9 DDL no longer has the two tables and five indexes this migration rebuilds (${rebuilt.length} found). ${nothing}`
    );
  }
  const format9Schema = schemaOf(options.format9Ddl, options.tables);

  const foreignKeysBefore = Number(Object.values(get(db, 'PRAGMA foreign_keys') ?? {})[0]);
  // Off for the rebuild (it cannot change inside a transaction); checked explicitly before commit.
  db.exec('PRAGMA foreign_keys = OFF');
  let backupPath: string | undefined;
  try {
    db.exec('BEGIN EXCLUSIVE');
    const format = get(db, 'SELECT format FROM mail_journal_meta WHERE id = 1')?.format;
    if (format !== 8) throw new MailJournalMigrationError(`Mail journal format changed to ${String(format)} during the open.`);

    // The exclusive lock is held and nothing is written yet: the file is the committed database.
    backupPath = `${file}.format8-backup-${backupStamp(options.now())}`;
    fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
    fsyncPath(backupPath, 'r+');
    fsyncPath(path.dirname(backupPath), 'r');
    if (sha256File(backupPath) !== sha256File(file)) {
      throw new MailJournalMigrationError(`The backup ${backupPath} does not match the database file.`);
    }

    const problems = unconvertibleRows(db);
    if (problems.length > 0) {
      throw new MailJournalMigrationError(
        `Mail journal format 8 has rows format 9 cannot hold faithfully: ${problems.join(' | ')}.`
      );
    }

    const countRows = (table: string): number => Number(get(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n);
    const rowsBefore = Object.fromEntries(options.tables.map((t) => [t, countRows(t)]));
    const jobSequence = get(db, "SELECT seq FROM sqlite_sequence WHERE name = 'outbound_job'")?.seq;

    for (const index of FORMAT_8_DROPPED_INDEXES) db.exec(`DROP INDEX ${index}`);
    db.exec('ALTER TABLE outbound_job RENAME TO outbound_job_format8');
    db.exec('ALTER TABLE mail_message RENAME TO mail_message_format8');
    for (const statement of rebuilt) db.exec(statement);

    db.exec(`
      INSERT INTO mail_message
        (scope_account, mail_key, item_key, rfc_message_id, payload_digest, frank_message_id,
         conversation_id, direction, in_reply_to, created_at)
      SELECT scope_account, mail_key, item_key,
             CASE WHEN direction = 'email_to_frank' AND claimed_rfc_id IS NOT NULL
                  THEN claimed_rfc_id ELSE rfc_message_id END,
             payload_digest, frank_message_id, conversation_id, direction, in_reply_to, created_at
        FROM mail_message_format8
       ORDER BY rowid
    `);
    db.exec(`
      INSERT INTO outbound_job
        (job_id, scope_account, mail_key, recipient_email, sender_local_part, bounce_token, signed_rfc822,
         state, attempts, submission_started_at, provider_email_id, next_attempt_at, last_error, created_at)
      SELECT j.job_id, j.scope_account, m.mail_key, j.recipient_email, j.sender_local_part, j.bounce_token,
             j.signed_rfc822, j.state, j.attempts, j.submission_started_at, j.provider_email_id,
             j.next_attempt_at, j.last_error, j.created_at
        FROM outbound_job_format8 j
        JOIN mail_message_format8 m ON m.scope_account = j.scope_account AND m.rfc_message_id = j.rfc_message_id
       ORDER BY j.job_id
    `);
    db.exec('DROP TABLE outbound_job_format8');
    db.exec('DROP TABLE mail_message_format8');
    if (jobSequence !== undefined && jobSequence !== null) {
      const seq = Number(jobSequence);
      if (get(db, "SELECT 1 AS present FROM sqlite_sequence WHERE name = 'outbound_job'")) {
        db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'outbound_job'").run(seq);
      } else {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('outbound_job', ?)").run(seq);
      }
    }
    db.exec('UPDATE mail_journal_meta SET format = 9 WHERE id = 1 AND format = 8');

    const rowsAfter = Object.fromEntries(options.tables.map((t) => [t, countRows(t)]));
    const lost = options.tables.filter((t) => rowsAfter[t] !== rowsBefore[t]);
    if (lost.length > 0) {
      throw new MailJournalMigrationError(
        `Row counts changed in ${lost.map((t) => `${t} (${rowsBefore[t]} -> ${rowsAfter[t]})`).join(', ')}.`
      );
    }
    const violations = all(db, 'PRAGMA foreign_key_check');
    if (violations.length > 0) throw new MailJournalMigrationError(describeRows('Foreign key violations', violations));
    const schemaDiff = differingObjects(journalSchema(db, options.tables), format9Schema);
    if (schemaDiff.length > 0) {
      throw new MailJournalMigrationError(`The migrated schema differs from format 9 in ${schemaDiff.join(', ')}.`);
    }
    db.exec('COMMIT');
    return { migrated: true, backupPath, rows: rowsAfter };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    const cause = err instanceof Error ? err.message : String(err);
    const kept = backupPath && fs.existsSync(backupPath) ? ` The backup ${backupPath} was kept.` : '';
    throw new MailJournalMigrationError(
      `Mail journal format 8 to 9 migration failed and was rolled back; the database is unchanged.${kept} ${cause}`
    );
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeysBefore ? 'ON' : 'OFF'}`);
  }
}
