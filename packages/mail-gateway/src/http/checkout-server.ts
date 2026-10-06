import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { CreditLedger } from '../ledger/credit-ledger';
import { GatewayStampProvider } from '../stamps/stamp-provider.interface';

export interface CheckoutServerOptions {
  readonly port: number;
  readonly ledger: CreditLedger;
  readonly stampProvider: GatewayStampProvider;
  readonly stripeWebhookSecret?: string;
  readonly paypalWebhookId?: string;
}

export class CheckoutServer {
  private readonly port: number;
  private readonly ledger: CreditLedger;
  private readonly stampProvider: GatewayStampProvider;
  private server?: Server;

  constructor(options: CheckoutServerOptions) {
    this.port = options.port;
    this.ledger = options.ledger;
    this.stampProvider = options.stampProvider;
  }

  start(host: string = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, host, () => {
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    const address = this.server?.address();
    if (address && typeof address === 'object') {
      return address.port;
    }
    return this.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname.startsWith('/pay/')) {
      return this.renderPaymentPage(url.pathname.slice('/pay/'.length), res);
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
      return this.handleStripeWebhook(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/paypal') {
      return this.handlePaypalWebhook(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const health = await this.stampProvider.checkHealth();
      const balance = await this.stampProvider.getBalance();
      const serializedBalance = {
        raw: balance.raw.toString(),
        display: balance.display,
        isLowBalance: balance.isLowBalance,
      };
      res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ health, balance: serializedBalance }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private renderPaymentPage(tokenOrId: string, res: ServerResponse): void {
    const held = this.ledger.getHeldMessage(tokenOrId);
    if (!held) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Message Not Found — Frank Gateway</title><style>body{font-family:system-ui,sans-serif;padding:2rem;max-width:600px;margin:auto;color:#222;}</style></head>
        <body>
          <h1>Message Not Found</h1>
          <p>This message payment link has expired or has already been delivered.</p>
        </body>
        </html>
      `);
      return;
    }

    const hoursRemaining = Math.max(0, Math.round((held.expiresAtMs - Date.now()) / (1000 * 60 * 60)));

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deliver Your Email — Frank Gateway</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1a1a1a; background: #f8fafc; padding: 2rem 1rem; margin: 0; }
    .card { background: #ffffff; max-width: 600px; margin: 0 auto; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1); }
    h1 { font-size: 1.5rem; margin-top: 0; color: #0f172a; }
    .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; background: #fef3c7; color: #92400e; }
    .details { background: #f1f5f9; padding: 1rem; border-radius: 8px; margin: 1.5rem 0; font-size: 0.9rem; }
    .details p { margin: 0.25rem 0; }
    .explainer { border-left: 4px solid #3b82f6; padding-left: 1rem; margin: 1.5rem 0; font-size: 0.95rem; color: #334155; }
    .tier-list { display: grid; gap: 1rem; margin: 1.5rem 0; }
    .tier { border: 1px solid #cbd5e1; border-radius: 8px; padding: 1rem; display: flex; justify-content: space-between; align-items: center; }
    .tier-title { font-weight: 600; color: #0f172a; }
    .tier-price { font-size: 1.25rem; font-weight: 700; color: #2563eb; }
    .btn { display: inline-block; background: #2563eb; color: white; padding: 0.75rem 1.25rem; border-radius: 6px; text-decoration: none; font-weight: 600; text-align: center; border: none; cursor: pointer; }
    .btn:hover { background: #1d4ed8; }
    .btn-paypal { background: #ffc439; color: #111; }
    .btn-paypal:hover { background: #f4b628; }
    .footer { text-align: center; margin-top: 2rem; font-size: 0.85rem; color: #64748b; }
    .footer a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h1>Deliver Your Message</h1>
      <span class="badge">Held: ${hoursRemaining}h remaining</span>
    </div>

    <div class="explainer">
      <strong>Why is payment required?</strong><br>
      The recipient uses <strong>Frank</strong>, a private messaging network. Instead of intrusive corporate spam filters that scan your private correspondence or sell ads, Frank protects users through a cryptographic attention stamp.
    </div>

    <div class="details">
      <p><strong>From:</strong> ${escapeHtml(held.senderEmail)}</p>
      <p><strong>To:</strong> ${escapeHtml(held.recipientAddress)}</p>
      <p><strong>Subject:</strong> ${escapeHtml(held.subject)}</p>
    </div>

    <p style="font-size:0.9rem; color:#475569;">
      Choose a credit tier below to stamp and deliver this message. When the recipient replies to your email, subsequent messages in this thread are credited automatically.
    </p>

    <div class="tier-list">
      <div class="tier">
        <div>
          <div class="tier-title">Single Delivery</div>
          <div style="font-size:0.8rem; color:#64748b;">Delivers this held message immediately</div>
        </div>
        <div style="text-align:right;">
          <div class="tier-price">$1.00</div>
          <a class="btn" href="https://buy.stripe.com/mock_tier1?client_reference_id=${encodeURIComponent(held.id)}&prefilled_email=${encodeURIComponent(held.senderEmail)}">Pay with Card</a>
        </div>
      </div>

      <div class="tier">
        <div>
          <div class="tier-title">Conversation Pack (5 Credits)</div>
          <div style="font-size:0.8rem; color:#64748b;">Delivers this message + 4 future messages</div>
        </div>
        <div style="text-align:right;">
          <div class="tier-price">$3.00</div>
          <a class="btn" href="https://buy.stripe.com/mock_tier2?client_reference_id=${encodeURIComponent(held.id)}&prefilled_email=${encodeURIComponent(held.senderEmail)}">Pay with Card</a>
        </div>
      </div>
    </div>

    <div class="footer">
      Want to message for free? <a href="https://frank.org" target="_blank">Download Frank</a> and message ${escapeHtml(held.recipientAddress)} directly.
    </div>
  </div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private async handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    try {
      const event = JSON.parse(rawBody);
      // Fulfill checkout session or payment intent
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'payment_intent.succeeded'
      ) {
        const session = event.data.object;
        const heldMessageId = session.client_reference_id || session.metadata?.heldMessageId;
        const email =
          session.customer_details?.email || session.customer_email || session.metadata?.email;
        const credits = Number(session.metadata?.credits ?? 1);

        if (heldMessageId && email) {
          await this.fulfillPurchase({
            providerTxId: session.id,
            provider: 'stripe',
            email,
            credits,
            heldMessageId,
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async handlePaypalWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    try {
      const event = JSON.parse(rawBody);
      if (
        event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ||
        event.event_type === 'CHECKOUT.ORDER.APPROVED'
      ) {
        const resource = event.resource;
        const heldMessageId = resource.custom_id;
        const email = resource.payer?.email_address;
        const credits = Number(resource.custom_metadata?.credits ?? 1);

        if (heldMessageId && email) {
          await this.fulfillPurchase({
            providerTxId: resource.id,
            provider: 'paypal',
            email,
            credits,
            heldMessageId,
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  async fulfillPurchase(params: {
    providerTxId: string;
    provider: string;
    email: string;
    credits: number;
    heldMessageId: string;
  }): Promise<void> {
    // 1. Add purchased credits to ledger
    this.ledger.addCredits(params.email, params.credits, params.providerTxId, params.provider);

    // 2. Release held message
    const held = this.ledger.releaseHeldMessage(params.heldMessageId);
    if (!held) return;

    // 3. Deduct credit for this release
    this.ledger.consumeCredit(held.senderEmail, held.recipientAddress);

    // 4. Dispatch stamped direct message to Frank relay
    const emailText = new TextDecoder().decode(held.rawRfc822);
    await this.stampProvider.stampAndSendDirectMessage({
      recipientAddress: held.recipientAddress,
      text: `[Email from ${held.senderEmail}]\nSubject: ${held.subject}\n\n${emailText}`,
    });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
