import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import { HeldEmailAutoResponder } from '../src/mta/held-email-auto-responder';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { createJournaledMailHost, type JournaledMailHost } from '../src/host/journaled-mail-host';
import { buildStripeWebhookSignatureHeader } from '../src/http/checkout-server';
import { createIssuedMailboxLookup } from '../src/smtp/issued-mailbox-lookup';
import { JournaledSmtpIngress } from '../src/smtp/journaled-smtp-ingress';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';

const GATEWAY = `0x${'9'.repeat(40)}`;
const RECIPIENT = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const SENDER = 'human@example.org';

describe('first authenticated mail introductory postage through the production host', () => {
  let directory: string;
  let host: JournaledMailHost;
  let ledger: CreditLedger;
  let submitted: Uint8Array[];
  let attempts: Map<string, string>;
  let failSmtp: boolean;
  let pending: boolean;
  const stampValues: bigint[] = [];

  function open(mode: 'provision' | 'existing') {
    const chain = {
      chainIdentifier: 'monad-testnet',
      parseAddress: (value: string) => /^0x[0-9a-f]{40}$/.test(value) ? { raw: value } : undefined,
      directMessages: {
        send: async (input: { messageId: string; stampValue: bigint; onEnvelopeDurable: (digest: string) => Promise<void> }) => {
          const digest = crypto.createHash('sha256').update(input.messageId).digest('hex');
          if (attempts.has(input.messageId)) throw new Error('already attempted');
          attempts.set(input.messageId, digest);
          stampValues.push(input.stampValue);
          await input.onEnvelopeDurable(digest);
          if (pending) throw new Error('delivery acceptance unknown');
          return { payloadDigest: digest, stampValueWei: 1000n, stampPayments: [], preparationTxHashes: [] };
        },
        attemptOf: async ({ messageId }: { messageId: string }) => {
          const payloadDigest = attempts.get(messageId);
          return payloadDigest ? { payloadDigest, paid: true } : undefined;
        },
        reconcileAttempts: async ({ payloadDigests }: { payloadDigests: string[] }) =>
          Object.fromEntries(payloadDigests.map((digest) => [digest, pending ? 'pending' : 'delivered'])),
      },
    } as unknown as ActiveChain;
    const atomic = jest.spyOn(CreditLedger.prototype, 'atomic');
    host = createJournaledMailHost({
      chain, wallet: { identity: { address: { raw: GATEWAY } } } as WalletHandle,
      journalFile: path.join(directory, 'mail.sqlite3'), blobDirectory: path.join(directory, 'blobs'),
      operatorAccountAddress: GATEWAY,
      journalMode: mode, gatewayDomain: 'gateway.example', mailboxSalt: new Uint8Array(32).fill(7),
      resendApiKey: 're_test', resendWebhookSecret: 'whsec_test', resendRawOrigins: ['https://raw.example'],
      inboundStampValue: 1000n, webhookHost: '127.0.0.1', webhookPort: 0,
      frankAppUrl: 'https://app.example', stripeWebhookSecret: 'whsec_stripe',
      stripePaymentLinkTier2: 'https://buy.stripe.com/test_pack',
      outboundPort: { submit: async (mail) => {
        submitted.push(mail.signedRfc822);
        if (failSmtp) throw new Error('SMTP acceptance uncertain');
      } },
    });
    // Capture the real host-owned ledger through its public atomic boundary; a second SQLite owner is forbidden.
    ledger = atomic.mock.contexts[0] as CreditLedger;
    atomic.mockRestore();
  }

  function admit(id: string, recipient = RECIPIENT, alias = 'alice', extraHeaders = '') {
    const raw = Buffer.from(`From: Human <${SENDER}>\r\nTo: ${alias}@gateway.example\r\nMessage-ID: <${id}@example.org>\r\nSubject: ${id}\r\n${extraHeaders}\r\nBody ${id}`);
    return host.inbound.admit({ email: parseRawRfc822(raw), verifiedTransportId: `verified:${id}`, authenticatedSenderEmail: SENDER.toUpperCase() }, recipient, 1000n, undefined, alias);
  }

  async function restart() {
    await host.close();
    open('existing');
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-intro-'));
    submitted = []; attempts = new Map(); failSmtp = false; pending = false; stampValues.length = 0;
    open('provision');
    host.journal.issueMailbox({ localPart: 'alice', scopeAccount: RECIPIENT });
    host.journal.issueMailbox({ localPart: 'bob', scopeAccount: OTHER });
  });
  afterEach(async () => {
    await host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('grants three once, debits one, forwards at configured postage, and shares the allowance across recipients/restarts', async () => {
    const first = admit('first');
    expect(first.kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(2);
    if (first.kind !== 'queued') throw new Error('first mail not queued');
    expect(await host.inbound.resume(first.slot.slotId)).toBe('delivered');
    expect(stampValues).toEqual([1000n]);
    expect(admit('first')).toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: first.slot.slotId } });
    expect(ledger.getBalance(SENDER.toUpperCase())).toBe(2);
    await restart();
    const second = admit('second', OTHER, 'bob');
    expect(second.kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(1);
    expect(admit('third').kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(0);
    await restart();
    expect(admit('fourth', OTHER, 'bob')).toEqual({ kind: 'held' });
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('rolls back the grant with failed send-slot admission instead of losing or duplicating the allowance', () => {
    const admission = jest.spyOn(host.journal, 'relayInboundEmail').mockImplementationOnce(() => {
      throw new Error('interrupted admission');
    });
    expect(() => admit('rollback')).toThrow('interrupted admission');
    expect(ledger.getBalance(SENDER)).toBe(0);
    admission.mockRestore();
    expect(admit('rollback').kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(2);
  });

  it('sends one durable welcome only after accepted delivery; its actual top-up route cannot resend the delivered mail', async () => {
    const first = admit('welcome');
    expect(first.kind).toBe('queued');
    if (first.kind !== 'queued') throw new Error('first mail not queued');
    const key = first.slot.sourceKey.slice(RECIPIENT.length + 1);
    expect(host.checkoutServer.renderPaymentPageResponse(key, new URLSearchParams()).body).toContain('Delivery Pending');
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(0);
    await host.inbound.resume(first.slot.slotId);
    const competingOptions = {
      journal: host.journal, gatewayDomain: 'gateway.example', onboardingSecret: 'fixture',
      dbPath: path.join(directory, 'blobs', 'held-auto-reply.db'),
      introductoryPostageBalance: (email: string) => ledger.getBalance(email),
      port: { submit: async (mail: { signedRfc822: Uint8Array }) => { submitted.push(mail.signedRfc822); } },
    };
    const competing = new HeldEmailAutoResponder(competingOptions);
    try {
      await Promise.all([host.inbound.sendPendingHeldAutoReplies(), competing.processHeldEmails()]);
    } finally { competing.close(); }
    expect(submitted).toHaveLength(1);
    const raw = Buffer.from(submitted[0]).toString('utf8');
    const text = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
    const body = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8');
    expect(body).toContain('received 3 free postage credits');
    expect(body).toContain('prepared: 2');
    expect(body).toContain(`https://gateway.example/pay/${key}`);
    const page = host.checkoutServer.renderPaymentPageResponse(key, new URLSearchParams());
    expect(page.status).toBe(200);
    expect(page.body).toContain('Delivery Accepted');
    expect(page.body).toContain('do not need to pay to deliver this email again');
    expect(page.body).toContain(`client_reference_id=${key}`);
    expect(page.body).not.toContain('A reply allowance has been activated');
    const event = JSON.stringify({ id: 'evt_intro_topup', type: 'checkout.session.completed', data: { object: {
      payment_status: 'paid', amount_total: 300, currency: 'usd', client_reference_id: key,
      customer_details: { email: 'unrelated@example.org' },
    } } });
    expect((await host.checkoutServer.handleStripeWebhookPayload(event, buildStripeWebhookSignatureHeader(event, 'whsec_stripe'))).status).toBe(200);
    expect(ledger.getBalance(SENDER)).toBe(7);
    expect(attempts.size).toBe(1);
    await restart();
    const second = admit('later', OTHER, 'bob');
    if (second.kind !== 'queued') throw new Error('later mail not queued');
    await host.inbound.resume(second.slot.slotId);
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(1);
  });

  it('keeps an ambiguous original wallet operation and uncertain welcome from becoming duplicate payments or SMTP submissions', async () => {
    const first = admit('uncertain');
    if (first.kind !== 'queued') throw new Error('first mail not queued');
    pending = true;
    await host.inbound.resume(first.slot.slotId).catch(() => undefined);
    await restart();
    await host.inbound.recover();
    expect(attempts.size).toBe(1);
    expect(ledger.getBalance(SENDER)).toBe(2);
    expect(submitted).toHaveLength(0);
    pending = false;
    await host.inbound.recover();
    failSmtp = true;
    await expect(host.inbound.sendPendingHeldAutoReplies()).rejects.toThrow('failures');
    expect(submitted).toHaveLength(1);
    await restart();
    failSmtp = false;
    await expect(host.inbound.sendPendingHeldAutoReplies()).rejects.toThrow('failures');
    expect(submitted).toHaveLength(1);
    expect(attempts.size).toBe(1);
  });

  function smtpIngress() {
    return new JournaledSmtpIngress({
      gatewayDomain: 'gateway.example', sender: host.inbound, stampValue: 1000n,
      issuedMailboxLookup: createIssuedMailboxLookup(host.journal, {
        relayUrl: 'https://relay.example', operatorAccountAddress: GATEWAY,
        fetcher: (async (url: string | URL | Request) => String(url).endsWith('/usernames/relayuser')
          ? new Response(JSON.stringify({ address: RECIPIENT }), { status: 200 })
          : new Response('', { status: 404 })) as typeof fetch,
      }),
      authentication: { authenticatedAuthor: async () => SENDER },
    });
  }

  function smtpMail(id: string, localPart: string, from = SENDER) {
    return Buffer.from(`From: ${from}\r\nTo: ${localPart}@gateway.example\r\nMessage-ID: <${id}@example.org>\r\nSubject: ${id}\r\n\r\nBody`);
  }

  const envelope = (localPart: string) => ({
    clientIp: '192.0.2.1', helo: 'sender.example.org', mailFrom: SENDER,
    recipients: [`${localPart}@gateway.example`],
  });

  it('introduces a real relay-resolved username without creating or requiring an issued alias row', async () => {
    expect(host.journal.issuedMailbox('relayuser')).toBeUndefined();
    const raw = smtpMail('relay-first', 'relayuser');
    const ingress = smtpIngress();
    await Promise.all([ingress.accept(raw, envelope('relayuser')), ingress.accept(raw, envelope('relayuser'))]);
    expect(ledger.getBalance(SENDER)).toBe(2);
    expect(host.journal.listUnfinishedFrankSends()).toHaveLength(1);
    const slot = host.journal.listUnfinishedFrankSends()[0];
    // A separately authenticated webhook arrival shares the same source, regardless of transport id.
    expect(host.inbound.admit({ email: parseRawRfc822(raw), authenticatedSenderEmail: SENDER,
      verifiedTransportId: 'resend:relay-first' }, RECIPIENT, 1000n, undefined, 'relayuser'))
      .toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: slot.slotId } });
    expect(ledger.getBalance(SENDER)).toBe(2);
    expect(slot).toMatchObject({ scopeAccount: RECIPIENT, stampValue: '1000' });
    expect(await host.inbound.resume(slot.slotId)).toBe('delivered');
    expect(host.journal.issuedMailbox('relayuser')).toBeUndefined();
  });

  it.each([RECIPIENT, `u.${RECIPIENT}`])('introduces the existing direct-address fallback %s through actual SMTP resolution', async (localPart) => {
    await smtpIngress().accept(smtpMail('direct-first', localPart), envelope(localPart));
    expect(ledger.getBalance(SENDER)).toBe(2);
    const slot = host.journal.listUnfinishedFrankSends()[0];
    expect(slot).toMatchObject({ scopeAccount: RECIPIENT, stampValue: '1000' });
    expect(await host.inbound.resume(slot.slotId)).toBe('delivered');
  });

  it.each(['help', 'info', 'contact'])('introduces user-owned %s as ordinary postage even when a different operator is configured', async (localPart) => {
    host.journal.issueMailbox({ localPart, scopeAccount: RECIPIENT });
    const ingress = smtpIngress();
    const slots: number[] = [];
    for (let i = 0; i < 3; i++) {
      await ingress.accept(smtpMail(`user-contact-${i}`, localPart), envelope(localPart));
      expect(ledger.getBalance(SENDER)).toBe(2 - i);
      slots.push(host.journal.listUnfinishedFrankSends().at(-1)!.slotId);
    }
    expect(await host.inbound.resume(slots[0])).toBe('delivered');
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(1);
    await ingress.accept(smtpMail('fourth-user-contact', localPart), envelope(localPart));
    expect(ledger.getBalance(SENDER)).toBe(0);
    expect(host.journal.listHeldInboundEmails()).toHaveLength(1);
    expect(host.journal.listUnfinishedFrankSends()).toHaveLength(2);
    expect(submitted).toHaveLength(1);
  });

  it.each(['help', 'postmaster'])('preserves the configured operator fallback %s without requiring or granting introductory postage', async (localPart) => {
    const ingress = smtpIngress();
    await ingress.accept(smtpMail('operator-contact', localPart), envelope(localPart));
    expect(ledger.getBalance(SENDER)).toBe(0);
    expect(host.journal.listUnfinishedFrankSends()).toMatchObject([{ scopeAccount: GATEWAY }]);
    expect(host.journal.listHeldInboundEmails()).toHaveLength(0);
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(0);
  });

  it('rejects unknown/malformed recipients and forged From at actual ingress before any subsidy or history mutation', async () => {
    const ingress = smtpIngress();
    expect(await ingress.acceptsRecipient('unknown@gateway.example')).toBe(false);
    expect(await ingress.acceptsRecipient('bad!@gateway.example')).toBe(false);
    await expect(ingress.accept(smtpMail('unknown', 'unknown'), envelope('unknown'))).rejects.toThrow('Recipient unavailable');
    await expect(ingress.accept(smtpMail('forged', 'alice', 'someone@example.org'), envelope('alice'))).rejects.toThrow('projection differs');
    expect(ledger.getBalance(SENDER)).toBe(0);
    expect(host.journal.listHeldInboundEmails()).toHaveLength(0);
    expect(host.journal.listUnfinishedFrankSends()).toHaveLength(0);
    await restart();
    expect(admit('first-after-rejections').kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(2);
  });

  it('keeps reply allowance consumption ahead of ordinary postage and never resets either balance', async () => {
    ledger.grantReplyAllowance(SENDER, RECIPIENT, 1);
    expect(admit('reply-allowance').kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(3);
    expect(ledger.getThreadAllowance(SENDER, RECIPIENT)).toBe(0);
    expect(admit('ordinary-after-reply', OTHER, 'bob').kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(2);
    await restart();
    expect(ledger.getBalance(SENDER)).toBe(2);
    expect(ledger.getThreadAllowance(SENDER, RECIPIENT)).toBe(0);
  });

  it('preserves paid credits and suppresses the initial automated notice', async () => {
    ledger.addCredits(SENDER, 5, 'paid-before-first-mail', 'stripe');
    const first = admit('automated', RECIPIENT, 'alice', 'Auto-Submitted: auto-generated\r\n');
    expect(first.kind).toBe('queued');
    expect(ledger.getBalance(SENDER)).toBe(7);
    if (first.kind !== 'queued') throw new Error('first mail not queued');
    await host.inbound.resume(first.slot.slotId);
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(0);
    await restart();
    await host.inbound.sendPendingHeldAutoReplies();
    expect(submitted).toHaveLength(0);
    expect(ledger.getBalance(SENDER)).toBe(7);
  });
});
