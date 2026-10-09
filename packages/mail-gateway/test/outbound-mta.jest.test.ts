import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateDkimKeyPair,
  loadPrivateKey,
  DkimSigner,
  verifyDkimSignature,
  canonicalizeBodyRelaxed,
  canonicalizeHeaderRelaxed,
  computeBodyHash,
} from '../src/mta/dkim-signer';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { OutboundEmailDelivery } from '../src/mta/outbound-delivery';
import { MxDirectTransport } from '../src/mta/mx-transport';
import {
  OutboundMtaWorker,
  calculateBackoffMs,
  isTemporaryFailure,
} from '../src/mta/outbound-worker';
import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { SmtpListener } from '../src/smtp/smtp-listener';
import { GatewayStampProvider, GatewayWalletBalance, StampSubmissionResult } from '../src/stamps/stamp-provider.interface';
import { InboundEmail } from '../src/types';

class MockStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  public sentMessages: Array<{
    recipientAddress: string;
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
  }> = [];

  async getBalance(): Promise<GatewayWalletBalance> {
    return { raw: 1000n, display: '1000 MON', isLowBalance: false };
  }
  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Healthy' };
  }
  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
    conversationId?: string;
    inReplyToFrankMessageId?: string;
  }): Promise<StampSubmissionResult> {
    this.sentMessages.push(params);
    return {
      txHash: `0xmock_bounce_tx_${Date.now()}`,
      payloadDigest: '0xmock_digest',
      recipientAddress: params.recipientAddress,
    };
  }
}

