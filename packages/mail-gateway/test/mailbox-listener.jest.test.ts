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
