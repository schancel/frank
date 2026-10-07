import { CheckoutServer } from '../src/http/checkout-server';
import { CreditLedger } from '../src/ledger/credit-ledger';
import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from '../src/stamps/stamp-provider.interface';

class MockStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  public sentMessages: Array<{ recipientAddress: string; text?: string }> = [];

  async getBalance(): Promise<GatewayWalletBalance> {
    return { raw: 10000000000000000000n, display: '10.0 MON', isLowBalance: false };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Mock healthy' };
  }

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
  }): Promise<StampSubmissionResult> {
    this.sentMessages.push(params);
    return {
      txHash: '0xmocktx123',
      payloadDigest: '0xmockdigest',
      recipientAddress: params.recipientAddress,
    };
  }
}

describe('CheckoutServer', () => {
  let ledger: CreditLedger;
  let stampProvider: MockStampProvider;
  let server: CheckoutServer;
  let testPort: number;

  beforeEach(async () => {
    ledger = new CreditLedger(':memory:');
    stampProvider = new MockStampProvider();
    server = new CheckoutServer({
      port: 0,
      ledger,
      stampProvider,
    });
    await server.start();
    testPort = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds to GET /health', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.health.ok).toBe(true);
    expect(json.balance.display).toBe('10.0 MON');
  });

  it('renders payment explanation page on GET /pay/:token', async () => {
    await ledger.holdMessage({
      id: 'token_abc123',
      senderEmail: 'alice@external.com',
      recipientAddress: '0xfrankrecipient',
      dkimDomain: 'external.com',
      subject: 'Coffee catchup',
      rawRfc822: new TextEncoder().encode('Hey Alice here!'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600000 * 72,
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/pay/token_abc123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Deliver Your Message');
    expect(html).toContain('alice@external.com');
    expect(html).toContain('0xfrankrecipient');
    expect(html).toContain('Coffee catchup');
    expect(html).toContain('Pay with Card');
  });

  it('atomically fulfills Stripe payment webhook, releases message, and stamps DM', async () => {
    await ledger.holdMessage({
      id: 'held_999',
      senderEmail: 'recruiter@hiring.com',
      recipientAddress: '0xengineer',
      dkimDomain: 'hiring.com',
      subject: 'Senior Rust Role',
      rawRfc822: new TextEncoder().encode('We love your GitHub work!'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600000 * 72,
    });

    const stripeEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123456',
          client_reference_id: 'held_999',
          customer_details: { email: 'recruiter@hiring.com' },
          metadata: { credits: '5' },
        },
      },
    };

    const res = await fetch(`http://127.0.0.1:${testPort}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripeEvent),
    });

    expect(res.status).toBe(200);

    // 1. Message released
    const held = ledger.getHeldMessage('held_999');
    expect(held?.status).toBe('released');

    // 2. 5 credits added, 1 consumed for this message = 4 remaining
    expect(ledger.getBalance('recruiter@hiring.com')).toBe(4);

    // 3. Stamped direct message sent to Frank relay
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0xengineer');
    expect(stampProvider.sentMessages[0].text).toContain('Senior Rust Role');
    expect(stampProvider.sentMessages[0].text).toContain('We love your GitHub work!');

    // 4. Visiting payment URL after fulfillment shows confirmed delivery page
    const payRes = await fetch(`http://127.0.0.1:${testPort}/pay/held_999`);
    expect(payRes.status).toBe(200);
    const confirmedHtml = await payRes.text();
    expect(confirmedHtml).toContain('Payment Confirmed');
    expect(confirmedHtml).toContain('Delivered to Frank Relay');
  });

  it('renders payment confirmed page when ?success=true query param is passed', async () => {
    await ledger.holdMessage({
      id: 'held_redirect',
      senderEmail: 'payer@external.com',
      recipientAddress: '0xrecipient',
      dkimDomain: 'external.com',
      subject: 'Hello',
      rawRfc822: new TextEncoder().encode('Body'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600000 * 72,
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/pay/held_redirect?success=true`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Payment Confirmed');
  });

  it('returns 410 Gone when held message has expired', async () => {
    await ledger.holdMessage({
      id: 'held_expired',
      senderEmail: 'old@external.com',
      recipientAddress: '0xrecipient',
      dkimDomain: 'external.com',
      subject: 'Old message',
      rawRfc822: new TextEncoder().encode('Old body'),
      createdAtMs: Date.now() - 3600000 * 73,
      expiresAtMs: Date.now() - 1000,
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/pay/held_expired`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toContain('Message Expired');
  });
});
