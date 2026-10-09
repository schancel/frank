/**
 * Mail journal (#1237 G1). File-backed SQLite in a temp directory, real close
 * and reopen, no database mocks. Each test names the later-stage failure it
 * prevents.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MAIL_JOURNAL_TABLES } from '../src/ledger/database';
import {
  MailJournal,
  MailJournalArgumentError,
  MailJournalOpenError,
  MailJournalOptions,
  MailJournalStateError,
  MAX_INBOUND_CLAIMS_PER_MESSAGE_ID,
} from '../src/ledger/mail-journal';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const DOMAIN = 'gw.example';
const IDENTITY: MailJournalOptions = {
  chainIdentifier: 'monad-testnet',
  gatewayAccount: `0x${'9'.repeat(40)}`,
  gatewayDomain: DOMAIN,
};
const ALICE = `0x${'a'.repeat(40)}`;
const BOB = `0x${'b'.repeat(40)}`;
const SENDER = 'carol@mail.example';

const sha = (text: string | Uint8Array): string => crypto.createHash('sha256').update(text).digest('hex');
const key = (name: string): string => sha(`content:${name}`);
const digest = (name: string): string => sha(`digest:${name}`);
const frankId = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

interface Opened {
  ledger: CreditLedger;
  journal: MailJournal;
  db: DatabaseSync;
}

let dir: string;
let file: string;
let current: Opened | undefined;

function open(options: Partial<MailJournalOptions> = {}): Opened {
  const ledger = new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
  try {
    const journal = new MailJournal(ledger, { ...IDENTITY, ...options });
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

/** Every row of every journal table, on any connection. */
function dump(db: DatabaseSync): string {
  const out: Record<string, unknown[]> = {};
  for (const table of MAIL_JOURNAL_TABLES) {
    out[table] = db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])
        )
      );
  }
  return JSON.stringify(out);
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Admits one inbound email whose DATA bytes are derived from `name`. */
function admit(journal: MailJournal, scope: string, name: string, rfcMessageId: string) {
  const bytes = Buffer.from(`mail body of ${name}`);
  return journal.admitInboundEmail({
    scopeAccount: scope,
    contentKey: key(name),
    rfcMessageId,
    senderEmail: SENDER,
    dataSha256: sha(bytes),
    raw: { kind: 'inline', bytes },
  });
}

function relay(
  journal: MailJournal,
  scope: string,
  name: string,
  parents: { inReplyTo?: string; references?: string[] } = {}
) {
  return journal.relayInboundEmail({ scopeAccount: scope, contentKey: key(name), stampValue: '1000', ...parents });
}

