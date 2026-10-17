import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import * as crypto from 'node:crypto';
import { CreditLedger } from '../ledger/credit-ledger';
import { GatewayStampProvider } from '../stamps/stamp-provider.interface';
import { parseRawRfc822 } from '../smtp/smtp-listener';
import { OutboundEmailDelivery, OutboundRenderRefusal } from '../mta/outbound-delivery';
import { buildOnboardingDeepLink } from '../secure-link/secure-message-portal';

/**
 * Verifies a Stripe webhook `Stripe-Signature` header (`t=<timestamp>,v1=<hexSig>`)
 * using HMAC-SHA256 and constant-time comparison (`crypto.timingSafeEqual`).
 */
export function verifyStripeWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = signatureHeader.split(',').map((part) => part.trim());
  let timestampStr: string | undefined;
  const v1Signatures: string[] = [];
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 't') timestampStr = val;
    else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(val)) v1Signatures.push(val.toLowerCase());
  }
  if (!timestampStr || !/^[0-9]+$/.test(timestampStr) || v1Signatures.length === 0) {
    return false;
  }
  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (toleranceSeconds > 0 && Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${timestamp}.${payload}`;
  const expectedHex = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  for (const candidateHex of v1Signatures) {
    const candidateBuf = Buffer.from(candidateHex, 'hex');
    if (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Helper to construct a valid `Stripe-Signature` header for signed webhook testing.
 */
export function buildStripeWebhookSignatureHeader(
  rawBody: string | Buffer,
  webhookSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const sig = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestampSeconds}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${sig}`;
}

export interface HeldPaymentViewRecord {
  readonly id: string;
  readonly senderEmail: string;
  readonly recipientAddress: string;
  readonly subject: string;
  readonly status: 'held' | 'released' | 'expired';
  readonly expiresAtMs: number;
  readonly conversationId?: string;
}

export interface StripePaymentVerifiedEvent {
  readonly senderEmail: string;
  readonly tierId: string;
  readonly creditsAdded: number;
  readonly referenceId: string;
  readonly providerTxId: string;
}

export interface CheckoutServerOptions {
  readonly port: number;
  readonly ledger: CreditLedger;
  readonly stampProvider?: GatewayStampProvider;
  readonly stripeWebhookSecret?: string;
  readonly paypalWebhookId?: string;
  readonly outboundDelivery?: OutboundEmailDelivery;
  readonly outboundApiToken?: string;
  readonly stripePaymentLinkTier1?: string;
  readonly stripePaymentLinkTier2?: string;
  readonly stripePaymentLinkTier3?: string;
  readonly frankAppUrl?: string;
  readonly onboardingSecret?: Uint8Array | string;
  readonly findHeldMail?: (tokenOrId: string) => HeldPaymentViewRecord | undefined;
  readonly onPaymentVerified?: (event: StripePaymentVerifiedEvent) => Promise<void> | void;
}

export class CheckoutServer {
  private readonly port: number;
  private readonly ledger: CreditLedger;
  private readonly stampProvider?: GatewayStampProvider;
  private readonly stripeWebhookSecret?: string;
  private readonly outboundDelivery?: OutboundEmailDelivery;
  private readonly outboundApiToken?: string;
  private readonly stripePaymentLinkTier1?: string;
  private readonly stripePaymentLinkTier2?: string;
  private readonly stripePaymentLinkTier3?: string;
  private readonly frankAppUrl: string;
  private readonly onboardingSecret: Uint8Array | string;
  private readonly findHeldMail?: (tokenOrId: string) => HeldPaymentViewRecord | undefined;
  private readonly onPaymentVerified?: (event: StripePaymentVerifiedEvent) => Promise<void> | void;
  private server?: Server;

