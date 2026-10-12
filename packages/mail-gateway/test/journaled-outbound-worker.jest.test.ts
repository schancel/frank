import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import {
  JournaledOutboundWorker,
  type OutboundMailPort,
} from '../src/mta/journaled-outbound-worker';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const DOMAIN = 'gw.example';
const ACCOUNT = `0x${'a'.repeat(40)}`;
const GATEWAY = `0x${'9'.repeat(40)}`;
const RECIPIENT = 'recipient@example.test';
const ID = '00000000-0000-0000-0000-000000000001';
const CONVERSATION = '00000000-0000-0000-0000-000000000002';
const RFC_ID = `<outbound@gw.example>`;
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function makeJob(journal: MailJournal): number {
  const input = {
    outcome: 'bridged' as const,
    payloadDigest: sha('payload'),
    receivedTimeMs: 1000,
    stampValue: '0',
    scopeAccount: ACCOUNT,
    frankMessageId: ID,
    conversationId: CONVERSATION,
    authoredMessageId: RFC_ID,
    itemKey: sha('item'),
  };
  const render = journal.recordFrankMessage(input);
  if (render.kind !== 'needs_render') throw new Error('Expected render request');
  const bridged = journal.recordFrankMessage({
    ...input,
    emitted: { rfcMessageId: render.rfcMessageId, mailKey: sha('mail') },
  });
  if (bridged.kind !== 'bridged') throw new Error('Expected bridged message');
  const mail = Buffer.from(
    `From: ${ACCOUNT}@${DOMAIN}\r\nTo: ${RECIPIENT}\r\nSubject: Test\r\nMessage-ID: ${RFC_ID}\r\n\r\nHello`
  );
  const job = journal.addOutboundJob({
    scopeAccount: ACCOUNT,
    rfcMessageId: bridged.message.rfcMessageId,
    recipientEmail: RECIPIENT,
    signedRfc822: { kind: 'inline', bytes: mail },
    nextAttemptAtMs: 0,
  });
  if (job.kind !== 'created') throw new Error('Expected new outbound job');
  return job.job.jobId;
}

describe('journaled outbound worker', () => {
  let dir: string;
  let ledger: CreditLedger;
  let journal: MailJournal;
  let dbPath: string;

  const open = () => {
    ledger = new CreditLedger(dbPath, new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: 'monad-testnet',
      gatewayAccount: GATEWAY,
      gatewayDomain: DOMAIN,
      now: () => 1000,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-outbound-'));
    dbPath = path.join(dir, 'mail.sqlite');
    open();
  });
  afterEach(() => {
    ledger.sqlite?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claims durable bytes before provider submission, then marks acceptance', async () => {
    const jobId = makeJob(journal);
    const submit = jest.fn(async () => {
      expect(journal.findOutboundJob(jobId)?.state).toBe('submitting');
      expect(journal.listDueOutboundJobs(1000, 10)).toHaveLength(0);
    });
    const worker = new JournaledOutboundWorker({
      journal,
      gatewayDomain: DOMAIN,
      port: { submit },
    });
    expect(await worker.dispatch(jobId)).toBe('sent');
    expect(journal.findOutboundJob(jobId)?.state).toBe('sent');
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: `${ACCOUNT}@${DOMAIN}`,
        recipientEmail: RECIPIENT,
      })
    );
  });

  it('keeps an ambiguous provider outcome out of the due queue after restart', async () => {
    const jobId = makeJob(journal);
    const submit = jest.fn(async () => {
      throw new Error('connection ended after DATA');
    });
    const worker = new JournaledOutboundWorker({
      journal,
      gatewayDomain: DOMAIN,
      port: { submit },
    });
    expect(await worker.dispatch(jobId)).toBe('uncertain');
    expect(journal.findOutboundJob(jobId)?.state).toBe('uncertain');
    ledger.sqlite?.close();
    open();
    const afterRestart = new JournaledOutboundWorker({
      journal,
      gatewayDomain: DOMAIN,
      port: { submit },
    });
    expect(await afterRestart.dispatchDue(1000, 10)).toEqual({
      sent: 0,
      uncertain: 0,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(journal.listUncertainOutboundJobs().map((job) => job.jobId)).toEqual([jobId]);
  });

  it('retains a claim interrupted after the journal commit without submitting', async () => {
    const jobId = makeJob(journal);
    journal.claimOutboundJob(jobId);
    ledger.sqlite?.close();
    open();
    const port: OutboundMailPort = { submit: jest.fn() };
    const worker = new JournaledOutboundWorker({
      journal,
      gatewayDomain: DOMAIN,
      port,
    });
    expect(await worker.dispatchDue(1000, 10)).toEqual({
      sent: 0,
      uncertain: 0,
    });
    expect(port.submit).not.toHaveBeenCalled();
    expect(journal.listUncertainOutboundJobs()[0].state).toBe('submitting');
  });
});
