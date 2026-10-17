/**
 * Mail journal (#1237 G1, #1347 content-hash cutover, format 9). File-backed SQLite in a temp
 * directory, real close and reopen, no database mocks. Each test names the
 * later-stage failure it prevents.
 *
 * The journal computes no key. `key(name)` stands for a mail key and
 * `ikey(name)` for an item key; both are arbitrary 64-hex values.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as packageIndex from '../src/index';
import { CreditLedger, LedgerPoisonedError } from '../src/ledger/credit-ledger';
import {
  INBOUND_HOLD_TTL_MS,
  MAIL_JOURNAL_FORMAT,
  MAIL_JOURNAL_TABLES,
  MailJournal,
  MailJournalArgumentError,
  MailJournalOpenError,
  MailJournalOptions,
  MailJournalStateError,
  RecordFrankMessageInput,
} from '../src/ledger/mail-journal';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry';

const DOMAIN = 'gw.example';
const IDENTITY: MailJournalOptions = {
  chainIdentifier: 'monad-testnet',
  gatewayAccount: `0x${'9'.repeat(40)}`,
  gatewayDomain: DOMAIN,
};
const ALICE = `0x${'a'.repeat(40)}`;
const BOB = `0x${'b'.repeat(40)}`;
const SENDER = 'carol@mail.example';
const T0 = 1_800_000_000_000;
const SRC = path.join(__dirname, '..', 'src');

const sha = (text: string | Uint8Array): string => crypto.createHash('sha256').update(text).digest('hex');
/** A mail key. */
const key = (name: string): string => sha(`mail:${name}`);
/** An item key. Never equal to a mail key of the same name. */
const ikey = (name: string): string => sha(`item:${name}`);
const digest = (name: string): string => sha(`digest:${name}`);
const frankId = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const syntheticId = (k: string): string => `<${k}@no-message-id.${DOMAIN}>`;
const turnEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Opened {
  ledger: CreditLedger;
  journal: MailJournal;
  db: DatabaseSync;
}

let dir: string;
let file: string;
let current: Opened | undefined;
/** The journal's injected clock. */
let clock: number;

function newLedger(): CreditLedger {
  return new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
}

function open(options: Partial<MailJournalOptions> = {}): Opened {
  const ledger = newLedger();
  try {
    const journal = new MailJournal(ledger, { ...IDENTITY, now: () => clock, ...options });
    current = { ledger, journal, db: ledger.sqlite! };
    return current;
  } catch (err) {
    ledger.sqlite!.close();
    throw err;
  }
}

function close(): void {
  current?.db.close();
  current = undefined;
}

function reopen(): Opened {
  close();
  return open();
}

function rowsOf(db: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  return JSON.stringify(
    db
      .prepare(sql)
      .all(...params)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])
        )
      )
  );
}

/** Every row of every journal table, and of the held-mail table the journal can touch, on any connection. */
function dump(db: DatabaseSync): string {
  return [...MAIL_JOURNAL_TABLES, 'held_messages']
    .map((table) => `${table}=${rowsOf(db, `SELECT * FROM ${table} ORDER BY rowid`)}`)
    .join('\n');
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function fileHash(): string {
  return sha(fs.readFileSync(file));
}

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

interface AdmitOver {
  sender?: string;
  body?: string;
}

/** Admits one inbound email whose mail key and DATA bytes are derived from `name`. */
function admit(journal: MailJournal, scope: string, name: string, messageIdHeader: string | undefined, over: AdmitOver = {}) {
  const bytes = Buffer.from(over.body ?? `mail body of ${name}`);
  return journal.admitInboundEmail({
    scopeAccount: scope,
    mailKey: key(name),
    stampValue: '1000',
    messageIdHeader,
    senderEmail: over.sender ?? SENDER,
    dataSha256: sha(bytes),
    raw: { kind: 'inline', bytes },
  });
}

function relay(
  journal: MailJournal,
  scope: string,
  name: string,
  parents: { inReplyTo?: string; references?: string[]; conversationId?: string } = {}
) {
  return journal.relayInboundEmail({ scopeAccount: scope, mailKey: key(name), stampValue: '1000', ...parents });
}

type BridgedInput = Extract<RecordFrankMessageInput, { outcome: 'bridged' }>;
interface BridgeOver {
  digestName?: string;
  frankMessageId?: string;
  conversationId?: string;
  stampValue?: string;
  /** Name the emitted mail's key is derived from; defaults to `name`. */
  mailName?: string;
  replyAllowance?: { unit: string; wanted: number };
}

/** Single-call input for a Frank message authored as `name`. */
function frankInput(scope: string, name: string, rfcMessageId: string, over: BridgeOver = {}): BridgedInput {
  return {
    outcome: 'bridged',
    payloadDigest: digest(over.digestName ?? name),
    receivedTimeMs: 1_000,
    stampValue: over.stampValue ?? '0',
    scopeAccount: scope,
    frankMessageId: over.frankMessageId ?? frankId(1),
    conversationId: over.conversationId ?? frankId(100),
    rfcMessageId,
    itemKey: ikey(name),
    mailKey: key(over.mailName ?? name),
    replyAllowance: over.replyAllowance,
  };
}

function bridge(journal: MailJournal, scope: string, name: string, rfcMessageId: string, over: BridgeOver = {}) {
  return journal.recordFrankMessage(frankInput(scope, name, rfcMessageId, over));
}

function bridged(journal: MailJournal, scope: string, name: string, rfcMessageId: string, over: BridgeOver = {}) {
  const result = bridge(journal, scope, name, rfcMessageId, over);
  if (result.kind !== 'bridged') throw new Error(`expected bridged, got ${result.kind}`);
  return result;
}

function addJob(journal: MailJournal, scope: string, mailKey: string, recipient: string, body = 'signed bytes') {
  const message = /^[\da-f]{64}$/.test(mailKey) ? journal.findMailMessage(scope, mailKey) : undefined;
  const senderLocalPart = message
    ? `thread${sha(`${scope}:${message.conversationId}`).slice(0, 26)}`
    : 'threadmissing';
  if (message?.direction === 'frank_to_email')
    journal.issueMailbox({ localPart: senderLocalPart, scopeAccount: scope, conversationId: message.conversationId });
  return journal.addOutboundJob({
    scopeAccount: scope,
    mailKey,
    recipientEmail: recipient,
    senderLocalPart,
    signedRfc822: { kind: 'inline', bytes: Buffer.from(body) },
    nextAttemptAtMs: 100,
  });
}

function createdJob(journal: MailJournal, scope: string, mailKey: string, recipient: string, body?: string) {
  const result = addJob(journal, scope, mailKey, recipient, body);
  if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
  return result.job;
}

/** Runs `operation` once per step with a failure raised right after that statement; nothing may remain. */
function expectAtomic(db: DatabaseSync, steps: Array<[string, string]>, operation: () => unknown): void {
  for (const [event, table] of steps) {
    const before = dump(db);
    db.exec(`CREATE TEMP TRIGGER injected AFTER ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    try {
      expect(operation).toThrow(/injected/);
    } finally {
      db.exec('DROP TRIGGER injected');
    }
    expect(dump(db)).toBe(before);
    expect(db.isTransaction).toBe(false);
  }
}

/** The journal tables exactly as commit 29979f3d (format 1) created them. */
const FORMAT_1_DDL = `
  CREATE TABLE mail_journal_meta (id INTEGER PRIMARY KEY CHECK (id = 1), format INTEGER NOT NULL,
    chain_identifier TEXT NOT NULL, gateway_account TEXT NOT NULL, frank_cursor_ms INTEGER, frank_incomplete_floor_ms INTEGER);
  CREATE TABLE mail_thread (scope_account TEXT NOT NULL, conversation_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('email', 'frank')), created_at INTEGER NOT NULL, PRIMARY KEY (scope_account, conversation_id));
  CREATE TABLE mail_message (scope_account TEXT NOT NULL, rfc_message_id TEXT NOT NULL, claimed_rfc_id TEXT,
    content_key TEXT NOT NULL, frank_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('email_to_frank', 'frank_to_email')), in_reply_to TEXT,
    created_at INTEGER NOT NULL, PRIMARY KEY (scope_account, rfc_message_id));
  CREATE INDEX idx_mail_message_frank ON mail_message(scope_account, frank_message_id);
  CREATE TABLE inbound_email (scope_account TEXT NOT NULL, content_key TEXT NOT NULL, rfc_message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL, data_sha256 TEXT NOT NULL, raw BLOB NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('relay', 'held', 'released', 'echo')), held_message_id TEXT,
    duplicate_mismatches INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (scope_account, content_key));
  CREATE INDEX idx_inbound_email_claim ON inbound_email(scope_account, rfc_message_id);
  CREATE TABLE frank_send (slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('inbound_email', 'bounce', 'reject')), source_key TEXT NOT NULL,
    frank_message_id TEXT NOT NULL UNIQUE, payload_digest TEXT UNIQUE, scope_account TEXT NOT NULL,
    conversation_id TEXT NOT NULL, stamp_value TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'sending', 'linked', 'delivered', 'held')), last_refused_at INTEGER,
    failed_calls INTEGER NOT NULL DEFAULT 0, next_call_at INTEGER, hold_reason TEXT, created_at INTEGER NOT NULL,
    UNIQUE (source_kind, source_key));
  CREATE TABLE frank_inbound (payload_digest TEXT PRIMARY KEY, scope_account TEXT, frank_message_id TEXT,
    conversation_id TEXT, received_time INTEGER NOT NULL, stamp_value_wei TEXT NOT NULL, budget_wei TEXT NOT NULL,
    spent_wei TEXT NOT NULL DEFAULT '0', disposition TEXT NOT NULL CHECK (disposition IN ('bridged', 'rejected', 'quarantined')),
    reason TEXT);
  CREATE INDEX idx_frank_inbound_message ON frank_inbound(scope_account, frank_message_id);
  CREATE TABLE outbound_job (job_id INTEGER PRIMARY KEY AUTOINCREMENT, scope_account TEXT NOT NULL,
    frank_message_id TEXT NOT NULL, recipient_email TEXT NOT NULL, conversation_id TEXT NOT NULL,
    bounce_token TEXT NOT NULL UNIQUE, signed_rfc822 BLOB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'bounced')), attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
    UNIQUE (scope_account, frank_message_id, recipient_email));
  CREATE INDEX idx_outbound_job_due ON outbound_job(state, next_attempt_at);
