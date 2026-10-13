import { ResendWebhookHttp } from '../src/host/resend-webhook-http';
import type { ResendInboundWebhook } from '../src/smtp/resend-inbound-webhook';

describe('journaled Resend HTTP host', () => {
  it('acknowledges only the signed webhook path after the importer returns', async () => {
    const handle = jest.fn(async () => ({ kind: 'admitted' as const, admissions: [] }));
    const server = new ResendWebhookHttp({
      importer: { handle } as unknown as ResendInboundWebhook,
      port: 0,
      host: '127.0.0.1',
    });
    await server.start();
    try {
      const base = server.address();
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      server.setReady(false);
      expect((await fetch(`${base}/healthz`)).status).toBe(503);
      server.setReady(true);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/other`, { method: 'POST', body: 'event' })).status).toBe(404);
      expect((await fetch(`${base}/webhooks/resend`, { method: 'GET' })).status).toBe(405);
      const headers = { 'svix-id': 'e1', 'svix-timestamp': '1', 'svix-signature': 'signature' };
      expect((await fetch(`${base}/webhooks/resend`, { method: 'POST', headers, body: 'signed body' })).status).toBe(204);
      expect(handle).toHaveBeenCalledWith('signed body', {
        id: 'e1', timestamp: '1', signature: 'signature',
      });
      handle.mockRejectedValueOnce(new Error('journal unavailable'));
      expect((await fetch(`${base}/webhooks/resend`, { method: 'POST', headers, body: 'retry' })).status).toBe(503);
      expect((await fetch(`${base}/webhooks/resend`, { method: 'POST', headers,
        body: 'x'.repeat(65 * 1024) })).status).toBe(413);
    } finally {
      await server.stop();
    }
  });

  it('serves GET /.well-known/cashweb.json with CORS and Cache-Control headers', async () => {
    const handle = jest.fn(async () => ({ kind: 'admitted' as const, admissions: [] }));
    const server = new ResendWebhookHttp({
      importer: { handle } as unknown as ResendInboundWebhook,
      port: 0,
      host: '127.0.0.1',
      relayUrl: 'https://relay.signet.mx',
      mailGatewayDomain: 'signet.mx',
      network: 'monad-testnet',
    });
    await server.start();
    try {
      const base = server.address();
      const response = await fetch(`${base}/.well-known/cashweb.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await response.json()).toEqual({
        version: 1,
        relay: 'https://relay.signet.mx',
        mail_gateway: 'signet.mx',
        network: 'monad-testnet',
      });

      const optionsResp = await fetch(`${base}/.well-known/cashweb.json`, { method: 'OPTIONS' });
      expect(optionsResp.status).toBe(204);
      expect(optionsResp.headers.get('access-control-allow-origin')).toBe('*');

      const postResp = await fetch(`${base}/.well-known/cashweb.json`, { method: 'POST' });
      expect(postResp.status).toBe(405);
    } finally {
      await server.stop();
    }
  });
});
