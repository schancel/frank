import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import {
  ResendOutboundReconciler,
  type SentMailEvidencePort,
} from '../src/mta/resend-outbound-reconciler';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';

const DOMAIN = 'gw.example';
const ACCOUNT = `0x${'a'.repeat(40)}`;
const GATEWAY = `0x${'9'.repeat(40)}`;
const RECIPIENT = 'recipient@example.test';
const ID = '00000000-0000-0000-0000-000000000001';
const CONVERSATION = '00000000-0000-0000-0000-000000000002';
const RFC_ID = '<outbound@gw.example>';
const ALIAS = 'threadreply001';
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function claimedJob(journal: MailJournal, suffix = '1'): number {
  const input = {
    outcome: 'bridged' as const,
    payloadDigest: sha(`payload-${suffix}`),
    receivedTimeMs: 1000,
    stampValue: '0',
    scopeAccount: ACCOUNT,
    frankMessageId: suffix === '1' ? ID : '00000000-0000-0000-0000-000000000003',
    conversationId: CONVERSATION,
    authoredMessageId: suffix === '1' ? RFC_ID : '<outbound-2@gw.example>',
    itemKey: sha(`item-${suffix}`),
  };
  const render = journal.recordFrankMessage(input);
  if (render.kind !== 'needs_render') throw new Error('Expected render request');
  const bridged = journal.recordFrankMessage({
    ...input,
    emitted: { rfcMessageId: render.rfcMessageId, mailKey: sha(`mail-${suffix}`) },
  });
  if (bridged.kind !== 'bridged') throw new Error('Expected bridged message');
  journal.issueMailbox({ localPart: ALIAS, scopeAccount: ACCOUNT, conversationId: CONVERSATION });
  const job = journal.addOutboundJob({
    scopeAccount: ACCOUNT,
    rfcMessageId: bridged.message.rfcMessageId,
    recipientEmail: RECIPIENT,
    senderLocalPart: ALIAS,
    signedRfc822: { kind: 'inline', bytes: Buffer.from('signed mail') },
    nextAttemptAtMs: 0,
  });
  if (job.kind !== 'created') throw new Error('Expected outbound job');
  journal.claimOutboundJob(job.job.jobId);
  return job.job.jobId;
}

describe('Resend outbound acceptance reconciliation', () => {
  let dir: string;
  let ledger: CreditLedger;
  let journal: MailJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-resend-reconcile-'));
    ledger = new CreditLedger(path.join(dir, 'mail.sqlite'), new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: 'monad-testnet',
      gatewayAccount: GATEWAY,
      gatewayDomain: DOMAIN,
      now: () => 1000,
    });
  });
  afterEach(() => {
    ledger.sqlite?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts only exact Message-ID, issued sender, recipient and submission-time evidence', async () => {
    const jobId = claimedJob(journal);
    const matching = {
      id: 'provider-1',
      messageId: RFC_ID,
      from: `${ALIAS}@${DOMAIN}`,
      to: [RECIPIENT],
      createdAt: new Date(1000).toISOString(),
    };
    const list = jest.fn(async () => ({
      messages: [
        { ...matching, id: 'wrong-id', messageId: '<different@gw.example>' },
        { ...matching, id: 'wrong-sender', from: `${ACCOUNT}@${DOMAIN}` },
        { ...matching, id: 'wrong-recipient', to: ['other@example.test'] },
        { ...matching, id: 'too-early', createdAt: new Date(-400_000).toISOString() },
        matching,
      ],
      hasMore: false,
    }));
    const port: SentMailEvidencePort = { list };
    expect(await new ResendOutboundReconciler(journal, port).reconcile()).toEqual({
      confirmed: 1,
      unresolved: 0,
      pages: 1,
    });
    expect(journal.findOutboundJob(jobId)).toMatchObject({ state: 'sent', providerEmailId: 'provider-1' });
  });

  it('never resends or marks failed when the provider listing has no proof', async () => {
    const jobId = claimedJob(journal);
    const port: SentMailEvidencePort = {
      list: jest.fn(async () => ({ messages: [], hasMore: false })),
    };
    expect(await new ResendOutboundReconciler(journal, port).reconcile()).toEqual({
      confirmed: 0,
      unresolved: 1,
      pages: 1,
    });
    expect(journal.findOutboundJob(jobId)?.state).toBe('submitting');
    expect(journal.listDueOutboundJobs(100_000, 10)).toEqual([]);
  });

  it('walks past old unresolved jobs and resumes after a bounded provider page', async () => {
    const old = claimedJob(journal);
    const later = claimedJob(journal, '2');
    const evidence = {
      id: 'provider-later',
      messageId: '<outbound-2@gw.example>',
      from: `${ALIAS}@${DOMAIN}`,
      to: [RECIPIENT],
      createdAt: new Date(1000).toISOString(),
    };
    const list = jest.fn(async (after?: string) => after === 'first-page'
      ? { messages: [evidence], hasMore: false }
      : { messages: [{ ...evidence, id: 'first-page', messageId: '<wrong@gw.example>' }], hasMore: true });
    const reconciler = new ResendOutboundReconciler(journal, { list });
    const first = await reconciler.reconcile(1, 1);
    expect(first).toEqual({ confirmed: 0, unresolved: 1, pages: 1, nextProviderAfter: 'first-page' });
    const exhausted = await reconciler.reconcile(1, 1, 0, first.nextProviderAfter);
    expect(exhausted).toEqual({ confirmed: 0, unresolved: 1, pages: 1, nextJobId: old });
    const next = await reconciler.reconcile(1, 2, exhausted.nextJobId);
    expect(next).toMatchObject({ confirmed: 1, unresolved: 0, nextJobId: later });
    expect(journal.findOutboundJob(old)?.state).toBe('submitting');
    expect(journal.findOutboundJob(later)).toMatchObject({ state: 'sent', providerEmailId: 'provider-later' });
    expect(list).toHaveBeenCalledWith('first-page');
  });
});
