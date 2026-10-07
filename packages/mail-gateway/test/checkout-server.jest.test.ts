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
  public shouldFailSend: boolean = false;

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
    if (this.shouldFailSend) {
      throw new Error('Relay connection dropped');
    }
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
    expect(html).toContain('How credits work:');
    expect(html).toContain('Delivering this message will use <strong>1 credit</strong>');
    expect(html).toContain('Conversation Pack (5 Credits)');
    expect(html).toContain('Volume Top-Up (20 Credits)');
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

    // 4. Visiting payment URL after fulfillment shows confirmed delivery page with remaining balance
    const payRes = await fetch(`http://127.0.0.1:${testPort}/pay/held_999`);
    expect(payRes.status).toBe(200);
    const confirmedHtml = await payRes.text();
    expect(confirmedHtml).toContain('Payment Confirmed');
    expect(confirmedHtml).toContain('Delivered to Frank Relay');
    expect(confirmedHtml).toContain('Credit Account Balance');
    expect(confirmedHtml).toContain('4 Credits Remaining');
    expect(confirmedHtml).toContain('1 credit');
    expect(confirmedHtml).toContain('Leftover credits (4) remain tied to <code>recruiter@hiring.com</code>');
  });

  it('does not release held message and does not consume credits if relay delivery fails, and succeeds on retry', async () => {
    await ledger.holdMessage({
      id: 'held_transient',
      senderEmail: 'author@research.org',
      recipientAddress: '0xpeer',
      dkimDomain: 'research.org',
      subject: 'Paper Draft',
      rawRfc822: new TextEncoder().encode('Please review section 3'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600000 * 72,
    });

    // Simulate transient relay failure
    stampProvider.shouldFailSend = true;

    // Fulfill purchase should fail when relay is down
    await expect(
      server.fulfillPurchase({
        providerTxId: 'cs_fail_1',
        provider: 'stripe',
        email: 'author@research.org',
        credits: 5,
        heldMessageId: 'held_transient',
      })
    ).rejects.toThrow('Relay connection dropped');

    // 1. Held message is NOT released
    const heldStill = ledger.getHeldMessage('held_transient');
    expect(heldStill?.status).toBe('held');

    // 2. Purchased credits (5) remain intact in balance because delivery was NOT completed
    expect(ledger.getBalance('author@research.org')).toBe(5);

    // Now simulate relay recovery
    stampProvider.shouldFailSend = false;

    // Webhook retry arrives with same providerTxId
    await server.fulfillPurchase({
      providerTxId: 'cs_fail_1',
      provider: 'stripe',
      email: 'author@research.org',
      credits: 5,
      heldMessageId: 'held_transient',
    });

    // 3. Now message is released
    const heldReleased = ledger.getHeldMessage('held_transient');
    expect(heldReleased?.status).toBe('released');

    // 4. Exactly 1 credit consumed for delivery (5 - 1 = 4 remaining)
    expect(ledger.getBalance('author@research.org')).toBe(4);
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].text).toContain('Paper Draft');
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