`;

/** Writes a ledger file holding a format-1 or format-2 journal with one stored mail. */
function writeLegacyFormatDatabase(format: 1 | 2 = 1): void {
  newLedger().sqlite!.close();
  const raw = new DatabaseSync(file);
  raw.exec(FORMAT_1_DDL);
  raw
    .prepare('INSERT INTO mail_journal_meta (id, format, chain_identifier, gateway_account) VALUES (1, ?, ?, ?)')
    .run(format, IDENTITY.chainIdentifier, IDENTITY.gatewayAccount);
  raw
    .prepare(
      "INSERT INTO inbound_email (scope_account, content_key, rfc_message_id, sender_email, data_sha256, raw, disposition, created_at) VALUES (?, ?, '<m1@x.example>', ?, ?, ?, 'held', 1)"
    )
    .run(ALICE, key('old'), SENDER, sha('old'), Buffer.from('old'));
  raw.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-journal-'));
  file = path.join(dir, 'gateway.sqlite3');
  clock = T0;
});

afterEach(() => {
  try {
    close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('open, format marker and the single connection', () => {
  // Prevents: a later stage writing through a connection that loses a committed row on power loss.
  it('creates the eight tables and the marker in a durable, exclusively locked database', () => {
    const { db, journal } = open();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    for (const table of MAIL_JOURNAL_TABLES) expect(tables).toContain(table);
    expect(db.prepare('SELECT * FROM mail_journal_meta').all()).toEqual([
      expect.objectContaining({
        format: MAIL_JOURNAL_FORMAT,
        chain_identifier: IDENTITY.chainIdentifier,
        gateway_account: IDENTITY.gatewayAccount,
        gateway_domain: IDENTITY.gatewayDomain,
        frank_cursor_ms: null,
      }),
    ]);
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
    expect(MAIL_JOURNAL_FORMAT).toBe(9);
    expect(journal.frankCursor()).toEqual({});
  });

  // Prevents: G2 polling from a forgotten cursor after a restart and re-reading or skipping mail.
  it('keeps the cursor and its incomplete floor across a reopen and refuses a cursor past the floor', () => {
    open().journal.setFrankCursor(5_000, 6_000);
    const { journal, db } = reopen();
    expect(journal.frankCursor()).toEqual({ cursorMs: 5_000, incompleteFloorMs: 6_000 });
    const before = dump(db);
    expect(() => journal.setFrankCursor(7_000, 6_000)).toThrow(MailJournalArgumentError);
    expect(() => journal.setFrankCursor(-1)).toThrow(MailJournalArgumentError);
    expect(dump(db)).toBe(before);
    journal.setFrankCursor(7_000);
    expect(reopen().journal.frankCursor()).toEqual({ cursorMs: 7_000 });
  });

  // B2. Prevents: a gateway pointed at another chain or wallet treating this journal's slots and
  // message IDs as its own, which would re-send paid mail from a wallet that never attempted it.
  it('refuses a reopen under another chain identifier, gateway account or domain and writes nothing', () => {
    const first = open();
    admit(first.journal, ALICE, 'm1', '<m1@x.example>');
    relay(first.journal, ALICE, 'm1');
    const before = dump(first.db);
    close();

    expect(() => open({ chainIdentifier: 'monad-mainnet' })).toThrow(MailJournalOpenError);
    expect(() => open({ gatewayAccount: `0x${'8'.repeat(40)}` })).toThrow(/belongs to chain monad-testnet/);
    expect(() => open({ gatewayDomain: 'other.example' })).toThrow(/domain/);

    const raw = new DatabaseSync(file);
    expect(dump(raw)).toBe(before);
    raw.close();
    expect(dump(open().db)).toBe(before);
  });

  // Prevents: a build silently re-creating or reinterpreting a journal it cannot read, which
  // would forget which mails were already relayed and pay for them again.
  it.each([
    ['format 1', 'UPDATE mail_journal_meta SET format = 1', /format 1 is not supported; this build reads format 9 only/],
    ['format 2', 'UPDATE mail_journal_meta SET format = 2', /format 2 is not supported; this build reads format 9 only/],
    ['format 8', 'UPDATE mail_journal_meta SET format = 8', /format 8 is not supported; this build reads format 9 only/],
    ['a later format', 'UPDATE mail_journal_meta SET format = 10', /format 10 is not supported/],
    ['no marker row', 'DELETE FROM mail_journal_meta', /format marker is missing/],
    ['no marker table', 'DROP TABLE mail_journal_meta', /format marker is missing/],
    ['a second marker row', 'DROP TABLE mail_journal_meta; CREATE TABLE mail_journal_meta (format); INSERT INTO mail_journal_meta VALUES (3), (3)', /format marker is missing/],
    ['a missing table', 'DROP TABLE outbound_job', /missing tables \(outbound_job\)/],
  ])('refuses a database with %s and leaves every row as it was', (_name, damage, message) => {
    const first = open();
    admit(first.journal, ALICE, 'm1', '<m1@x.example>');
    relay(first.journal, ALICE, 'm1');
    close();

    const snapshot = (db: DatabaseSync): string =>
      JSON.stringify([
        db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
        db.prepare('SELECT * FROM mail_message').all(),
        db.prepare('SELECT * FROM frank_send').all(),
        db.prepare('SELECT * FROM inbound_email').all().map((r) => ({ ...r, raw: undefined })),
      ]);
    let raw = new DatabaseSync(file);
    raw.exec(damage);
    const before = snapshot(raw);
    raw.close();

    expect(() => open()).toThrow(MailJournalOpenError);
    expect(() => open()).toThrow(message);

    raw = new DatabaseSync(file);
    expect(snapshot(raw)).toBe(before);
    expect(count(raw, 'mail_message')).toBe(1);
    raw.close();
  });

  // 19.2 rule 7. Prevents: the daemon running handlers against Postgres, where no journal exists.
  it('refuses a ledger with no SQLite connection', () => {
    const postgres = new CreditLedger('postgres://frank:secret@localhost:5432/none');
    expect(postgres.sqlite).toBeUndefined();
    expect(() => new MailJournal(postgres, IDENTITY)).toThrow(/Postgres is not supported/);
    expect(() => postgres.atomic(() => 1)).toThrow(/only supported on SQLite/);
  });

  // 6.5. Prevents: the journal disturbing credits, held mail or the old mapping tables.
  it('leaves the existing ledger tables and rows untouched', () => {
    const ledger = newLedger();
    ledger.addCredits('carol@mail.example', 5);
    ledger.sqlite!.close();
    const { ledger: reopened, db } = open();
    expect(reopened.getBalance('carol@mail.example')).toBe(5);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['thread_mappings', 'outbound_spool', 'held_messages']));
  });

  // Prevents: two gateway processes on one file both deciding they are the first to relay a mail.
  it('locks the file against a second connection and a second process until it is closed', () => {
    open();
    // Reopened, so the lock comes from the open of an existing journal, not from creating one.
    reopen();
    const second = new DatabaseSync(file);
    expect(() => second.prepare('SELECT COUNT(*) FROM mail_message').get()).toThrow(/locked/);
    expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    second.close();
    expect(() => new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }))).toThrow(/locked/);

    const script =
      "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT');";
    const blocked = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/locked/);

    close();
    expect(spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8' }).status).toBe(0);
  });

  // Prevents: regenerated identifiers that the header module would refuse to render at delivery time.
  it('refuses identity values and a gateway domain it cannot use', () => {
    expect(() => open({ gatewayDomain: 'GW.example' })).toThrow(MailJournalArgumentError);
    expect(() => open({ gatewayDomain: `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example` })).toThrow(
      /too long/
    );
    expect(() => open({ gatewayAccount: `0x${'A'.repeat(40)}` })).toThrow(MailJournalArgumentError);
    expect(() => open({ chainIdentifier: '' })).toThrow(MailJournalArgumentError);
    const raw = new DatabaseSync(file);
    expect(count(raw, "sqlite_master WHERE name LIKE 'mail_%'")).toBe(0);
    raw.close();
  });
});

describe('explicit mailbox issuance', () => {
  it('resolves only durable issued local parts and keeps their owner after reopen', async () => {
    const { journal, db } = open();
    expect(journal.issuedMailbox('alice')).toBeUndefined();
    expect(await packageIndex.createIssuedMailboxLookup(journal)('alice')).toBeUndefined();
    journal.issueMailbox({ localPart: 'Alice', scopeAccount: ALICE, conversationId: frankId(11) });
    const afterIssue = dump(db);
    journal.issueMailbox({ localPart: 'alice', scopeAccount: ALICE, conversationId: frankId(11) });
    expect(dump(db)).toBe(afterIssue);
    expect(journal.issuedMailbox('ALICE')).toEqual({ scopeAccount: ALICE, conversationId: frankId(11) });
    expect(await packageIndex.createIssuedMailboxLookup(journal)('ALICE')).toEqual({
      accountAddress: ALICE,
      conversationId: frankId(11),
    });
    expect(reopen().journal.issuedMailbox('alice')).toEqual({
      scopeAccount: ALICE,
      conversationId: frankId(11),
    });
  });

  it('refuses conflicts, raw account addresses and operational aliases without changing ownership', () => {
    const { journal, db } = open();
    journal.issueMailbox({ localPart: 'alice', scopeAccount: ALICE });
    const before = dump(db);
    expect(() => journal.issueMailbox({ localPart: 'ALICE', scopeAccount: BOB })).toThrow(MailJournalStateError);
    expect(() => journal.issueMailbox({ localPart: 'alice', scopeAccount: ALICE, conversationId: frankId(12) })).toThrow(MailJournalStateError);
    expect(() => journal.issueMailbox({ localPart: 'SeCuRiTy', scopeAccount: BOB })).toThrow(MailJournalArgumentError);
    expect(() => journal.issueMailbox({ localPart: `0x${'1'.repeat(40)}`, scopeAccount: BOB })).toThrow(MailJournalArgumentError);
    expect(journal.issuedMailbox('unknown')).toBeUndefined();
    expect(dump(db)).toBe(before);
  });
});

describe('atomic units', () => {
  // J21 (21.4 b). Prevents: half a unit committed after an `await`. Before this rule an async
  // callback's first write was rolled back and its second, after the await, committed on its own.
  it('J21: refuses an async callback before BEGIN, without calling it', async () => {
    const { ledger, journal, db } = open();
    const before = dump(db);
    const exec = jest.spyOn(db, 'exec');
    let ran = false;
    expect(() =>
      // @ts-expect-error an async callback must not compile: its type is refused.
      ledger.atomic(async () => {
        ran = true;
        admit(journal, ALICE, 'm1', '<m1@x.example>');
        await Promise.resolve();
        admit(journal, ALICE, 'm2', '<m2@x.example>');
      })
    ).toThrow(/async function/);
    expect(exec).not.toHaveBeenCalled();
    exec.mockRestore();
    expect(ran).toBe(false);
    expect(db.isTransaction).toBe(false);
    await turnEventLoop();
    expect(dump(db)).toBe(before);

    // Refused inside another unit too, and that unit cannot commit.
    expect(() =>
      ledger.atomic(() => {
        admit(journal, ALICE, 'm1', '<m1@x.example>');
        try {
          ledger.atomic((async () => undefined) as unknown as () => void);
        } catch {
          // swallowed on purpose
        }
      })
    ).toThrow(/joined unit failed/);
    expect(dump(db)).toBe(before);

    // Nothing ran, so nothing can continue: the ledger is not poisoned.
    expect(admit(journal, ALICE, 'm1', '<m1@x.example>').kind).toBe('admitted');
  });

  // J22 (21.4 b). Prevents: the same half-committed unit through a wrapper the first check cannot
  // see: a plain function that returns a promise whose continuation writes later.
  it('J22: a synchronous callback that returns a promise is rolled back and poisons the ledger', async () => {
    const { ledger, journal, db } = open();
    const before = dump(db);
    let continuation: Promise<unknown> | undefined;
    const wrapper = (): Promise<unknown> => {
      admit(journal, ALICE, 'm1', '<m1@x.example>');
      continuation = Promise.resolve().then(() => admit(journal, ALICE, 'm2', '<m2@x.example>'));
      return continuation;
    };
    expect(() => ledger.atomic(wrapper as unknown as () => void)).toThrow(LedgerPoisonedError);
    expect(db.isTransaction).toBe(false);
    expect(dump(db)).toBe(before);

    await expect(continuation).rejects.toThrow(LedgerPoisonedError);
    await turnEventLoop();
    expect(dump(db)).toBe(before);

    expect(() => ledger.atomic(() => 1)).toThrow(LedgerPoisonedError);
    expect(() => journal.setFrankCursor(1)).toThrow(LedgerPoisonedError);
    expect(() => admit(journal, ALICE, 'm3', '<m3@x.example>')).toThrow(LedgerPoisonedError);
    expect(() => journal.expireInboundEmails(1)).toThrow(LedgerPoisonedError);
    expect(dump(db)).toBe(before);
    // Reads still answer, and the poison is this instance's: reopening the file starts clean.
    expect(journal.frankCursor()).toEqual({});
    expect(admit(reopen().journal, ALICE, 'm1', '<m1@x.example>').kind).toBe('admitted');
  });

  // 21.4 b, the task's guard. Prevents: the journal's poison rule changing how the live ledger
  // (which never calls atomic()) behaves.
  it('a ledger that never misuses atomic() is never poisoned, and its own methods do not go through it', () => {
    const { ledger, db } = open();
    ledger.addCredits(SENDER, 2);
    expect(ledger.consumeCredit(SENDER, ALICE)).toBe(true);
    for (let i = 0; i < 3; i++) expect(ledger.atomic(() => i)).toBe(i);
    expect(() => ledger.atomic(() => { throw new Error('ordinary failure'); })).toThrow('ordinary failure');
    expect(ledger.atomic(() => 'still usable')).toBe('still usable');

    // Poisoned on purpose: atomic() is closed, the methods that never used it are as before.
    expect(() => ledger.atomic((() => Promise.resolve()) as unknown as () => void)).toThrow(LedgerPoisonedError);
    expect(() => ledger.atomic(() => 1)).toThrow(LedgerPoisonedError);
    ledger.addCredits(SENDER, 1);
    expect(ledger.getBalance(SENDER)).toBe(2);
    expect(db.isTransaction).toBe(false);
  });

  // 19.2 rule 5. Prevents: a failed COMMIT leaving the connection inside a transaction that a
  // later operation would silently extend.
  it('rolls back when COMMIT itself fails and stays usable', () => {
    const { ledger, journal, db } = open();
    db.exec('CREATE TABLE t_parent (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE t_child (p INTEGER REFERENCES t_parent(id) DEFERRABLE INITIALLY DEFERRED)');
    const before = dump(db);
    expect(() =>
      ledger.atomic(() => {
        admit(journal, ALICE, 'm1', '<m1@x.example>');
        db.exec('INSERT INTO t_child VALUES (7)');
      })
    ).toThrow(/FOREIGN KEY/);
    expect(db.isTransaction).toBe(false);
    expect(dump(db)).toBe(before);
    expect(admit(journal, ALICE, 'm1', '<m1@x.example>').kind).toBe('admitted');
  });

  // D14 shape. Prevents: one DATA with two recipients committing the first scope and not the second.
  it('commits several operations together or not at all when a caller joins them', () => {
    const { ledger, journal, db } = open();
    const before = dump(db);
    expect(() =>
      ledger.atomic(() => {
        admit(journal, ALICE, 'm1', '<m1@x.example>');
        relay(journal, ALICE, 'm1');
        admit(journal, BOB, 'm1', '<m1@x.example>');
        throw new Error('second scope failed');
      })
    ).toThrow('second scope failed');
    expect(dump(db)).toBe(before);

    ledger.atomic(() => {
      for (const scope of [ALICE, BOB]) {
        admit(journal, scope, 'm1', '<m1@x.example>');
        relay(journal, scope, 'm1');
      }
    });
    expect(count(reopen().db, 'frank_send')).toBe(2);
  });

  // Prevents: a caller that catches a failed operation and carries on, committing a unit whose
  // decision was never completed.
  it('cannot commit a unit after a joined operation failed, even if the error was caught', () => {
    const { ledger, journal, db } = open();
    const before = dump(db);
    expect(() =>
      ledger.atomic(() => {
        admit(journal, ALICE, 'm1', '<m1@x.example>');
        try {
          relay(journal, ALICE, 'never-admitted');
        } catch {
          // swallowed on purpose
        }
      })
    ).toThrow(/joined unit failed/);
    expect(dump(db)).toBe(before);
  });

  // Prevents: a journal decision made inside someone else's open transaction, where the reads
  // it rests on could be rolled back from under it.
  it('refuses to run inside a transaction it did not start', () => {
    const { journal, db } = open();
    db.exec('BEGIN');
    expect(() => admit(journal, ALICE, 'm1', '<m1@x.example>')).toThrow(/within a transaction/);
    db.exec('ROLLBACK');
    expect(count(db, 'inbound_email')).toBe(0);
  });
});

describe('B1: a failure after any statement leaves no partial row', () => {
  // Prevents: a slot with no mail_message (a paid send whose replies can never find it), or a
  // mail_message with no slot (a thread parent for a mail that was never sent).
  it('relayInboundEmail: slot, message, thread and disposition', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    expectAtomic(
      db,
      [
        ['INSERT', 'frank_send'],
        ['INSERT', 'mail_message'],
        ['INSERT', 'mail_thread'],
        ['UPDATE', 'inbound_email'],
      ],
      () => relay(journal, ALICE, 'm1')
    );
    expect(relay(journal, ALICE, 'm1').created).toBe(true);
    expect(reopen().journal.findInboundEmail(ALICE, key('m1'))!.disposition).toBe('relay');
  });

  // Prevents: a Frank message marked bridged with no Message-ID row, so its email reply starts a
  // new conversation; or a Message-ID row for a message the cursor will fetch and bridge again.
  it('recordFrankMessage: inbound row, message and thread', () => {
    const { journal, db } = open();
    expectAtomic(
      db,
      [
        ['INSERT', 'frank_inbound'],
        ['INSERT', 'mail_message'],
        ['INSERT', 'mail_thread'],
      ],
      () => bridge(journal, ALICE, 'f1', '<f1@frank.org>')
    );
    expect(bridge(journal, ALICE, 'f1', '<f1@frank.org>').kind).toBe('bridged');
  });

  // Prevents: a notice debited and never staged, or staged and never debited (the gateway paying
  // a stamp that no Frank message covered).
  it('stageNotice: debit and slot', () => {
    const { journal, db } = open();
    journal.recordFrankMessage({
      outcome: 'rejected',
      reason: 'bad_recipient',
      payloadDigest: digest('f1'),
      receivedTimeMs: 1_000,
      stampValue: '10',
      scopeAccount: ALICE,
      conversationId: frankId(100),
    });
    const notice = () =>
      journal.stageNotice({ sourceKind: 'reject', payloadDigest: digest('f1'), stampValue: '5', unit: '10' });
    expectAtomic(
      db,
      [
        ['UPDATE', 'frank_inbound'],
        ['INSERT', 'frank_send'],
      ],
      notice
    );
    expect(notice().kind).toBe('created');
    expect(journal.findFrankInbound(digest('f1'))!.spent).toBe('10');
  });

  // (f). Prevents: a process killed between two statements leaving a state that reads as a
  // relayed mail with no slot. Reopening sees the transaction fully absent, or fully present.
  it('a process killed inside a write transaction leaves nothing; killed after COMMIT leaves all of it', () => {
    const first = open();
    admit(first.journal, ALICE, 'm1', '<m1@x.example>');
    const before = dump(first.db);
    close();

    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA cache_size = 5');
      db.exec('BEGIN IMMEDIATE');
      db.exec("INSERT INTO mail_thread VALUES ('0x${'c'.repeat(40)}', '${frankId(7)}', 'email', 1)");
      if (process.argv[2] === 'commit') db.exec('COMMIT');
      else {
        const stmt = db.prepare("INSERT INTO frank_inbound (payload_digest, received_time, stamp_value, budget, disposition, reason) VALUES (?, 1, '0', '0', 'rejected', ?)");
        for (let i = 0; i < 400; i++) stmt.run(String(i).padStart(64, '0'), 'x'.repeat(2000));
      }
      process.kill(process.pid, 'SIGKILL');
    `;
    const killed = spawnSync(process.execPath, ['-e', script, file, 'open'], { encoding: 'utf8' });
    expect(killed.signal).toBe('SIGKILL');
    // The uncommitted pages reached the file: SQLite left a hot rollback journal beside it.
    expect(fs.statSync(`${file}-journal`).size).toBeGreaterThan(0);
    expect(dump(open().db)).toBe(before);
    close();

    const committed = spawnSync(process.execPath, ['-e', script, file, 'commit'], { encoding: 'utf8' });
    expect(committed.signal).toBe('SIGKILL');
    const after = open();
    expect(count(after.db, 'mail_thread')).toBe(1);
    expect(after.journal.findInboundEmail(ALICE, key('m1'))!.disposition).toBe('held');
  });
});

