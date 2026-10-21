import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { MailJournal } from '../src/ledger/mail-journal';
import { JournaledInboundSend } from '../src/relay/journaled-inbound-send';
import { LocalFsBlobStore } from '../src/storage/local-fs-blob-store';
import { parseRawRfc822 } from '../src/smtp/smtp-listener';
import { mailKey } from '../src/rfc/mail-keys';
import { HeldEmailAutoResponder } from '../src/mta/held-email-auto-responder';

const GATEWAY = `0x${'9'.repeat(40)}`;
const RECIPIENT = `0x${'a'.repeat(40)}`;
const SENDER = 'carol@mail.example';
const DIGEST = crypto.createHash('sha256').update('durable-envelope').digest('hex');
const RAW = Buffer.from(
  `From: Carol <${SENDER}>\r\nTo: ${RECIPIENT}@gw.example\r\nMessage-ID: <mail-1@mail.example>\r\nSubject: Hello\r\n\r\nHello, Frank.`,
  'utf8'
);

describe('journal-backed inbound Frank send', () => {
  let dir: string;
  let file: string;
  let ledger: CreditLedger;
  let journal: MailJournal;
  let wallet: WalletHandle;
  let chain: ActiveChain;
  const attempts = new Map<string, string>();
  let sendCalls: string[];
  let interrupt: 'before_attempt' | 'before_barrier' | 'after_barrier' | undefined;

  function open(): JournaledInboundSend {
    ledger = new CreditLedger(file, new LocalFsBlobStore({ inMemory: true }));
    journal = new MailJournal(ledger, {
      chainIdentifier: 'monad-testnet',
      gatewayAccount: GATEWAY,
      gatewayDomain: 'gw.example',
    });
    return new JournaledInboundSend({ chain, wallet, ledger, journal });
  }

  function restart(): JournaledInboundSend {
    ledger.sqlite!.close();
    return open();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-mail-send-'));
    file = path.join(dir, 'mail.sqlite3');
    attempts.clear();
    sendCalls = [];
    interrupt = undefined;
    wallet = { identity: { address: { raw: GATEWAY } } } as unknown as WalletHandle;
    chain = {
      chainIdentifier: 'monad-testnet',
      parseAddress: (input: string) =>
        /^0x[0-9a-f]{40}$/.test(input) ? { raw: input } : undefined,
      directMessages: {
        send: async (params: {
          messageId: string;
          onEnvelopeDurable: (digest: string) => Promise<void>;
        }) => {
          sendCalls.push(params.messageId);
          if (interrupt === 'before_attempt') {
            interrupt = undefined;
            throw new Error('interrupted before wallet attempt');
          }
          if (attempts.has(params.messageId)) throw new Error('already attempted');
          attempts.set(params.messageId, DIGEST);
          if (interrupt === 'before_barrier') {
            interrupt = undefined;
            throw new Error('interrupted after wallet journal');
          }
          await params.onEnvelopeDurable(DIGEST);
          if (interrupt === 'after_barrier') {
            interrupt = undefined;
            throw new Error('interrupted after host barrier');
          }
          return { payloadDigest: DIGEST, stampValueWei: 1000n, stampPayments: [], preparationTxHashes: [] };
        },
        attemptOf: async ({ messageId }: { messageId: string }) => {
          const payloadDigest = attempts.get(messageId);
          return payloadDigest ? { payloadDigest, paid: true } : undefined;
        },
        reconcileAttempts: async ({ payloadDigests }: { payloadDigests: string[] }) =>
          Object.fromEntries(payloadDigests.map((digest) => [digest, 'delivered'])),
      },
    } as unknown as ActiveChain;
    open();
  });

  afterEach(() => {
    ledger.sqlite?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function admit(sender: JournaledInboundSend) {
    return sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER },
      RECIPIENT,
      1000n
    );
  }

  it('keeps an uncertain optional challenge separate from held financial release after restart', async () => {
    const submit = jest.fn(async () => { throw new Error('SMTP acceptance unknown'); });
    const options = {
      journal, port: { submit }, gatewayDomain: 'gw.example',
      onboardingSecret: Buffer.alloc(32, 3), dbPath: path.join(dir, 'challenges.sqlite3'),
    };
    const responder = new HeldEmailAutoResponder(options);
    let sender = new JournaledInboundSend({ chain, wallet, ledger, journal, heldAutoResponder: responder });
    expect(admit(sender)).toEqual({ kind: 'held' });
    await expect(sender.sendPendingHeldAutoReplies()).rejects.toThrow('Held auto-reply failures: 1');
    responder.close();
    const reopened = new HeldEmailAutoResponder(options);
    try {
      sender = new JournaledInboundSend({ chain, wallet, ledger, journal, heldAutoResponder: reopened });
      await expect(sender.releaseHeld()).resolves.toMatchObject({ released: 0, errors: [] });
      await expect(sender.sendPendingHeldAutoReplies()).rejects.toThrow('Held auto-reply failures: 1');
      expect(submit).toHaveBeenCalledTimes(1);
      expect(journal.listHeldInboundEmails()).toHaveLength(1);
      expect(sendCalls).toHaveLength(0);
    } finally { reopened.close(); }
  });

  it('carries an issued mailbox conversation through the durable send slot', () => {
    const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    journal.issueMailbox({ localPart: 'alice', scopeAccount: RECIPIENT, conversationId });
    ledger.addCredits(SENDER, 1);
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const admitted = sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER },
      RECIPIENT, 1000n, journal.issuedMailbox('alice')!.conversationId, 'alice',
    );
    expect(admitted).toMatchObject({ kind: 'queued', slot: { conversationId } });
    expect(journal.findMailThread(RECIPIENT, conversationId)).toBeDefined();
  });

  it('accepts an issued inbox alias without a preassigned conversation', () => {
    journal.issueMailbox({ localPart: 'inbox', scopeAccount: RECIPIENT });
    ledger.addCredits(SENDER, 1);
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const result = sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER },
      RECIPIENT, 1000n, undefined, 'inbox',
    );
    expect(result).toMatchObject({ kind: 'queued' });
    if (result.kind !== 'queued') throw new Error('mail was not queued');
    expect(journal.findInboundEmail(RECIPIENT, result.slot.sourceKey.slice(RECIPIENT.length + 1))).toMatchObject({
      mailboxLocalPart: 'inbox', stampValue: '1000',
    });
  });

  it('keeps two aliases for one account as separate durable deliveries across replay and restart', () => {
    const aliceConversation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const bobConversation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    journal.issueMailbox({ localPart: 'alice', scopeAccount: RECIPIENT, conversationId: aliceConversation });
    journal.issueMailbox({ localPart: 'bob', scopeAccount: RECIPIENT, conversationId: bobConversation });
    ledger.addCredits(SENDER, 2);
    let sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const verified = { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER };
    const first = sender.admit(verified, RECIPIENT, 1000n, aliceConversation, 'alice');
    const second = sender.admit(verified, RECIPIENT, 1000n, bobConversation, 'bob');
    expect(first).toMatchObject({ kind: 'queued', slot: { conversationId: aliceConversation } });
    expect(second).toMatchObject({ kind: 'queued', slot: { conversationId: bobConversation } });
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('mail was not queued');
    expect(second.slot.slotId).not.toBe(first.slot.slotId);
    expect(ledger.getBalance(SENDER)).toBe(0);
    sender = restart();
    expect(sender.admit(verified, RECIPIENT, 1000n, aliceConversation, 'alice')).toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: first.slot.slotId } });
    expect(sender.admit(verified, RECIPIENT, 1000n, bobConversation, 'bob')).toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: second.slot.slotId } });
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('preserves the assigned alias conversation while mail is held for credit', () => {
    const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const verified = { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER };
    let sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    expect(sender.admit(verified, RECIPIENT, 1000n, conversationId, 'alice')).toEqual({ kind: 'held' });
    const held = ledger.sqlite!.prepare('SELECT mail_key, mailbox_local_part, conversation_id FROM inbound_email').get() as { mail_key: string; mailbox_local_part: string; conversation_id: string };
    expect(held).toMatchObject({ mailbox_local_part: 'alice', conversation_id: conversationId });
    sender = restart();
    ledger.addCredits(SENDER, 1);
    expect(sender.admit(verified, RECIPIENT, 1000n, conversationId, 'alice')).toMatchObject({ kind: 'queued', slot: { conversationId } });
    expect(journal.relayInboundEmail({ scopeAccount: RECIPIENT, mailKey: held.mail_key, stampValue: '1000' }).slot.conversationId).toBe(conversationId);
  });

  it('releases a held alias after restart and credit top-up without a second webhook', async () => {
    const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const verified = { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER };
    let sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    expect(sender.admit(verified, RECIPIENT, 1000n, conversationId, 'alice')).toEqual({ kind: 'held' });
    sender = restart();
    ledger.addCredits(SENDER, 1);
    expect(await sender.releaseHeld()).toMatchObject({ released: 1, errors: [] });
    expect(ledger.getBalance(SENDER)).toBe(0);
    const slot = journal.listUnfinishedFrankSends()[0];
    expect(slot).toMatchObject({ conversationId, stampValue: '1000' });
    expect(await sender.releaseHeld()).toMatchObject({ released: 0, errors: [] });
    expect(journal.listUnfinishedFrankSends()).toHaveLength(1);
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('credits and releases only the held mail a purchase was made for (BOT-8)', async () => {
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const daveRaw = Buffer.from(
      `From: Dave <dave@mail.example>\r\nTo: ${RECIPIENT}@gw.example\r\nMessage-ID: <mail-2@mail.example>\r\nSubject: Other\r\n\r\nNot paid for.`,
      'utf8'
    );
    expect(admit(sender)).toEqual({ kind: 'held' });
    expect(sender.admit(
      { email: parseRawRfc822(daveRaw), verifiedTransportId: 'resend:mail-2', authenticatedSenderEmail: 'dave@mail.example' },
      RECIPIENT,
      1000n
    )).toEqual({ kind: 'held' });
    // Dave has credit too, but this purchase is not for his mail.
    ledger.addCredits('dave@mail.example', 1);
    const carolKey = mailKey(RAW);

    const purchase = {
      providerTxId: 'evt_paid_1',
      provider: 'stripe',
      credits: 5,
      referenceId: carolKey,
      payerEmail: 'someone-else@typed.example',
    };
    expect(await sender.applyHeldMailPurchase(purchase)).toEqual({ creditedEmail: SENDER, released: true });
    expect(ledger.getBalance(SENDER)).toBe(4);
    expect(ledger.getBalance('someone-else@typed.example')).toBe(0);
    expect(journal.findInboundEmail(RECIPIENT, carolKey)?.disposition).toBe('relay');
    expect(journal.findInboundEmail(RECIPIENT, mailKey(daveRaw))?.disposition).toBe('held');
    expect(ledger.getBalance('dave@mail.example')).toBe(1);
    expect(journal.listUnfinishedFrankSends()).toHaveLength(1);

    // Stripe redelivers the same event: no second credit, no second slot.
    expect(await sender.applyHeldMailPurchase(purchase)).toEqual({ creditedEmail: SENDER, released: false });
    expect(ledger.getBalance(SENDER)).toBe(4);
    expect(journal.listUnfinishedFrankSends()).toHaveLength(1);

    // A purchase with no held mail credits the payer's own email.
    expect(await sender.applyHeldMailPurchase({
      providerTxId: 'evt_paid_2', provider: 'stripe', credits: 1, payerEmail: 'Payer@Typed.example',
    })).toEqual({ creditedEmail: 'payer@typed.example', released: false });
    expect(ledger.getBalance('payer@typed.example')).toBe(1);
  });

  it('never releases an expired held alias or consumes its later credit', async () => {
    const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const verified = { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER };
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    expect(sender.admit(verified, RECIPIENT, 1000n, conversationId, 'alice')).toEqual({ kind: 'held' });
    ledger.sqlite!.prepare("UPDATE inbound_email SET expires_at = 1 WHERE disposition = 'held'").run();
    ledger.addCredits(SENDER, 1);
    expect(await sender.releaseHeld()).toMatchObject({ released: 0, errors: [] });
    expect(ledger.getBalance(SENDER)).toBe(1);
    expect(journal.listUnfinishedFrankSends()).toHaveLength(0);
  });

  it.each(['before_attempt', 'before_barrier', 'after_barrier'] as const)(
    'recovers a %s interruption using the same message identity and one credit',
    async (point) => {
      ledger.addCredits(SENDER, 1);
      const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
      const first = admit(sender);
      expect(first.kind).toBe('queued');
      if (first.kind !== 'queued') throw new Error('admission failed');
      expect(ledger.getBalance(SENDER)).toBe(0);
      expect(admit(sender)).toMatchObject({ kind: 'queued', duplicate: true, slot: { slotId: first.slot.slotId } });
      expect(ledger.getBalance(SENDER)).toBe(0);

      interrupt = point;
      await expect(sender.resume(first.slot.slotId)).rejects.toThrow('interrupted');
      const recovered = restart();
      expect(await recovered.recover()).toMatchObject({ attempted: 1, delivered: 1 });
      expect(journal.findFrankSend(first.slot.slotId)).toMatchObject({
        frankMessageId: first.slot.frankMessageId,
        payloadDigest: DIGEST,
        state: 'delivered',
      });
      expect(ledger.getBalance(SENDER)).toBe(0);
      expect(new Set(sendCalls)).toEqual(new Set([first.slot.frankMessageId]));
      expect(attempts.size).toBe(1);
      expect(await recovered.recover()).toMatchObject({ attempted: 0 });
    }
  );

  it('keeps an unpaid mail held, then consumes one credit when the same verified mail returns', async () => {
    let sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    expect(admit(sender)).toEqual({ kind: 'held' });
    expect(journal.countWaitingFrankSends()).toBe(0);
    sender = restart();
    ledger.addCredits(SENDER, 1);
    const admitted = sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: SENDER },
      RECIPIENT, 2000n,
    );
    expect(admitted.kind).toBe('queued');
    expect(admitted).toMatchObject({ slot: { stampValue: '1000' } });
    expect(ledger.getBalance(SENDER)).toBe(0);
    expect(admit(sender)).toMatchObject({ kind: 'queued', duplicate: true });
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('uses the raw header and a deterministic synthetic ID when the mail has no Message-ID', () => {
    ledger.addCredits(SENDER, 1);
    const raw = Buffer.from(RAW.toString('utf8').replace('Message-ID: <mail-1@mail.example>\r\n', ''));
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const first = sender.admit(
      { email: parseRawRfc822(raw), verifiedTransportId: 'smtp:no-id', authenticatedSenderEmail: SENDER },
      RECIPIENT, 1000n
    );
    expect(first.kind).toBe('queued');
    const key = mailKey(raw);
    const expected = journal.noMessageIdFor(key);
    expect(journal.findInboundEmail(RECIPIENT, key)?.rfcMessageId).toBe(expected);
    const reopened = restart();
    expect(reopened.admit(
      { email: parseRawRfc822(raw), verifiedTransportId: 'smtp:no-id-replay', authenticatedSenderEmail: SENDER },
      RECIPIENT, 1000n
    )).toMatchObject({ kind: 'queued', duplicate: true });
    expect(journal.findInboundEmail(RECIPIENT, key)?.rfcMessageId).toBe(expected);
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('reports one failed recovery slot and still processes the next slot', async () => {
    ledger.addCredits(SENDER, 2);
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const first = admit(sender);
    const secondRaw = Buffer.from(RAW.toString('utf8').replace('mail-1', 'mail-2').replace('Hello, Frank.', 'Second mail.'));
    const second = sender.admit(
      { email: parseRawRfc822(secondRaw), verifiedTransportId: 'resend:mail-2', authenticatedSenderEmail: SENDER },
      RECIPIENT,
      1000n
    );
    if (first.kind !== 'queued' || second.kind !== 'queued') throw new Error('admission failed');

    interrupt = 'before_attempt';
    const page = await sender.recover(1);
    expect(page).toMatchObject({ attempted: 1, delivered: 0, errors: [{ slotId: first.slot.slotId }] });
    expect(journal.findFrankSend(first.slot.slotId)?.state).toBe('sending');
    const next = await sender.recover(1, page.nextAfterSlotId);
    expect(next).toMatchObject({ attempted: 1, delivered: 1, errors: [] });
    expect(journal.findFrankSend(second.slot.slotId)?.state).toBe('delivered');
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('rejects a journal bound to another wallet or chain before admitting mail', () => {
    const wrongWallet = { identity: { address: { raw: RECIPIENT } } } as unknown as WalletHandle;
    expect(() => new JournaledInboundSend({ chain, wallet: wrongWallet, ledger, journal })).toThrow(
      'another gateway wallet'
    );
    const wrongChain = { ...chain, chainIdentifier: 'monad-mainnet' } as ActiveChain;
    expect(() => new JournaledInboundSend({ chain: wrongChain, wallet, ledger, journal })).toThrow(
      'chain identifiers differ'
    );
  });

  it('refuses a credit ledger on another connection before any debit or journal write', () => {
    const other = new CreditLedger(path.join(dir, 'other.sqlite3'), new LocalFsBlobStore({ inMemory: true }));
    try {
      expect(() => new JournaledInboundSend({ chain, wallet, ledger: other, journal })).toThrow(
        'different connections'
      );
      expect(journal.countWaitingFrankSends()).toBe(0);
    } finally {
      other.sqlite!.close();
    }
  });

  it('resends the same free envelope after a crash at the host barrier without paid reconciliation', async () => {
    ledger.addCredits(SENDER, 1);
    const freeAttempts = new Map<string, string>();
    let delivered = false;
    let sends = 0;
    const directMessages = chain.directMessages as unknown as Record<string, unknown>;
    directMessages.send = async (params: {
      messageId: string;
      stampValue: bigint;
      onEnvelopeDurable: (digest: string) => Promise<void>;
    }) => {
      expect(params.stampValue).toBe(0n);
      sends++;
      freeAttempts.set(params.messageId, DIGEST);
      await params.onEnvelopeDurable(DIGEST);
      if (sends === 1) throw new Error('crash after free host barrier');
      delivered = true;
      return { payloadDigest: DIGEST, stampValueWei: 0n, stampPayments: [], preparationTxHashes: [] };
    };
    directMessages.attemptOf = async ({ messageId }: { messageId: string }) => {
      const payloadDigest = freeAttempts.get(messageId);
      return payloadDigest ? { payloadDigest, paid: false } : undefined;
    };
    directMessages.deliveryOf = async () => delivered ? 'delivered' : 'live';
    directMessages.reconcileAttempts = jest.fn(async () => { throw new Error('paid reconcile used for free mail'); });

    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const admitted = sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'smtp:mail-1', authenticatedSenderEmail: SENDER },
      RECIPIENT, 0n
    );
    if (admitted.kind !== 'queued') throw new Error('admission failed');
    await expect(sender.resume(admitted.slot.slotId)).rejects.toThrow('crash after free host barrier');
    expect(journal.findFrankSend(admitted.slot.slotId)?.payloadDigest).toBe(DIGEST);
    const recovered = restart();
    expect(await recovered.recover()).toMatchObject({ attempted: 1, delivered: 1 });
    expect(sends).toBe(2);
    expect(freeAttempts.size).toBe(1);
    expect(directMessages.reconcileAttempts).not.toHaveBeenCalled();
    expect(ledger.getBalance(SENDER)).toBe(0);
  });

  it('refuses sender metadata that differs from the authenticated principal without debiting credit', () => {
    ledger.addCredits(SENDER, 1);
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    expect(() => sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:mail-1', authenticatedSenderEmail: 'eve@mail.example' },
      RECIPIENT,
      1000n
    )).toThrow('Authenticated sender');
    expect(ledger.getBalance(SENDER)).toBe(1);
    expect(journal.countWaitingFrankSends()).toBe(0);
  });

  it('queues inbound mail to operator/operational local-parts without requiring sender credits', () => {
    expect(ledger.getBalance(SENDER)).toBe(0);
    const sender = new JournaledInboundSend({ chain, wallet, ledger, journal });
    const admitted = sender.admit(
      { email: parseRawRfc822(RAW), verifiedTransportId: 'resend:support-1', authenticatedSenderEmail: SENDER },
      RECIPIENT,
      1000n,
      undefined,
      'support',
    );
    expect(admitted.kind).toBe('queued');
    expect(journal.countWaitingFrankSends()).toBe(1);
  });
});

