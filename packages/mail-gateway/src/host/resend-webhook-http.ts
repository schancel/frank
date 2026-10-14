import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CheckoutServer } from '../http/checkout-server';
import type { SecureMessagePortal } from '../secure-link/secure-message-portal';
import { handleResendWebhookRequest, type ResendInboundWebhook } from '../smtp/resend-inbound-webhook';
import {
  createWkdHttpHandler,
  type WkdHttpHandler,
  type WkdHttpHandlerOptions,
} from '../wkd/wkd';

const MAX_BODY_BYTES = 64 * 1024;

export interface ResendWebhookHttpOptions {
  readonly importer: ResendInboundWebhook;
  readonly port: number;
  readonly host: string;
  readonly wkdHandler?: WkdHttpHandler;
  readonly wkd?: WkdHttpHandlerOptions;
  readonly securePortal?: SecureMessagePortal;
  readonly checkoutServer?: CheckoutServer;
  readonly relayUrl?: string;
  readonly mailGatewayDomain?: string;
  readonly network?: string;
}

/** Public HTTP ingress for Resend signed webhooks, OpenPGP WKD routes, Secure Message Portal links, Stripe payment webhooks, and domain discovery. */
export class ResendWebhookHttp {
  private server?: Server;
  private ready = false;
  private readonly wkdHandler?: WkdHttpHandler;
  private readonly securePortal?: SecureMessagePortal;
  private readonly checkoutServer?: CheckoutServer;

  constructor(private readonly options: ResendWebhookHttpOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
      throw new Error('Invalid Resend webhook port');
    if (!options.host) throw new Error('Resend webhook bind host is required');
    this.wkdHandler =
      options.wkdHandler ?? (options.wkd ? createWkdHttpHandler(options.wkd) : undefined);
    this.securePortal = options.securePortal;
    this.checkoutServer = options.checkoutServer;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Resend webhook HTTP server already started');
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port, this.options.host, resolve);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    this.server = server;
    this.ready = true;
  }

  address(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('Resend webhook HTTP server is not listening');
    return `http://${this.options.host}:${address.port}`;
  }

  /** Recovery failure withdraws readiness while ingress remains retryable. */
  setReady(ready: boolean): void {
    this.ready = ready && this.server !== undefined;
  }

  async stop(): Promise<void> {
    this.ready = false;
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  private async handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    if (incoming.url === '/healthz' && incoming.method === 'GET') {
      incoming.resume();
      outgoing.writeHead(this.ready ? 200 : 503).end();
      return;
    }
    if (incoming.url === '/.well-known/cashweb.json') {
      incoming.resume();
      if (incoming.method === 'OPTIONS') {
        outgoing.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'cache-control': 'public, max-age=3600',
        }).end();
        return;
      }
      if (incoming.method !== 'GET') {
        outgoing.writeHead(405, {
          'access-control-allow-origin': '*',
        }).end();
        return;
      }
      const mailGateway =
        this.options.mailGatewayDomain ??
        (this.options.importer as { readonly gatewayDomain?: string } | undefined)?.gatewayDomain;
      const relay =
        this.options.relayUrl ??
        (mailGateway ? `https://relay.${mailGateway}` : this.address());
      const network = this.options.network ?? 'monad-testnet';
      const body = JSON.stringify({
        version: 1,
        relay,
        ...(mailGateway ? { mail_gateway: mailGateway } : {}),
        network,
      });
      outgoing.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
      }).end(body);
      return;
    }
    if (this.wkdHandler && incoming.url && incoming.url.startsWith('/.well-known/openpgpkey/')) {
      incoming.resume();
      const parsedUrl = new URL(incoming.url, 'https://mail-gateway.invalid');
      const wkdResult = await this.wkdHandler({
        pathname: parsedUrl.pathname,
        searchParams: parsedUrl.searchParams,
        method: incoming.method ?? 'GET',
      });
      if (wkdResult) {
        outgoing.writeHead(wkdResult.status, wkdResult.headers);
        outgoing.end(wkdResult.body);
        return;
      }
    }
    if (
      this.securePortal &&
      incoming.url &&
      (incoming.url.startsWith('/secure/') || incoming.url.startsWith('/onboard/claim/'))
    ) {
      const parsedUrl = new URL(incoming.url, 'https://mail-gateway.invalid');
      let bodyText = '';
      if (incoming.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_BODY_BYTES) {
            incoming.resume();
            outgoing.writeHead(413).end();
            return;
          }
          chunks.push(bytes);
        }
        bodyText = Buffer.concat(chunks, size).toString('utf8');
      } else {
        incoming.resume();
      }
      const portalResult = await this.securePortal.handleHttpRequest({
        pathname: parsedUrl.pathname,
        method: incoming.method ?? 'GET',
        body: bodyText,
      });
      if (portalResult) {
        outgoing.writeHead(portalResult.status, portalResult.headers);
        outgoing.end(portalResult.body);
        return;
      }
    }
    if (this.checkoutServer && incoming.url) {
      const parsedUrl = new URL(incoming.url, 'https://mail-gateway.invalid');
      if (incoming.method === 'GET' && parsedUrl.pathname.startsWith('/pay/')) {
        incoming.resume();
        const tokenOrId = parsedUrl.pathname.slice('/pay/'.length);
        const page = this.checkoutServer.renderPaymentPageResponse(
          tokenOrId,
          parsedUrl.searchParams,
        );
        outgoing.writeHead(page.status, page.headers);
        outgoing.end(page.body);
        return;
      }
      if (
        incoming.method === 'POST' &&
        (parsedUrl.pathname === '/webhooks/stripe' ||
          parsedUrl.pathname === '/api/webhooks/stripe')
      ) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_BODY_BYTES) {
            incoming.resume();
            outgoing.writeHead(413).end();
            return;
          }
          chunks.push(bytes);
        }
        const rawBody = Buffer.concat(chunks, size).toString('utf8');
        const sigHeader =
          typeof incoming.headers['stripe-signature'] === 'string'
            ? incoming.headers['stripe-signature']
            : undefined;
        const stripeResult = await this.checkoutServer.handleStripeWebhookPayload(
          rawBody,
          sigHeader,
        );
        outgoing.writeHead(stripeResult.status, stripeResult.headers);
        outgoing.end(stripeResult.body);
        return;
      }
    }
    if (incoming.url !== '/webhooks/resend') {
      incoming.resume();
      outgoing.writeHead(404).end();
      return;
    }
    if (incoming.method !== 'POST') {
      incoming.resume();
      outgoing.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        incoming.resume();
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach(part => headers.append(name, part));
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request('https://mail-gateway.invalid/webhooks/resend', {
      method: 'POST', headers, body: Buffer.concat(chunks, size),
    });
    const result = await handleResendWebhookRequest(request, this.options.importer);
    outgoing.writeHead(result.status).end();
  }
}