describe('email → Frank: content-hash identity, repeat and duplicate Message-ID', () => {
  // Prevents: an accepted mail (250 sent) that the gateway forgets on restart, so the sender's
  // retry is relayed and charged a second time.
  it('relays an email under its mail key, preserves its RFC Message-ID, and persists across reopen', () => {
    const { journal } = open();
    expect(admit(journal, ALICE, 'm1', '<m1@x.example>')).toMatchObject({
      kind: 'admitted',
      revived: false,
      email: {
        disposition: 'held',
        rfcMessageId: '<m1@x.example>',
        senderEmail: SENDER,
        expiresAtMs: T0 + INBOUND_HOLD_TTL_MS,
      },
    });
    // Admitted but not relayed: it owns no thread identity (19.2 rule 2).
    expect(journal.findMailMessage(ALICE, key('m1'))).toBeUndefined();

    const relayed = relay(journal, ALICE, 'm1');
    expect(relayed).toMatchObject({ created: true, email: { disposition: 'relay', expiresAtMs: undefined } });
    expect('contested' in relayed).toBe(false);
    expect(relayed.slot).toMatchObject({
      state: 'staged',
      sourceKind: 'inbound_email',
      scopeAccount: ALICE,
      stampValue: '1000',
      conversationId: relayed.slot.frankMessageId,
    });
    expect(relayed.slot.frankMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(relayed.message).toMatchObject({
      rfcMessageId: '<m1@x.example>',
      mailKey: key('m1'),
      itemKey: undefined,
      payloadDigest: undefined,
      direction: 'email_to_frank',
      frankMessageId: relayed.slot.frankMessageId,
    });
    expect('claimedRfcId' in relayed.message).toBe(false);

    const again = reopen().journal;
    expect(again.findMailMessage(ALICE, key('m1'))).toEqual(relayed.message);
    expect(again.findFrankSend(relayed.slot.slotId)).toEqual(relayed.slot);
    expect(again.findMailThread(ALICE, relayed.slot.conversationId)).toMatchObject({ origin: 'email' });
  });

  // D3. Prevents: a sender's retry (after a 451, or after a 250 that was lost) creating a second
  // slot, a second credit and a second paid Frank message.
  it('an exact repeat returns the same rows and writes nothing, before and after a reopen', () => {
    const first = open();
    admit(first.journal, ALICE, 'm1', '<m1@x.example>');
    const relayed = relay(first.journal, ALICE, 'm1');
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      const admitted = admit(journal, ALICE, 'm1', '<m1@x.example>');
      expect(admitted).toMatchObject({ kind: 'duplicate', email: { disposition: 'relay' } });
      const repeat = relay(journal, ALICE, 'm1', { inReplyTo: '<other@x.example>' });
      expect(repeat).toEqual({ ...relayed, created: false });
      expect(dump(db)).toBe(before);
    }
  });

  // #1347. Two different emails with one Message-ID are both delivered under their own mail keys
  // without renaming; a reply naming that Message-ID joins the earliest one that was relayed.
  it('delivers two different mails with the same Message-ID under their own mail keys without renaming; replies join the earliest relayed one', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'real', '<m1@x.example>');
    const first = relay(journal, ALICE, 'real');
    const firstRow = JSON.stringify(db.prepare('SELECT * FROM mail_message WHERE mail_key = ?').all(key('real')));

    clock += 1_000;
    expect(admit(journal, ALICE, 'other', '<m1@x.example>').kind).toBe('admitted');
    const second = relay(journal, ALICE, 'other');
    expect(second).toMatchObject({
      created: true,
      message: { rfcMessageId: '<m1@x.example>', mailKey: key('other') },
    });
    expect('contested' in second).toBe(false);
    expect('claimedRfcId' in second.message).toBe(false);

    // The first mail's row is byte-identical, and both rows exist under their own mail keys with the same rfc_message_id.
    expect(JSON.stringify(db.prepare('SELECT * FROM mail_message WHERE mail_key = ?').all(key('real')))).toBe(firstRow);
    expect(journal.findMailMessage(ALICE, key('real'))).toEqual(first.message);
    expect(journal.findMailMessage(ALICE, key('other'))).toEqual(second.message);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE rfc_message_id = ?').get('<m1@x.example>')).toEqual({
      n: 2,
    });
    // It did not join the first mail's conversation merely by sharing its Message-ID: it is its own root.
    expect(second.message.conversationId).not.toBe(first.message.conversationId);
    expect(second.slot.frankMessageId).not.toBe(first.slot.frankMessageId);
    expect(count(db, 'mail_thread')).toBe(2);

    // A reply naming the shared Message-ID joins the earliest relayed conversation.
    clock += 1_000;
    admit(journal, ALICE, 'reply-to-x', '<r1@x.example>');
    expect(relay(journal, ALICE, 'reply-to-x', { inReplyTo: '<m1@x.example>' }).message.conversationId).toBe(
      first.message.conversationId
    );
  });

  // Prevents: a retry of the second mail with the same Message-ID creating a third row or slot.
  it('a repeat of a second mail sharing a Message-ID returns the same row, before and after a reopen', () => {
    const first = open();
    admit(first.journal, ALICE, 'real', '<m1@x.example>');
    relay(first.journal, ALICE, 'real');
    admit(first.journal, ALICE, 'other', '<m1@x.example>');
    const second = relay(first.journal, ALICE, 'other');
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(admit(journal, ALICE, 'other', '<m1@x.example>').kind).toBe('duplicate');
      expect(relay(journal, ALICE, 'other')).toEqual({ ...second, created: false });
      expect(dump(db)).toBe(before);
    }
  });

  // #1347. An unfunded first copy that is held does not enter mail_message until released; a funded
  // mail with the same Message-ID that is relayed first is the earliest relayed row, so replies join it.
  it('when an unfunded copy arrives first and a funded copy is relayed first, both keep the Message-ID and replies join the earliest relayed one', () => {
    const { journal } = open();
    admit(journal, ALICE, 'forged', '<m1@x.example>');
    expect(journal.holdInboundEmail(ALICE, key('forged'), 'held-1')).toMatchObject({
      disposition: 'held',
      heldMessageId: 'held-1',
    });
    expect(journal.findMailMessage(ALICE, key('forged'))).toBeUndefined();

    clock += 1_000;
    admit(journal, ALICE, 'real', '<m1@x.example>');
    const real = relay(journal, ALICE, 'real');
    expect(real).toMatchObject({ created: true, message: { rfcMessageId: '<m1@x.example>', mailKey: key('real') } });

    clock += 1_000;
    const released = relay(reopen().journal, ALICE, 'forged');
    expect(released).toMatchObject({
      created: true,
      email: { disposition: 'released', heldMessageId: 'held-1' },
      message: { rfcMessageId: '<m1@x.example>', mailKey: key('forged') },
    });
    expect(current!.journal.findMailMessage(ALICE, key('real'))).toEqual(real.message);
    expect(current!.journal.findMailMessage(ALICE, key('forged'))).toEqual(released.message);

    // Reply to '<m1@x.example>' joins `real`'s conversation because `real` was relayed earlier.
    clock += 1_000;
    admit(current!.journal, ALICE, 'reply', '<r1@x.example>');
    expect(relay(current!.journal, ALICE, 'reply', { inReplyTo: '<m1@x.example>' }).message.conversationId).toBe(
      real.message.conversationId
    );
  });

  // Prevents: the held-mail link being repointed, so a payment releases a different mail.
  it('links held mail once and never repoints it', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    journal.holdInboundEmail(ALICE, key('m1'), 'held-1');
    const before = dump(db);
    expect(journal.holdInboundEmail(ALICE, key('m1'), 'held-1').heldMessageId).toBe('held-1');
    expect(() => journal.holdInboundEmail(ALICE, key('m1'), 'held-2')).toThrow(MailJournalStateError);
    expect(() => journal.holdInboundEmail(ALICE, key('nope'), 'held-1')).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
  });

  // #1347. There is no cap of 8 claims per Message-ID and no eviction.
  it('admits and relays more than eight different mails with the same Message-ID without any claim limit or eviction', () => {
    const { journal, db } = open();
    for (let i = 0; i < 12; i++) {
      expect(admit(journal, ALICE, `copy-${i}`, '<m1@x.example>').kind).toBe('admitted');
      expect(relay(journal, ALICE, `copy-${i}`).created).toBe(true);
    }
    expect(count(db, 'inbound_email')).toBe(12);
    expect(count(db, 'mail_message')).toBe(12);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE rfc_message_id = ?').get('<m1@x.example>')).toEqual({
      n: 12,
    });
  });

  // B3, D1, AGENTS.md section 5. Prevents: two threads through one gateway being merged because
  // they share a Message-ID across accounts, or a peer and a subject within one account.
  it('keeps the same Message-ID in two scopes, and two equal-subject threads in one scope, apart', () => {
    let { journal } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    admit(journal, BOB, 'm1', '<m1@x.example>');
    const alice = relay(journal, ALICE, 'm1');
    const bob = relay(journal, BOB, 'm1');
    expect(alice.message.conversationId).not.toBe(bob.message.conversationId);
    expect(journal.findMailMessage(ALICE, key('m1'))!.frankMessageId).toBe(alice.slot.frankMessageId);
    expect(journal.findMailMessage(BOB, key('m1'))!.frankMessageId).toBe(bob.slot.frankMessageId);
    expect(journal.findMailMessage(ALICE, key('bob-only'))).toBeUndefined();

    // Same sender, same Frank user, same subject (the journal has no subject column at all):
    // two roots, and interleaved replies each join their own, across a reopen.
    admit(journal, ALICE, 'root-2', '<m2@x.example>');
    const second = relay(journal, ALICE, 'root-2');
    expect(second.message.conversationId).not.toBe(alice.message.conversationId);

    admit(journal, ALICE, 'a-reply', '<a1@x.example>');
    const aReply = relay(journal, ALICE, 'a-reply', { inReplyTo: '<m1@x.example>' });
    journal = reopen().journal;
    admit(journal, ALICE, 'b-reply', '<b1@x.example>');
    const bReply = relay(journal, ALICE, 'b-reply', { references: ['<m2@x.example>', '<unknown@x.example>'] });
    admit(journal, ALICE, 'a-reply-2', '<a2@x.example>');
    const aReply2 = relay(journal, ALICE, 'a-reply-2', {
      inReplyTo: '<never-stored@x.example>',
      references: ['<m1@x.example>', '<a1@x.example>'],
    });

    expect(aReply.message.conversationId).toBe(alice.message.conversationId);
    expect(aReply2.message.conversationId).toBe(alice.message.conversationId);
    expect(bReply.message.conversationId).toBe(second.message.conversationId);
    expect(count(current!.db, 'mail_thread')).toBe(3);

    // D19: a parent stored only in another scope is not a parent here.
    admit(journal, BOB, 'bob-reply', '<b9@x.example>');
    const bobReply = relay(journal, BOB, 'bob-reply', { inReplyTo: '<m2@x.example>' });
    expect(bobReply.message.conversationId).toBe(bobReply.slot.frankMessageId);
  });

  it('routes issued aliases to their own conversation despite cross-thread RFC headers', () => {
    let { journal } = open();
    const firstId = frankId(401);
    const secondId = frankId(402);
    journal.issueMailbox({ localPart: 'first', scopeAccount: ALICE, conversationId: firstId });
    journal.issueMailbox({ localPart: 'second', scopeAccount: ALICE, conversationId: secondId });
    admit(journal, ALICE, 'first-mail', '<first@x.example>');
    const first = relay(journal, ALICE, 'first-mail', { conversationId: journal.issuedMailbox('first')!.conversationId });
    journal = reopen().journal;
    admit(journal, ALICE, 'second-mail', '<second@x.example>');
    const second = relay(journal, ALICE, 'second-mail', {
      conversationId: journal.issuedMailbox('second')!.conversationId,
      inReplyTo: '<first@x.example>',
    });
    expect(first.slot.conversationId).toBe(firstId);
    expect(second.slot.conversationId).toBe(secondId);
    expect(journal.findMailThread(ALICE, firstId)).toBeDefined();
    expect(journal.findMailThread(ALICE, secondId)).toBeDefined();
  });

  // Two different mails with one ID, admitted together and relayed back to back at the same clock,
  // are both stored under their mail keys and rowid breaks the tie in favour of the one relayed first.
  it('two different mails with one ID, admitted together and relayed back to back, both keep the ID and rowid orders parent lookup', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'first', '<m1@x.example>');
    admit(journal, ALICE, 'second', '<m1@x.example>');
    const secondRelayed = relay(journal, ALICE, 'second');
    const firstRelayed = relay(journal, ALICE, 'first');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE rfc_message_id = ?').get('<m1@x.example>')).toEqual({
      n: 2,
    });
    expect(journal.findMailMessage(ALICE, key('second'))!.rfcMessageId).toBe('<m1@x.example>');
    expect(journal.findMailMessage(ALICE, key('first'))!.rfcMessageId).toBe('<m1@x.example>');

    admit(journal, ALICE, 'reply', '<r1@x.example>');
    expect(relay(journal, ALICE, 'reply', { inReplyTo: '<m1@x.example>' }).message.conversationId).toBe(
      secondRelayed.message.conversationId
    );
    expect(secondRelayed.message.conversationId).not.toBe(firstRelayed.message.conversationId);

    const other = new DatabaseSync(file);
    expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    other.close();
  });

  // 19.2 rule 4 and its test. Prevents: two mails with one ID sharing or overwriting stored bytes.
  it('each mail keeps its own bytes; a blob is named only by the hash of its bytes', () => {
    const { journal } = open();
    admit(journal, ALICE, 'one', '<m1@x.example>');
    admit(journal, ALICE, 'two', '<m1@x.example>');
    const tricky = Buffer.from('blob://looks-like-a-pointer');
    const common = { scopeAccount: ALICE, senderEmail: SENDER, stampValue: '1000' };
    journal.admitInboundEmail({
      ...common,
      mailKey: key('tricky'),
      messageIdHeader: '<m3@x.example>',
      dataSha256: sha(tricky),
      raw: { kind: 'inline', bytes: tricky },
    });
    journal.admitInboundEmail({
      ...common,
      mailKey: key('big'),
      messageIdHeader: '<m4@x.example>',
      dataSha256: sha('big'),
      raw: { kind: 'blob', sha256: sha('big') },
    });

    const again = reopen().journal;
    const bytesOf = (name: string): string => {
      const raw = again.findInboundEmail(ALICE, key(name))!.raw!;
      return raw.kind === 'inline' ? Buffer.from(raw.bytes).toString() : `blob:${raw.sha256}`;
    };
    expect(bytesOf('one')).toBe('mail body of one');
    expect(bytesOf('two')).toBe('mail body of two');
    expect(bytesOf('tricky')).toBe('blob://looks-like-a-pointer');
    expect(bytesOf('big')).toBe(`blob:${sha('big')}`);

    const base = { ...common, mailKey: key('bad'), messageIdHeader: '<m5@x.example>' };
    expect(() =>
      again.admitInboundEmail({ ...base, dataSha256: sha('a'), raw: { kind: 'inline', bytes: Buffer.from('b') } })
    ).toThrow(/do not match dataSha256/);
    expect(() =>
      again.admitInboundEmail({ ...base, dataSha256: sha('a'), raw: { kind: 'blob', sha256: sha('b') } })
    ).toThrow(/do not match dataSha256/);
    expect(again.findInboundEmail(ALICE, key('bad'))).toBeUndefined();
  });
});

