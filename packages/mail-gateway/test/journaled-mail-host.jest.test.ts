import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import { createJournaledMailHost } from '../src/host/journaled-mail-host';
import { buildStripeWebhookSignatureHeader } from '../src/http/checkout-server';
import { mailKey } from '../src/rfc/mail-keys';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';

const GATEWAY = `0x${'9'.repeat(40)}`;

describe('journaled mail host admission', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-host-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const options = (dir: string, journalMode: 'existing' | 'provision') => ({
    chain: { chainIdentifier: 'monad-testnet' } as ActiveChain,
    wallet: { identity: { address: { raw: GATEWAY } } } as WalletHandle,
    journalFile: path.join(dir, 'mail.sqlite3'),
    blobDirectory: path.join(dir, 'blobs'),
    journalMode,
    gatewayDomain: 'signet.mx',
    mailboxSalt: new Uint8Array(32).fill(7),
    resendApiKey: 're_test',
    resendWebhookSecret: 'whsec_test',
    resendRawOrigins: ['https://raw.example.test'],
    inboundStampValue: 1000n,
    webhookHost: '127.0.0.1',
    webhookPort: 0,
  });

  it('requires explicit provisioning, then reopens only the original journal identity and format', async () => {
    expect(() => createJournaledMailHost(options(dir, 'existing'))).toThrow('Existing mail journal is missing');
    const first = createJournaledMailHost(options(dir, 'provision'));
    expect(first.journal.chainIdentifier).toBe('monad-testnet');
    await first.close();
    expect(() => createJournaledMailHost(options(dir, 'provision'))).toThrow('already exists');
    const reopened = createJournaledMailHost(options(dir, 'existing'));
    await reopened.close();
    expect(() => createJournaledMailHost({ ...options(dir, 'existing'),
      gatewayDomain: 'other.example',
    })).toThrow('identity or format differs');
    expect(() => createJournaledMailHost({ ...options(dir, 'existing'),
      wallet: { identity: { address: { raw: `0x${'8'.repeat(40)}` } } } as WalletHandle,
    })).toThrow('identity or format differs');
  });

  it('a verified Stripe payment releases the paid-for held mail and no other (BOT-8)', async () => {
    const recipient = `0x${'a'.repeat(40)}`;
    const host = createJournaledMailHost({
      ...options(dir, 'provision'),
      chain: {
        chainIdentifier: 'monad-testnet',
        parseAddress: (input: string) => (/^0x[0-9a-f]{40}$/.test(input) ? { raw: input } : undefined),
      } as unknown as ActiveChain,
      stripeWebhookSecret: 'whsec_stripe_test',
    });
    try {
      const mail = (from: string, id: string) => Buffer.from(
        `From: <${from}>\r\nTo: ${recipient}@signet.mx\r\nMessage-ID: <${id}@mail.example>\r\nSubject: ${id}\r\n\r\nBody ${id}`,
        'utf8',
      );
      const paidFor = mail('carol@mail.example', 'paid');
      const other = mail('dave@mail.example', 'other');
      for (const [raw, from] of [[paidFor, 'carol@mail.example'], [other, 'dave@mail.example']] as const) {
        expect(host.inbound.admit(
          { email: parseRawRfc822(raw), verifiedTransportId: `t:${from}`, authenticatedSenderEmail: from },
          recipient,
          1000n,
        )).toEqual({ kind: 'held' });
      }
      const event = JSON.stringify({
        id: 'evt_host_1',
        type: 'checkout.session.completed',
        data: { object: {
          payment_status: 'paid', amount_total: 100, currency: 'usd',
          client_reference_id: mailKey(paidFor),
          customer_details: { email: 'typed@elsewhere.example' },
        } },
      });
      const result = await host.checkoutServer.handleStripeWebhookPayload(
        event, buildStripeWebhookSignatureHeader(event, 'whsec_stripe_test'),
      );
      expect(result.status).toBe(200);
      expect(host.journal.findInboundEmail(recipient, mailKey(paidFor))?.disposition).toBe('relay');
      expect(host.journal.findInboundEmail(recipient, mailKey(other))?.disposition).toBe('held');
    } finally {
      await host.close();
    }
  });
});