  constructor(options: CheckoutServerOptions) {
    this.port = options.port;
    this.ledger = options.ledger;
    this.stampProvider = options.stampProvider;
    this.stripeWebhookSecret = options.stripeWebhookSecret;
    this.outboundDelivery = options.outboundDelivery;
    this.outboundApiToken = options.outboundApiToken?.trim() || undefined;
    this.stripePaymentLinkTier1 = options.stripePaymentLinkTier1;
    this.stripePaymentLinkTier2 = options.stripePaymentLinkTier2;
    this.stripePaymentLinkTier3 = options.stripePaymentLinkTier3;
    this.frankAppUrl = (options.frankAppUrl?.trim() || 'https://frank.org').replace(/\/+$/, '');
    this.onboardingSecret =
      options.onboardingSecret instanceof Uint8Array
        ? Buffer.from(options.onboardingSecret)
        : (options.onboardingSecret ?? options.stripeWebhookSecret ?? 'frank-default-onboarding-secret-32b');
    this.findHeldMail = options.findHeldMail;
    this.onPaymentVerified = options.onPaymentVerified;
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
      return this.renderPaymentPage(url.pathname.slice('/pay/'.length), url, res);
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/api/webhooks/stripe' || url.pathname === '/webhooks/stripe')
    ) {
      return this.handleStripeWebhook(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/paypal') {
      return this.handlePaypalWebhook(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/health' && this.stampProvider) {
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

    if (req.method === 'GET' && url.pathname === '/metrics' && this.stampProvider) {
      const health = await this.stampProvider.checkHealth();
      const balance = await this.stampProvider.getBalance();
      const asset = this.stampProvider.assetUnit || 'MON';
      const heldCount = this.ledger.getHeldMessageCount();
      const pendingSpool = this.ledger.getPendingSpoolCount();
      const lines = [
        '# HELP gateway_up Health check status of the mail gateway (1 = up, 0 = down)',
        '# TYPE gateway_up gauge',
        `gateway_up ${health.ok ? 1 : 0}`,
        '# HELP gateway_wallet_balance_wei Hot wallet balance in wei',
        '# TYPE gateway_wallet_balance_wei gauge',
        `gateway_wallet_balance_wei{asset="${asset}"} ${balance.raw.toString()}`,
        '# HELP gateway_wallet_low_balance Flag indicating if wallet balance is low (1 = low, 0 = ok)',
        '# TYPE gateway_wallet_low_balance gauge',
        `gateway_wallet_low_balance ${balance.isLowBalance ? 1 : 0}`,
        '# HELP gateway_held_messages_count Number of inbound emails currently held waiting for payment',
        '# TYPE gateway_held_messages_count gauge',
        `gateway_held_messages_count ${heldCount}`,
        '# HELP gateway_outbound_spool_pending Number of outbound emails in delivery spool',
        '# TYPE gateway_outbound_spool_pending gauge',
        `gateway_outbound_spool_pending ${pendingSpool}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(lines.join('\n') + '\n');
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/api/mail/send' || url.pathname === '/api/v1/outbound')) {
      return this.handleOutboundMailSend(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private verifyOutboundAuthHeader(req: IncomingMessage): boolean {
    if (!this.outboundApiToken) return true;
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];
    let candidate = '';
    if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
      candidate = authHeader.replace(/^Bearer\s+/i, '').trim();
    } else if (typeof apiKeyHeader === 'string') {
      candidate = apiKeyHeader.trim();
    }
    if (!candidate) return false;
    const expectedBuf = Buffer.from(this.outboundApiToken, 'utf8');
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return (
      expectedBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(expectedBuf, candidateBuf)
    );
  }

  private handleOutboundMailSend(req: IncomingMessage, res: ServerResponse): void {
    if (!this.verifyOutboundAuthHeader(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized outbound mail send request' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (!body.recipientEmail || !body.bodyText) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'recipientEmail and bodyText are required' }));
          return;
        }
        if (!this.outboundDelivery) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Outbound delivery service not configured on gateway' }));
          return;
        }
        const deliveryResult = await this.outboundDelivery.processOutboundDirectMessage({
          senderFrankAddress: body.senderFrankAddress || '0xunknown',
          recipientEmail: body.recipientEmail,
          subject: body.subject,
          bodyText: body.bodyText,
          conversationId: body.conversationId || `conv_${Date.now()}`,
          frankMessageId: body.frankMessageId || `msg_${Date.now()}`,
          inReplyToFrankMessageId: body.inReplyToFrankMessageId,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            rfc822MessageId: deliveryResult.rfc822MessageId,
            inReplyToRfc822: deliveryResult.inReplyToRfc822,
            grantedReplyAllowance: deliveryResult.grantedReplyAllowance,
            renderedEmail: deliveryResult.renderedEmail,
          })
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof OutboundRenderRefusal ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    });
  }

  private lookupHeldForView(tokenOrId: string): HeldPaymentViewRecord | undefined {
    const fromLedger = this.ledger.getHeldMessage(tokenOrId);
    if (fromLedger) return fromLedger;
    return this.findHeldMail?.(tokenOrId);
  }

  private renderFreeNativeOnboardingCard(held: HeldPaymentViewRecord): string {
    const conversationId =
      held.conversationId ||
      (() => {
        const participantsKey = [
          held.senderEmail.toLowerCase().trim(),
          held.recipientAddress.toLowerCase().trim(),
        ]
          .sort()
          .join('#');
        const hash = crypto.createHash('sha256').update(participantsKey).digest('hex').slice(0, 32);
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
      })();
    const { url: onboardingUrl } = buildOnboardingDeepLink({
      frankAppUrl: this.frankAppUrl,
      secret: this.onboardingSecret,
      payload: {
        kind: 'pay',
        id: held.id,
        peerAddress: held.recipientAddress,
        email: held.senderEmail,
        conversationId,
        subject: held.subject,
        exp: Math.max(held.expiresAtMs, Date.now() + 72 * 60 * 60 * 1000),
      },
    });
    return `
    <div class="onboarding-card">
      <div class="onboarding-badge-row">
        <span class="pill-free">Free Alternative: Message Directly on Frank</span>
        <span class="pill-e2ee">End-to-End Encrypted</span>
      </div>
      <h2>Skip the email stamp fee!</h2>
      <p>Open a free native Frank account to message <strong>${escapeHtml(held.recipientAddress)}</strong> directly with end-to-end encryption and zero email gateway fees.</p>
      <a class="btn-onboarding" href="${escapeHtml(onboardingUrl)}" rel="noopener noreferrer">Join Frank for Free &amp; Message Directly &rarr;</a>
    </div>`;
  }

  public renderPaymentPageResponse(
    tokenOrId: string,
    searchParams: URLSearchParams,
  ): { status: number; headers: Record<string, string>; body: string } {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    const held = this.lookupHeldForView(tokenOrId);
    if (!held) {
      return {
        status: 404,
        headers,
        body: `<!DOCTYPE html>
<html>
<head><title>Message Not Found — Frank Gateway</title><style>body{font-family:Inter,system-ui,sans-serif;padding:2.5rem;max-width:600px;margin:auto;color:#f8fafc;background:#0f172a;}</style></head>
<body>
  <h1>Message Not Found</h1>
  <p>This message payment link has expired or has already been delivered.</p>
</body>
</html>`,
      };
    }

    if (held.status === 'released' || searchParams.get('success') === 'true') {
      const remainingBalance = this.ledger.getBalance(held.senderEmail);
      return {
        status: 200,
        headers,
        body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Confirmed — Frank Gateway</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; color: #0f172a; background: radial-gradient(circle at 50% 0%, #eff6ff 0%, #f8fafc 75%); padding: 2.5rem 1rem; margin: 0; }
    .shell { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.25rem; }
    .card { background: #ffffff; padding: 2.5rem 2rem; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 12px 32px -4px rgba(15, 23, 42, 0.08); text-align: center; }
    .badge-success { display: inline-flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; background: #dcfce7; color: #16a34a; font-size: 2rem; font-weight: bold; margin-bottom: 1.25rem; }
    h1 { color: #0f172a; margin: 0 0 0.5rem 0; font-size: 1.5rem; }
    h2 { color: #f8fafc; margin: 0.35rem 0; font-size: 1.15rem; }
    p { color: #475569; font-size: 0.95rem; margin: 0.5rem 0; }
    .credit-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 1.25rem; margin: 1.5rem 0; text-align: left; }
    .credit-box-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .credit-box-title { font-weight: 600; color: #1e40af; font-size: 0.95rem; }
    .credit-badge { background: #2563eb; color: #ffffff; padding: 0.25rem 0.7rem; border-radius: 9999px; font-weight: 700; font-size: 0.8rem; }
    .credit-text { color: #1e3a8a; font-size: 0.88rem; margin: 0.35rem 0; line-height: 1.4; }
    .details { background: #f8fafc; border: 1px solid #e2e8f0; padding: 1.25rem; border-radius: 12px; margin: 1.5rem 0; text-align: left; font-size: 0.9rem; }
    .details p { margin: 0.35rem 0; color: #334155; }
    .details strong { color: #0f172a; }
    .onboarding-card { background: linear-gradient(145deg, #1e1b4b 0%, #0f172a 100%); color: #f8fafc; border-radius: 16px; padding: 1.75rem 2rem; border: 1px solid rgba(168, 85, 247, 0.35); box-shadow: 0 12px 28px rgba(15, 23, 42, 0.2); text-align: left; }
    .onboarding-card p { color: #cbd5e1; }
    .onboarding-badge-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
    .pill-free { background: rgba(168, 85, 247, 0.2); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.4); padding: 0.2rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .pill-e2ee { background: rgba(56, 189, 248, 0.16); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.3); padding: 0.2rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .btn-onboarding { display: inline-block; margin-top: 0.5rem; background: linear-gradient(135deg, #9333ea 0%, #4f46e5 100%); color: #ffffff; padding: 0.75rem 1.35rem; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 0.92rem; }
    .footer { font-size: 0.85rem; color: #64748b; margin-top: 1.5rem; }
    .footer a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="badge-success">✓</div>
      <h1>Payment Confirmed</h1>
      <p>Your email has been cryptographically stamped and delivered to <strong>${escapeHtml(held.recipientAddress)}</strong>.</p>
      
      <div class="credit-box">
        <div class="credit-box-header">
          <span class="credit-box-title">Credit Account Balance</span>
          <span class="credit-badge">${remainingBalance} Credit${remainingBalance === 1 ? '' : 's'} Remaining</span>
        </div>
        <p class="credit-text">&bull; <strong>1 credit</strong> was used for this email delivery.</p>
        <p class="credit-text">&bull; Leftover credits (${remainingBalance}) remain tied to <code>${escapeHtml(held.senderEmail)}</code>. Any future emails you send to Frank users will be delivered automatically without having to pay again.</p>
      </div>

      <div class="details">
        <p><strong>From:</strong> ${escapeHtml(held.senderEmail)}</p>
        <p><strong>Subject:</strong> ${escapeHtml(held.subject)}</p>
        <p><strong>Delivery Status:</strong> Delivered to Frank Relay</p>
      </div>
      <p style="font-size: 0.9rem; color: #16a34a; font-weight: 500;">
        A reply allowance has been activated. When the recipient replies, subsequent emails in this thread will be delivered automatically for free.
      </p>
      <div class="footer">
        Powered by Frank Gateway &bull; <a href="${escapeHtml(this.frankAppUrl)}" target="_blank">About Frank</a>
      </div>
    </div>
    ${this.renderFreeNativeOnboardingCard(held)}
  </div>
</body>
</html>`,
      };
    }

    if (held.status === 'expired' || Date.now() > held.expiresAtMs) {
      return {
        status: 410,
        headers,
        body: `<!DOCTYPE html>
<html>
<head><title>Message Expired — Frank Gateway</title><style>body{font-family:Inter,system-ui,sans-serif;padding:2.5rem;max-width:600px;margin:auto;color:#f8fafc;background:#0f172a;}</style></head>
<body>
  <h1>Message Expired</h1>
  <p>This message held duration exceeded its 72-hour TTL and was discarded.</p>
</body>
</html>`,
      };
    }

    const hoursRemaining = Math.max(0, Math.round((held.expiresAtMs - Date.now()) / (1000 * 60 * 60)));
    const tier1Base = this.stripePaymentLinkTier1 || 'https://buy.stripe.com/mock_tier1';
    const tier2Base = this.stripePaymentLinkTier2 || 'https://buy.stripe.com/mock_tier2';
    const tier3Base = this.stripePaymentLinkTier3 || 'https://buy.stripe.com/mock_tier3';
    const tier1Url = `${tier1Base}?client_reference_id=${encodeURIComponent(held.id)}&prefilled_email=${encodeURIComponent(held.senderEmail)}`;
    const tier2Url = `${tier2Base}?client_reference_id=${encodeURIComponent(held.id)}&prefilled_email=${encodeURIComponent(held.senderEmail)}`;
    const tier3Url = `${tier3Base}?client_reference_id=${encodeURIComponent(held.id)}&prefilled_email=${encodeURIComponent(held.senderEmail)}`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deliver Your Email — Frank Gateway</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; color: #0f172a; background: radial-gradient(circle at 50% 0%, #eff6ff 0%, #f8fafc 75%); padding: 2.5rem 1rem; margin: 0; }
    .shell { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.25rem; }
    .card { background: #ffffff; padding: 2.25rem; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 12px 32px -4px rgba(15, 23, 42, 0.08); }
    h1 { font-size: 1.5rem; margin: 0; color: #0f172a; letter-spacing: -0.01em; }
    h2 { font-size: 1.15rem; margin: 0.35rem 0; color: #f8fafc; }
    .badge { display: inline-block; padding: 0.3rem 0.7rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .details { background: #f8fafc; border: 1px solid #e2e8f0; padding: 1.1rem 1.25rem; border-radius: 12px; margin: 1.25rem 0; font-size: 0.9rem; }
    .details p { margin: 0.3rem 0; color: #334155; }
    .explainer { border-left: 4px solid #2563eb; background: #f8fafc; padding: 0.9rem 1.1rem; border-radius: 0 10px 10px 0; margin: 1.25rem 0; font-size: 0.93rem; color: #334155; }
    .credit-info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 1.1rem 1.25rem; margin: 1.25rem 0; font-size: 0.9rem; color: #1e40af; }
    .credit-info strong { color: #1e3a8a; }
    .tier-list { display: grid; gap: 0.9rem; margin: 1.5rem 0; }
    .tier { border: 1px solid #cbd5e1; border-radius: 12px; padding: 1.15rem 1.25rem; display: flex; justify-content: space-between; align-items: center; background: #ffffff; transition: border-color 0.15s ease; }
    .tier:hover { border-color: #2563eb; }
    .tier-title { font-weight: 600; color: #0f172a; font-size: 0.98rem; }
    .tier-price { font-size: 1.25rem; font-weight: 700; color: #2563eb; margin-bottom: 0.25rem; }
    .btn { display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 0.65rem 1.15rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem; text-align: center; border: none; cursor: pointer; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25); }
    .btn:hover { background: #1e40af; }
    .onboarding-card { background: linear-gradient(145deg, #1e1b4b 0%, #0f172a 100%); color: #f8fafc; border-radius: 16px; padding: 1.75rem 2rem; border: 1px solid rgba(168, 85, 247, 0.35); box-shadow: 0 12px 28px rgba(15, 23, 42, 0.2); }
    .onboarding-card p { color: #cbd5e1; font-size: 0.94rem; margin: 0.4rem 0 0.9rem 0; }
    .onboarding-badge-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
    .pill-free { background: rgba(168, 85, 247, 0.2); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.4); padding: 0.2rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .pill-e2ee { background: rgba(56, 189, 248, 0.16); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.3); padding: 0.2rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .btn-onboarding { display: inline-block; background: linear-gradient(135deg, #9333ea 0%, #4f46e5 100%); color: #ffffff; padding: 0.75rem 1.35rem; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 0.92rem; box-shadow: 0 4px 14px rgba(147, 51, 234, 0.35); }
    .footer { text-align: center; margin-top: 1.5rem; font-size: 0.85rem; color: #64748b; }
    .footer a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap: 1rem;">
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

      <div class="credit-info">
        <strong>How credits work:</strong><br>
        Delivering this message will use <strong>1 credit</strong>. Any leftover credits are tied to your email (<code>${escapeHtml(held.senderEmail)}</code>) and can be used to send future emails to any Frank user without having to pay each time. Furthermore, once the recipient replies, subsequent emails in that conversation thread are completely free.
      </div>

      <div class="tier-list">
        <div class="tier">
          <div>
            <div class="tier-title">Single Delivery (1 Credit)</div>
            <div style="font-size:0.8rem; color:#64748b;">Delivers this held message immediately</div>
          </div>
          <div style="text-align:right;">
            <div class="tier-price">$1.00</div>
            <a class="btn" href="${tier1Url}">Pay with Card</a>
          </div>
        </div>

        <div class="tier">
          <div>
            <div class="tier-title">Conversation Pack (5 Credits)</div>
            <div style="font-size:0.8rem; color:#64748b;">1 credit delivers this message &bull; 4 leftover credits for future emails</div>
          </div>
          <div style="text-align:right;">
            <div class="tier-price">$3.00</div>
            <a class="btn" href="${tier2Url}">Pay with Card</a>
          </div>
        </div>

        <div class="tier">
          <div>
            <div class="tier-title">Volume Top-Up (20 Credits)</div>
            <div style="font-size:0.8rem; color:#64748b;">1 credit delivers this message &bull; 19 leftover credits ($0.50/msg)</div>
          </div>
          <div style="text-align:right;">
            <div class="tier-price">$10.00</div>
            <a class="btn" href="${tier3Url}">Pay with Card</a>
          </div>
        </div>
      </div>

      <div class="footer">
        Want to message for free? <a href="${escapeHtml(this.frankAppUrl)}" target="_blank">Download Frank</a> and message ${escapeHtml(held.recipientAddress)} directly.
      </div>
    </div>
    ${this.renderFreeNativeOnboardingCard(held)}
  </div>
</body>
</html>`;

    return { status: 200, headers, body: html };
  }

  private renderPaymentPage(tokenOrId: string, url: URL, res: ServerResponse): void {
    const response = this.renderPaymentPageResponse(tokenOrId, url.searchParams);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  }

  public async handleStripeWebhookPayload(
    rawBody: string,
    signatureHeader?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const jsonHeaders = { 'Content-Type': 'application/json' };
    if (this.stripeWebhookSecret) {
      const valid = verifyStripeWebhookSignature(rawBody, signatureHeader, this.stripeWebhookSecret);
      if (!valid) {
        return {
          status: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: 'Invalid Stripe webhook signature' }),
        };
      }
    }
    try {
      const event = JSON.parse(rawBody);
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'payment_intent.succeeded'
      ) {
        const session = event.data.object;
        const heldMessageId = session.client_reference_id || session.metadata?.heldMessageId;
        const email =
          session.customer_details?.email || session.customer_email || session.metadata?.email;
        const credits = Number(session.metadata?.credits ?? 1);
        const tierId = String(session.metadata?.tierId ?? (credits >= 20 ? 'tier3' : credits >= 5 ? 'tier2' : 'tier1'));

        if (heldMessageId && email) {
          await this.fulfillPurchase({
            providerTxId: session.id,
            provider: 'stripe',
            email,
            credits,
            heldMessageId,
          });
          if (this.onPaymentVerified) {
            await this.onPaymentVerified({
              senderEmail: email,
              tierId,
              creditsAdded: credits,
              referenceId: heldMessageId,
              providerTxId: session.id,
            });
          }
        }
      }

      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ received: true }),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: message }),
      };
    }
  }

  private async handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    const sigHeader =
      typeof req.headers['stripe-signature'] === 'string'
        ? req.headers['stripe-signature']
        : undefined;
    const outcome = await this.handleStripeWebhookPayload(rawBody, sigHeader);
    res.writeHead(outcome.status, outcome.headers);
    res.end(outcome.body);
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
    const held = this.ledger.getHeldMessage(params.heldMessageId);
    const targetEmail = held && held.senderEmail ? held.senderEmail : params.email;

    // 1. Add purchased credits to ledger (idempotent duplicate check handled in addCredits)
    this.ledger.addCredits(targetEmail, params.credits, params.providerTxId, params.provider);

    // If message does not exist or is not held (e.g. already released or expired) or no legacy stampProvider, stop here
    if (!held || held.status !== 'held' || !this.stampProvider) {
      return;
    }

    // 2. Thread resolution for held message
    const resolvedPayload = await this.ledger.resolvePayload(held.rawRfc822);
    const parsed = parseRawRfc822(
      Buffer.from(resolvedPayload, 'utf-8'),
      held.senderEmail,
      held.recipientAddress
    );
    let conversationId: string | undefined;
    let inReplyToFrankMessageId: string | undefined;

    if (parsed.inReplyTo) {
      const parent = this.ledger.getThreadMappingByRfc822Id(parsed.inReplyTo);
      if (parent) {
        conversationId = parent.conversationId;
        inReplyToFrankMessageId = parent.frankMessageId;
      }
    }

    if (!conversationId) {
      const participantsKey = [
        held.senderEmail.toLowerCase().trim(),
        held.recipientAddress.toLowerCase().trim(),
      ]
        .sort()
        .join('#');
      const hash = crypto
        .createHash('sha256')
        .update(participantsKey)
        .digest('hex')
        .slice(0, 32);
      conversationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    }

    // 3. Dispatch stamped direct message to Frank relay.
    // NOTE: We do NOT mark the message as released or deduct credit until relay dispatch
    // has successfully resolved. If dispatch fails, the message remains 'held' and
    // unconsumed credits remain on the sender's account to allow safe retries.
    const emailText = resolvedPayload;
    const sendResult = await this.stampProvider.stampAndSendDirectMessage({
      recipientAddress: held.recipientAddress,
      text: `[Email from ${held.senderEmail}]\nSubject: ${held.subject}\n\n${emailText}`,
      conversationId,
      inReplyToFrankMessageId,
    });

    // 4. Mark held message as released now that delivery is confirmed
    this.ledger.releaseHeldMessage(held.id);

    // 5. Deduct 1 credit for delivering the held email
    this.ledger.consumeCredit(held.senderEmail, held.recipientAddress);

    // 6. Record thread mapping
    const frankMsgId =
      sendResult.txHash ||
      `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.ledger.recordThreadMapping({
      conversationId,
      frankMessageId: frankMsgId,
      rfc822MessageId: parsed.messageId,
      inReplyToRfc822: parsed.inReplyTo,
      subject: held.subject,
      createdAtMs: Date.now(),
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