describe('boundary refusals', () => {
  // Prevents: an identifier the header module would not read back, or a repaired or case-folded
  // one, becoming a stored key that no later mail can ever match (or that matches the wrong one).
  it.each([
    ['no brackets', 'm1@x.example'],
    ['no @', '<abc>'],
    ['a space', '<a b@c>'],
    ['surrounding text', 'x <a@b>'],
    ['a trailing space', '<a@b> '],
    ['two IDs', '<a@b> <c@d>'],
    ['a newline', '<a@b>\r\n'],
    ['257 characters', `<${'a'.repeat(250)}@x.ex>`],
    ['non-ASCII', '<é@b>'],
    ['empty', ''],
  ])('refuses a Message-ID with %s wherever one is taken, and writes nothing', (_name, bad) => {
    const { journal, db } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    const before = dump(db);
    expect(() => admit(journal, ALICE, 'm2', bad)).toThrow(MailJournalArgumentError);
    expect(() => relay(journal, ALICE, 'm1', { inReplyTo: bad })).toThrow(MailJournalArgumentError);
    expect(() => relay(journal, ALICE, 'm1', { references: ['<ok@x.example>', bad] })).toThrow(
      MailJournalArgumentError
    );
    expect(() => bridge(journal, ALICE, 'f1', bad)).toThrow(MailJournalArgumentError);
    expect(dump(db)).toBe(before);
  });

  // The longest valid ID is accepted, and IDs differing only in case are different IDs.
  it('accepts a 256-character ID and compares IDs byte for byte', () => {
    const { journal } = open();
    const longest = `<${'a'.repeat(249)}@x.ex>`;
    expect(longest).toHaveLength(256);
    expect(admit(journal, ALICE, 'long', longest).kind).toBe('admitted');
    admit(journal, ALICE, 'lower', '<abc@x.example>');
    admit(journal, ALICE, 'upper', '<ABC@x.example>');
    const lower = relay(journal, ALICE, 'lower');
    const upper = relay(journal, ALICE, 'upper');
    expect(lower.created).toBe(true);
    expect(upper.created).toBe(true);
    admit(journal, ALICE, 'mixed-reply', '<r1@x.example>');
    const mixedReply = relay(journal, ALICE, 'mixed-reply', { inReplyTo: '<Abc@x.example>' });
    expect(mixedReply.message.conversationId).not.toBe(lower.message.conversationId);
    expect(mixedReply.message.conversationId).not.toBe(upper.message.conversationId);
  });

  // Prevents: anyone claiming a synthetic no-message-id identifier this gateway generates for
  // ID-less inbound mail. A Frank author is refused; an inbound mail bearing one is assigned its own.
  it('never accepts a reserved no-message-id identifier as a claim, from either direction', () => {
    const { journal, db } = open();
    const before = dump(db);
    const mine = journal.noMessageIdFor(key('m1'));
    expect(mine).toBe(syntheticId(key('m1')));
    const reserved = [
      journal.noMessageIdFor(key('someone-else')),
      `<x@No-Message-Id.${DOMAIN}>`,
      `<x@NO-MESSAGE-ID.${DOMAIN.toUpperCase()}>`,
      mine,
    ];
    for (const claimed of reserved) {
      expect(journal.isReservedMessageId(claimed)).toBe(true);
      expect(() => bridge(journal, ALICE, 'f1', claimed)).toThrow(/reserved/);
    }
    expect(dump(db)).toBe(before);

    // Inbound: whatever reserved identifier the header bears, the mail is filed under its own.
    reserved.forEach((claimed, i) => {
      expect(admit(journal, ALICE, `in-${i}`, claimed)).toMatchObject({
        kind: 'admitted',
        email: { rfcMessageId: syntheticId(key(`in-${i}`)) },
      });
    });
    expect(admit(journal, ALICE, 'm1', mine)).toMatchObject({ kind: 'admitted', email: { rfcMessageId: mine } });
    expect(admit(journal, ALICE, 'no-header', undefined)).toMatchObject({
      kind: 'admitted',
      email: { rfcMessageId: syntheticId(key('no-header')) },
    });
    // A name that only ends like a reserved one is an ordinary identifier.
    const lookalike = `<x@no-message-id.${DOMAIN}.evil.example>`;
    expect(journal.isReservedMessageId(lookalike)).toBe(false);
    expect(admit(journal, ALICE, 'lookalike', lookalike)).toMatchObject({ email: { rfcMessageId: lookalike } });
  });

  // Prevents: a scope, sealed ID, key or digest in a second spelling (uppercase, undashed, short)
  // becoming a second identity for the same account or message.
  it('refuses malformed scopes, sealed IDs, keys, digests and addresses', () => {
    const { journal, db } = open();
    const before = dump(db);
    const good = {
      scopeAccount: ALICE,
      mailKey: key('m1'),
      stampValue: '1000',
      messageIdHeader: '<m1@x.example>',
      senderEmail: SENDER,
      dataSha256: sha('x'),
      raw: { kind: 'blob' as const, sha256: sha('x') },
    };
    for (const patch of [
      { scopeAccount: `0x${'A'.repeat(40)}` },
      { scopeAccount: 'a'.repeat(40) },
      { scopeAccount: 'alice' },
      { mailKey: key('m1').toUpperCase() },
      { mailKey: key('m1').slice(1) },
      { senderEmail: 'Carol@mail.example' },
      { senderEmail: 'carol' },
      { senderEmail: 'carol @mail.example' },
      { dataSha256: 'zz' },
      { stampValue: '01' },
    ]) {
      expect(() => journal.admitInboundEmail({ ...good, ...patch })).toThrow(MailJournalArgumentError);
    }
    for (const patch of [
      { frankMessageId: '0'.repeat(32) },
      { frankMessageId: frankId(1).toUpperCase().replace(/0/g, 'A') },
      { conversationId: 'not-an-id' },
    ]) {
      expect(() => bridge(journal, ALICE, 'f1', '<f1@frank.org>', patch)).toThrow(MailJournalArgumentError);
    }
    expect(() => bridge(journal, ALICE, 'f1', '<f1@frank.org>', { stampValue: '01' })).toThrow(
      MailJournalArgumentError
    );
    const input = frankInput(ALICE, 'f1', '<f1@frank.org>');
    for (const patch of [
      { rfcMessageId: 'f1@frank.org' },
      { mailKey: key('f1').toUpperCase() },
      { mailKey: 'short' },
      { itemKey: 'short' },
    ]) {
      expect(() => journal.recordFrankMessage({ ...input, ...patch })).toThrow(MailJournalArgumentError);
    }
    expect(() => journal.findMailMessage(ALICE, 'not-a-mail-key')).toThrow(MailJournalArgumentError);
    expect(() => relay(journal, ALICE, 'm1')).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
  });
});

describe('Frank → email and the cross-direction rule', () => {
  // C1, 18.3. Prevents: a message fetched again by an inclusive cursor being bridged and emailed twice.
  it('records a bridged message once per payload digest, before and after a reopen', () => {
    const first = open();
    const recorded = bridge(first.journal, ALICE, 'f1', '<f1@frank.org>');
    expect(recorded).toMatchObject({
      kind: 'bridged',
      threadCreated: true,
      allowancesCovered: 0,
      inbound: { disposition: 'bridged', scopeAccount: ALICE, frankMessageId: frankId(1) },
      message: { rfcMessageId: '<f1@frank.org>', mailKey: key('f1'), direction: 'frank_to_email', conversationId: frankId(100) },
    });
    expect('contested' in recorded).toBe(false);
    const before = dump(first.db);
    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(bridge(journal, ALICE, 'f1', '<f1@frank.org>')).toMatchObject({
        kind: 'duplicate',
        inbound: { payloadDigest: digest('f1') },
      });
      expect(dump(db)).toBe(before);
    }
    expect(current!.journal.findMailThread(ALICE, frankId(100))).toMatchObject({ origin: 'frank' });
  });

  // #1347. Different content that reuses a sealed ID or an authored Message-ID is stored under its own
  // mail key and item key without renaming. (The re-seal half of this test is J6.)
  it('keeps different content that reuses a sealed ID or an authored Message-ID as its own message without renaming', () => {
    const { journal, db } = open();
    const original = bridged(journal, ALICE, 'f1', '<f1@frank.org>');

    // Same sealed message ID, different content, its own authored ID: both stay (the index is not unique).
    const sameSealedId = bridge(journal, ALICE, 'f2', '<f2@frank.org>', { frankMessageId: frankId(1) });
    expect(sameSealedId).toMatchObject({ kind: 'bridged', threadCreated: false });

    // Same authored Message-ID, different content: stored under its own mailKey with the same rfcMessageId.
    const sameRfcId = bridge(journal, ALICE, 'f3', '<f1@frank.org>', { frankMessageId: frankId(3) });
    expect(sameRfcId).toMatchObject({
      kind: 'bridged',
      message: {
        rfcMessageId: '<f1@frank.org>',
        itemKey: ikey('f3'),
        mailKey: key('f3'),
        payloadDigest: digest('f3'),
      },
    });
    expect(journal.findMailMessage(ALICE, key('f1'))).toEqual(original.message);
    expect(journal.findMailMessage(ALICE, key('f3'))).toEqual(
      sameRfcId.kind === 'bridged' ? sameRfcId.message : undefined
    );
    expect(count(db, 'frank_inbound')).toBe(3);
    expect(count(db, 'mail_message')).toBe(3);
  });

  // C9, R10. Prevents: one Frank sender occupying a sealed message ID or a Message-ID before another uses it.
  it('two senders using the same sealed ID and the same Message-ID are both bridged, each in its own scope', () => {
    const { journal } = open();
    const a = bridge(journal, ALICE, 'from-alice', '<same@frank.org>', { digestName: 'a' });
    const b = bridge(journal, BOB, 'from-bob', '<same@frank.org>', { digestName: 'b' });
    expect([a.kind, b.kind]).toEqual(['bridged', 'bridged']);
    expect(a).toMatchObject({ threadCreated: true });
    expect(b).toMatchObject({ threadCreated: true });
    expect(journal.countFrankRootsSince(ALICE, 0)).toBe(1);
  });

  // #1347. Prevents: a user's own mail coming back from a list or self-copy being charged and relayed
  // to them as new mail; while a list-modified copy with a different mailKey is delivered under its own mailKey.
  it('own outbound mail arriving inbound: equal mail key is an echo, different mail key with same Message-ID is delivered without renaming', () => {
    const { journal, db } = open();
    const sent = bridged(journal, ALICE, 'sent', '<f1@frank.org>');

    const echo = admit(journal, ALICE, 'sent', '<f1@frank.org>', { body: 'the same mail' });
    expect(echo).toMatchObject({ kind: 'echo', revived: false, email: { disposition: 'echo', expiresAtMs: undefined } });
    expect(() => relay(journal, ALICE, 'sent')).toThrow(/echo; it cannot be relayed/);
    expect(count(db, 'frank_send')).toBe(0);
    const before = dump(db);
    expect(admit(reopen().journal, ALICE, 'sent', '<f1@frank.org>').kind).toBe('duplicate');
    expect(dump(current!.db)).toBe(before);

    // The same mail key in another scope is ordinary mail there.
    expect(admit(current!.journal, BOB, 'sent', '<f1@frank.org>').kind).toBe('admitted');

    // A list added a footer: a different mail key. Admitted and delivered with its Message-ID intact.
    expect(admit(current!.journal, ALICE, 'sent-with-footer', '<f1@frank.org>').kind).toBe('admitted');
    const footer = relay(current!.journal, ALICE, 'sent-with-footer');
    expect(footer).toMatchObject({
      created: true,
      message: { rfcMessageId: '<f1@frank.org>', mailKey: key('sent-with-footer') },
    });
    expect(current!.journal.findMailMessage(ALICE, key('sent'))).toEqual(sent.message);
    expect(current!.journal.findMailMessage(ALICE, key('sent-with-footer'))).toEqual(footer.message);
  });

  // #1347. An inbound message and an outbound message with the same Message-ID in the same scope
  // are both stored under their own mail keys with the same rfcMessageId.
  it('an inbound message, then the same ID authored outbound: both keep their Message-ID under their own mail keys', () => {
    const { journal } = open();
    admit(journal, ALICE, 'in', '<m1@x.example>');
    const inboundMsg = relay(journal, ALICE, 'in');

    const out = bridge(journal, ALICE, 'out', '<m1@x.example>', { conversationId: inboundMsg.message.conversationId });
    expect(out).toMatchObject({
      kind: 'bridged',
      threadCreated: false,
      message: {
        rfcMessageId: '<m1@x.example>',
        mailKey: key('out'),
        itemKey: ikey('out'),
        direction: 'frank_to_email',
      },
    });
    const again = reopen().journal;
    expect(again.findMailMessage(ALICE, key('in'))).toEqual(inboundMsg.message);
    expect(again.findMailMessage(ALICE, key('out'))).toEqual(out.kind === 'bridged' ? out.message : undefined);
    expect(again.findMailThread(ALICE, inboundMsg.message.conversationId)).toMatchObject({ origin: 'email' });
  });

  // 6.4, 19.2 rule 6. Prevents: a refused or quarantined message being evaluated again on every
  // fetch (and, for quota, bridged later when the window has moved).
  it('records rejected and quarantined messages once, with no message or thread row', () => {
    const { journal, db } = open();
    const base = { receivedTimeMs: 5, stampValue: '7' };
    expect(
      journal.recordFrankMessage({ ...base, outcome: 'rejected', payloadDigest: digest('r'), reason: 'quota', scopeAccount: ALICE })
    ).toMatchObject({ kind: 'rejected', inbound: { reason: 'quota', budget: '7', spent: '0' } });
    expect(journal.recordFrankMessage({ ...base, outcome: 'quarantined', payloadDigest: digest('q') })).toMatchObject({
      kind: 'quarantined',
      inbound: { disposition: 'quarantined', scopeAccount: undefined },
    });
    expect(() =>
      journal.recordFrankMessage({
        ...base,
        outcome: 'rejected',
        payloadDigest: digest('x'),
        reason: 'duplicate_message_id' as never,
      })
    ).toThrow(MailJournalArgumentError);
    const before = dump(db);
    const again = reopen().journal;
    expect(
      again.recordFrankMessage({ ...base, outcome: 'rejected', payloadDigest: digest('r'), reason: 'bad_recipient' })
    ).toMatchObject({ kind: 'duplicate', inbound: { reason: 'quota' } });
    expect(dump(current!.db)).toBe(before);
    expect(count(current!.db, 'mail_message')).toBe(0);
    expect(count(current!.db, 'mail_thread')).toBe(0);
  });

  // 19.4 rule 2. Prevents: the gateway paying more because of a Frank message than its stamp,
  // and a repeat granting or debiting twice.
  it('covers reply allowances and notices from the message stamp, once', () => {
    const first = open();
    const over = { stampValue: '25', replyAllowance: { unit: '10', wanted: 3 } };
    const recorded = bridged(first.journal, ALICE, 'f1', '<f1@frank.org>', over);
    expect(recorded).toMatchObject({ allowancesCovered: 2, inbound: { budget: '25', spent: '20' } });
    expect(bridge(first.journal, ALICE, 'f1', '<f1@frank.org>', over).kind).toBe('duplicate');

    const one = createdJob(first.journal, ALICE, recorded.message.mailKey, 'dave@mail.example').jobId;
    const two = createdJob(first.journal, ALICE, recorded.message.mailKey, 'erin@mail.example').jobId;
    first.journal.claimOutboundJob(one);
    first.journal.claimOutboundJob(two);
    first.journal.markOutboundJobFailed(one, '550 no');
    first.journal.markOutboundJobFailed(two, '550 no');

    const notice = (journal: MailJournal, unit: string, jobId = one) =>
      journal.stageNotice({ sourceKind: 'bounce', jobId, stampValue: '5', unit });
    expect(notice(first.journal, '10')).toEqual({ kind: 'uncovered' });
    expect(count(first.db, 'frank_send')).toBe(0);
    const created = notice(first.journal, '5');
    expect(created).toMatchObject({
      kind: 'created',
      slot: { sourceKind: 'bounce', sourceKey: String(one), state: 'staged' },
    });
    const before = dump(first.db);

    const again = reopen().journal;
    expect(notice(again, '5')).toEqual({ ...created, kind: 'existing' });
    expect(notice(again, '5', two)).toEqual({ kind: 'uncovered' });
    expect(dump(current!.db)).toBe(before);
    expect(again.findFrankInbound(digest('f1'))!.spent).toBe('25');
  });
});

