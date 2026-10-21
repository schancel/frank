/**
 * Format-8 to format-9 mail journal migration (owner-requested, for the production volume).
 *
 * The format-8 journal is written by the format-8 code itself (`fixtures/mail-journal-format8.ts`,
 * verbatim from 1760e3031^), on a real file, and then opened by the current journal. No
 * database mocks.
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CreditLedger } from '../src/ledger/credit-ledger';
import {
  MAIL_JOURNAL_TABLES,
  MailJournal,
  MailJournalOpenError,
  MailJournalOptions,
} from '../src/ledger/mail-journal';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';
import { MailJournal as MailJournalFormat8 } from './fixtures/mail-journal-format8';

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
const ROOT_ID = '<root@x.example>';

const sha = (text: string | Uint8Array): string => crypto.createHash('sha256').update(text).digest('hex');
const key = (name: string): string => sha(`mail:${name}`);
const ikey = (name: string): string => sha(`item:${name}`);
const digest = (name: string): string => sha(`digest:${name}`);
const frankId = (n: number): string => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const alias = (scope: string, conversationId: string): string => `thread${sha(`${scope}:${conversationId}`).slice(0, 26)}`;

let dir: string;
let file: string;
let clock: number;
const open: DatabaseSync[] = [];

function newLedger(): CreditLedger {
  const ledger = new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
  open.push(ledger.sqlite!);
  return ledger;
}

function closeAll(): void {
  for (const db of open.splice(0)) {
    if (db.isOpen) db.close();
  }
}

function openFormat9(options: Partial<MailJournalOptions> = {}): { ledger: CreditLedger; journal: MailJournal } {
  const ledger = newLedger();
  const journal = new MailJournal(ledger, { ...IDENTITY, now: () => clock, ...options });
  return { ledger, journal };
}

function fileHash(target = file): string {
  return sha(fs.readFileSync(target));
}

/** Every row of every table, in rowid order. */
function dumpAll(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name);
  return JSON.stringify(tables.map((t) => [t, rows(db, `SELECT * FROM "${t}" ORDER BY rowid`)]));
}

/** Another process tries to write the database file; answers 'wrote' or 'locked'. */
function otherProcessWrite(): string {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    try {
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 0');
      db.exec("INSERT INTO credit_ledger (email, balance, updated_at) VALUES ('intruder@x.example', 1, 1)");
      process.stdout.write('wrote');
    } catch (err) {
      process.stdout.write(/locked|busy/i.test(String(err && err.message)) ? 'locked' : 'error: ' + err.message);
    }`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout;
}

function backups(): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${path.basename(file)}.format8-backup-`));
}

function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])
    )
  );
}

/** Tables the migration must leave row-for-row identical. */
const UNCHANGED_TABLES = [
  'mail_thread',
  'issued_mailbox',
  'inbound_email',
  'frank_send',
  'frank_inbound',
  'credit_ledger',
  'thread_allowances',
  'transactions',
] as const;

function snapshotUnchanged(db: DatabaseSync): string {
  return JSON.stringify(UNCHANGED_TABLES.map((t) => [t, rows(db, `SELECT * FROM ${t} ORDER BY rowid`)]));
}

interface Format8Facts {
  c1: string;
  c2: string;
  m1FrankId: string;
  m2FrankId: string;
  contestedInboundId: string;
  contestedOutboundId: string;
  jobs: { a: number; b: number; c: number; d: number; e: number };
  heldId: string;
  mailMessages: Array<Record<string, unknown>>;
  jobRows: Array<Record<string, unknown>>;
  jobSeq: number;
}

/**
 * Writes a format-8 journal with the format-8 code: every record kind, a contested
 * Message-ID pair on each side, pending/sent/uncertain/failed/bounced jobs, a held inbound
 * mail, an expired one, an echo, notices, a re-seal, a refused and a quarantined Frank
 * message, ledger credit, and a cursor.
 */
