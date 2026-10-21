import {
  buildStripeWebhookSignatureHeader,
  CheckoutServer,
  type VerifiedCheckoutPayment,
} from '../src/http/checkout-server';
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

const WEBHOOK_SECRET = 'whsec_checkout_test';

function paidSessionEvent(overrides: {
  eventId?: string;
  type?: string;
  amountTotal?: number;
  currency?: string;
  paymentStatus?: string;
  clientReferenceId?: string;
  email?: string;
  metadata?: Record<string, string>;
} = {}): string {
  return JSON.stringify({
    id: overrides.eventId ?? 'evt_test_1',
    type: overrides.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: overrides.paymentStatus ?? 'paid',
        amount_total: overrides.amountTotal ?? 300,
        currency: overrides.currency ?? 'usd',
        client_reference_id: overrides.clientReferenceId ?? 'held_1',
        customer_details: { email: overrides.email ?? 'payer@external.com' },
        ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
      },
    },
  });
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
      stripeWebhookSecret: WEBHOOK_SECRET,
      stripePaymentLinkTier1: 'https://buy.stripe.com/test_tier1',
      stripePaymentLinkTier2: 'https://buy.stripe.com/test_tier2',
      stripePaymentLinkTier3: 'https://buy.stripe.com/test_tier3',
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

    const body = paidSessionEvent({
      eventId: 'evt_test_123456',
      amountTotal: 300,
      clientReferenceId: 'held_999',
      email: 'recruiter@hiring.com',
      metadata: { credits: '1000000' },
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': buildStripeWebhookSignatureHeader(body, WEBHOOK_SECRET),
      },
      body,
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

  it('does not show payment confirmation for an unverified ?success=true redirect', async () => {
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
    expect(html).not.toContain('Payment Confirmed');
    expect(html).toContain('Waiting for Payment Confirmation');
    expect(ledger.getHeldMessage('held_redirect')?.status).toBe('held');
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

describe('CheckoutServer Stripe webhook fails closed (BOT-3)', () => {
  const holdLegacy = (ledger: CreditLedger, id: string) =>
    ledger.holdMessage({
      id,
      senderEmail: 'sender@external.com',
      recipientAddress: '0xrecipient',
      dkimDomain: 'external.com',
      subject: 'Held',
      rawRfc822: new TextEncoder().encode('Body'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 3600000 * 72,
    });

  it('answers 503 and credits nothing when no webhook secret is configured', async () => {
    const ledger = new CreditLedger(':memory:');
    const fulfilled: VerifiedCheckoutPayment[] = [];
    const server = new CheckoutServer({
      port: 0,
      ledger,
      fulfillPayment: async (payment) => { fulfilled.push(payment); },
    });
    const forged = paidSessionEvent({
      clientReferenceId: 'anything',
      email: 'attacker@evil.test',
      metadata: { credits: '1000000' },
    });
    const result = await server.handleStripeWebhookPayload(forged, undefined);
    expect(result.status).toBe(503);
    expect(fulfilled).toEqual([]);
    expect(ledger.getBalance('attacker@evil.test')).toBe(0);
  });

  it('rejects a missing or wrong signature with 400', async () => {
    const ledger = new CreditLedger(':memory:');
    const fulfilled: VerifiedCheckoutPayment[] = [];
    const server = new CheckoutServer({
      port: 0,
      ledger,
      stripeWebhookSecret: WEBHOOK_SECRET,
      fulfillPayment: async (payment) => { fulfilled.push(payment); },
    });
    const body = paidSessionEvent();
    expect((await server.handleStripeWebhookPayload(body, undefined)).status).toBe(400);
    expect(
      (await server.handleStripeWebhookPayload(body, buildStripeWebhookSignatureHeader(body, 'whsec_other'))).status,
    ).toBe(400);
    expect(fulfilled).toEqual([]);
  });

  it('takes credits from the server tier table by charged amount, never from metadata', async () => {
    const ledger = new CreditLedger(':memory:');
    const fulfilled: VerifiedCheckoutPayment[] = [];
    const server = new CheckoutServer({
      port: 0,
      ledger,
      stripeWebhookSecret: WEBHOOK_SECRET,
      fulfillPayment: async (payment) => { fulfilled.push(payment); },
    });
    const send = (body: string) =>
      server.handleStripeWebhookPayload(body, buildStripeWebhookSignatureHeader(body, WEBHOOK_SECRET));

    expect((await send(paidSessionEvent({ eventId: 'evt_a', amountTotal: 100, metadata: { credits: '1000000' } }))).status).toBe(200);
    expect((await send(paidSessionEvent({ eventId: 'evt_b', amountTotal: 1000, currency: 'USD' }))).status).toBe(200);
    // Unknown amount, wrong currency, unpaid session and other event types fulfil nothing.
    expect((await send(paidSessionEvent({ eventId: 'evt_c', amountTotal: 1 }))).status).toBe(200);
    expect((await send(paidSessionEvent({ eventId: 'evt_d', amountTotal: 100, currency: 'eur' }))).status).toBe(200);
    expect((await send(paidSessionEvent({ eventId: 'evt_e', paymentStatus: 'unpaid' }))).status).toBe(200);
    expect((await send(paidSessionEvent({ eventId: 'evt_f', type: 'payment_intent.succeeded' }))).status).toBe(200);

    expect(fulfilled.map((p) => [p.providerTxId, p.tierId, p.credits])).toEqual([
      ['evt_a', 'tier1', 1],
      ['evt_b', 'tier3', 20],
    ]);
  });

  it('answers 500 when fulfilment fails so Stripe redelivers', async () => {
    const ledger = new CreditLedger(':memory:');
    const server = new CheckoutServer({
      port: 0,
      ledger,
      stripeWebhookSecret: WEBHOOK_SECRET,
      fulfillPayment: async () => { throw new Error('journal busy'); },
    });
    const body = paidSessionEvent();
    const result = await server.handleStripeWebhookPayload(body, buildStripeWebhookSignatureHeader(body, WEBHOOK_SECRET));
    expect(result.status).toBe(500);
  });

  it('credits a redelivered event once (idempotent by event id)', async () => {
    const ledger = new CreditLedger(':memory:');
    await holdLegacy(ledger, 'held_dup');
    const server = new CheckoutServer({ port: 0, ledger, stripeWebhookSecret: WEBHOOK_SECRET });
    const body = paidSessionEvent({ eventId: 'evt_dup', amountTotal: 1000, clientReferenceId: 'held_dup' });
    const header = buildStripeWebhookSignatureHeader(body, WEBHOOK_SECRET);
    expect((await server.handleStripeWebhookPayload(body, header)).status).toBe(200);
    expect((await server.handleStripeWebhookPayload(body, header)).status).toBe(200);
    expect(ledger.getBalance('sender@external.com')).toBe(20);
  });

  it('offers no card payment and no placeholder links unless links and webhook secret are configured', async () => {
    const ledger = new CreditLedger(':memory:');
    await holdLegacy(ledger, 'held_links');
    const noLinks = new CheckoutServer({ port: 0, ledger, stripeWebhookSecret: WEBHOOK_SECRET });
    const page = noLinks.renderPaymentPageResponse('held_links', new URLSearchParams());
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('buy.stripe.com');
    expect(page.body).not.toContain('Pay with Card');
    expect(page.body).toContain('Card payment is not available on this gateway.');

    const linksWithoutSecret = new CheckoutServer({
      port: 0,
      ledger,
      stripePaymentLinkTier1: 'https://buy.stripe.com/test_tier1',
    });
    const unverifiable = linksWithoutSecret.renderPaymentPageResponse('held_links', new URLSearchParams());
    expect(unverifiable.body).not.toContain('Pay with Card');

    const oneLink = new CheckoutServer({
      port: 0,
      ledger,
      stripeWebhookSecret: WEBHOOK_SECRET,
      stripePaymentLinkTier2: 'https://buy.stripe.com/test_tier2',
    });
    const partial = oneLink.renderPaymentPageResponse('held_links', new URLSearchParams());
    expect(partial.body).toContain('https://buy.stripe.com/test_tier2?client_reference_id=held_links');
    expect(partial.body).toContain('Conversation Pack (5 Credits)');
    expect(partial.body).not.toContain('Single Delivery (1 Credit)');
  });
});