describe('outbound jobs and send slots', () => {
  it('settles an ambiguous SMTP attempt only with durable positive provider evidence', () => {
    const first = open();
    const message = bridged(first.journal, ALICE, 'provider', '<provider@frank.org>').message;
    const job = createdJob(first.journal, ALICE, message.mailKey, 'dave@mail.example');
    expect(() => first.journal.confirmOutboundJobAccepted(job.jobId, 'provider-1')).toThrow(MailJournalStateError);
    first.journal.claimOutboundJob(job.jobId);
    first.journal.markOutboundJobUncertain(job.jobId, 'SMTP DATA result lost');
    const journal = reopen().journal;
    expect(journal.confirmOutboundJobAccepted(job.jobId, 'provider-1')).toMatchObject({
      state: 'sent',
      providerEmailId: 'provider-1',
      attempts: 1,
    });
    expect(journal.confirmOutboundJobAccepted(job.jobId, 'provider-1')).toMatchObject({ state: 'sent', attempts: 1 });
    expect(() => journal.confirmOutboundJobAccepted(job.jobId, 'provider-2')).toThrow(MailJournalStateError);
    expect(reopen().journal.listUncertainOutboundJobs()).toEqual([]);
  });

  it('persists an exclusive send claim before any provider effect and holds ambiguous outcomes for reconciliation', () => {
    const first = open();
    const message = bridged(first.journal, ALICE, 'claim', '<claim@frank.org>').message;
    const job = createdJob(first.journal, ALICE, message.mailKey, 'dave@mail.example');
    expect(first.journal.claimOutboundJob(job.jobId)).toMatchObject({ state: 'submitting', submissionStartedAtMs: expect.any(Number) });
    expect(() => first.journal.claimOutboundJob(job.jobId)).toThrow(MailJournalStateError);
    const again = reopen().journal;
    expect(again.listDueOutboundJobs(100000, 10)).toEqual([]);
    expect(again.listUncertainOutboundJobs().map((row) => row.jobId)).toEqual([job.jobId]);
    expect(again.markOutboundJobUncertain(job.jobId, 'provider timeout')).toMatchObject({ state: 'uncertain', attempts: 1 });
    expect(reopen().journal.listDueOutboundJobs(100000, 10)).toEqual([]);
    expect(() => reopen().journal.claimOutboundJob(job.jobId)).toThrow(MailJournalStateError);
  });
  // C5, C6. Prevents: a job re-created with new bytes (a second, different email for one
  // message), an email with no recorded message, and a guessable bounce address changing state.
  it('adds one job per recipient, never replaces its bytes, and moves it only along its states', () => {
    const first = open();
    const message = bridged(first.journal, ALICE, 'f1', '<f1@frank.org>').message;
    const job = (journal: MailJournal, recipient: string, body: string) =>
      addJob(journal, ALICE, message.mailKey, recipient, body);
    const one = job(first.journal, 'dave@mail.example', 'signed bytes');
    const two = job(first.journal, 'erin@mail.example', 'signed bytes');
    expect(one).toMatchObject({
      kind: 'created',
      job: {
        state: 'pending',
        attempts: 0,
        mailKey: key('f1'),
        // Read from the message row, not stored on the job.
        rfcMessageId: '<f1@frank.org>',
        frankMessageId: message.frankMessageId,
        conversationId: message.conversationId,
        payloadDigest: digest('f1'),
      },
    });
    if (one.kind === 'key_taken' || two.kind === 'key_taken') throw new Error('unexpected');
    expect(one.job.bounceToken).toMatch(/^[0-9a-f]{32}$/);
    expect(one.job.bounceToken).not.toBe(two.job.bounceToken);
    const before = dump(first.db);

    const journal = reopen().journal;
    expect(job(journal, 'dave@mail.example', 'signed bytes')).toEqual({ ...one, kind: 'existing' });
    expect(job(journal, 'dave@mail.example', 'other bytes')).toEqual({ ...one, kind: 'key_taken' });
    expect(dump(current!.db)).toBe(before);

    expect(journal.listDueOutboundJobs(99, 10)).toEqual([]);
    expect(journal.listDueOutboundJobs(100, 10).map((j) => j.jobId)).toEqual([one.job.jobId, two.job.jobId]);
    expect(journal.claimOutboundJob(one.job.jobId)).toMatchObject({ state: 'submitting' });
    expect(journal.deferOutboundJob(one.job.jobId, 500, '451 later')).toMatchObject({
      state: 'pending',
      attempts: 1,
      nextAttemptAtMs: 500,
      lastError: '451 later',
    });
    journal.claimOutboundJob(one.job.jobId);
    expect(journal.markOutboundJobSent(one.job.jobId)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(journal.markOutboundJobSent(one.job.jobId)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(() => journal.markOutboundJobFailed(one.job.jobId, 'late')).toThrow(MailJournalStateError);
    journal.claimOutboundJob(two.job.jobId);
    expect(journal.markOutboundJobFailed(two.job.jobId, '550 no')).toMatchObject({ state: 'failed', attempts: 1 });
    expect(journal.markOutboundJobFailed(two.job.jobId, 'again')).toMatchObject({ lastError: '550 no' });
    expect(() => journal.markOutboundJobSent(two.job.jobId)).toThrow(MailJournalStateError);

    // C8: an unknown or malformed token changes nothing; the real token marks its own job only.
    const settled = dump(current!.db);
    expect(journal.markOutboundJobBounced('0'.repeat(32))).toBeUndefined();
    expect(journal.markOutboundJobBounced('17')).toBeUndefined();
    expect(dump(current!.db)).toBe(settled);
    expect(journal.markOutboundJobBounced(one.job.bounceToken)).toMatchObject({ state: 'bounced' });
    expect(journal.markOutboundJobBounced(two.job.bounceToken)).toMatchObject({ state: 'failed' });

    const final = reopen().journal;
    expect(final.findOutboundJob(one.job.jobId)).toMatchObject({ state: 'bounced' });
    expect(final.countOutboundJobs('pending')).toBe(0);
    expect(final.countOutboundJobs('failed')).toBe(1);
  });

  // 6.3, D17. Prevents: a slot adopting another slot's digest and being marked delivered without
  // ever being sent; and a stored digest being replaced, which would lose the paid attempt.
  it('links a slot to one digest, holds on a digest another slot has, and never replaces a digest', () => {
    let { journal } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    admit(journal, ALICE, 'm2', '<m2@x.example>');
    const a = relay(journal, ALICE, 'm1').slot.slotId;
    const b = relay(journal, ALICE, 'm2').slot.slotId;
    expect(journal.countWaitingFrankSends()).toBe(2);

    expect(() => journal.linkFrankSend(a, digest('a'))).toThrow(MailJournalStateError);
    expect(() => journal.markFrankSendDelivered(a)).toThrow(MailJournalStateError);
    expect(journal.markFrankSendSending(a).state).toBe('sending');
    journal = reopen().journal;
    expect(journal.markFrankSendSending(a).state).toBe('sending');
    expect(journal.linkFrankSend(a, digest('a'))).toMatchObject({
      kind: 'linked',
      slot: { state: 'linked', payloadDigest: digest('a') },
    });
    const linked = dump(current!.db);
    expect(journal.linkFrankSend(a, digest('a')).kind).toBe('linked');
    expect(() => journal.linkFrankSend(a, digest('other'))).toThrow(/digest was not changed/);
    expect(dump(current!.db)).toBe(linked);

    journal.markFrankSendSending(b);
    expect(journal.linkFrankSend(b, digest('a'))).toMatchObject({
      kind: 'held',
      slot: { state: 'held', holdReason: 'digest_conflict', payloadDigest: undefined },
    });
    journal = reopen().journal;
    expect(journal.linkFrankSend(b, digest('a')).kind).toBe('held');
    expect(() => journal.markFrankSendDelivered(b)).toThrow(MailJournalStateError);
    expect(journal.holdFrankSend(b, 'send_failed').holdReason).toBe('digest_conflict');

    expect(journal.markFrankSendDelivered(a).state).toBe('delivered');
    expect(journal.markFrankSendDelivered(a).state).toBe('delivered');
    expect(() => journal.holdFrankSend(a, 'send_failed')).toThrow(MailJournalStateError);
    expect(() => journal.markFrankSendSending(999)).toThrow(/No send slot/);
    expect(reopen().journal.countWaitingFrankSends()).toBe(0);
  });
});

describe('G1b: the open path, the registry and what stays private (21.4, 21.5)', () => {
  // The G1 review's request. Prevents: the journal's pragmas or tables reaching a ledger that never
  // opened a journal, which is every ledger in the running gateway today.
  it('a plain CreditLedger open creates no journal table and sets no pragma', () => {
    const ledger = newLedger();
    const db = ledger.sqlite!;
    expect(count(db, "sqlite_master WHERE name LIKE 'mail_%' OR name IN ('inbound_email', 'frank_send', 'frank_inbound', 'outbound_job')")).toBe(0);
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'normal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    ledger.addCredits(SENDER, 1);
    // Another connection reads and writes the same file while the ledger stays open.
    const second = new DatabaseSync(file);
    second.exec('CREATE TABLE probe (x)');
    expect(count(second, 'credit_ledger')).toBe(1);
    second.close();
    db.close();
  });

  // J20 (21.4 a). Prevents: an unknown, family, alias or inherited name stored as the journal's chain
  // for good, after which the right identifier would be refused at every open.
  it('J20: opens only under a canonical registry identifier; anything else creates nothing and changes no pragma', () => {
    for (const bad of ['monad', 'evm', 'ecash-testnet', 'ecash-mainnet', 'constructor', '__proto__', 'Monad-Testnet', 'monad-testnet ', '']) {
      const ledger = newLedger();
      const db = ledger.sqlite!;
      db.exec('PRAGMA busy_timeout = 1234');
      expect(() => new MailJournal(ledger, { ...IDENTITY, chainIdentifier: bad })).toThrow(MailJournalArgumentError);
      expect(() => new MailJournal(ledger, { ...IDENTITY, chainIdentifier: 7 as never })).toThrow(MailJournalArgumentError);
      expect(count(db, "sqlite_master WHERE name LIKE 'mail_%'")).toBe(0);
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
      expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'normal' });
      db.close();
    }
    // Every name the journal can accept is an `id` of the protocol registry: the wallet's table adds none.
    const registry = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'protocol', 'chains', 'v1.json'), 'utf8')
    ) as { chains: Array<{ id: string }> };
    const ids = registry.chains.map((chain) => chain.id);
    expect(Object.keys(PROTOCOL_CHAINS).filter((name) => !ids.includes(name))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining(['monad-testnet', 'xec-testnet']));
    // Two canonical identifiers of two families open, each in its own file.
    expect(open({ chainIdentifier: 'monad-testnet' }).journal.chainIdentifier).toBe('monad-testnet');
    close();
    file = path.join(dir, 'xec.sqlite3');
    expect(open({ chainIdentifier: 'xec-testnet' }).journal.chainIdentifier).toBe('xec-testnet');
    // The alias of that very chain is still not it.
    close();
    expect(() => open({ chainIdentifier: 'ecash-testnet' })).toThrow(MailJournalArgumentError);
    expect(open({ chainIdentifier: 'xec-testnet' }).db.prepare('SELECT chain_identifier FROM mail_journal_meta').get()).toEqual({
      chain_identifier: 'xec-testnet',
    });
  });

  // J23 (21.4 e). Prevents: a failed start leaving the ledger file write-locked, with a changed
  // timeout, for as long as the process keeps the connection.
  const refusedOpens: Array<[string, () => void, Partial<MailJournalOptions>, new (message: string) => Error]> = [
    [
      'another gateway account',
      (): void => {
        open();
        close();
      },
      { gatewayAccount: `0x${'8'.repeat(40)}` },
      MailJournalOpenError,
    ],
    ['a format-1 journal', (): void => writeLegacyFormatDatabase(1), {}, MailJournalOpenError],
    ['a format-2 journal', (): void => writeLegacyFormatDatabase(2), {}, MailJournalOpenError],
    ['an unknown chain', (): void => undefined, { chainIdentifier: 'monad' }, MailJournalArgumentError],
  ];
  it.each(refusedOpens)('J23: a refused open (%s) restores the timeout and releases the file', (_name, prepare, options, error) => {
    prepare();
    const ledger = newLedger();
    const db = ledger.sqlite!;
    db.exec('PRAGMA busy_timeout = 1234');
    expect(() => new MailJournal(ledger, { ...IDENTITY, ...options })).toThrow(error);
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'normal' });
    expect(db.isTransaction).toBe(false);

    // At once: the second connection has no busy timeout, so it would fail rather than wait.
    const second = new DatabaseSync(file);
    second.exec('BEGIN IMMEDIATE');
    second.exec('CREATE TABLE probe (x)');
    second.exec('COMMIT');
    second.close();
    // And the refused ledger still works as a ledger.
    ledger.addCredits(SENDER, 1);
    expect(ledger.getBalance(SENDER)).toBe(1);
    db.close();
  });

  // 21.4 e, one step further than the contract's text. Prevents: a second, refused journal on a
  // ledger that already has an open one switching off the first one's exclusive lock.
  it('a refused second journal on the same ledger leaves the first journal locked and its timeout in place', () => {
    const { ledger, db } = open();
    expect(() => new MailJournal(ledger, { ...IDENTITY, gatewayAccount: `0x${'8'.repeat(40)}` })).toThrow(
      MailJournalOpenError
    );
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    const second = new DatabaseSync(file);
    expect(() => second.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    second.close();
  });

  // J24 (21.5). Prevents: a file written by an earlier format build (including formats 1 and 2) opening under this one and failing
  // at its first statement ("no such column"), or being altered, migrated or reset on the way.
  it.each([1, 2] as const)('J24: a format-%i database is refused with the reset message and is byte-identical afterwards', (fmt) => {
    writeLegacyFormatDatabase(fmt);
    const before = fileHash();
    for (let i = 0; i < 2; i++) {
      expect(() => open()).toThrow(MailJournalOpenError);
      expect(() => open()).toThrow(
        new RegExp(`format ${fmt} is not supported; this build reads format 9 only\\. Nothing was changed\\. Archive this database together with the gateway wallet stores and start a new one`)
      );
    }
    expect(fileHash()).toBe(before);
    expect(fs.existsSync(`${file}-journal`)).toBe(false);
    const raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: fmt });
    expect(raw.prepare('SELECT content_key, duplicate_mismatches FROM inbound_email').get()).toEqual({
      content_key: key('old'),
      duplicate_mismatches: 0,
    });
    raw.close();
  });

  // J25 (21.4 c). Prevents: the raw handle, the DDL or EVM-only names spreading to code that the
  // journal's rules do not cover.
  it('J25: the raw handle, the DDL and the old column names stay out of reach', () => {
    const allowed = ['credit-ledger.ts', 'mail-journal.ts'].map((name) => path.join(SRC, 'ledger', name));
    const usesHandle = sourceFiles(SRC).filter((f) => /\.sqlite\b/.test(fs.readFileSync(f, 'utf8')));
    expect(usesHandle.filter((f) => !allowed.includes(f))).toEqual([]);
    // The scan does see a use where there is one.
    expect(usesHandle).toEqual([path.join(SRC, 'ledger', 'mail-journal.ts')]);

    expect('MAIL_JOURNAL_DDL' in packageIndex).toBe(false);
    expect(Object.keys(packageIndex).filter((name) => /DDL/.test(name))).toEqual([]);
    expect(packageIndex.MAIL_JOURNAL_FORMAT).toBe(9);
    expect(packageIndex.MAIL_JOURNAL_TABLES).toBe(MAIL_JOURNAL_TABLES);

    const { db } = open();
    const columns = MAIL_JOURNAL_TABLES.flatMap((table) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((column) => `${table}.${String(column.name)}`)
    );
    expect(columns.filter((name) => /_wei$/.test(name) || /duplicate_mismatches|content_key|claimed_rfc_id/.test(name))).toEqual([]);
    expect(columns).toEqual(
      expect.arrayContaining([
        'mail_message.mail_key',
        'mail_message.item_key',
        'mail_message.payload_digest',
        'inbound_email.mail_key',
        'inbound_email.expires_at',
        'frank_inbound.stamp_value',
        'frank_inbound.budget',
        'frank_inbound.spent',
        'outbound_job.mail_key',
      ])
    );
    expect(columns).not.toEqual(expect.arrayContaining(['outbound_job.frank_message_id']));
    expect(columns).not.toEqual(expect.arrayContaining(['outbound_job.conversation_id']));
    expect(columns).not.toEqual(expect.arrayContaining(['outbound_job.rfc_message_id']));
    expect(columns).not.toEqual(expect.arrayContaining(['mail_message.claimed_rfc_id']));
  });

  // 21.6 rule 4 and explicitly admitted runtime callers. Prevents a message's
  // row being rewritten or a new, unreviewed path taking journal ownership.
  it('has no UPDATE or DELETE on mail_message, and only accepted coordinators use the journal', () => {
    const journalSource = fs.readFileSync(path.join(SRC, 'ledger', 'mail-journal.ts'), 'utf8');
    expect(journalSource).not.toMatch(/UPDATE\s+mail_message|DELETE\s+FROM\s+mail_message|REPLACE\s+INTO\s+mail_message/i);
    const outside = sourceFiles(SRC).filter((f) => !f.startsWith(path.join(SRC, 'ledger') + path.sep));
    const users = outside.filter((f) =>
      /MailJournal|\.atomic\(|expireHeldMessage|LedgerPoisonedError/.test(fs.readFileSync(f, 'utf8'))
    );
    expect(users.map((f) => path.relative(SRC, f))).toEqual([
      'host/gateway-provision.ts',
      'host/journaled-mail-host.ts',
      'mta/journaled-outbound-worker.ts',
      'mta/resend-outbound-reconciler.ts',
      'relay/journaled-frank-mailbox.ts',
      'relay/journaled-frank-outbound.ts',
      'relay/journaled-inbound-send.ts',
      'smtp/issued-mailbox-lookup.ts',
    ]);
  });
});