function bridge(
  journal: MailJournal,
  scope: string,
  name: string,
  rfcMessageId: string,
  over: { digestName?: string; frankMessageId?: string; conversationId?: string; stampValueWei?: string } = {}
) {
  return journal.recordFrankMessage({
    outcome: 'bridged',
    payloadDigest: digest(over.digestName ?? name),
    receivedTimeMs: 1_000,
    stampValueWei: over.stampValueWei ?? '0',
    scopeAccount: scope,
    frankMessageId: over.frankMessageId ?? frankId(1),
    conversationId: over.conversationId ?? frankId(100),
    rfcMessageId,
    contentKey: key(name),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-journal-'));
  file = path.join(dir, 'gateway.sqlite3');
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
  it('creates the seven tables and the marker in a durable, exclusively locked database', () => {
    const { db, journal } = open();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    for (const table of MAIL_JOURNAL_TABLES) expect(tables).toContain(table);
    expect(db.prepare('SELECT * FROM mail_journal_meta').all()).toEqual([
      expect.objectContaining({
        format: 1,
        chain_identifier: IDENTITY.chainIdentifier,
        gateway_account: IDENTITY.gatewayAccount,
        frank_cursor_ms: null,
      }),
    ]);
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
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
  it('refuses a reopen under another chain identifier or gateway account and writes nothing', () => {
    const first = open();
    admit(first.journal, ALICE, 'm1', '<m1@x.example>');
    relay(first.journal, ALICE, 'm1');
    const before = dump(first.db);
    close();

    expect(() => open({ chainIdentifier: 'monad' })).toThrow(MailJournalOpenError);
    expect(() => open({ gatewayAccount: `0x${'8'.repeat(40)}` })).toThrow(/belongs to chain monad-testnet/);

    const raw = new DatabaseSync(file);
    expect(dump(raw)).toBe(before);
    raw.close();
    expect(dump(open().db)).toBe(before);
  });

  // Prevents: a build silently re-creating or reinterpreting a journal it cannot read, which
  // would forget which mails were already relayed and pay for them again.
  it.each([
    ['another format', 'UPDATE mail_journal_meta SET format = 2', /format 2 is not supported/],
    ['no marker row', 'DELETE FROM mail_journal_meta', /format marker is missing/],
    ['no marker table', 'DROP TABLE mail_journal_meta', /format marker is missing/],
    ['a second marker row', 'DROP TABLE mail_journal_meta; CREATE TABLE mail_journal_meta (format); INSERT INTO mail_journal_meta VALUES (1), (1)', /format marker is missing/],
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
    const ledger = new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
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

describe('atomic units', () => {
  // 18.2 / 19.2 rule 5. Prevents: an `await` inside a unit committing half of it.
  it('refuses a callback that returns a promise and rolls it back', () => {
    const { ledger, journal, db } = open();
    const before = dump(db);
    expect(() =>
      ledger.atomic(async () => {
        admit(journal, ALICE, 'm1', '<m1@x.example>');
      })
    ).toThrow(/returned a promise/);
    expect(dump(db)).toBe(before);
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
    bridge(journal, ALICE, 'f1', '<f1@frank.org>', { stampValueWei: '10' });
    const notice = () =>
      journal.stageNotice({
        sourceKind: 'reject',
        sourceKey: digest('f1'),
        scopeAccount: ALICE,
        conversationId: frankId(100),
        stampValue: '5',
        cover: { payloadDigest: digest('f1'), unitWei: '10' },
      });
    expectAtomic(
      db,
      [
        ['UPDATE', 'frank_inbound'],
        ['INSERT', 'frank_send'],
      ],
      notice
    );
    expect(notice().kind).toBe('created');
    expect(journal.findFrankInbound(digest('f1'))!.spentWei).toBe('10');
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
        const stmt = db.prepare("INSERT INTO frank_inbound (payload_digest, received_time, stamp_value_wei, budget_wei, disposition, reason) VALUES (?, 1, '0', '0', 'rejected', ?)");
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

describe('email → Frank: holder, repeat and contested', () => {
  // Prevents: an accepted mail (250 sent) that the gateway forgets on restart, so the sender's
  // retry is relayed and charged a second time.
  it('the first mail relayed under an ID becomes its holder, and still is after a reopen', () => {
    const { journal } = open();
    expect(admit(journal, ALICE, 'm1', '<m1@x.example>')).toMatchObject({
      kind: 'admitted',
      email: { disposition: 'held', rfcMessageId: '<m1@x.example>', senderEmail: SENDER },
    });
    // Admitted but not relayed: it owns no thread identity (19.2 rule 2).
    expect(journal.findMailMessage(ALICE, '<m1@x.example>')).toBeUndefined();

    const relayed = relay(journal, ALICE, 'm1');
    expect(relayed).toMatchObject({ created: true, contested: false, email: { disposition: 'relay' } });
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
      claimedRfcId: undefined,
      contentKey: key('m1'),
      direction: 'email_to_frank',
      frankMessageId: relayed.slot.frankMessageId,
    });

    const again = reopen().journal;
    expect(again.findMailMessage(ALICE, '<m1@x.example>')).toEqual(relayed.message);
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

  // Section 20. Prevents: a later mail with a stored Message-ID overwriting, shadowing or being
  // dropped in favour of the stored one, so a forged copy could replace or silence real mail.
  it('a different mail with the same ID is kept under the contested identifier and the holder is untouched', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'real', '<m1@x.example>');
    const holder = relay(journal, ALICE, 'real');
    const holderRow = JSON.stringify(db.prepare('SELECT * FROM mail_message').all());

    expect(admit(journal, ALICE, 'other', '<m1@x.example>').kind).toBe('admitted');
    const contested = relay(journal, ALICE, 'other');
    const localId = `<${key('other')}@contested.${DOMAIN}>`;
    expect(contested).toMatchObject({
      created: true,
      contested: true,
      message: { rfcMessageId: localId, claimedRfcId: '<m1@x.example>', contentKey: key('other') },
    });
    expect(journal.contestedIdFor(key('other'))).toBe(localId);

    // The holder's row is byte-identical and still answers for the ID.
    expect(JSON.stringify(db.prepare('SELECT * FROM mail_message WHERE rfc_message_id = ?').all('<m1@x.example>'))).toBe(
      holderRow
    );
    expect(journal.findMailMessage(ALICE, '<m1@x.example>')).toEqual(holder.message);
    // It did not join the holder's conversation merely by claiming its ID: it is its own root.
    expect(contested.message.conversationId).not.toBe(holder.message.conversationId);
    expect(contested.slot.frankMessageId).not.toBe(holder.slot.frankMessageId);
    expect(count(db, 'mail_thread')).toBe(2);

    // A reply naming the contested ID binds to the holder; a reply naming the local ID reaches the contested mail.
    admit(journal, ALICE, 'reply-to-x', '<r1@x.example>');
    expect(relay(journal, ALICE, 'reply-to-x', { inReplyTo: '<m1@x.example>' }).message.conversationId).toBe(
      holder.message.conversationId
    );
    admit(journal, ALICE, 'reply-to-local', '<r2@x.example>');
    expect(relay(journal, ALICE, 'reply-to-local', { inReplyTo: localId }).message.conversationId).toBe(
      contested.message.conversationId
    );
  });

  // Prevents: a retry of a contested mail getting a second regenerated identity, a second slot and
  // a second payment.
  it('a contested repeat is the same row, before and after a reopen', () => {
    const first = open();
    admit(first.journal, ALICE, 'real', '<m1@x.example>');
    relay(first.journal, ALICE, 'real');
    admit(first.journal, ALICE, 'other', '<m1@x.example>');
    const contested = relay(first.journal, ALICE, 'other');
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(admit(journal, ALICE, 'other', '<m1@x.example>').kind).toBe('duplicate');
      expect(relay(journal, ALICE, 'other')).toEqual({ ...contested, created: false });
      expect(dump(db)).toBe(before);
    }
  });

  // 20.6. Prevents: an unfunded forged copy that arrives first taking the real mail's identifier.
  it('an unfunded first copy holds nothing; the funded real mail is the holder; the copy is contested on release', () => {
    const { journal } = open();
    admit(journal, ALICE, 'forged', '<m1@x.example>');
    expect(journal.holdInboundEmail(ALICE, key('forged'), 'held-1')).toMatchObject({
      disposition: 'held',
      heldMessageId: 'held-1',
    });
    expect(journal.findMailMessage(ALICE, '<m1@x.example>')).toBeUndefined();

    admit(journal, ALICE, 'real', '<m1@x.example>');
    const real = relay(journal, ALICE, 'real');
    expect(real).toMatchObject({ contested: false, message: { rfcMessageId: '<m1@x.example>' } });

    const released = relay(reopen().journal, ALICE, 'forged');
    expect(released).toMatchObject({
      contested: true,
      email: { disposition: 'released', heldMessageId: 'held-1' },
      message: { rfcMessageId: `<${key('forged')}@contested.${DOMAIN}>`, claimedRfcId: '<m1@x.example>' },
    });
    expect(current!.journal.findMailMessage(ALICE, '<m1@x.example>')).toEqual(real.message);
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

  // 20.7. Prevents: unbounded storage from one Message-ID replayed with ever-different content,
  // and a ninth copy being dropped silently instead of told (554 5.7.1 before any credit).
  it('stores at most eight different mails per (scope, claimed ID); the ninth is refused and writes nothing', () => {
    const first = open();
    for (let i = 0; i < MAX_INBOUND_CLAIMS_PER_MESSAGE_ID; i++) {
      expect(admit(first.journal, ALICE, `copy-${i}`, '<m1@x.example>').kind).toBe('admitted');
    }
    relay(first.journal, ALICE, 'copy-0');
    relay(first.journal, ALICE, 'copy-1');
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(admit(journal, ALICE, 'copy-8', '<m1@x.example>')).toEqual({ kind: 'refused', reason: 'claim_limit' });
      expect(journal.findInboundEmail(ALICE, key('copy-8'))).toBeUndefined();
      // A retry of one of the eight is still that mail, not a refusal.
      expect(admit(journal, ALICE, 'copy-3', '<m1@x.example>').kind).toBe('duplicate');
      expect(dump(db)).toBe(before);
    }
    // The bound is per scope and per claimed ID.
    expect(admit(current!.journal, BOB, 'copy-8', '<m1@x.example>').kind).toBe('admitted');
    expect(admit(current!.journal, ALICE, 'copy-8', '<m2@x.example>').kind).toBe('admitted');
    expect(count(current!.db, 'inbound_email')).toBe(10);
  });

  // B3, D1, AGENTS.md section 5. Prevents: two threads through one gateway being merged because
  // they share a Message-ID across accounts, or a peer and a subject within one account.
  it('keeps the same Message-ID in two scopes, and two equal-subject threads in one scope, apart', () => {
    let { journal } = open();
    admit(journal, ALICE, 'm1', '<m1@x.example>');
    admit(journal, BOB, 'm1', '<m1@x.example>');
    const alice = relay(journal, ALICE, 'm1');
    const bob = relay(journal, BOB, 'm1');
    expect(alice.contested).toBe(false);
    expect(bob.contested).toBe(false);
    expect(alice.message.conversationId).not.toBe(bob.message.conversationId);
    expect(journal.findMailMessage(ALICE, '<m1@x.example>')!.frankMessageId).toBe(alice.slot.frankMessageId);
    expect(journal.findMailMessage(BOB, '<m1@x.example>')!.frankMessageId).toBe(bob.slot.frankMessageId);
    expect(journal.findMailMessage(ALICE, '<bob-only@x.example>')).toBeUndefined();

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

  // Prevents: two arrivals of one ID both becoming its holder. Only one connection can exist
  // (see the lock test), and on it each decision is one transaction.
  it('two different mails claiming one ID, admitted together and relayed back to back, give exactly one holder', () => {
    const { journal, db } = open();
    admit(journal, ALICE, 'first', '<m1@x.example>');
    admit(journal, ALICE, 'second', '<m1@x.example>');
    const results = [relay(journal, ALICE, 'second'), relay(journal, ALICE, 'first')];
    expect(results.map((r) => r.contested)).toEqual([false, true]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_message WHERE rfc_message_id = ?').get('<m1@x.example>')).toEqual({
      n: 1,
    });
    expect(journal.findMailMessage(ALICE, '<m1@x.example>')!.contentKey).toBe(key('second'));

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
    journal.admitInboundEmail({
      scopeAccount: ALICE,
      contentKey: key('tricky'),
      rfcMessageId: '<m3@x.example>',
      senderEmail: SENDER,
      dataSha256: sha(tricky),
      raw: { kind: 'inline', bytes: tricky },
    });
    journal.admitInboundEmail({
      scopeAccount: ALICE,
      contentKey: key('big'),
      rfcMessageId: '<m4@x.example>',
      senderEmail: SENDER,
      dataSha256: sha('big'),
      raw: { kind: 'blob', sha256: sha('big') },
    });

    const again = reopen().journal;
    const bytesOf = (name: string): string => {
      const raw = again.findInboundEmail(ALICE, key(name))!.raw;
      return raw.kind === 'inline' ? Buffer.from(raw.bytes).toString() : `blob:${raw.sha256}`;
    };
    expect(bytesOf('one')).toBe('mail body of one');
    expect(bytesOf('two')).toBe('mail body of two');
    expect(bytesOf('tricky')).toBe('blob://looks-like-a-pointer');
    expect(bytesOf('big')).toBe(`blob:${sha('big')}`);

    const base = { scopeAccount: ALICE, contentKey: key('bad'), rfcMessageId: '<m5@x.example>', senderEmail: SENDER };
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
    expect(() => journal.findMailMessage(ALICE, bad)).toThrow(MailJournalArgumentError);
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
    expect(relay(journal, ALICE, 'lower').contested).toBe(false);
    expect(relay(journal, ALICE, 'upper').contested).toBe(false);
    expect(journal.findMailMessage(ALICE, '<Abc@x.example>')).toBeUndefined();
  });

  // 20.2. Prevents: an outside sender claiming an identifier this gateway regenerates, and so
  // taking the place a contested or ID-less mail would be stored under.
  it('refuses claims in the reserved namespaces, from either direction', () => {
    const { journal, db } = open();
    const before = dump(db);
    const mine = journal.noMessageIdFor(key('m1'));
    expect(mine).toBe(`<${key('m1')}@no-message-id.${DOMAIN}>`);
    for (const claimed of [
      journal.contestedIdFor(key('m1')),
      `<anything@contested.${DOMAIN}>`,
      `<anything@CONTESTED.${DOMAIN.toUpperCase()}>`,
      journal.noMessageIdFor(key('someone-else')),
      `<x@No-Message-Id.${DOMAIN}>`,
    ]) {
      expect(journal.isReservedMessageId(claimed)).toBe(true);
      expect(() => admit(journal, ALICE, 'm1', claimed)).toThrow(/reserved/);
      expect(() => bridge(journal, ALICE, 'f1', claimed)).toThrow(/reserved/);
    }
    expect(() => bridge(journal, ALICE, 'f1', mine)).toThrow(/reserved/);
    expect(dump(db)).toBe(before);

    // The synthetic ID of this very content is the one reserved ID intake may use.
    expect(admit(journal, ALICE, 'm1', mine).kind).toBe('admitted');
    expect(journal.isReservedMessageId(`<x@contested.${DOMAIN}.evil.example>`)).toBe(false);
  });

  // Prevents: a scope, sealed ID, key or digest in a second spelling (uppercase, undashed, short)
  // becoming a second identity for the same account or message.
  it('refuses malformed scopes, sealed IDs, keys, digests and addresses', () => {
    const { journal, db } = open();
    const before = dump(db);
    const good = {
      scopeAccount: ALICE,
      contentKey: key('m1'),
      rfcMessageId: '<m1@x.example>',
      senderEmail: SENDER,
      dataSha256: sha('x'),
      raw: { kind: 'blob' as const, sha256: sha('x') },
    };
    for (const patch of [
      { scopeAccount: `0x${'A'.repeat(40)}` },
      { scopeAccount: 'a'.repeat(40) },
      { scopeAccount: 'alice' },
      { contentKey: key('m1').toUpperCase() },
      { contentKey: key('m1').slice(1) },
      { senderEmail: 'Carol@mail.example' },
      { senderEmail: 'carol' },
      { senderEmail: 'carol @mail.example' },
      { dataSha256: 'zz' },
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
    expect(() => bridge(journal, ALICE, 'f1', '<f1@frank.org>', { stampValueWei: '01' })).toThrow(
      MailJournalArgumentError
    );
    expect(() => relay(journal, ALICE, 'm1')).toThrow(MailJournalStateError);
    expect(dump(db)).toBe(before);
  });
});

describe('Frank → email and the cross-direction rule', () => {
  // C1, 18.3. Prevents: a message fetched again by an inclusive cursor being bridged and emailed twice.
  it('records a bridged message once per payload digest, before and after a reopen', () => {
    const first = open();
    const bridged = bridge(first.journal, ALICE, 'f1', '<f1@frank.org>');
    expect(bridged).toMatchObject({
      kind: 'bridged',
      contested: false,
      threadCreated: true,
      allowancesCovered: 0,
      inbound: { disposition: 'bridged', scopeAccount: ALICE, frankMessageId: frankId(1) },
      message: { rfcMessageId: '<f1@frank.org>', direction: 'frank_to_email', conversationId: frankId(100) },
    });
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

  // 20.3. Prevents: the same email re-sealed under a new digest going out a second time, and a
  // different message that reuses a sealed ID or a Message-ID replacing or being dropped for the first.
  it('deduplicates the same content under a new seal and keeps different content as its own message', () => {
    const first = open();
    const original = bridge(first.journal, ALICE, 'f1', '<f1@frank.org>');
    if (original.kind !== 'bridged') throw new Error('expected bridged');
    const before = dump(first.db);

    for (const at of [() => first, reopen]) {
      const { journal, db } = at();
      expect(bridge(journal, ALICE, 'f1', '<f1@frank.org>', { digestName: 'f1-resealed' })).toEqual({
        kind: 'same_message',
        message: original.message,
      });
      expect(dump(db)).toBe(before);
    }
    const journal = current!.journal;

    // Same sealed message ID, different content, its own authored ID: both stay (the index is not unique).
    const sameSealedId = bridge(journal, ALICE, 'f2', '<f2@frank.org>', { frankMessageId: frankId(1) });
    expect(sameSealedId).toMatchObject({ kind: 'bridged', contested: false, threadCreated: false });

    // Same authored Message-ID, different content: sent under the regenerated ID; the holder is untouched.
    const sameRfcId = bridge(journal, ALICE, 'f3', '<f1@frank.org>', { frankMessageId: frankId(3) });
    expect(sameRfcId).toMatchObject({
      kind: 'bridged',
      contested: true,
      message: { rfcMessageId: `<${key('f3')}@contested.${DOMAIN}>`, claimedRfcId: '<f1@frank.org>' },
    });
    expect(journal.findMailMessage(ALICE, '<f1@frank.org>')).toEqual(original.message);
    // And that contested message, re-sealed, is still one message.
    expect(bridge(journal, ALICE, 'f3', '<f1@frank.org>', { digestName: 'f3-again' }).kind).toBe('same_message');
    expect(count(current!.db, 'frank_inbound')).toBe(3);
  });

  // C9, R10. Prevents: one Frank sender occupying a sealed message ID or a Message-ID before another uses it.
  it('two senders using the same sealed ID and the same Message-ID are both bridged, each in its own scope', () => {
    const { journal } = open();
    const a = bridge(journal, ALICE, 'from-alice', '<same@frank.org>', { digestName: 'a' });
    const b = bridge(journal, BOB, 'from-bob', '<same@frank.org>', { digestName: 'b' });
    expect([a.kind, b.kind]).toEqual(['bridged', 'bridged']);
    expect(a).toMatchObject({ contested: false, threadCreated: true });
    expect(b).toMatchObject({ contested: false, threadCreated: true });
    expect(journal.countFrankRootsSince(ALICE, 0)).toBe(1);
  });

  // 20.4, first rule. Prevents: a user's own mail coming back from a list or self-copy being
  // charged and relayed to them as new mail; and a list-modified copy being dropped.
  it('own outbound mail arriving inbound: equal content is an echo, different content is contested', () => {
    const { journal, db } = open();
    const sent = bridge(journal, ALICE, 'sent', '<f1@frank.org>');
    if (sent.kind !== 'bridged') throw new Error('expected bridged');

    const echoBytes = Buffer.from('the same mail');
    const echo = journal.admitInboundEmail({
      scopeAccount: ALICE,
      contentKey: key('sent'),
      rfcMessageId: '<f1@frank.org>',
      senderEmail: SENDER,
      dataSha256: sha(echoBytes),
      raw: { kind: 'inline', bytes: echoBytes },
    });
    expect(echo).toMatchObject({ kind: 'echo', email: { disposition: 'echo' } });
    expect(() => relay(journal, ALICE, 'sent')).toThrow(/echo; it cannot be relayed/);
    expect(count(db, 'frank_send')).toBe(0);
    const before = dump(db);
    expect(admit(reopen().journal, ALICE, 'sent', '<f1@frank.org>').kind).toBe('duplicate');
    expect(dump(current!.db)).toBe(before);

    // The same Message-ID in another scope is ordinary mail there.
    expect(admit(current!.journal, BOB, 'sent', '<f1@frank.org>').kind).toBe('admitted');

    // A list added a footer: a different mail. Kept; if funded, delivered under a local identifier.
    expect(admit(current!.journal, ALICE, 'sent-with-footer', '<f1@frank.org>').kind).toBe('admitted');
    const footer = relay(current!.journal, ALICE, 'sent-with-footer');
    expect(footer).toMatchObject({
      contested: true,
      message: { rfcMessageId: `<${key('sent-with-footer')}@contested.${DOMAIN}>`, claimedRfcId: '<f1@frank.org>' },
    });
    expect(current!.journal.findMailMessage(ALICE, '<f1@frank.org>')).toEqual(sent.message);
  });

  // 20.4, second rule. Prevents: a Frank user's authored ID displacing the inbound mail that
  // already holds it, so replies to that ID would bind to the wrong message.
  it('an inbound holder, then the same ID authored outbound: sent under a regenerated identifier', () => {
    const { journal } = open();
    admit(journal, ALICE, 'in', '<m1@x.example>');
    const holder = relay(journal, ALICE, 'in');

    const out = bridge(journal, ALICE, 'out', '<m1@x.example>', { conversationId: holder.message.conversationId });
    expect(out).toMatchObject({
      kind: 'bridged',
      contested: true,
      threadCreated: false,
      message: {
        rfcMessageId: `<${key('out')}@contested.${DOMAIN}>`,
        claimedRfcId: '<m1@x.example>',
        direction: 'frank_to_email',
      },
    });
    const again = reopen().journal;
    expect(again.findMailMessage(ALICE, '<m1@x.example>')).toEqual(holder.message);
    expect(again.findMailThread(ALICE, holder.message.conversationId)).toMatchObject({ origin: 'email' });
  });

  // 6.4, 19.2 rule 6. Prevents: a refused or quarantined message being evaluated again on every
  // fetch (and, for quota, bridged later when the window has moved).
  it('records rejected and quarantined messages once, with no message or thread row', () => {
    const { journal, db } = open();
    const base = { receivedTimeMs: 5, stampValueWei: '7' };
    expect(
      journal.recordFrankMessage({ ...base, outcome: 'rejected', payloadDigest: digest('r'), reason: 'quota', scopeAccount: ALICE })
    ).toMatchObject({ kind: 'rejected', inbound: { reason: 'quota', budgetWei: '7', spentWei: '0' } });
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
    const record = (journal: MailJournal) =>
      journal.recordFrankMessage({
        outcome: 'bridged',
        payloadDigest: digest('f1'),
        receivedTimeMs: 1,
        stampValueWei: '25',
        scopeAccount: ALICE,
        frankMessageId: frankId(1),
        conversationId: frankId(100),
        rfcMessageId: '<f1@frank.org>',
        contentKey: key('f1'),
        replyAllowance: { unitWei: '10', wanted: 3 },
      });
    expect(record(first.journal)).toMatchObject({ allowancesCovered: 2, inbound: { budgetWei: '25', spentWei: '20' } });
    expect(record(first.journal).kind).toBe('duplicate');

    const notice = (journal: MailJournal, unitWei: string, sourceKey = '17') =>
      journal.stageNotice({
        sourceKind: 'bounce',
        sourceKey,
        scopeAccount: ALICE,
        conversationId: frankId(100),
        stampValue: '5',
        cover: { payloadDigest: digest('f1'), unitWei },
      });
    expect(notice(first.journal, '10')).toEqual({ kind: 'uncovered' });
    expect(count(first.db, 'frank_send')).toBe(0);
    const created = notice(first.journal, '5');
    expect(created).toMatchObject({ kind: 'created', slot: { sourceKind: 'bounce', sourceKey: '17', state: 'staged' } });
    const before = dump(first.db);

    const again = reopen().journal;
    expect(notice(again, '5')).toEqual({ ...created, kind: 'existing' });
    expect(notice(again, '5', '18')).toEqual({ kind: 'uncovered' });
    expect(dump(current!.db)).toBe(before);
    expect(again.findFrankInbound(digest('f1'))!.spentWei).toBe('25');
  });
});

describe('outbound jobs and send slots', () => {
  // C5, C6. Prevents: a job re-created with new bytes (a second, different email for one
  // message), an email with no recorded message, and a guessable bounce address changing state.
  it('adds one job per recipient, never replaces its bytes, and moves it only along its states', () => {
    const first = open();
    bridge(first.journal, ALICE, 'f1', '<f1@frank.org>');
    const job = (journal: MailJournal, recipient: string, body: string) =>
      journal.addOutboundJob({
        scopeAccount: ALICE,
        frankMessageId: frankId(1),
        conversationId: frankId(100),
        recipientEmail: recipient,
        signedRfc822: { kind: 'inline', bytes: Buffer.from(body) },
        nextAttemptAtMs: 100,
      });
    const one = job(first.journal, 'dave@mail.example', 'signed bytes');
    const two = job(first.journal, 'erin@mail.example', 'signed bytes');
    expect(one).toMatchObject({ kind: 'created', job: { state: 'pending', attempts: 0 } });
    if (one.kind === 'key_taken' || two.kind === 'key_taken') throw new Error('unexpected');
    expect(one.job.bounceToken).toMatch(/^[0-9a-f]{32}$/);
    expect(one.job.bounceToken).not.toBe(two.job.bounceToken);
    expect(() =>
      first.journal.addOutboundJob({
        scopeAccount: BOB,
        frankMessageId: frankId(1),
        conversationId: frankId(100),
        recipientEmail: 'dave@mail.example',
        signedRfc822: { kind: 'blob', sha256: sha('x') },
        nextAttemptAtMs: 0,
      })
    ).toThrow(/No bridged message/);
    const before = dump(first.db);

    const journal = reopen().journal;
    expect(job(journal, 'dave@mail.example', 'signed bytes')).toEqual({ ...one, kind: 'existing' });
    expect(job(journal, 'dave@mail.example', 'other bytes')).toEqual({ ...one, kind: 'key_taken' });
    expect(dump(current!.db)).toBe(before);

    expect(journal.listDueOutboundJobs(99, 10)).toEqual([]);
    expect(journal.listDueOutboundJobs(100, 10).map((j) => j.jobId)).toEqual([one.job.jobId, two.job.jobId]);
    expect(journal.deferOutboundJob(one.job.jobId, 500, '451 later')).toMatchObject({
      state: 'pending',
      attempts: 1,
      nextAttemptAtMs: 500,
      lastError: '451 later',
    });
    expect(journal.markOutboundJobSent(one.job.jobId)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(journal.markOutboundJobSent(one.job.jobId)).toMatchObject({ state: 'sent', attempts: 2 });
    expect(() => journal.markOutboundJobFailed(one.job.jobId, 'late')).toThrow(MailJournalStateError);
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
