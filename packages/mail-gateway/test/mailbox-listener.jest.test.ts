import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RelayMailboxListener } from '../src/relay/mailbox-listener';
import { CreditLedger } from '../src/ledger/credit-ledger';
import { OutboundEmailDelivery } from '../src/mta/outbound-delivery';
import { DkimSigner, generateDkimKeyPair } from '../src/mta/dkim-signer';
import { MxDirectTransport } from '../src/mta/mx-transport';
import type { MxDeliveryResult } from '../src/mta/mx-transport';
import { OutboundMtaWorker } from '../src/mta/outbound-worker';
import type { ActiveChain, DirectMessageReceived, WalletHandle } from '@frank/wallet/chain/active-chain';

describe('RelayMailboxListener', () => {
  let ledger: CreditLedger;
  let outboundDelivery: OutboundEmailDelivery;
  let dkimSigner: DkimSigner;
  let mxTransport: MxDirectTransport;
  let outboundWorker: OutboundMtaWorker;
  let dispatchedEmails: Array<{ from: string; to: string; raw: string }> = [];

  const gatewayDomain = 'frank.org';
  const aliceFrankAddress = '0x1111111111111111111111111111111111111111';

  beforeEach(() => {
    dispatchedEmails = [];
    ledger = new CreditLedger(':memory:');
    outboundDelivery = new OutboundEmailDelivery({
      gatewayDomain,
      ledger,
    });
    const keyPair = generateDkimKeyPair();
    dkimSigner = new DkimSigner({
      domain: gatewayDomain,
      selector: 'test',
      privateKey: keyPair.privateKey,
    });
    mxTransport = new MxDirectTransport({
      heloDomain: gatewayDomain,
      resolveMxFn: async () => [{ exchange: 'mx.example.com', priority: 10 }],
    });
    // Mock MX deliver
    jest.spyOn(mxTransport, 'deliver').mockImplementation(async (params) => {
      dispatchedEmails.push({
        from: params.fromAddress,
        to: params.toAddress,
        raw: new TextDecoder().decode(params.rawRfc822),
      });
      return { success: true, responseCode: 250, responseMessage: 'OK' };
    });

    outboundWorker = new OutboundMtaWorker({
      gatewayDomain,
      ledger,
      delivery: outboundDelivery,
      dkimSigner,
      mxTransport,
    });
  });

  const mockWallet = {} as WalletHandle;

  it('handles a reply to an existing 1-on-1 email thread', async () => {
    // 1. Setup existing thread mapping
    const conversationId = 'conv-1on1-1234';
    ledger.recordThreadMapping({
      conversationId,
      frankMessageId: 'inbound_msg_001',
      rfc822MessageId: '<original@external.com>',
      subject: 'Hello Alice',
      senderAddress: 'bob@external.com',
      toRecipientsJson: JSON.stringify([{ address: 'alice@frank.org' }]),
      createdAtMs: Date.now() - 10000,
    });

    const listener = new RelayMailboxListener({
      gatewayDomain,
      activeChain: {} as ActiveChain,
      wallet: mockWallet,
      ledger,
      outboundWorker,
    });

    // 2. Incoming DM from Alice replying in that thread
    const replyDm: DirectMessageReceived = {
      senderAddress: { raw: aliceFrankAddress },
      recipientAddress: { raw: '0xgateway' },
      conversationId,
      messageId: 'alice_reply_001',
      payloadDigest: 'digest_001',
      stampValueWei: 1000n,
      stampPayments: [],
      receivedTime: Date.now(),
      items: [
        {
          type: 'text',
          text: 'Sounds great, Bob!',
        },
      ],
    };

    await listener.processDirectMessage(replyDm);

    expect(dispatchedEmails).toHaveLength(1);
    expect(dispatchedEmails[0].to).toBe('bob@external.com');
    expect(dispatchedEmails[0].raw).toContain('Subject: Re: Hello Alice');
    expect(dispatchedEmails[0].raw).toContain('In-Reply-To: <original@external.com>');
    expect(dispatchedEmails[0].raw).toContain('Sounds great, Bob!');
  });

  it('handles a reply to a multi-party thread defaulting to Reply-All', async () => {
    const conversationId = 'conv-multiparty-5678';
    ledger.recordThreadMapping({
      conversationId,
      frankMessageId: 'inbound_msg_group',
      rfc822MessageId: '<group-msg@corp.com>',
      subject: 'Budget Meeting',
      senderAddress: 'chair@corp.com',
      toRecipientsJson: JSON.stringify([
        { address: 'alice@frank.org' },
        { address: 'dave@corp.com' },
      ]),
      ccRecipientsJson: JSON.stringify([
        { address: 'eve@corp.com' },
        { address: 'frank_bot@frank.org' },
      ]),
      createdAtMs: Date.now() - 20000,
    });

    const listener = new RelayMailboxListener({
      gatewayDomain,
      activeChain: {} as ActiveChain,
      wallet: mockWallet,
      ledger,
      outboundWorker,
    });

    const replyDm: DirectMessageReceived = {
      senderAddress: { raw: aliceFrankAddress },
      recipientAddress: { raw: '0xgateway' },
      conversationId,
      messageId: 'alice_reply_group',
      payloadDigest: 'digest_group',
      stampValueWei: 1000n,
      stampPayments: [],
      receivedTime: Date.now(),
      items: [
        {
          type: 'text',
          text: 'I have attached my projections.',
        },
      ],
    };

    await listener.processDirectMessage(replyDm);

    expect(dispatchedEmails).toHaveLength(1);
    expect(dispatchedEmails[0].to).toBe('chair@corp.com');
    // Notice dave@corp.com and eve@corp.com are included in Cc, but frank_bot@frank.org is excluded!
    expect(dispatchedEmails[0].raw).toContain('Cc: dave@corp.com, eve@corp.com');
    expect(dispatchedEmails[0].raw).toContain('In-Reply-To: <group-msg@corp.com>');
    expect(dispatchedEmails[0].raw).toContain('Subject: Re: Budget Meeting');
  });

  it('initiates a new outbound email thread using rich EmailItem', async () => {
    const listener = new RelayMailboxListener({
      gatewayDomain,
      activeChain: {} as ActiveChain,
      wallet: mockWallet,
      ledger,
      outboundWorker,
    });

    const newThreadDm: DirectMessageReceived = {
      senderAddress: { raw: aliceFrankAddress },
      recipientAddress: { raw: '0xgateway' },
      conversationId: 'new-conv-999',
      messageId: 'alice_new_thread',
      payloadDigest: 'digest_new_thread',
      stampValueWei: 1000n,
      stampPayments: [],
      receivedTime: Date.now(),
      items: [
        {
          type: 'email',
          messageId: '<client-draft-1@frank>',
          from: { address: 'alice@frank.org' },
          to: [{ address: 'partner@enterprise.com' }],
          cc: [{ address: 'lawyer@enterprise.com' }],
          subject: 'Partnership Proposal',
          textBody: 'Please see our proposal below.',
        },
      ],
    };

    await listener.processDirectMessage(newThreadDm);

    expect(dispatchedEmails).toHaveLength(1);
    expect(dispatchedEmails[0].to).toBe('partner@enterprise.com');
    expect(dispatchedEmails[0].raw).toContain('Cc: lawyer@enterprise.com');
    expect(dispatchedEmails[0].raw).toContain('Subject: Partnership Proposal');
    expect(dispatchedEmails[0].raw).toContain('Please see our proposal below.');

    // Verified thread mapping was recorded
    const saved = ledger.getLatestThreadMappingByConversationId('new-conv-999');
    expect(saved).toBeDefined();
    expect(saved?.senderAddress).toBe(aliceFrankAddress);
  });

  it('enforces 24-hour rate limit on newly initiated threads', async () => {
    const listener = new RelayMailboxListener({
      gatewayDomain,
      activeChain: {} as ActiveChain,
      wallet: mockWallet,
      ledger,
      outboundWorker,
      maxNewThreadsPerDay: 2, // Low threshold for test
    });

    const makeDm = (i: number): DirectMessageReceived => ({
      senderAddress: { raw: aliceFrankAddress },
      recipientAddress: { raw: '0xgateway' },
      conversationId: `conv-quota-${i}`,
      messageId: `msg-${i}`,
      payloadDigest: `digest-${i}`,
      stampValueWei: 1000n,
      stampPayments: [],
      receivedTime: Date.now(),
      items: [
        {
          type: 'email',
          messageId: `<draft-${i}@frank>`,
          from: { address: 'alice@frank.org' },
          to: [{ address: `recipient${i}@example.com` }],
          subject: `Outbound ${i}`,
          textBody: `Body ${i}`,
        },
      ],
    });

    // 1st initiation -> success
    await listener.processDirectMessage(makeDm(1));
    expect(dispatchedEmails).toHaveLength(1);

    // 2nd initiation -> success
    await listener.processDirectMessage(makeDm(2));
    expect(dispatchedEmails).toHaveLength(2);

    // 3rd initiation -> exceeds quota (2 max) -> blocked!
    await listener.processDirectMessage(makeDm(3));
    expect(dispatchedEmails).toHaveLength(2);
  });
});