describe('G1b: an outbound job is keyed by the email it carries (21.1)', () => {
  const R = 'r@x.example';

  /** Messages A and B of J1: one sealed ID, one authored Message-ID, different items. */
  function twoMessagesOneSealedId(journal: MailJournal) {
    const a = bridged(journal, ALICE, 'A', '<f1@frank.org>', { stampValue: '10', conversationId: frankId(100) });
    const jobA = createdJob(journal, ALICE, a.message.mailKey, R, 'email of A');
    const b = bridged(journal, ALICE, 'B', '<f1@frank.org>', { stampValue: '10', conversationId: frankId(200) });
    return { a, jobA, b };
  }

  // J1. Prevents: the second message's email never being queued, because the first message's job
  // to the same recipient answered `key_taken` under the old (scope, sealed ID, recipient) or (scope, rfcMessageId, recipient) key.
  it('J1: two messages with one sealed ID and one Message-ID each get their own job to the same recipient', () => {
    const first = open();
    const { a, jobA, b } = twoMessagesOneSealedId(first.journal);
    expect(a).toMatchObject({ message: { rfcMessageId: '<f1@frank.org>', mailKey: key('A'), frankMessageId: frankId(1) } });
    expect(b).toMatchObject({
      kind: 'bridged',
      message: { rfcMessageId: '<f1@frank.org>', mailKey: key('B'), frankMessageId: frankId(1) },
    });
    const jobB = addJob(first.journal, ALICE, b.message.mailKey, R, 'email of B');
    expect(jobB).toMatchObject({ kind: 'created', job: { mailKey: key('B'), rfcMessageId: '<f1@frank.org>', payloadDigest: digest('B'), conversationId: frankId(200) } });
    if (jobB.kind !== 'created') throw new Error('unexpected');
    expect(jobB.job.jobId).not.toBe(jobA.jobId);
    expect(jobA).toMatchObject({ mailKey: key('A'), rfcMessageId: '<f1@frank.org>', payloadDigest: digest('A'), conversationId: frankId(100) });
    const text = (raw: typeof jobA.signedRfc822) => (raw.kind === 'inline' ? Buffer.from(raw.bytes).toString() : '');
    expect([text(jobA.signedRfc822), text(jobB.job.signedRfc822)]).toEqual(['email of A', 'email of B']);
    expect(count(first.db, 'outbound_job')).toBe(2);
    const before = dump(first.db);

    // The whole sequence again, after a restart: nothing new.
    const { journal, db } = reopen();
    expect(bridge(journal, ALICE, 'A', '<f1@frank.org>').kind).toBe('duplicate');
    expect(bridge(journal, ALICE, 'B', '<f1@frank.org>').kind).toBe('duplicate');
    expect(addJob(journal, ALICE, key('A'), R, 'email of A')).toEqual({ kind: 'existing', job: jobA });
    expect(addJob(journal, ALICE, key('B'), R, 'email of B')).toEqual({ kind: 'existing', job: jobB.job });
    expect(addJob(journal, ALICE, key('B'), R, 'other bytes').kind).toBe('key_taken');
    expect(dump(db)).toBe(before);
    expect(journal.listDueOutboundJobs(100, 10)).toEqual([jobA, jobB.job]);
  });

  // J2. Prevents: an email queued that no bridged message owns, so nothing could pay for its
  // bounce notice and nothing would say which conversation it belongs to.
  it('J2: refuses a job for a mail key with no message, an inbound message, or another scope\'s message', () => {
    const { journal, db } = open();
    bridged(journal, ALICE, 'A', '<f1@frank.org>');
    admit(journal, ALICE, 'in', '<m1@x.example>');
    relay(journal, ALICE, 'in');
    const before = dump(db);
    expect(() => addJob(journal, ALICE, key('nothing'), 'r@x.example')).toThrow(MailJournalStateError);
    expect(() => addJob(journal, ALICE, key('in'), 'r@x.example')).toThrow(MailJournalStateError);
    expect(() => addJob(journal, BOB, key('A'), 'r@x.example')).toThrow(/No bridged message/);
    expect(() => addJob(journal, ALICE, 'not-a-mail-key', 'r@x.example')).toThrow(MailJournalArgumentError);
    expect(dump(db)).toBe(before);
    expect(count(db, 'outbound_job')).toBe(0);
    // The table itself refuses a job with no message row, whatever the code above it does.
    expect(() =>
      db.exec(
        `INSERT INTO outbound_job (scope_account, mail_key, recipient_email, sender_local_part, bounce_token, signed_rfc822, state, next_attempt_at, created_at)
         VALUES ('${ALICE}', '${key('nothing')}', 'r@x.example', 'threadmissing', 't', x'00', 'pending', 0, 0)`
      )
    ).toThrow(/FOREIGN KEY/);
  });

  // J3. Prevents: a notice paid from another message's stamp, or staged in the scope and
  // conversation a caller named instead of the failed email's own; and a repeat debiting twice.
  it('J3: each bounce notice debits its own message once and takes that message\'s scope and conversation', () => {
    const first = open();
    const { jobA, b } = twoMessagesOneSealedId(first.journal);
    const jobB = createdJob(first.journal, ALICE, b.message.mailKey, R, 'email of B');
    first.journal.claimOutboundJob(jobA.jobId);
    first.journal.markOutboundJobFailed(jobA.jobId, '550 no');
    first.journal.markOutboundJobBounced(jobB.bounceToken);
    const spent = (journal: MailJournal) => ['A', 'B'].map((name) => journal.findFrankInbound(digest(name))!.spent);

    // A caller that tries to name the scope, the conversation and the payer is not listened to.
    const forA = first.journal.stageNotice({
      sourceKind: 'bounce',
      jobId: jobA.jobId,
      stampValue: '3',
      unit: '4',
      scopeAccount: BOB,
      conversationId: frankId(999),
      cover: { payloadDigest: digest('B') },
    } as never);
    expect(forA).toMatchObject({
      kind: 'created',
      slot: { sourceKind: 'bounce', sourceKey: String(jobA.jobId), scopeAccount: ALICE, conversationId: frankId(100), stampValue: '3' },
    });
    expect(spent(first.journal)).toEqual(['4', '0']);

    const forB = first.journal.stageNotice({ sourceKind: 'bounce', jobId: jobB.jobId, stampValue: '3', unit: '4' });
    expect(forB).toMatchObject({
      kind: 'created',
      slot: { sourceKey: String(jobB.jobId), scopeAccount: ALICE, conversationId: frankId(200) },
    });
    expect(spent(first.journal)).toEqual(['4', '4']);
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      for (const [job, created] of [[jobA, forA], [jobB, forB]] as const) {
        expect(journal.stageNotice({ sourceKind: 'bounce', jobId: job.jobId, stampValue: '3', unit: '4' })).toEqual({
          ...created,
          kind: 'existing',
        });
      }
      expect(spent(journal)).toEqual(['4', '4']);
      expect(dump(db)).toBe(before);
    }
  });

  // J4. Prevents: a notice (and its debit) for something that did not fail, or staged on the
  // caller's word about whom to tell and who pays.
  it('J4: refuses a notice for anything that has not failed, and takes no scope, conversation or cover', () => {
    const { journal, db } = open();
    const message = bridged(journal, ALICE, 'A', '<f1@frank.org>', { stampValue: '100' }).message;
    const pending = createdJob(journal, ALICE, message.mailKey, 'p@x.example').jobId;
    const sent = createdJob(journal, ALICE, message.mailKey, 's@x.example').jobId;
    journal.claimOutboundJob(sent);
    journal.markOutboundJobSent(sent);
    bridge(journal, ALICE, 'A', '<f1@frank.org>', { digestName: 'A-resealed', stampValue: '100' });
    const base = { receivedTimeMs: 1, stampValue: '100' };
    journal.recordFrankMessage({ ...base, outcome: 'quarantined', payloadDigest: digest('quarantined'), scopeAccount: ALICE });
    journal.recordFrankMessage({ ...base, outcome: 'rejected', reason: 'quota', payloadDigest: digest('no-scope') });
    expect(journal.findFrankInbound(digest('A-resealed'))!.disposition).toBe('resealed');
    const before = dump(db);

    const price = { stampValue: '1', unit: '1' };
    for (const jobId of [999, pending, sent]) {
      expect(() => journal.stageNotice({ sourceKind: 'bounce', jobId, ...price })).toThrow(MailJournalStateError);
    }
    for (const name of ['unknown', 'A', 'quarantined', 'A-resealed', 'no-scope']) {
      expect(() => journal.stageNotice({ sourceKind: 'reject', payloadDigest: digest(name), ...price })).toThrow(
        MailJournalStateError
      );
    }
    for (const bad of [
      { sourceKind: 'bounce', jobId: 0, ...price },
      { sourceKind: 'bounce', jobId: 1.5, ...price },
      { sourceKind: 'bounce', jobId: '1', ...price },
      { sourceKind: 'bounce', sourceKey: String(pending), ...price },
      { sourceKind: 'reject', payloadDigest: 'zz', ...price },
      { sourceKind: 'inbound_email', jobId: pending, ...price },
      { sourceKind: 'bounce', jobId: pending, stampValue: '1', unit: '0' },
      { sourceKind: 'bounce', jobId: pending, stampValue: '1' },
    ]) {
      expect(() => journal.stageNotice(bad as never)).toThrow(MailJournalArgumentError);
    }
    expect(dump(db)).toBe(before);
    expect(count(db, 'frank_send')).toBe(0);

    // Type only, never run: each line must fail to compile, or `@ts-expect-error` is itself an error.
    const typeOnly = (): void => {
      // @ts-expect-error a notice takes no scope
      journal.stageNotice({ sourceKind: 'bounce', jobId: 1, ...price, scopeAccount: ALICE });
      // @ts-expect-error a notice takes no conversation
      journal.stageNotice({ sourceKind: 'reject', payloadDigest: digest('A'), ...price, conversationId: frankId(1) });
      // @ts-expect-error a notice takes no cover
      journal.stageNotice({ sourceKind: 'bounce', jobId: 1, ...price, cover: { payloadDigest: digest('A'), unit: '1' } });
      // @ts-expect-error a bounce notice is named by its job, not by a digest
      journal.stageNotice({ sourceKind: 'bounce', payloadDigest: digest('A'), ...price });
    };
    expect(typeof typeOnly).toBe('function');
  });

  // J5. Prevents: a rejected message that never had a usable conversation (the reason it was
  // rejected may be exactly that) getting a notice that cannot be staged.
  it('J5: a reject notice for a message with no conversation opens its own, and one with a conversation uses it', () => {
    const { journal } = open();
    const base = { receivedTimeMs: 1, stampValue: '10', outcome: 'rejected' as const, scopeAccount: ALICE };
    journal.recordFrankMessage({ ...base, reason: 'no_sealed_identity', payloadDigest: digest('rootless') });
    journal.recordFrankMessage({ ...base, reason: 'bad_recipient', payloadDigest: digest('threaded'), conversationId: frankId(300) });
    const notice = (name: string) =>
      journal.stageNotice({ sourceKind: 'reject', payloadDigest: digest(name), stampValue: '2', unit: '6' });

    const rootless = notice('rootless');
    if (rootless.kind !== 'created') throw new Error('unexpected');
    expect(rootless.slot).toMatchObject({ sourceKind: 'reject', sourceKey: digest('rootless'), scopeAccount: ALICE });
    expect(rootless.slot.conversationId).toBe(rootless.slot.frankMessageId);
    expect(notice('threaded')).toMatchObject({ kind: 'created', slot: { conversationId: frankId(300) } });

    // Each is paid by the rejected message itself, once.
    expect(notice('rootless')).toEqual({ ...rootless, kind: 'existing' });
    expect(journal.findFrankInbound(digest('rootless'))!.spent).toBe('6');
    expect(journal.findFrankInbound(digest('threaded'))!.spent).toBe('6');
  });
});