function writeFormat8Journal(): Format8Facts {
  const ledger = newLedger();
  const j8 = new MailJournalFormat8(ledger, { ...IDENTITY, now: () => clock });
  const admit = (
    scope: string,
    name: string,
    messageIdHeader: string | undefined,
    extra: { mailboxLocalPart?: string; conversationId?: string; echoMailKey?: string } = {}
  ) => {
    const bytes = Buffer.from(`mail body of ${name}`);
    return j8.admitInboundEmail({
      scopeAccount: scope,
      mailKey: key(name),
      stampValue: '1000',
      messageIdHeader,
      senderEmail: SENDER,
      dataSha256: sha(bytes),
      raw: { kind: 'inline', bytes },
      principalHasCredit: false,
      ...extra,
    });
  };
  const relay = (scope: string, name: string, parents: { inReplyTo?: string } = {}) =>
    j8.relayInboundEmail({ scopeAccount: scope, mailKey: key(name), stampValue: '1000', ...parents });
  const bridge = (
    scope: string,
    name: string,
    authored: string,
    { digestName, ...over }: { digestName?: string; frankMessageId?: string; conversationId?: string; inReplyTo?: string } = {}
  ) => {
    const input = {
      outcome: 'bridged' as const,
      payloadDigest: digest(digestName ?? name),
      receivedTimeMs: 1_000,
      stampValue: '5000',
      scopeAccount: scope,
      frankMessageId: frankId(1),
      conversationId: frankId(100),
      authoredMessageId: authored,
      itemKey: ikey(name),
      replyAllowance: { unit: '1000', wanted: 2 },
      ...over,
    };
    const first = j8.recordFrankMessage(input);
    if (first.kind !== 'needs_render') return first;
    return j8.recordFrankMessage({ ...input, emitted: { rfcMessageId: first.rfcMessageId, mailKey: key(name) } });
  };
  const job = (scope: string, rfcMessageId: string, recipient: string, body: string): number => {
    const message = j8.findMailMessage(scope, rfcMessageId)!;
    const sender = alias(scope, message.conversationId);
    if (!j8.issuedMailbox(sender)) {
      j8.issueMailbox({ localPart: sender, scopeAccount: scope, conversationId: message.conversationId });
    }
    const result = j8.addOutboundJob({
      scopeAccount: scope,
      rfcMessageId,
      recipientEmail: recipient,
      senderLocalPart: sender,
      signedRfc822: { kind: 'inline', bytes: Buffer.from(body) },
      nextAttemptAtMs: T0,
    });
    if (result.kind !== 'created') throw new Error(result.kind);
    return result.job.jobId;
  };

  // Inbound: m1 holds ROOT_ID; m2 claims it too and is stored contested; m3 replies to it.
  expect(admit(ALICE, 'm1', ROOT_ID).kind).toBe('admitted');
  const m1 = relay(ALICE, 'm1');
  clock += 1_000;
  expect(admit(ALICE, 'm2', ROOT_ID).kind).toBe('admitted');
  const m2 = relay(ALICE, 'm2');
  expect(m2.contested).toBe(true);
  clock += 1_000;
  admit(ALICE, 'm3', '<m3@x.example>');
  const m3 = relay(ALICE, 'm3', { inReplyTo: ROOT_ID });
  expect(m3.message.conversationId).toBe(m1.message.conversationId);
  // An inbound mail with no Message-ID, in Bob's scope.
  admit(BOB, 'nomsgid', undefined);
  relay(BOB, 'nomsgid');
  // Slot transitions on the relayed mails.
  j8.markFrankSendSending(m1.slot.slotId);
  j8.linkFrankSend(m1.slot.slotId, digest('slot-m1'));
  j8.markFrankSendDelivered(m1.slot.slotId);
  j8.markFrankSendSending(m2.slot.slotId);
  j8.holdFrankSend(m2.slot.slotId, 'relay_refused');

  // Issued mailboxes: one bound to a conversation, one scope-only; a held mail through the first.
  j8.issueMailbox({ localPart: 'alice-thread', scopeAccount: ALICE, conversationId: m1.message.conversationId });
  j8.issueMailbox({ localPart: 'bob-inbox', scopeAccount: BOB });
  clock += 1_000;
  admit(ALICE, 'held1', '<held1@x.example>', { mailboxLocalPart: 'alice-thread', conversationId: m1.message.conversationId });
  const heldId = 'a'.repeat(32);
  j8.holdInboundEmail(ALICE, key('held1'), heldId);
  // An unpaid mail that expires.
  admit(ALICE, 'gone', '<gone@x.example>');

  // Outbound: A uncontested; B authored ROOT_ID (held by m1) and goes out contested.
  const a = bridge(ALICE, 'A', '<fa@frank.org>', { inReplyTo: ROOT_ID });
  expect(a.kind).toBe('bridged');
  const b = bridge(ALICE, 'B', ROOT_ID, { digestName: 'B', frankMessageId: frankId(2), conversationId: frankId(200) });
  expect(b.kind === 'bridged' && b.contested).toBe(true);
  const c = bridge(BOB, 'C', '<fc@frank.org>', { frankMessageId: frankId(3), conversationId: frankId(300) });
  const d = bridge(BOB, 'D', '<fd@frank.org>', { frankMessageId: frankId(4), conversationId: frankId(400) });
  // A re-seal of A, a refused and a quarantined Frank message.
  expect(bridge(ALICE, 'A', '<fa@frank.org>', { digestName: 'A-reseal' }).kind).toBe('same_message');
  j8.recordFrankMessage({ outcome: 'rejected', reason: 'no_email_item', payloadDigest: digest('rej'), receivedTimeMs: 2_000, stampValue: '3000', scopeAccount: BOB, frankMessageId: frankId(5), conversationId: frankId(500) });
  j8.recordFrankMessage({ outcome: 'quarantined', payloadDigest: digest('quar'), receivedTimeMs: 3_000, stampValue: '7' });
  // An echo of A coming back.
  admit(ALICE, 'echoA', '<fa@frank.org>', { echoMailKey: key('A') });

  const contestedOutboundId = b.kind === 'bridged' ? b.message.rfcMessageId : '';
  const jobA = job(ALICE, '<fa@frank.org>', 'r1@x.example', 'signed A'); // pending
  const jobB = job(ALICE, contestedOutboundId, 'r2@x.example', 'signed B'); // sent
  j8.claimOutboundJob(jobB);
  j8.confirmOutboundJobAccepted(jobB, 'provider-b');
  const jobC = job(BOB, '<fc@frank.org>', 'r3@x.example', 'signed C'); // uncertain
  j8.claimOutboundJob(jobC);
  j8.markOutboundJobUncertain(jobC, 'timeout');
  const jobD = job(BOB, '<fd@frank.org>', 'r4@x.example', 'signed D'); // failed, with a bounce notice
  j8.claimOutboundJob(jobD);
  j8.markOutboundJobFailed(jobD, 'rejected by provider');
  expect(j8.stageNotice({ sourceKind: 'bounce', jobId: jobD, stampValue: '1000', unit: '1000' }).kind).toBe('created');
  const jobE = job(BOB, '<fc@frank.org>', 'r5@x.example', 'signed C to r5'); // bounced
  const bounced = j8.findOutboundJob(jobE)!;
  j8.markOutboundJobBounced(bounced.bounceToken);
  expect(j8.stageNotice({ sourceKind: 'reject', payloadDigest: digest('rej'), stampValue: '1000', unit: '1000' }).kind).toBe('created');
  expect(c.kind).toBe('bridged');

  // Both unpaid mails (`held1`, `gone`) expire; `held2` is admitted afterwards and stays held.
  clock += 73 * 60 * 60 * 1000;
  j8.expireInboundEmails(100);
  admit(ALICE, 'held2', '<held2@x.example>');
  const heldId2 = 'b'.repeat(32);
  j8.holdInboundEmail(ALICE, key('held2'), heldId2);
  j8.setFrankCursor(5_000, 6_000);
  ledger.addCredits(SENDER, 7, 'tx-1');
  ledger.grantReplyAllowance(SENDER, ALICE, 3);

  const db = ledger.sqlite!;
  expect(db.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 8 });
  const facts: Format8Facts = {
    c1: m1.message.conversationId,
    c2: m2.message.conversationId,
    m1FrankId: m1.message.frankMessageId,
    m2FrankId: m2.message.frankMessageId,
    contestedInboundId: m2.message.rfcMessageId,
    contestedOutboundId,
    jobs: { a: jobA, b: jobB, c: jobC, d: jobD, e: jobE },
    heldId: heldId2,
    mailMessages: rows(db, 'SELECT * FROM mail_message ORDER BY rowid'),
    jobRows: rows(db, 'SELECT * FROM outbound_job ORDER BY job_id'),
    jobSeq: Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outbound_job'").get() as { seq: number }).seq),
  };
  db.close();
  return facts;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-journal-f8-')));
  file = path.join(dir, 'gateway.sqlite3');
  clock = T0;
});