describe('1. DKIM Signer & Verifier (RFC 6376)', () => {
  let keyPair: { publicKey: string; privateKey: string };

  beforeAll(() => {
    keyPair = generateDkimKeyPair();
  });

  it('generates valid RSA-2048 keypair', () => {
    expect(keyPair.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(keyPair.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('correctly performs relaxed body and header canonicalization', () => {
    // Relaxed header
    const rawHeader = 'Subject:  Hello   Frank   World  \r\n';
    const canonicalHeader = canonicalizeHeaderRelaxed(rawHeader);
    expect(canonicalHeader).toBe('subject:Hello Frank World\r\n');

    // Relaxed body: compresses whitespace, ignores trailing spaces and trailing empty lines
    const rawBody = 'Line 1   \r\nLine 2   with   spaces\r\n\r\n   \r\n';
    const canonicalBody = canonicalizeBodyRelaxed(rawBody);
    expect(canonicalBody).toBe('Line 1\r\nLine 2 with spaces\r\n');

    // Empty body results in empty string
    expect(canonicalizeBodyRelaxed('   \r\n\r\n')).toBe('');
  });

  it('computes sha256 body hash over relaxed body', () => {
    const body = 'Hello world!\r\n';
    const bh = computeBodyHash(body);
    expect(typeof bh).toBe('string');
    expect(bh.length).toBeGreaterThan(20);
  });

  it('signs RFC 5322 message and generates valid DKIM-Signature header', () => {
    const signer = new DkimSigner({
      domain: 'frank.org',
      selector: 'test',
      privateKey: keyPair.privateKey,
    });

    const rawEmail =
      'From: Alice <alice@frank.org>\r\n' +
      'To: Bob <bob@example.com>\r\n' +
      'Subject: Hello from Frank\r\n' +
      'Date: Tue, 06 Oct 2026 12:00:00 GMT\r\n' +
      'Message-ID: <msg_123@frank.org>\r\n' +
      '\r\n' +
      'This is a test message body.';

    const signed = signer.sign(rawEmail);

    expect(signed).toContain('DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=frank.org; s=test;');
    expect(signed).toContain('h=from:to:subject:date:message-id;');
    expect(signed).toContain('bh=');
    expect(signed).toContain('b=');

    // Verify signature using DkimSigner.verify
    const valid = signer.verify(signed);
    expect(valid).toBe(true);

    // Verify using standalone verifyDkimSignature
    const validStandalone = verifyDkimSignature(signed, keyPair.publicKey);
    expect(validStandalone).toBe(true);
  });

  it('signs CRLF and LF input into the same bytes: CRLF line endings, the body hash of the canonical body, and a signature over the canonical headers', () => {
    const signer = new DkimSigner({
      domain: 'frank.org',
      selector: 'test',
      privateKey: keyPair.privateKey,
    });
    const headerLines = [
      'From: Alice <alice@frank.org>',
      'To: Bob <bob@example.com>',
      'Subject: Hello   from Frank',
      'Date: Tue, 06 Oct 2026 12:00:00 GMT',
      'Message-ID: <msg_pin@frank.org>',
    ];
    const bodyLines = ['first  line ', '.second line', '', 'last line', ''];
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_791_288_000_000);
    let signedCrlf: string;
    let signedLf: string;
    try {
      signedCrlf = signer.sign(`${headerLines.join('\r\n')}\r\n\r\n${bodyLines.join('\r\n')}`);
      signedLf = signer.sign(`${headerLines.join('\n')}\n\n${bodyLines.join('\n')}`);
    } finally {
      nowSpy.mockRestore();
    }

    // Expected values are computed here with node:crypto, not with the signer's helpers.
    const bodyHash = crypto
      .createHash('sha256')
      .update('first line\r\n.second line\r\n\r\nlast line\r\n', 'utf-8')
      .digest('base64');
    const dkimHeaderWithoutB =
      'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=frank.org; s=test; ' +
      `t=1791288000; h=from:to:subject:date:message-id; bh=${bodyHash}; b=`;
    const signedData =
      'from:Alice <alice@frank.org>\r\n' +
      'to:Bob <bob@example.com>\r\n' +
      'subject:Hello from Frank\r\n' +
      'date:Tue, 06 Oct 2026 12:00:00 GMT\r\n' +
      'message-id:<msg_pin@frank.org>\r\n' +
      `dkim-signature:${dkimHeaderWithoutB.slice('DKIM-Signature: '.length)}\r\n`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signedData, 'utf-8')
      .sign(keyPair.privateKey, 'base64');

    const expected =
      `${headerLines.join('\r\n')}\r\n${dkimHeaderWithoutB}${signature}\r\n\r\n${bodyLines.join('\r\n')}`;
    expect(signedCrlf).toBe(expected);
    expect(signedLf).toBe(expected);
  });

  it('treats a lone CR as a line ending when canonicalizing and signing a body', () => {
    expect(canonicalizeBodyRelaxed('one \rtwo\r\rthree\r')).toBe('one\r\ntwo\r\n\r\nthree\r\n');
    expect(computeBodyHash('one\rtwo\nthree\r\n')).toBe(computeBodyHash('one\r\ntwo\r\nthree\r\n'));

    const signer = new DkimSigner({
      domain: 'frank.org',
      selector: 'test',
      privateKey: keyPair.privateKey,
    });
    const signed = signer.sign(
      'From: Alice <alice@frank.org>\r\nSubject: Endings\r\n\r\none\rtwo\nthree\r\n'
    );

    expect(signed.endsWith('\r\n\r\none\r\ntwo\r\nthree\r\n')).toBe(true);
    expect(/\r(?!\n)/.test(signed)).toBe(false);
    expect(signer.verify(signed)).toBe(true);
  });

  it('rejects tampered body or modified signed headers', () => {
    const signer = new DkimSigner({
      domain: 'frank.org',
      selector: 'test',
      privateKey: keyPair.privateKey,
    });

    const rawEmail =
      'From: Alice <alice@frank.org>\r\n' +
      'To: Bob <bob@example.com>\r\n' +
      'Subject: Security Audit\r\n' +
      'Date: Tue, 06 Oct 2026 12:00:00 GMT\r\n' +
      'Message-ID: <sec_123@frank.org>\r\n' +
      '\r\n' +
      'Original sensitive content.';

    const signed = signer.sign(rawEmail);

    // Tamper body
    const tamperedBody = signed.replace('Original sensitive content.', 'Tampered content!');
    expect(signer.verify(tamperedBody)).toBe(false);

    // Tamper header
    const tamperedHeader = signed.replace('Security Audit', 'Fake Subject');
    expect(signer.verify(tamperedHeader)).toBe(false);
  });

  it('supports loading private key from file path on disk', () => {
    const tmpDir = os.tmpdir();
    const keyPath = path.join(tmpDir, `dkim-test-${Date.now()}.pem`);
    fs.writeFileSync(keyPath, keyPair.privateKey, 'utf-8');

    try {
      const loadedKey = loadPrivateKey(keyPath);
      expect(loadedKey).toBe(keyPair.privateKey);

      const signer = new DkimSigner({
        domain: 'frank.org',
        selector: 'test',
        privateKey: keyPath, // path to file
      });

      const message = 'From: test@frank.org\r\nTo: bob@example.com\r\nSubject: Test\r\n\r\nBody';
      const signed = signer.sign(message);
      expect(signer.verify(signed)).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
      }
    }
  });
});

describe('2. Outbound Spool & Retry Engine (CreditLedger)', () => {
  let ledger: CreditLedger;

  beforeEach(() => {
    ledger = new CreditLedger(':memory:');
  });

  it('enqueues outbound jobs and retrieves pending jobs', async () => {
    const now = 1_000_000;
    const jobId = await ledger.enqueueOutboundSpool({
      recipientEmail: 'recipient@example.com',
      fromAddress: 'alice@frank.org',
      rawRfc822: 'raw-email-content',
      nextAttemptAt: now,
      maxAttempts: 5,
    });

    expect(jobId).toBe(1);

    const pending = ledger.getPendingOutboundJobs(now);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(jobId);
    expect(pending[0].recipientEmail).toBe('recipient@example.com');
    expect(pending[0].fromAddress).toBe('alice@frank.org');
    expect(pending[0].attempts).toBe(0);
    expect(pending[0].status).toBe('pending');

    // Future jobs are not returned
    const futurePending = ledger.getPendingOutboundJobs(now - 1000);
    expect(futurePending.length).toBe(0);
  });

  it('calculates exponential backoff progression up to 72h', () => {
    const base = 60_000; // 1m
    const max = 72 * 3600 * 1000; // 72h

    expect(calculateBackoffMs(0, base, max)).toBe(60_000); // 1m
    expect(calculateBackoffMs(1, base, max)).toBe(120_000); // 2m
    expect(calculateBackoffMs(2, base, max)).toBe(240_000); // 4m
    expect(calculateBackoffMs(3, base, max)).toBe(480_000); // 8m
    expect(calculateBackoffMs(4, base, max)).toBe(960_000); // 16m

    // High attempt count caps at max (72h)
    expect(calculateBackoffMs(15, base, max)).toBe(max);
  });

  it('marks job success and updates status', async () => {
    const id = await ledger.enqueueOutboundSpool({
      recipientEmail: 'user@example.com',
      fromAddress: 'alice@frank.org',
      rawRfc822: 'content',
    });

    ledger.markOutboundJobSuccess(id);
    const job = ledger.getOutboundJob(id);
    expect(job?.status).toBe('success');

    // Succeeded jobs are not returned by getPendingOutboundJobs
    expect(ledger.getPendingOutboundJobs(Date.now() + 100000).length).toBe(0);
  });

  it('marks job failed with backoff and transitions to dead-letter failed on max attempts', async () => {
    const now = 1_000_000;
    const id = await ledger.enqueueOutboundSpool({
      recipientEmail: 'user@example.com',
      fromAddress: 'alice@frank.org',
      rawRfc822: 'content',
      maxAttempts: 3,
    });

    // Attempt 1: retriable
    const retriable1 = ledger.markOutboundJobFailed(id, 'SMTP 451 error', now, 60_000);
    expect(retriable1).toBe(true);
    let job = ledger.getOutboundJob(id);
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttemptAt).toBe(now + 60_000);
    expect(job?.status).toBe('pending');
    expect(job?.lastError).toBe('SMTP 451 error');

    // Attempt 2: retriable
    const retriable2 = ledger.markOutboundJobFailed(id, 'SMTP 451 error', now + 60_000, 120_000);
    expect(retriable2).toBe(true);
    job = ledger.getOutboundJob(id);
    expect(job?.attempts).toBe(2);

    // Attempt 3: reaches maxAttempts (3) -> returns false (dead letter)
    const retriable3 = ledger.markOutboundJobFailed(id, 'Max attempts reached', now + 180_000, 240_000);
    expect(retriable3).toBe(false);
    job = ledger.getOutboundJob(id);
    expect(job?.attempts).toBe(3);
    expect(job?.status).toBe('failed'); // dead letter
  });
});