describe('G1b: two keys, re-seals and echoes (21.2)', () => {
  // J6. Prevents: a second email for one authored message when it arrives under a new seal; and a
  // paid message that leaves no record, so every inclusive fetch examines it again.
  it('J6: the same authored email under a new seal writes one resealed row and nothing else', () => {
    const first = open();
    const original = bridged(first.journal, ALICE, 'f1', '<f1@frank.org>', { stampValue: '9' });
    const other = { digestName: 'f1-resealed', stampValue: '9', frankMessageId: frankId(2), conversationId: frankId(200) };
    const resealInput = {
      ...frankInput(ALICE, 'f1', '<f1@frank.org>', { ...other, replyAllowance: { unit: '1', wanted: 3 } }),
      receivedTimeMs: 2_000,
    };
    const untouched = (db: DatabaseSync) =>
      ['mail_message', 'mail_thread', 'outbound_job', 'frank_send'].map((t) => rowsOf(db, `SELECT * FROM ${t}`)).join('|');
    const before = untouched(first.db);

    const resealed = first.journal.recordFrankMessage(resealInput);
    expect(resealed).toMatchObject({
      kind: 'same_message',
      message: original.message,
      inbound: {
        payloadDigest: digest('f1-resealed'),
        disposition: 'resealed',
        scopeAccount: ALICE,
        frankMessageId: frankId(2),
        receivedTimeMs: 2_000,
        stampValue: '9',
        budget: '9',
        spent: '0',
      },
    });
    expect(untouched(first.db)).toBe(before);
    expect(count(first.db, 'frank_inbound')).toBe(2);
    expect(first.journal.findFrankInbound(digest('f1'))).toEqual(original.inbound);
    const settled = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(journal.recordFrankMessage(resealInput)).toMatchObject({
        kind: 'duplicate',
        inbound: { disposition: 'resealed' },
      });
      expect(dump(db)).toBe(settled);
    }
    // A third seal with a different mailKey is still recognised by itemKey and not stored as a new message.
    expect(
      current!.journal.recordFrankMessage({
        ...frankInput(ALICE, 'f1', '<f1@frank.org>', { digestName: 'f1-third-seal', mailName: 'another-render' }),
      })
    ).toMatchObject({ kind: 'same_message', message: original.message, inbound: { disposition: 'resealed' } });
    expect(untouched(current!.db)).toBe(before);
    expect(count(current!.db, 'frank_inbound')).toBe(3);
  });

  // J7. Prevents: two different item keys claiming the same rendered mailKey in a scope.
  it('J7: refuses a different itemKey claiming an already-stored mailKey in the same scope', () => {
    const { journal, db } = open();
    bridged(journal, ALICE, 'f1', '<f1@frank.org>');
    const before = dump(db);
    expect(() =>
      journal.recordFrankMessage(frankInput(ALICE, 'f2', '<f2@frank.org>', { mailName: 'f1' }))
    ).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
  });

  describe('recordFrankMessage: single-unit atomicity and replay idempotence', () => {
    const over = { stampValue: '25', replyAllowance: { unit: '10', wanted: 3 } };
    const input = frankInput(ALICE, 'f1', '<f1@frank.org>', over);
    const bridgeUnit = ({ ledger, journal }: Opened) =>
      ledger.atomic(() => {
        const result = journal.recordFrankMessage(input);
        if (result.kind === 'bridged') addJob(journal, ALICE, result.message.mailKey, 'r@x.example');
        return result;
      });

    it('inside the unit, after any statement: nothing is stored, and the unit then completes once', () => {
      const first = open();
      expectAtomic(
        first.db,
        [
          ['INSERT', 'frank_inbound'],
          ['INSERT', 'mail_message'],
          ['INSERT', 'mail_thread'],
          ['INSERT', 'outbound_job'],
        ],
        () => bridgeUnit(first)
      );
      const again = reopen();
      expect(bridgeUnit(again)).toMatchObject({ kind: 'bridged', allowancesCovered: 2 });
      for (const table of ['frank_inbound', 'mail_message', 'mail_thread', 'outbound_job']) {
        expect(count(again.db, table)).toBe(1);
      }
      expect(again.journal.findFrankInbound(digest('f1'))!.spent).toBe('20');
    });

    it('after the unit committed: replaying is a duplicate, with no second row and no second debit', () => {
      const first = open();
      const stored = bridgeUnit(first);
      if (stored.kind !== 'bridged') throw new Error('expected bridged');
      const before = dump(first.db);

      const again = reopen();
      expect(again.journal.recordFrankMessage(input)).toEqual({ kind: 'duplicate', inbound: stored.inbound });
      expect(bridgeUnit(again).kind).toBe('duplicate');
      expect(
        again.journal.recordFrankMessage({ ...input, mailKey: key('f1-rendered-again') }).kind
      ).toBe('duplicate');
      expect(addJob(again.journal, ALICE, key('f1'), 'r@x.example').kind).toBe('existing');
      expect(dump(again.db)).toBe(before);
      expect(again.journal.findFrankInbound(digest('f1'))!.spent).toBe('20');
      expect(again.journal.findMailMessage(ALICE, key('f1'))!.rfcMessageId).toBe('<f1@frank.org>');
    });
  });

  // J8. Prevents: a user's own mail, coming back from a list or a self-copy, being relayed to them
  // as new mail and charged to whoever it names as sender.
  it('J8: an inbound mail with an outbound row\'s mail key is an echo and can never be relayed', () => {
    const { journal, db } = open();
    bridged(journal, ALICE, 'out', '<f1@frank.org>');
    const echo = admit(journal, ALICE, 'out', '<f1@frank.org>');
    expect(echo).toMatchObject({ kind: 'echo', email: { disposition: 'echo', rfcMessageId: '<f1@frank.org>' } });
    expect(() => relay(journal, ALICE, 'out')).toThrow(/echo; it cannot be relayed/);
    expect(() => journal.holdInboundEmail(ALICE, key('out'), 'held-1')).toThrow(MailJournalStateError);
    expect(count(db, 'frank_send')).toBe(0);
    expect(admit(reopen().journal, ALICE, 'out', '<f1@frank.org>').kind).toBe('duplicate');
    // The same key in another scope is ordinary mail there.
    expect(admit(current!.journal, BOB, 'out', '<f1@frank.org>').kind).toBe('admitted');
  });

  // J10. Prevents: an echo being decided by the identifier it bears, which a relay on the way may
  // strip or replace.
  it('J10: a mail with no usable Message-ID whose mail key is an outbound row\'s is still an echo', () => {
    const { journal } = open();
    bridged(journal, ALICE, 'out', '<f1@frank.org>');
    expect(admit(journal, ALICE, 'out', undefined)).toMatchObject({
      kind: 'echo',
      email: { disposition: 'echo', rfcMessageId: syntheticId(key('out')) },
    });
    // And one bearing a stranger's ID with that key: the key alone decides.
    bridged(journal, BOB, 'out2', '<f2@frank.org>');
    expect(admit(journal, BOB, 'out2', '<unrelated@elsewhere.example>').kind).toBe('echo');
  });

  // J11. Prevents: an outside sender claiming or shadowing a synthetic no-message-id identifier
  // this gateway generated, by sending other content under it.
  it('J11: an outsider bearing a reserved no-message-id identifier claims nothing and shadows nothing', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'idless', undefined);
    const idless = relay(journal, ALICE, 'idless');
    const reservedId = syntheticId(key('idless'));
    expect(idless.message.rfcMessageId).toBe(reservedId);
    const idlessRow = rowsOf(db, 'SELECT * FROM mail_message WHERE mail_key = ?', key('idless'));

    const outsider = admit(journal, ALICE, 'outsider', reservedId);
    expect(outsider).toMatchObject({
      kind: 'admitted',
      email: { disposition: 'held', rfcMessageId: syntheticId(key('outsider')) },
    });
    const imitator = admit(journal, ALICE, 'imitator', syntheticId(key('someone-else')));
    expect(imitator).toMatchObject({ kind: 'admitted', email: { rfcMessageId: syntheticId(key('imitator')) } });

    // Relayed, each holds its own synthetic identifier in its own conversation.
    const relayed = relay(journal, ALICE, 'outsider');
    expect(relayed).toMatchObject({
      created: true,
      message: { rfcMessageId: syntheticId(key('outsider')) },
    });
    expect(relayed.message.conversationId).not.toBe(idless.message.conversationId);
    expect(relay(journal, ALICE, 'imitator').created).toBe(true);
    expect(rowsOf(db, 'SELECT * FROM mail_message WHERE mail_key = ?', key('idless'))).toBe(idlessRow);
    expect(journal.findMailMessage(ALICE, key('idless'))).toEqual(idless.message);

    // The synthetic identifier is still a lookup key: a reply to the ID-less mail cites it and joins its conversation.
    admit(journal, ALICE, 'reply', '<reply@x.example>');
    expect(relay(journal, ALICE, 'reply', { inReplyTo: reservedId }).message.conversationId).toBe(
      idless.message.conversationId
    );
    admit(journal, ALICE, 'reply-2', '<reply2@x.example>');
    expect(relay(journal, ALICE, 'reply-2', { references: [reservedId] }).message.conversationId).toBe(
      idless.message.conversationId
    );
  });

  // J12. Prevents: the two keys being compared with each other. An item key that happens to equal
  // a mail key must not make a different message a re-seal (silently dropped) or an echo (never
  // relayed).
  it('J12: a mail key and an item key of the same value are never taken for each other', () => {
    const { journal, db } = open();
    const V = sha('one value used as both kinds of key');
    const inbound = (mailKey: string, messageIdHeader: string, body: string) =>
      journal.admitInboundEmail({
        scopeAccount: ALICE,
        mailKey,
        stampValue: '1',
        messageIdHeader,
        senderEmail: SENDER,
        dataSha256: sha(body),
        raw: { kind: 'inline', bytes: Buffer.from(body) },
      });
    const relayKey = (mailKey: string) =>
      journal.relayInboundEmail({ scopeAccount: ALICE, mailKey, stampValue: '1' });

    // An inbound row with mailKey = V.
    inbound(V, '<m1@x.example>', 'inbound mail');
    expect(relayKey(V).message).toMatchObject({ rfcMessageId: '<m1@x.example>', direction: 'email_to_frank', mailKey: V });
    const before = dump(db);

    // An outbound message that tries to reuse the inbound row's mailKey V is refused on mail_key collision.
    expect(() =>
      journal.recordFrankMessage({ ...frankInput(ALICE, 'out-bad', '<m1@x.example>'), mailKey: V })
    ).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);

    // Outbound: an inbound row whose mailKey equals the outbound message's itemKey is NOT "the same authored email".
    const out2 = journal.recordFrankMessage({
      ...frankInput(ALICE, 'out2', '<m2@x.example>', { digestName: 'out2' }),
      itemKey: V,
      mailKey: key('out2'),
    });
    expect(out2).toMatchObject({ kind: 'bridged', message: { itemKey: V, mailKey: key('out2') } });

    // Inbound: an outbound row whose ITEM key equals the arriving mail's MAIL key is not an echo.
    const Z = sha('another shared value');
    const out3 = journal.recordFrankMessage({
      ...frankInput(ALICE, 'out3', '<f3@frank.org>', { digestName: 'out3' }),
      itemKey: Z,
      mailKey: key('out3'),
    });
    expect(out3).toMatchObject({ kind: 'bridged', message: { itemKey: Z, mailKey: key('out3') } });
    expect(inbound(Z, '<f3@frank.org>', 'not an echo')).toMatchObject({ kind: 'admitted', email: { disposition: 'held' } });
    // While the real echo, by mail key, still is one.
    expect(inbound(key('out3'), '<f3@frank.org>', 'the echo').kind).toBe('echo');
  });
});

