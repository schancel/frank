import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
}

/** Public HTTP ingress for Resend signed webhooks and OpenPGP Web Key Directory (WKD) routes. */
export class ResendWebhookHttp {
  private server?: Server;
  private ready = false;
  private readonly wkdHandler?: WkdHttpHandler;

  constructor(private readonly options: ResendWebhookHttpOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
      throw new Error('Invalid Resend webhook port');
    if (!options.host) throw new Error('Resend webhook bind host is required');
    this.wkdHandler =
      options.wkdHandler ?? (options.wkd ? createWkdHttpHandler(options.wkd) : undefined);
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