describe('3. Direct MX Delivery & Worker Spool Processor', () => {
  let mockServer: net.Server;
  let serverPort: number;
  let serverResponses: { [stage: string]: string };
  let receivedData: string;

  let ledger: CreditLedger;
  let keyPair: { publicKey: string; privateKey: string };
  let dkimSigner: DkimSigner;
  let outboundDelivery: OutboundEmailDelivery;
  let mxTransport: MxDirectTransport;
  let worker: OutboundMtaWorker;

  beforeAll(() => {
    keyPair = generateDkimKeyPair();
  });

  beforeEach(async () => {
    serverResponses = {
      GREETING: '220 mock.mta ESMTP Service Ready',
      EHLO: '250-mock.mta Hello\r\n250-SIZE 10485760\r\n250 OK',
      MAIL: '250 2.1.0 Sender OK',
      RCPT: '250 2.1.5 Recipient OK',
      DATA: '354 Start mail input; end with <CRLF>.<CRLF>',
      BODY: '250 2.0.0 Message accepted for delivery',
      QUIT: '221 2.0.0 Service closing transmission channel',
    };
    receivedData = '';

    mockServer = net.createServer((socket) => {
      let stage = 'GREETING';
      socket.write(`${serverResponses.GREETING}\r\n`);

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\n')) {
          const lineEnd = buffer.indexOf('\n');
          const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
          buffer = buffer.slice(lineEnd + 1);

          if (stage === 'DATA') {
            if (line === '.') {
              stage = 'BODY';
              socket.write(`${serverResponses.BODY}\r\n`);
            } else {
              receivedData += line + '\r\n';
            }
            continue;
          }

          if (line.startsWith('EHLO') || line.startsWith('HELO')) {
            socket.write(`${serverResponses.EHLO}\r\n`);
          } else if (line.startsWith('MAIL FROM:')) {
            socket.write(`${serverResponses.MAIL}\r\n`);
          } else if (line.startsWith('RCPT TO:')) {
            socket.write(`${serverResponses.RCPT}\r\n`);
          } else if (line === 'DATA') {
            stage = 'DATA';
            socket.write(`${serverResponses.DATA}\r\n`);
          } else if (line === 'QUIT') {
            socket.write(`${serverResponses.QUIT}\r\n`);
            socket.end();
          }
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        serverPort = (mockServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    ledger = new CreditLedger(':memory:');
    dkimSigner = new DkimSigner({
      domain: 'frank.org',
      selector: 'mta',
      privateKey: keyPair.privateKey,
    });
    outboundDelivery = new OutboundEmailDelivery({
      gatewayDomain: 'frank.org',
      ledger,
    });
    mxTransport = new MxDirectTransport({
      heloDomain: 'frank.org',
      defaultPort: serverPort,
      resolveMxFn: async () => [{ exchange: '127.0.0.1', priority: 10 }],
    });
    worker = new OutboundMtaWorker({
      gatewayDomain: 'frank.org',
      ledger,
      delivery: outboundDelivery,
      dkimSigner,
      mxTransport,
      baseBackoffMs: 50, // short backoff for tests
      maxBackoffMs: 1000,
    });
  });

  afterEach(async () => {
    worker.stopSpoolProcessor();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('dispatches direct message, signs with DKIM, and delivers successfully via MX', async () => {
    const result = await worker.dispatchMessage({
      conversationId: 'conv_1',
      frankMessageId: 'fmsg_1',
      senderFrankAddress: '0xalice',
      recipientEmail: 'bob@remote.com',
      bodyText: 'Hello Bob! This is Alice from Frank.',
      subject: 'Greeting',
    });

    expect(result.success).toBe(true);
    expect(result.spooled).toBe(false);
    expect(result.rfc822MessageId).toBeDefined();

    // Verify received data on mock server contains DKIM signature and headers
    expect(receivedData).toContain('DKIM-Signature: v=1; a=rsa-sha256;');
    expect(receivedData).toContain('From: 0xalice <0xalice@frank.org>');
    expect(receivedData).toContain('To: bob@remote.com');
    expect(receivedData).toContain('Subject: Greeting');
    expect(receivedData).toContain('Hello Bob! This is Alice from Frank.');

    // Verify received email is valid DKIM
    expect(verifyDkimSignature(receivedData, keyPair.publicKey)).toBe(true);
  });

  it('enqueues into outbound_spool upon temporary delivery failure (4xx)', async () => {
    // Make mock server reject with 451 temporary failure
    serverResponses.RCPT = '451 4.3.0 Mailbox temporarily busy, try again later';

    const result = await worker.dispatchMessage({
      conversationId: 'conv_temp',
      frankMessageId: 'fmsg_temp',
      senderFrankAddress: '0xcharlie',
      recipientEmail: 'busy@remote.com',
      bodyText: 'Please retry me.',
    });

    expect(result.success).toBe(false);
    expect(result.spooled).toBe(true);
    expect(result.spoolJobId).toBeDefined();
    expect(result.responseCode).toBe(451);

    // Spool job should exist in pending state
    const job = ledger.getOutboundJob(result.spoolJobId!);
    expect(job).toBeDefined();
    expect(job?.status).toBe('pending');
    expect(job?.recipientEmail).toBe('busy@remote.com');
  });

  it('sweeps pending spool jobs and re-delivers when MX server recovers', async () => {
    // 1. Fail initial delivery
    serverResponses.RCPT = '451 4.3.0 Mailbox temporarily unavailable';
    const dispatchResult = await worker.dispatchMessage({
      conversationId: 'conv_retry',
      frankMessageId: 'fmsg_retry',
      senderFrankAddress: '0xdave',
      recipientEmail: 'dave_friend@remote.com',
      bodyText: 'Retried message',
    });
    expect(dispatchResult.spooled).toBe(true);
    const spoolJobId = dispatchResult.spoolJobId!;

    // 2. Server recovers (RCPT 250)
    serverResponses.RCPT = '250 2.1.5 Recipient OK';

    // 3. Process spool with future timestamp
    const futureMs = Date.now() + 1000;
    const summary = await worker.processSpool(futureMs);

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);

    const updatedJob = ledger.getOutboundJob(spoolJobId);
    expect(updatedJob?.status).toBe('success');
  });

  it('rejects permanent failure (5xx) without spooling for retry', async () => {
    serverResponses.RCPT = '550 5.1.1 User unknown; mailbox not found';

    const result = await worker.dispatchMessage({
      conversationId: 'conv_perm',
      frankMessageId: 'fmsg_perm',
      senderFrankAddress: '0xeve',
      recipientEmail: 'nonexistent@remote.com',
      bodyText: 'Should not be spooled',
    });

    expect(result.success).toBe(false);
    expect(result.spooled).toBe(false);
    expect(result.responseCode).toBe(550);

    // Spool remains empty
    const pending = ledger.getPendingOutboundJobs(Date.now() + 100000);
    expect(pending.length).toBe(0);
  });
});

describe('4. Inbound Bounce / NDR Processing & Sender Notification', () => {
  let ledger: CreditLedger;
  let stampProvider: MockStampProvider;
  let handler: InboundEmailHandler;
  let listener: SmtpListener;
  const testPort = 25259;

  beforeEach(async () => {
    ledger = new CreditLedger(':memory:');
    stampProvider = new MockStampProvider();

    handler = new InboundEmailHandler({
      gatewayDomain: 'frank.org',
      ledger,
      stampProvider,
    });

    listener = new SmtpListener({
      gatewayDomain: 'frank.org',
      handler,
    });

    await listener.start(testPort, '127.0.0.1');
  });

  afterEach(async () => {
    await listener.stop();
  });

  it('handles envelope recipient bounce+<spoolId>@frank.org and notifies Frank sender', async () => {
    // 1. Spool an outbound job
    const spoolJobId = await ledger.enqueueOutboundSpool({
      recipientEmail: 'target@external.com',
      fromAddress: '0xsender_alice@frank.org',
      rawRfc822: 'From: 0xsender_alice <0xsender_alice@frank.org>\r\nSubject: Hi\r\n\r\nTest',
    });

    // 2. Inbound bounce arrives to bounce+<spoolJobId>@frank.org
    const bounceEmail: InboundEmail = {
      messageId: '<bounce_msg_1@remote-mta.com>',
      fromAddress: 'mailer-daemon@remote-mta.com',
      fromDomain: 'remote-mta.com',
      toAddress: `bounce+${spoolJobId}@frank.org`,
      localPart: `bounce+${spoolJobId}`,
      subject: 'Delivery Status Notification (Failure)',
      textBody:
        'Your message could not be delivered to target@external.com.\n' +
        'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      dkimValid: true,
      spfValid: true,
      rawRfc822: new TextEncoder().encode(
        `To: bounce+${spoolJobId}@frank.org\r\nSubject: Delivery Status Notification\r\n\r\nFailed.`
      ),
    };

    const result = await handler.processInboundEmail(bounceEmail);

    expect(result.status).toBe('bounce');
    expect(result.bounceNotificationSent).toBe(true);
    expect(result.bounceRecipient).toBe('target@external.com');

    // Verify Frank sender received direct message notification
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0xsender_alice');
    expect(stampProvider.sentMessages[0].text).toContain('[Delivery Status Notification - Bounce]');
    expect(stampProvider.sentMessages[0].text).toContain('target@external.com');
  });

  it('handles envelope recipient mailer-daemon@frank.org and resolves sender from thread history', async () => {
    // 1. Frank sender 0xsender_bob previously sent email to client@partner.com
    ledger.grantReplyAllowance('client@partner.com', '0xsender_bob', 3);

    // 2. Remote NDR arrives to mailer-daemon@frank.org
    const bounceEmail: InboundEmail = {
      messageId: '<ndr_msg_2@partner.com>',
      fromAddress: 'postmaster@partner.com',
      fromDomain: 'partner.com',
      toAddress: 'mailer-daemon@frank.org',
      localPart: 'mailer-daemon',
      subject: 'Undelivered Mail Returned to Sender',
      textBody:
        'This is the mail system at host partner.com.\n\n' +
        'Final-Recipient: rfc822; client@partner.com\n' +
        'Action: failed\n' +
        'Status: 5.2.2\n' +
        'Diagnostic-Code: X-Postfix; mailbox full',
      dkimValid: true,
      spfValid: true,
      rawRfc822: new TextEncoder().encode(
        'Final-Recipient: rfc822; client@partner.com\r\nStatus: 5.2.2\r\n\r\nMailbox full.'
      ),
    };

    const result = await handler.processInboundEmail(bounceEmail);

    expect(result.status).toBe('bounce');
    expect(result.bounceNotificationSent).toBe(true);
    expect(result.bounceRecipient).toBe('client@partner.com');

    // Verify 0xsender_bob received DM
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0xsender_bob');
    expect(stampProvider.sentMessages[0].text).toContain('client@partner.com');
  });

  it('accepts bounce notifications over live SMTP connection returning 250 response', async () => {
    ledger.grantReplyAllowance('bounced_client@external.com', '0xsender_frank', 2);

    const client = net.createConnection({ port: testPort, host: '127.0.0.1' });
    const responses: string[] = [];
    let buffer = '';

    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\n')) {
          const lineEnd = buffer.indexOf('\n');
          const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
          buffer = buffer.slice(lineEnd + 1);
          responses.push(line);

          if (line.startsWith('220')) {
            client.write('EHLO mail.external.com\r\n');
          } else if (line.startsWith('250-') || line === '250 OK') {
            if (line === '250 OK') {
              client.write('MAIL FROM:<>\r\n');
            }
          } else if (line.startsWith('250 2.1.0')) {
            client.write('RCPT TO:<mailer-daemon@frank.org>\r\n');
          } else if (line.startsWith('250 2.1.5')) {
            client.write('DATA\r\n');
          } else if (line.startsWith('354')) {
            client.write(
              'From: <>\r\n' +
              'To: <mailer-daemon@frank.org>\r\n' +
              'Subject: Delivery Failure\r\n' +
              '\r\n' +
              'Final-Recipient: rfc822; bounced_client@external.com\r\n' +
              'Diagnostic-Code: smtp; 550 5.1.1 User not found\r\n' +
              '\r\n.\r\n'
            );
          } else if (line.includes('Bounce notification processed')) {
            client.write('QUIT\r\n');
          } else if (line.startsWith('221')) {
            resolve();
          }
        }
      });
    });

    expect(responses.some((r) => r.includes('250 2.0.0 Bounce notification processed'))).toBe(true);
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0xsender_frank');
  });
});