describe('G1b: unpaid inbound mail expires (21.3)', () => {
  const X = '<x@sender.example>';
  const FAR = T0 + 10 * INBOUND_HOLD_TTL_MS;
  const dispositionOf = (journal: MailJournal, name: string, scope = ALICE) =>
    journal.findInboundEmail(scope, key(name))!.disposition;

  /** Admits `names` under one Message-ID, one second apart starting at `clock`. */
  function admitEach(journal: MailJournal, names: string[], header = X): void {
    for (const name of names) {
      expect(admit(journal, ALICE, name, header).kind).toBe('admitted');
      clock += 1_000;
    }
  }
  const copies = (n: number, prefix = 'copy'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  async function holdMessage(ledger: CreditLedger, id: string): Promise<void> {
    await ledger.holdMessage({
      id,
      senderEmail: SENDER,
      recipientAddress: ALICE,
      dkimDomain: 'mail.example',
      subject: 'held',
      rawRfc822: Buffer.from(`held mail ${id}`),
      createdAtMs: clock,
      expiresAtMs: clock + INBOUND_HOLD_TTL_MS,
    });
  }

  // J13. Unpaid held mails expire at their exact TTL via the sweep.
  it('J13: unpaid held mails expire at their exact TTL by the sweep', () => {
    let { journal } = open();
    admitEach(journal, copies(8));

    // One millisecond early nothing is due.
    clock = T0 + INBOUND_HOLD_TTL_MS - 1;
    const early = dump(current!.db);
    expect(journal.expireInboundEmails(256)).toEqual({ expired: 0, more: false });
    expect(dump(current!.db)).toBe(early);

    journal = reopen().journal;
    // The fourth copy's time, to the millisecond: four are due and four are not.
    clock = T0 + 3_000 + INBOUND_HOLD_TTL_MS;
    expect(journal.expireInboundEmails(256)).toEqual({ expired: 4, more: false });

    journal = reopen().journal;
    for (let i = 0; i < 8; i++) {
      const email = journal.findInboundEmail(ALICE, key(`copy-${i}`))!;
      expect(email.disposition).toBe(i < 4 ? 'expired' : 'held');
      expect(email.raw === undefined).toBe(i < 4);
      // What stays is the record that it was accepted and never paid for.
      expect(email).toMatchObject({
        rfcMessageId: X,
        senderEmail: SENDER,
        dataSha256: sha(`mail body of copy-${i}`),
        createdAtMs: T0 + i * 1_000,
        expiresAtMs: T0 + i * 1_000 + INBOUND_HOLD_TTL_MS,
      });
    }
    expect(count(current!.db, "inbound_email WHERE disposition = 'expired' AND raw IS NULL")).toBe(4);
    expect(count(current!.db, 'inbound_email WHERE raw IS NULL')).toBe(4);
  });

  // J14. Prevents: expiry touching relayed or released mail, their thread identity or their send
  // slots, or echoes.
  it('J14: only held mail expires; relayed and released mail, slots and echoes never do', () => {
    const { journal, db } = open();
    admitEach(journal, ['first-relayed', 'paid-later', ...copies(6)]);
    const firstRelayed = relay(journal, ALICE, 'first-relayed');
    journal.holdInboundEmail(ALICE, key('paid-later'), 'held-paid-later');
    const released = relay(journal, ALICE, 'paid-later');
    expect([firstRelayed.email.disposition, released.email.disposition]).toEqual(['relay', 'released']);
    // An echo under the same identifier, given a past time by hand (the journal never gives it one).
    bridged(journal, ALICE, 'out', '<f1@frank.org>');
    expect(admit(journal, ALICE, 'out', X).kind).toBe('echo');
    db.prepare("UPDATE inbound_email SET expires_at = 1 WHERE disposition = 'echo'").run();

    const kept = () =>
      [
        rowsOf(db, 'SELECT * FROM mail_message ORDER BY rowid'),
        rowsOf(db, 'SELECT * FROM mail_thread ORDER BY rowid'),
        rowsOf(db, 'SELECT * FROM frank_send ORDER BY rowid'),
        rowsOf(db, "SELECT * FROM inbound_email WHERE disposition IN ('relay', 'released', 'echo') ORDER BY rowid"),
      ].join('|');
    const before = kept();

    clock = FAR;
    expect(journal.expireInboundEmails(1000)).toEqual({ expired: 6, more: false });
    expect(journal.expireInboundEmails(1000)).toEqual({ expired: 0, more: false });
    expect(kept()).toBe(before);
    expect(copies(6).map((name) => dispositionOf(journal, name))).toEqual(Array(6).fill('expired'));
    expect(['first-relayed', 'paid-later', 'out'].map((name) => dispositionOf(journal, name))).toEqual(['relay', 'released', 'echo']);
    expect(journal.findMailMessage(ALICE, key('first-relayed'))).toEqual(firstRelayed.message);
  });

  // J16. Prevents: a mail resent after its unpaid copy expired being answered 250 and never
  // delivered, because its key was still stored.
  it('J16: the bytes of an expired mail arriving again are a new arrival, written over its expired row', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'm', X, { body: 'first bytes' });
    journal.holdInboundEmail(ALICE, key('m'), 'held-1');
    clock = T0 + INBOUND_HOLD_TTL_MS;
    expect(journal.expireInboundEmails(10)).toEqual({ expired: 1, more: false });
    expect(journal.findInboundEmail(ALICE, key('m'))).toMatchObject({ disposition: 'expired', heldMessageId: 'held-1' });

    clock += 5_000;
    const revived = admit(journal, ALICE, 'm', X, { sender: 'dora@mail.example', body: 'second bytes' });
    expect(revived).toMatchObject({
      kind: 'admitted',
      revived: true,
      email: {
        disposition: 'held',
        senderEmail: 'dora@mail.example',
        dataSha256: sha('second bytes'),
        heldMessageId: undefined,
        expiresAtMs: clock + INBOUND_HOLD_TTL_MS,
        createdAtMs: T0,
      },
    });
    if (revived.kind !== 'admitted' || revived.email.raw?.kind !== 'inline') throw new Error('unexpected');
    expect(Buffer.from(revived.email.raw.bytes).toString()).toBe('second bytes');
    expect(count(db, 'inbound_email')).toBe(1);
    // It is ordinary held mail again: a repeat is a duplicate, it can be linked and relayed.
    expect(admit(reopen().journal, ALICE, 'm', X).kind).toBe('duplicate');
    current!.journal.holdInboundEmail(ALICE, key('m'), 'held-2');
    expect(relay(current!.journal, ALICE, 'm')).toMatchObject({ created: true, email: { disposition: 'released' } });
  });

  // 21.3 rule 6. Prevents: an expired mail that has since become the scope's own outbound mail
  // (the user sent it on) being revived as held mail and offered for payment.
  it('an expired mail whose key is now an outbound row\'s is written again as an echo', () => {
    const { journal } = open();
    admit(journal, ALICE, 'm', X);
    clock = T0 + INBOUND_HOLD_TTL_MS;
    journal.expireInboundEmails(10);
    bridged(journal, ALICE, 'out', '<f1@frank.org>', { mailName: 'm' });
    expect(admit(journal, ALICE, 'm', X)).toMatchObject({
      kind: 'echo',
      revived: true,
      email: { disposition: 'echo', expiresAtMs: undefined, createdAtMs: T0 },
    });
    expect(() => relay(journal, ALICE, 'm')).toThrow(/echo/);
  });

  // 21.3 rule 5, the order "expire, then duplicate". Prevents: a mail whose own time has passed
  // being answered as a duplicate and so never tested for credit again.
  it('a repeat of a held mail past its time is expired and revived in the one admission', async () => {
    const { ledger, journal } = open();
    await holdMessage(ledger, 'held-1');
    admit(journal, ALICE, 'm', X);
    journal.holdInboundEmail(ALICE, key('m'), 'held-1');
    clock = T0 + INBOUND_HOLD_TTL_MS - 1;
    expect(admit(journal, ALICE, 'm', X)).toMatchObject({ kind: 'duplicate', email: { heldMessageId: 'held-1' } });
    clock = T0 + INBOUND_HOLD_TTL_MS;
    expect(admit(journal, ALICE, 'm', X)).toMatchObject({
      kind: 'admitted',
      revived: true,
      email: { disposition: 'held', heldMessageId: undefined, expiresAtMs: clock + INBOUND_HOLD_TTL_MS },
    });
    expect(ledger.getHeldMessage('held-1')!.status).toBe('expired');
  });

  // J17. Prevents: unbounded work in one worker pass; and the pay page (held_messages) and the
  // journal disagreeing about whether a mail can still be paid for.
  it('J17: the sweep expires at most `limit`, oldest first, with the linked held message, all or nothing', async () => {
    const { ledger, journal, db } = open();
    await holdMessage(ledger, 'held-0');
    await holdMessage(ledger, 'held-1');
    for (let i = 0; i < 5; i++) {
      admit(journal, ALICE, `e-${i}`, `<e${i}@sender.example>`);
      clock += 1_000;
    }
    journal.holdInboundEmail(ALICE, key('e-0'), 'held-0');
    journal.holdInboundEmail(ALICE, key('e-1'), 'held-1');
    admit(journal, ALICE, 'not-due', '<later@sender.example>');
    clock = T0 + 4_000 + INBOUND_HOLD_TTL_MS;
    const states = () => copies(5, 'e').map((name) => dispositionOf(journal, name));

    for (const bad of [0, 1001, 1.5, -1, NaN, '2' as never]) {
      expect(() => journal.expireInboundEmails(bad)).toThrow(MailJournalArgumentError);
    }
    // A failure after the first mail (and its held message) was expired leaves nothing changed.
    const before = dump(db);
    for (const trigger of [
      "AFTER UPDATE ON inbound_email WHEN (SELECT COUNT(*) FROM inbound_email WHERE disposition = 'expired') >= 2",
      "AFTER UPDATE ON held_messages WHEN NEW.id = 'held-1'",
    ]) {
      db.exec(`CREATE TEMP TRIGGER injected ${trigger} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      expect(() => journal.expireInboundEmails(2)).toThrow(/injected/);
      db.exec('DROP TRIGGER injected');
      expect(dump(db)).toBe(before);
      expect(ledger.getHeldMessage('held-0')!.status).toBe('held');
    }

    expect(journal.expireInboundEmails(2)).toEqual({ expired: 2, more: true });
    expect(states()).toEqual(['expired', 'expired', 'held', 'held', 'held']);
    expect(['held-0', 'held-1'].map((id) => ledger.getHeldMessage(id)!.status)).toEqual(['expired', 'expired']);
    expect(journal.findInboundEmailByHeldMessage('held-0')).toMatchObject({ mailKey: key('e-0'), disposition: 'expired' });

    const again = reopen();
    expect(again.journal.expireInboundEmails(2)).toEqual({ expired: 2, more: true });
    expect(again.journal.expireInboundEmails(2)).toEqual({ expired: 1, more: false });
    expect(again.journal.expireInboundEmails(2)).toEqual({ expired: 0, more: false });
    expect(dispositionOf(again.journal, 'not-due')).toBe('held');
    expect(again.ledger.getHeldMessage('held-0')!.status).toBe('expired');
  });

  // 21.6 rule 2. Prevents: the new ledger operation expiring mail that was released or is unknown.
  it('CreditLedger.expireHeldMessage moves held to expired once and touches nothing else', async () => {
    const { ledger } = open();
    await holdMessage(ledger, 'held-0');
    await holdMessage(ledger, 'held-1');
    expect(ledger.releaseHeldMessage('held-1')!.status).toBe('released');
    expect(ledger.expireHeldMessage('held-0')).toBe(true);
    expect(ledger.expireHeldMessage('held-0')).toBe(false);
    expect(ledger.expireHeldMessage('held-1')).toBe(false);
    expect(ledger.expireHeldMessage('nobody')).toBe(false);
    expect(['held-0', 'held-1'].map((id) => ledger.getHeldMessage(id)!.status)).toEqual(['expired', 'released']);
  });

  // J18. Prevents: a paid release lost because the clock passed before any sweep ran; and a
  // mail whose bytes are gone being "relayed".
  it('J18: expiry is the transition, not the clock: a held mail past its time is still relayed, an expired one never', () => {
    const { journal, db } = open();
    admitEach(journal, ['late', 'gone']);
    journal.holdInboundEmail(ALICE, key('late'), 'held-late');
    clock = FAR;
    // Nothing has expired `late` yet.
    const released = relay(journal, ALICE, 'late');
    expect(released).toMatchObject({ created: true, email: { disposition: 'released', expiresAtMs: undefined } });
    expect(db.prepare('SELECT expires_at FROM inbound_email WHERE mail_key = ?').get(key('late'))).toEqual({ expires_at: null });
    expect(journal.findInboundEmailByHeldMessage('held-late')).toEqual(released.email);
    expect(journal.findInboundEmailByHeldMessage('held-unknown')).toBeUndefined();

    expect(journal.expireInboundEmails(10)).toEqual({ expired: 1, more: false });
    const before = dump(db);
    expect(() => relay(journal, ALICE, 'gone')).toThrow(/expired; it cannot be relayed/);
    expect(() => journal.holdInboundEmail(ALICE, key('gone'), 'held-gone')).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
    expect(relay(reopen().journal, ALICE, 'late')).toEqual({ ...released, created: false });
  });

  // J19. Prevents: one purchase releasing two mails, or releasing a mail other than the one paid for.
  it('J19: two mails cannot be linked to one held message, by the operation or in the table', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'one', '<one@sender.example>');
    admit(journal, ALICE, 'two', '<two@sender.example>');
    admit(journal, BOB, 'three', '<three@sender.example>');
    journal.holdInboundEmail(ALICE, key('one'), 'held-1');
    const before = dump(db);
    expect(() => journal.holdInboundEmail(ALICE, key('two'), 'held-1')).toThrow(/Another inbound email is linked/);
    expect(() => journal.holdInboundEmail(BOB, key('three'), 'held-1')).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
    expect(() =>
      db.prepare("UPDATE inbound_email SET held_message_id = 'held-1' WHERE mail_key = ?").run(key('two'))
    ).toThrow(/UNIQUE/);

    // The link outlives expiry, so the held message of an expired mail is never given to another.
    clock = FAR;
    journal.expireInboundEmails(10);
    admit(journal, ALICE, 'four', '<four@sender.example>');
    expect(() => journal.holdInboundEmail(ALICE, key('four'), 'held-1')).toThrow(MailJournalStateError);
    expect(journal.holdInboundEmail(ALICE, key('four'), 'held-4').heldMessageId).toBe('held-4');
  });
});
