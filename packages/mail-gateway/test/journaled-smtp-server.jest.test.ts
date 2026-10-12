import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { JournaledSmtpIngress, JournaledSmtpServer } from '../src/smtp/journaled-smtp-ingress';

describe('actual TLS SMTP listener and durable admission responses', () => {
  let directory: string;
  let server: JournaledSmtpServer | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'frank-mail-smtp-')); });
  afterEach(async () => {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  function tls(): { tlsKey: Buffer; tlsCert: Buffer } {
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    return { tlsKey: readFileSync(key), tlsCert: readFileSync(cert) };
  }

  async function send(port: number) {
    const client = nodemailer.createTransport({
      host: '127.0.0.1', port, secure: false, requireTLS: true,
      tls: { rejectUnauthorized: false },
    });
    try {
      return await client.sendMail({
        from: 'Alice <alice@example.org>', to: 'one@signet.mx',
        subject: 'Test', text: 'Hello',
      });
    } finally {
      client.close();
    }
  }

  it('returns 250 only after admission, temporarily refuses failures, and restarts cleanly', async () => {
    const admit = jest.fn(() => ({ kind: 'held' as const }));
    const ingress = new JournaledSmtpIngress({
      gatewayDomain: 'signet.mx',
      issuedMailboxLookup: async () => ({ accountAddress: `0x${'1'.repeat(40)}`, conversationId: 'issued' }),
      sender: { admit }, stampValue: 1n,
      authentication: { authenticatedAuthor: async () => 'alice@example.org' },
    });
    const certificate = tls();
    server = new JournaledSmtpServer({ ingress, hostname: 'localhost', ...certificate });
    await server.start(0, '127.0.0.1');
    const port = server.address().port;
    const delivered = await send(port);
    expect(delivered.response).toMatch(/^250 /);
    expect(admit).toHaveBeenCalledTimes(1);

    admit.mockReturnValueOnce({ kind: 'refused' } as never);
    await expect(send(port)).rejects.toMatchObject({ responseCode: 451 });
    expect(admit).toHaveBeenCalledTimes(2);

    server.setReady(false);
    await expect(send(port)).rejects.toMatchObject({ responseCode: 451 });
    expect(admit).toHaveBeenCalledTimes(2);
    await server.stop();
    server = new JournaledSmtpServer({ ingress, hostname: 'localhost', ...certificate });
    await server.start(port, '127.0.0.1');
    expect((await send(port)).response).toMatch(/^250 /);
    expect(admit).toHaveBeenCalledTimes(3);
  });
});