describe('RelayMailboxListener polling', () => {
  const gatewayDomain = 'frank.org';
  const SENDER = '0x1111111111111111111111111111111111111111';
  const T = 1_791_288_000_000;
  const CONTENT_MARKER = 'PRIVATE-CONTENT-MARKER';

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let tmpDirs: string[] = [];
  let openLedgers: CreditLedger[] = [];

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const ledger of openLedgers) ledger.sqlite?.close();
    openLedgers = [];
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  function openLedger(file = ':memory:'): CreditLedger {
    const ledger = new CreditLedger(file);
    openLedgers.push(ledger);
    return ledger;
  }

  function ledgerFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-listener-'));
    tmpDirs.push(dir);
    return path.join(dir, 'ledger.sqlite');
  }

  interface Sent {
    to: string;
    raw: string;
  }

  /**
   * A listener over `inbox` with a fetch that, like the relay client, returns
   * every message at or after the cursor, so the newest ones come back on
   * every poll.
   */
  function makeGateway(
    ledger: CreditLedger,
    inbox: DirectMessageReceived[],
    options: { sent?: Sent[]; maxNewThreadsPerDay?: number } = {}
  ) {
    const sent = options.sent ?? [];
    const cursors: number[] = [];
    const mxTransport = new MxDirectTransport({
      heloDomain: gatewayDomain,
      resolveMxFn: async () => [{ exchange: 'mx.example.com', priority: 10 }],
    });
    const deliver = jest.spyOn(mxTransport, 'deliver').mockImplementation(async (params) => {
      sent.push({ to: params.toAddress, raw: new TextDecoder().decode(params.rawRfc822) });
      return { success: true, responseCode: 250, responseMessage: 'OK' } as MxDeliveryResult;
    });
    const worker = new OutboundMtaWorker({
      gatewayDomain,
      ledger,
      delivery: new OutboundEmailDelivery({ gatewayDomain, ledger }),
      dkimSigner: new DkimSigner({
        domain: gatewayDomain,
        selector: 'test',
        privateKey: generateDkimKeyPair().privateKey,
      }),
      mxTransport,
    });
    const listener = new RelayMailboxListener({
      gatewayDomain,
      activeChain: {
        directMessages: {
          fetchSince: async (params: { sinceMs: number }) => {
            cursors.push(params.sinceMs);
            return inbox
              .filter((m) => m.receivedTime >= params.sinceMs)
              .sort((a, b) => a.receivedTime - b.receivedTime);
          },
        },
      } as unknown as ActiveChain,
      wallet: {} as WalletHandle,
      ledger,
      outboundWorker: worker,
      maxNewThreadsPerDay: options.maxNewThreadsPerDay,
    });
    return { listener, worker, deliver, sent, cursors };
  }

  function dm(
    id: string,
    receivedTime: number,
    items: unknown,
    overrides: Partial<DirectMessageReceived> = {}
  ): DirectMessageReceived {
    return {
      senderAddress: { raw: SENDER },
      recipientAddress: { raw: '0xgateway' },
      conversationId: `conv_${id}`,
      messageId: id,
      payloadDigest: `digest_${id}`,
      stampValueWei: 1000n,
      stampPayments: [],
      receivedTime,
      items,
      ...overrides,
    } as DirectMessageReceived;
  }

  function emailTo(address: string, extra: Record<string, unknown> = {}) {
    return [
      {
        type: 'email',
        messageId: '<draft@frank>',
        from: { address: 'alice@frank.org' },
        to: [{ address }],
        subject: 'Greeting',
        textBody: `Hello. ${CONTENT_MARKER}`,
        ...extra,
      },
    ];
  }

  function mappingCount(ledger: CreditLedger): number {
    const row = ledger.sqlite!.prepare('SELECT COUNT(*) AS total FROM thread_mappings').get() as {
      total: number;
    };
    return Number(row.total);
  }

  async function pollTimes(listener: RelayMailboxListener, times: number): Promise<void> {
    for (let i = 0; i < times; i++) await listener.pollOnce();
  }

  function logged(spy: jest.SpyInstance): string {
    return spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it.each([
    ['with a conversation', {}],
    ['without a conversation', { conversationId: undefined }],
  ])('handles a message %s once however often it is fetched', async (_name, overrides) => {
    const ledger = openLedger();
    const { listener, sent } = makeGateway(ledger, [dm('m1', T, emailTo('bob@remote.com'), overrides)]);

    await pollTimes(listener, 6);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('bob@remote.com');
    expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
    expect(mappingCount(ledger)).toBe(1);
    expect(ledger.countInitiatedThreadsInPast24Hours(SENDER)).toBe(1);
  });

  it('does not handle a bridged message again after a restart', async () => {
    const file = ledgerFile();
    const inbox = [dm('m1', T, emailTo('bob@remote.com'))];
    const sent: Sent[] = [];

    const before = openLedger(file);
    await pollTimes(makeGateway(before, inbox, { sent }).listener, 2);
    expect(sent).toHaveLength(1);
    before.sqlite?.close();
    openLedgers = [];

    // A new process: nothing in memory, the cursor starts again, the same ledger file.
    const after = openLedger(file);
    await pollTimes(makeGateway(after, inbox, { sent }).listener, 3);

    expect(sent).toHaveLength(1);
    expect(after.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
    expect(mappingCount(after)).toBe(1);
    expect(after.countInitiatedThreadsInPast24Hours(SENDER)).toBe(1);
  });

  it('handles two messages received at the same time, each once', async () => {
    const ledger = openLedger();
    const { listener, sent } = makeGateway(ledger, [
      dm('m1', T, emailTo('bob@remote.com')),
      dm('m2', T, emailTo('carol@remote.com')),
    ]);

    await pollTimes(listener, 5);

    expect(sent.map((s) => s.to).sort()).toEqual(['bob@remote.com', 'carol@remote.com']);
    expect(mappingCount(ledger)).toBe(2);
    expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
    expect(ledger.getThreadAllowance('carol@remote.com', SENDER)).toBe(3);
  });

  it('handles the same message identifier from two senders as two messages', async () => {
    const ledger = openLedger();
    const other = '0x2222222222222222222222222222222222222222';
    const { listener, sent } = makeGateway(ledger, [
      dm('m1', T, emailTo('bob@remote.com')),
      dm('m1', T + 1, emailTo('carol@remote.com'), { senderAddress: { raw: other }, conversationId: 'conv_other' }),
    ]);

    await pollTimes(listener, 4);

    expect(sent.map((s) => s.to)).toEqual(['bob@remote.com', 'carol@remote.com']);
  });

  it.each<[string, DirectMessageReceived, { maxNewThreadsPerDay?: number }]>([
    ['has no recipient', dm('m1', T, emailTo('bob@remote.com', { to: [] })), {}],
    ['is over the sender quota', dm('m1', T, emailTo('bob@remote.com')), { maxNewThreadsPerDay: 0 }],
    ['has no email or text item', dm('m1', T, [{ type: 'reaction', emoji: CONTENT_MARKER }]), {}],
    [
      'cannot be rendered',
      dm('m1', T, emailTo('bob@remote.com'), { senderAddress: { raw: 'not a sender' } }),
      {},
    ],
  ])('sends nothing and warns once for a message that %s', async (_name, message, options) => {
    const ledger = openLedger();
    const { listener, deliver } = makeGateway(ledger, [message], options);

    await pollTimes(listener, 5);

    expect(deliver).not.toHaveBeenCalled();
    expect(mappingCount(ledger)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged(warn)).not.toContain(CONTENT_MARKER);
    expect(error).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['a To list holding an empty entry', emailTo('x', { to: [null] })],
    ['a To field that is not a list', emailTo('x', { to: `x@remote.com ${CONTENT_MARKER}` })],
    ['no To field', emailTo('x', { to: undefined })],
    ['a Cc field that is not a list', emailTo('bob@remote.com', { cc: `c@remote.com ${CONTENT_MARKER}` })],
    ['a Cc list holding an empty entry', emailTo('bob@remote.com', { cc: [null] })],
    ['a subject that is not text', emailTo('bob@remote.com', { subject: { text: CONTENT_MARKER } })],
    ['a body that is not text', emailTo('bob@remote.com', { textBody: [CONTENT_MARKER] })],
    ['text that is not text', [{ type: 'text', text: { value: CONTENT_MARKER } }]],
    ['an empty item', [null]],
    ['items that are not a list', { type: 'text', text: CONTENT_MARKER }],
  ])('skips a message with %s and delivers the messages after it', async (_name, items) => {
    const ledger = openLedger();
    const { listener, sent, cursors } = makeGateway(ledger, [
      dm('odd', T, items),
      dm('good', T + 1, emailTo('carol@remote.com')),
    ]);

    await expect(pollTimes(listener, 3)).resolves.toBeUndefined();

    expect(sent.map((s) => s.to)).toEqual(['carol@remote.com']);
    expect(mappingCount(ledger)).toBe(1);
    expect(cursors).toEqual([0, T + 1, T + 1]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged(warn)).toContain('odd');
    expect(logged(warn)).not.toContain(CONTENT_MARKER);
    expect(error).not.toHaveBeenCalled();
  });

  it('warns once for a malformed message that every poll returns', async () => {
    const ledger = openLedger();
    const { listener, deliver } = makeGateway(ledger, [dm('odd', T, emailTo('x', { to: [null] }))]);

    await pollTimes(listener, 5);

    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('handles the rest of a batch when one message fails before sending, and tries that message again', async () => {
    const ledger = openLedger();
    const { listener, sent, cursors } = makeGateway(ledger, [
      dm('first', T, emailTo('bob@remote.com')),
      dm('second', T + 1, emailTo('carol@remote.com')),
    ]);
    const lookup = ledger.getLatestThreadMappingByConversationId.bind(ledger);
    let failures = 1;
    jest.spyOn(ledger, 'getLatestThreadMappingByConversationId').mockImplementation((conversationId) => {
      if (conversationId === 'conv_first' && failures-- > 0) throw new Error(`lookup failed ${CONTENT_MARKER}`);
      return lookup(conversationId);
    });

    await listener.pollOnce();
    expect(sent.map((s) => s.to)).toEqual(['carol@remote.com']);
    expect(listener.unexpectedFailureCount).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged(error)).toContain('first');
    expect(logged(error)).not.toContain(CONTENT_MARKER);

    await pollTimes(listener, 3);
    expect(sent.map((s) => s.to)).toEqual(['carol@remote.com', 'bob@remote.com']);
    // The cursor waits at the message being tried again, then passes it.
    expect(cursors).toEqual([0, T, T + 1, T + 1]);
    expect(listener.unexpectedFailureCount).toBe(1);
    expect(ledger.getThreadAllowance('carol@remote.com', SENDER)).toBe(3);
    expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
  });

  it('stops trying a message that keeps failing before sending, and moves past it', async () => {
    const ledger = openLedger();
    const { listener, sent, cursors } = makeGateway(ledger, [
      dm('first', T, emailTo('bob@remote.com')),
      dm('second', T + 1, emailTo('carol@remote.com')),
    ]);
    const lookup = ledger.getLatestThreadMappingByConversationId.bind(ledger);
    let attempts = 0;
    jest.spyOn(ledger, 'getLatestThreadMappingByConversationId').mockImplementation((conversationId) => {
      if (conversationId === 'conv_first') {
        attempts++;
        throw new Error('lookup failed');
      }
      return lookup(conversationId);
    });

    await pollTimes(listener, 6);

    expect(attempts).toBe(3);
    expect(listener.unexpectedFailureCount).toBe(3);
    expect(error).toHaveBeenCalledTimes(3);
    expect(sent.map((s) => s.to)).toEqual(['carol@remote.com']);
    expect(cursors).toEqual([0, T, T, T + 1, T + 1, T + 1]);
  });

  it.each([
    ['is the newest', T + 1, T],
    ['has a message after it', T, T + 1],
  ])('does not send again when sending a message that %s fails unexpectedly', async (_name, failingAt, otherAt) => {
    const ledger = openLedger();
    const { listener, deliver, sent, cursors } = makeGateway(ledger, [
      dm('failing', failingAt, emailTo('bob@remote.com')),
      dm('other', otherAt, emailTo('carol@remote.com')),
    ]);
    deliver.mockImplementation(async (params) => {
      sent.push({ to: params.toAddress, raw: new TextDecoder().decode(params.rawRfc822) });
      // The email has reached the transport when the failure is raised.
      if (params.toAddress === 'bob@remote.com') throw new Error(`connection lost ${CONTENT_MARKER}`);
      return { success: true, responseCode: 250, responseMessage: 'OK' } as MxDeliveryResult;
    });

    await pollTimes(listener, 5);

    expect(sent.filter((s) => s.to === 'bob@remote.com')).toHaveLength(1);
    expect(sent.filter((s) => s.to === 'carol@remote.com')).toHaveLength(1);
    expect(ledger.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
    expect(listener.unexpectedFailureCount).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(logged(error)).toContain('failing');
    expect(logged(error)).not.toContain(CONTENT_MARKER);
    expect(cursors.slice(1)).toEqual([T + 1, T + 1, T + 1, T + 1]);
  });

  it('does not send again after a restart when sending failed unexpectedly', async () => {
    const file = ledgerFile();
    const inbox = [dm('failing', T, emailTo('bob@remote.com'))];
    const sent: Sent[] = [];

    const before = openLedger(file);
    const first = makeGateway(before, inbox, { sent });
    first.deliver.mockImplementation(async (params) => {
      sent.push({ to: params.toAddress, raw: '' });
      throw new Error('connection lost');
    });
    await first.listener.pollOnce();
    before.sqlite?.close();
    openLedgers = [];

    const after = openLedger(file);
    await pollTimes(makeGateway(after, inbox, { sent }).listener, 2);

    expect(sent).toHaveLength(1);
    expect(after.getThreadAllowance('bob@remote.com', SENDER)).toBe(3);
  });

  it('keeps no more in memory than the messages the fetch can return again', async () => {
    const ledger = openLedger();
    const inbox: DirectMessageReceived[] = [];
    const { listener } = makeGateway(ledger, inbox);

    for (let i = 0; i < 300; i++) {
      inbox.push(dm(`m${i}`, T + i, [{ type: 'reaction' }]));
      await listener.pollOnce();
      expect(listener.rememberedMessageCount).toBeLessThanOrEqual(1);
    }
    expect(warn).toHaveBeenCalledTimes(300);
  });
});
