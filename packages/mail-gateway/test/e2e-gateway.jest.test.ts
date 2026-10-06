import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { EmailGatewayDaemon } from '../src/index';
import { GatewayStampProvider, GatewayWalletBalance, StampSubmissionResult } from '../src/stamps/stamp-provider.interface';
import { GatewayConfig } from '../src/types';

class MockE2eStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  readonly sentMessages: Array<{ recipientAddress: string; text?: string }> = [];

  async getBalance(): Promise<GatewayWalletBalance> {
    return { raw: 10000000000000000000n, display: '10 MON', isLowBalance: false };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Healthy' };
  }

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
  }): Promise<StampSubmissionResult> {
    this.sentMessages.push(params);
    return {
      txHash: `0x${crypto.randomBytes(32).toString('hex')}`,
      payloadDigest: `0x${crypto.randomBytes(32).toString('hex')}`,
      recipientAddress: params.recipientAddress,
    };
  }
}

describe('End-to-End Integration Test: Live Relay + SMTP Server + Checkout Webhook', () => {
  let mockRelayServer: http.Server;
  let daemon: EmailGatewayDaemon;
  let stampProvider: MockE2eStampProvider;
  let relayPort: number;
  let httpPort: number;
  let smtpPort: number;

  const stripeWebhookSecret = 'whsec_test_secret_123';

  beforeAll(async () => {
    // 1. Start Mock Frank Relay matching Rust backend GET /directory/user/:username
    mockRelayServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/directory/user/alice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            username: 'alice',
            account_address: '0x1111111111111111111111111111111111111111',
            status: 'active',
            updated_at_ms: Date.now(),
          })
        );
      } else if (req.method === 'GET' && url.pathname === '/directory/user/bob_tombstone') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            username: 'bob_tombstone',
            account_address: '0x2222222222222222222222222222222222222222',
            status: 'tombstoned',
            updated_at_ms: Date.now(),
            tombstone_expires_at_ms: Date.now() + 86400000,
          })
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
      }
    });

    await new Promise<void>((resolve) => {
      mockRelayServer.listen(0, '127.0.0.1', () => {
        const address = mockRelayServer.address() as net.AddressInfo;
        relayPort = address.port;
        resolve();
      });
    });

    // 2. Start Gateway Daemon on dynamic ephemeral ports (0)
    stampProvider = new MockE2eStampProvider();
    const config: GatewayConfig = {
      gatewayDomain: 'frank.org',
      gatewayRelayUrl: `http://127.0.0.1:${relayPort}`,
      stampChain: 'monad',
      httpPort: 0,
      smtpPort: 0,
      dkimSelector: 'default',
      dkimPrivateKey: 'mock-key',
      lowBalanceThresholdWei: 1000n,
      stripeWebhookSecret,
    };

    daemon = new EmailGatewayDaemon(config, stampProvider, { dbPath: ':memory:' });
    await daemon.start();
    httpPort = daemon.checkoutServer.getPort();
    smtpPort = daemon.smtpListener.getPort();
  });

  afterAll(async () => {
    if (daemon) {
      await daemon.stop();
    }
    if (mockRelayServer) {
      await new Promise<void>((resolve) => mockRelayServer.close(() => resolve()));
    }
  });

  function sendSmtp(commands: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: smtpPort, host: '127.0.0.1' });
      const responses: string[] = [];
      let buffer = '';
      let cmdIndex = 0;

      socket.on('error', reject);
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          responses.push(line);

          if (line.match(/^220 /) || line.match(/^250 /) || line.match(/^354 /) || line.match(/^550 /)) {
            if (cmdIndex < commands.length) {
              const cmd = commands[cmdIndex++];
              socket.write(cmd + '\r\n');
            } else if (line.startsWith('221 ') || line.startsWith('550 ')) {
              socket.end();
            }
          }
        }
      });

      socket.on('close', () => resolve(responses));
    });
  }

  it('orchestrates end-to-end: SMTP hold -> pay checkout -> DM release -> reply allowance -> free follow-up', async () => {
    // Phase 1: Inbound SMTP from stranger to alice (0 credits)
    const rawRfc822 =
      'From: stranger@example.com\r\n' +
      'To: alice@frank.org\r\n' +
      'Subject: Introduction\r\n' +
      'Authentication-Results: dkim=pass\r\n' +
      '\r\n' +
      'Hello Alice, this is stranger wishing to contact you via Frank.\r\n' +
      '.';

    const smtpResponses = await sendSmtp([
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<alice@frank.org>',
      'DATA',
      rawRfc822,
      'QUIT',
    ]);

    expect(smtpResponses.some((r) => r.includes('250 2.0.0 Message queued for funding'))).toBe(true);

    // Retrieve held message record from SQLite ledger
    const held = daemon.ledger.findLatestHeldMessage('stranger@example.com', '0x1111111111111111111111111111111111111111');
    expect(held).toBeDefined();
    expect(held?.status).toBe('held');
    const heldId = held!.id;

    // Phase 2: Checkout explanation page request over HTTP
    const checkoutPageRes = await fetch(`http://127.0.0.1:${httpPort}/pay/${heldId}`);
    expect(checkoutPageRes.status).toBe(200);
    const html = await checkoutPageRes.text();
    expect(html).toContain('Deliver Your Message');
    expect(html).toContain('0x1111111111111111111111111111111111111111');
    expect(html).toContain('Why is payment required?');

    // Phase 3: Stripe webhook fulfillment settling payment
    const eventPayload = JSON.stringify({
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: heldId,
          customer_email: 'stranger@example.com',
          amount_total: 100,
          payment_status: 'paid',
        },
      },
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', stripeWebhookSecret)
      .update(`${timestamp}.${eventPayload}`)
      .digest('hex');
    const stripeHeader = `t=${timestamp},v1=${signature}`;

    const webhookRes = await fetch(`http://127.0.0.1:${httpPort}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': stripeHeader,
      },
      body: eventPayload,
    });

    expect(webhookRes.status).toBe(200);
    const webhookJson = (await webhookRes.json()) as { received: boolean };
    expect(webhookJson.received).toBe(true);

    // Verify stamp provider delivered DM to Alice
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(stampProvider.sentMessages[0].text).toContain('Hello Alice');

    // Phase 4: Alice replies outbound via Frank, granting reply allowance
    const outboundEmail = await daemon.outboundDelivery.processOutboundDirectMessage({
      senderFrankAddress: '0x1111111111111111111111111111111111111111',
      recipientEmail: 'stranger@example.com',
      subject: 'Re: Introduction',
      bodyText: 'Nice to meet you stranger!',
      conversationId: 'conv_123',
      frankMessageId: 'msg_123',
    });

    expect(outboundEmail.renderedEmail).toContain('From: 0x1111111111111111111111111111111111111111 <0x1111111111111111111111111111111111111111@frank.org>');
    expect(outboundEmail.renderedEmail).toContain('Nice to meet you stranger!');
    expect(outboundEmail.renderedEmail).toContain('Sent via Frank. Reply to this email to continue the thread for free');

    // Verify allowance granted in ledger
    const remainingAllowance = daemon.ledger.getThreadAllowance('stranger@example.com', '0x1111111111111111111111111111111111111111');
    expect(remainingAllowance).toBeGreaterThanOrEqual(1);

    // Phase 5: Stranger sends follow-up inbound email over SMTP -> delivered immediately without holding!
    const followUpMsg =
      'From: stranger@example.com\r\n' +
      'To: alice@frank.org\r\n' +
      'Subject: Re: Introduction\r\n' +
      'Authentication-Results: dkim=pass\r\n' +
      '\r\n' +
      'Thanks for replying Alice!\r\n' +
      '.';

    const followUpResponses = await sendSmtp([
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<alice@frank.org>',
      'DATA',
      followUpMsg,
      'QUIT',
    ]);

    expect(followUpResponses.some((r) => r.includes('250 2.0.0 Message accepted and delivered'))).toBe(true);
    expect(stampProvider.sentMessages.length).toBe(2);
    expect(stampProvider.sentMessages[1].text).toContain('Thanks for replying Alice!');
  });

  it('rejects inbound email to tombstoned handle via live relay check with 550', async () => {
    const rawRfc822 =
      'From: stranger@example.com\r\n' +
      'To: bob_tombstone@frank.org\r\n' +
      'Subject: Deactivated test\r\n' +
      '\r\n' +
      'Trying to reach deactivated bob\r\n' +
      '.';

    const responses = await sendSmtp([
      'EHLO mail.example.com',
      'MAIL FROM:<stranger@example.com>',
      'RCPT TO:<bob_tombstone@frank.org>',
      'DATA',
      rawRfc822,
      'QUIT',
    ]);

    expect(responses.some((r) => r.startsWith('550 5.2.1 Recipient account deactivated and tombstoned'))).toBe(true);
  });
});