afterEach(() => {
  try {
    closeAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('format-8 journal migration', () => {
  it('backs up, migrates every row to format 9, and the format-9 API reads it back', () => {
    const f8 = writeFormat8Journal();
    expect(f8.contestedInboundId).toBe(`<${key('m2')}@contested.${DOMAIN}>`);
    expect(f8.contestedOutboundId).toBe(`<${ikey('B')}@contested.${DOMAIN}>`);
    const before = fileHash();
    let raw = new DatabaseSync(file);
    const everythingBefore = dumpAll(raw);
    const unchangedBefore = snapshotUnchanged(raw);
    const metaBefore = rows(raw, 'SELECT * FROM mail_journal_meta');
    raw.close();

    const { journal, ledger } = openFormat9();
    // The connection still holds its exclusive lock. (Checked first: reading the file in this
    // process, as fileHash does, would itself drop the lock; so did the earlier file-copy backup.)
    expect(otherProcessWrite()).toBe('locked');

    // Backup: one file, holding every row of the format-8 database.
    expect(backups()).toHaveLength(1);
    expect(journal.format8Migration?.backupPath).toBe(path.join(dir, backups()[0]));
    expect(backups()[0]).toBe(`gateway.sqlite3.format8-backup-${new Date(T0 + 3_000 + 73 * 3600_000).toISOString().replace(/[-:.]/g, '')}`);
    const backup = new DatabaseSync(journal.format8Migration!.backupPath, { readOnly: true });
    expect(dumpAll(backup)).toBe(everythingBefore);
    expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    backup.close();

    const db = ledger.sqlite!;
    expect(rows(db, 'SELECT * FROM mail_journal_meta')).toEqual([{ ...metaBefore[0], format: 9 }]);
    expect(snapshotUnchanged(db)).toBe(unchangedBefore);
    expect(rows(db, "SELECT name FROM sqlite_master WHERE name LIKE '%format8%'")).toEqual([]);

    // mail_message: same rows in the same order, re-keyed, with the real Message-ID of the contested inbound mail.
    const expectedMessages = f8.mailMessages.map((m) => ({
      scope_account: m.scope_account,
      mail_key: m.mail_key,
      item_key: m.item_key,
      rfc_message_id: m.direction === 'email_to_frank' && m.claimed_rfc_id !== null ? m.claimed_rfc_id : m.rfc_message_id,
      payload_digest: m.payload_digest,
      frank_message_id: m.frank_message_id,
      conversation_id: m.conversation_id,
      direction: m.direction,
      in_reply_to: m.in_reply_to,
      created_at: m.created_at,
    }));
    expect(rows(db, 'SELECT * FROM mail_message ORDER BY rowid')).toEqual(expectedMessages);
    expect(journal.findMailMessage(ALICE, key('m1'))).toMatchObject({ rfcMessageId: ROOT_ID, conversationId: f8.c1 });
    expect(journal.findMailMessage(ALICE, key('m2'))).toMatchObject({
      rfcMessageId: ROOT_ID,
      conversationId: f8.c2,
      frankMessageId: f8.m2FrankId,
      direction: 'email_to_frank',
    });
    expect(journal.findMailMessage(ALICE, key('B'))).toMatchObject({
      rfcMessageId: f8.contestedOutboundId,
      itemKey: ikey('B'),
      payloadDigest: digest('B'),
      conversationId: frankId(200),
    });
    expect(journal.findMailMessage(BOB, key('nomsgid'))?.rfcMessageId).toBe(`<${key('nomsgid')}@no-message-id.${DOMAIN}>`);

    // outbound_job: every job, same id, state and bytes, keyed by its message's mail key.
    const jobMailKey: Record<string, string> = { 'signed A': key('A'), 'signed B': key('B'), 'signed C': key('C'), 'signed D': key('D'), 'signed C to r5': key('C') };
    expect(rows(db, 'SELECT * FROM outbound_job ORDER BY job_id')).toEqual(
      f8.jobRows.map(({ rfc_message_id: _rfc, ...j }) => ({
        ...j,
        mail_key: jobMailKey[Buffer.from(String(j.signed_rfc822), 'hex').toString()],
      }))
    );
    expect(journal.findOutboundJob(f8.jobs.a)).toMatchObject({ state: 'pending', mailKey: key('A'), rfcMessageId: '<fa@frank.org>', conversationId: frankId(100) });
    expect(journal.findOutboundJob(f8.jobs.b)).toMatchObject({ state: 'sent', mailKey: key('B'), rfcMessageId: f8.contestedOutboundId, providerEmailId: 'provider-b' });
    expect(journal.findOutboundJob(f8.jobs.c)).toMatchObject({ state: 'uncertain', mailKey: key('C') });
    expect(journal.findOutboundJob(f8.jobs.d)).toMatchObject({ state: 'failed', mailKey: key('D'), lastError: 'rejected by provider' });
    expect(journal.findOutboundJob(f8.jobs.e)).toMatchObject({ state: 'bounced', mailKey: key('C') });
    expect(journal.listDueOutboundJobs(clock, 10).map((j) => j.jobId)).toEqual([f8.jobs.a]);
    expect(journal.listUncertainOutboundJobs().map((j) => j.jobId)).toEqual([f8.jobs.c]);
    expect(Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outbound_job'").get() as { seq: number }).seq)).toBe(f8.jobSeq);

    // Held inbound mail, budgets and the cursor.
    expect(journal.findInboundEmailByHeldMessage(f8.heldId)).toMatchObject({ mailKey: key('held2'), disposition: 'held' });
    expect(journal.findInboundEmail(ALICE, key('held1'))?.disposition).toBe('expired');
    expect(journal.findInboundEmail(ALICE, key('echoA'))?.disposition).toBe('echo');
    expect(journal.findInboundEmail(ALICE, key('m2'))).toMatchObject({ disposition: 'relay', rfcMessageId: ROOT_ID });
    expect(journal.findFrankInbound(digest('A'))).toMatchObject({ disposition: 'bridged', budget: '5000', spent: '2000' });
    expect(journal.findFrankInbound(digest('A-reseal'))).toMatchObject({ disposition: 'resealed', spent: '0' });
    expect(journal.findFrankInbound(digest('quar'))?.disposition).toBe('quarantined');
    expect(journal.frankCursor()).toEqual({ cursorMs: 5_000, incompleteFloorMs: 6_000 });
    expect(journal.issuedMailbox('bob-inbox')).toEqual({ scopeAccount: BOB });
    expect(ledger.getBalance(SENDER)).toBe(7);

    // Reply threading by Message-ID: ROOT_ID is carried by m1 and m2 (and was authored for B);
    // a reply joins the earliest relayed one, m1, as format 8's holder rule did.
    expect(journal.findConversationByThreadHeaders({ scopeAccount: ALICE, inReplyTo: ROOT_ID })).toBe(f8.c1);
    expect(journal.findConversationByThreadHeaders({ scopeAccount: ALICE, inReplyTo: f8.contestedOutboundId })).toBe(frankId(200));
    expect(journal.findConversationByThreadHeaders({ scopeAccount: ALICE, inReplyTo: '<fa@frank.org>' })).toBe(frankId(100));
    expect(journal.findConversationByThreadHeaders({ scopeAccount: ALICE, references: ['<nope@x.example>', '<m3@x.example>'] })).toBe(f8.c1);

    // The migrated journal keeps working: a new reply relays into m1's conversation, the
    // re-seal of A is still recognised by item key, and new jobs continue the job sequence.
    clock += 1_000;
    const bytes = Buffer.from('mail body of reply');
    expect(journal.admitInboundEmail({ scopeAccount: ALICE, mailKey: key('reply'), stampValue: '1000', messageIdHeader: '<reply@x.example>', senderEmail: SENDER, dataSha256: sha(bytes), raw: { kind: 'inline', bytes } }).kind).toBe('admitted');
    expect(journal.relayInboundEmail({ scopeAccount: ALICE, mailKey: key('reply'), stampValue: '1000', inReplyTo: ROOT_ID }).message.conversationId).toBe(f8.c1);
    const reseal = journal.recordFrankMessage({
      outcome: 'bridged', payloadDigest: digest('A-reseal-2'), receivedTimeMs: 9_000, stampValue: '5000', scopeAccount: ALICE,
      frankMessageId: frankId(1), conversationId: frankId(100), rfcMessageId: '<fa@frank.org>', itemKey: ikey('A'), mailKey: key('A-other-seal'),
    });
    expect(reseal.kind).toBe('same_message');
    const e = journal.recordFrankMessage({
      outcome: 'bridged', payloadDigest: digest('E'), receivedTimeMs: 9_000, stampValue: '5000', scopeAccount: ALICE,
      frankMessageId: frankId(6), conversationId: frankId(100), rfcMessageId: '<fe@frank.org>', itemKey: ikey('E'), mailKey: key('E'),
    });
    expect(e.kind).toBe('bridged');
    const added = journal.addOutboundJob({ scopeAccount: ALICE, mailKey: key('E'), recipientEmail: 'r1@x.example', senderLocalPart: alias(ALICE, frankId(100)), signedRfc822: { kind: 'inline', bytes: Buffer.from('signed E') }, nextAttemptAtMs: clock });
    expect(added.kind).toBe('created');
    expect(added.job.jobId).toBe(f8.jobSeq + 1);
    expect(journal.claimOutboundJob(f8.jobs.a).state).toBe('submitting');

    // Reopening a migrated (format-9) journal migrates nothing and takes no second backup.
    closeAll();
    const reopened = openFormat9();
    expect(reopened.journal.format8Migration).toBeUndefined();
    expect(backups()).toHaveLength(1);
    raw = reopened.ledger.sqlite!;
    expect(raw.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 9 });
  });

  it('migrates a format-8 journal with no outbound job and no mail', () => {
    const ledger = newLedger();
    new MailJournalFormat8(ledger, { ...IDENTITY, now: () => clock });
    ledger.sqlite!.close();
    const { journal, ledger: l9 } = openFormat9();
    expect(journal.format8Migration?.rows).toMatchObject({ mail_message: 0, outbound_job: 0 });
    expect(l9.sqlite!.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 9 });
  });

  it.each([
    [
      'two outbound messages with one item key in a scope (refused before any write)',
      `INSERT INTO mail_message (scope_account, rfc_message_id, mail_key, item_key, payload_digest, frank_message_id,
         conversation_id, direction, created_at)
       SELECT scope_account, '<dup@frank.org>', '${key('dup')}', item_key, '${digest('dup')}', frank_message_id,
         conversation_id, direction, created_at FROM mail_message WHERE mail_key = '${key('A')}'`,
      /rows format 9 cannot hold faithfully: mail_message rows sharing one \(scope_account, item_key\), unique in format 9 \(1\): .*<dup@frank\.org>/,
    ],
    [
      'two messages with one mail key in a scope',
      `INSERT INTO mail_message (scope_account, rfc_message_id, mail_key, frank_message_id, conversation_id, direction, created_at)
       VALUES ('${ALICE}', '<other@x.example>', '${key('m1')}', '${frankId(77)}', '${frankId(77)}', 'email_to_frank', 1)`,
      /mail_message rows sharing one \(scope_account, mail_key\).*<other@x\.example>/,
    ],
    [
      'a contested inbound message whose inbound_email row names another Message-ID',
      `UPDATE inbound_email SET rfc_message_id = '<changed@x.example>' WHERE mail_key = '${key('m2')}'`,
      /contested inbound mail_message rows whose real Message-ID is not confirmed.*<changed@x\.example>/,
    ],
    [
      'an outbound job whose sender mailbox is missing',
      `PRAGMA foreign_keys = OFF; DELETE FROM issued_mailbox WHERE local_part = (SELECT sender_local_part FROM outbound_job ORDER BY job_id LIMIT 1)`,
      /foreign key violations \(1\): .*outbound_job/,
    ],
    [
      'an outbound job whose message is inbound',
      `INSERT INTO outbound_job (scope_account, rfc_message_id, recipient_email, sender_local_part, bounce_token,
         signed_rfc822, state, next_attempt_at, created_at)
       VALUES ('${ALICE}', '${ROOT_ID}', 'z@x.example', 'alice-thread', 'tok-z', X'00', 'pending', 1, 1)`,
      /outbound_job rows with no outbound mail_message.*"direction":"email_to_frank"/,
    ],
  ])('refuses before any backup or write, naming the rows: %s', (_name, damage, message) => {
    writeFormat8Journal();
    const raw = new DatabaseSync(file);
    raw.exec(damage);
    raw.close();
    const before = fileHash();

    let error: unknown;
    try {
      openFormat9();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MailJournalOpenError);
    expect((error as Error).message).toMatch(/Nothing was changed and no backup was written/);
    expect((error as Error).message).toMatch(message);
    closeAll();

    expect(fileHash()).toBe(before);
    expect(backups()).toEqual([]);
    const check = new DatabaseSync(file);
    expect(check.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 8 });
    expect(check.prepare("PRAGMA table_info(mail_message)").all().map((c) => c.name)).toContain('claimed_rfc_id');
    check.close();
  });

  it('a failure after the rebuild has written rolls back: file byte-identical, the verified backup kept', () => {
    writeFormat8Journal();
    const before = fileHash();
    const ledger = newLedger();
    // A temporary trigger lives on this connection only, outside the schema: it fails the
    // marker update, the last write of the migration.
    ledger.sqlite!.exec(
      "CREATE TEMP TRIGGER injected BEFORE UPDATE ON main.mail_journal_meta BEGIN SELECT RAISE(ABORT, 'injected'); END"
    );
    expect(() => new MailJournal(ledger, { ...IDENTITY, now: () => clock })).toThrow(
      /migration failed and was rolled back; the database is unchanged\. The verified backup .* was kept\. .*injected/
    );
    closeAll();
    expect(fileHash()).toBe(before);
    expect(backups()).toHaveLength(1);
    const backup = new DatabaseSync(path.join(dir, backups()[0]), { readOnly: true });
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(dumpAll(backup)).toBe(dumpAll(raw));
    backup.close();
    raw.close();
  });

  it('holds the exclusive lock throughout the migration window', () => {
    writeFormat8Journal();
    let during = '';
    // The clock is read for the backup's name, after the lock is taken and before the backup.
    openFormat9({ now: () => ((during = otherProcessWrite()), clock) });
    expect(during).toBe('locked');
    expect(otherProcessWrite()).toBe('locked');
  });

  it('keeps an outbound_job sequence above the largest job id', () => {
    const f8 = writeFormat8Journal();
    let raw = new DatabaseSync(file);
    raw.exec("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'outbound_job'");
    raw.close();
    expect(f8.jobSeq).toBeLessThan(500);
    const { ledger } = openFormat9();
    raw = ledger.sqlite!;
    expect(raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outbound_job'").get()).toEqual({ seq: 500 });
    expect(raw.prepare('SELECT MAX(job_id) AS m FROM outbound_job').get()).toEqual({ m: f8.jobSeq });
  });

  it('refuses when the backup path already exists, leaving that file and the journal as they were', () => {
    writeFormat8Journal();
    const taken = `${file}.format8-backup-${new Date(clock).toISOString().replace(/[-:.]/g, '')}`;
    fs.writeFileSync(taken, 'someone else');
    const before = fileHash();
    expect(() => openFormat9()).toThrow(/backup path .* already exists\. Nothing was changed and no backup was written/);
    closeAll();
    expect(fs.readFileSync(taken, 'utf8')).toBe('someone else');
    expect(fileHash()).toBe(before);
  });

  it('refuses a format-8 journal in WAL mode without a backup', () => {
    writeFormat8Journal();
    let raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.close();
    expect(() => openFormat9()).toThrow(/uses journal_mode wal; the migration needs a rollback journal\. Nothing was changed/);
    closeAll();
    expect(backups()).toEqual([]);
    raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 8 });
    raw.close();
  });

  it('refuses a format-8 journal of another gateway without a backup or a change', () => {
    writeFormat8Journal();
    const before = fileHash();
    expect(() => openFormat9({ gatewayDomain: 'other.example' })).toThrow(/format 8 belongs to chain monad-testnet.*Nothing was changed/);
    closeAll();
    expect(fileHash()).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('refuses a format-8 marker on a schema that is not format 8, without a backup or a change', () => {
    writeFormat8Journal();
    let raw = new DatabaseSync(file);
    raw.exec('CREATE INDEX idx_extra ON mail_message(created_at)');
    raw.close();
    const before = fileHash();
    expect(() => openFormat9()).toThrow(/marked format 8 but its schema is not the format-8 schema \(differs: index idx_extra\)/);
    closeAll();
    expect(fileHash()).toBe(before);
    expect(backups()).toEqual([]);
    raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format: 8 });
    raw.close();
  });

  it.each([7, 1])('still refuses a format-%i journal, byte-identical, with no backup', (format) => {
    writeFormat8Journal();
    let raw = new DatabaseSync(file);
    raw.prepare('UPDATE mail_journal_meta SET format = ?').run(format);
    raw.close();
    const before = fileHash();
    expect(() => openFormat9()).toThrow(new RegExp(`format ${format} is not supported; this build reads format 9 only`));
    closeAll();
    expect(fileHash()).toBe(before);
    expect(backups()).toEqual([]);
    raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT format FROM mail_journal_meta').get()).toEqual({ format });
    raw.close();
  });

  it('leaves a format-9 journal untouched', () => {
    const { journal } = openFormat9();
    const bytes = Buffer.from('x');
    journal.admitInboundEmail({ scopeAccount: ALICE, mailKey: key('x'), stampValue: '1', messageIdHeader: '<x@x.example>', senderEmail: SENDER, dataSha256: sha(bytes), raw: { kind: 'inline', bytes } });
    journal.relayInboundEmail({ scopeAccount: ALICE, mailKey: key('x'), stampValue: '1' });
    closeAll();
    const before = fileHash();
    const reopened = openFormat9();
    expect(reopened.journal.format8Migration).toBeUndefined();
    closeAll();
    expect(fileHash()).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('every journal table is covered by the migration', () => {
    expect([...MAIL_JOURNAL_TABLES].sort()).toEqual(
      ['frank_inbound', 'frank_send', 'inbound_email', 'issued_mailbox', 'mail_journal_meta', 'mail_message', 'mail_thread', 'outbound_job']
    );
  });
});
