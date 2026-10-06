import { InboundEmailHandler } from '../src/smtp/inbound-server';
import { OutboundEmailDelivery } from '../src/mta/outbound-delivery';
import { CreditLedger } from '../src/ledger/credit-ledger';
import {
  GatewayStampProvider,
  GatewayWalletBalance,
  StampSubmissionResult,
} from '../src/stamps/stamp-provider.interface';
import { InboundEmail } from '../src/types';

class MockStampProvider implements GatewayStampProvider {
  readonly chainFamily = 'evm' as const;
  readonly assetUnit = 'MON';
  public sentMessages: Array<{ recipientAddress: string; text?: string }> = [];

  async getBalance(): Promise<GatewayWalletBalance> {
    return { raw: 10000000000000000000n, display: '10.0 MON', isLowBalance: false };
  }

  async checkHealth(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Healthy' };
  }

  async stampAndSendDirectMessage(params: {
    recipientAddress: string;
    text?: string;
  }): Promise<StampSubmissionResult> {
    this.sentMessages.push(params);
    return {
      txHash: '0xtx_success',
      payloadDigest: '0xdigest_success',
      recipientAddress: params.recipientAddress,
    };
  }
}

describe('End-to-End Email ↔ Frank Gateway Flow', () => {
  let ledger: CreditLedger;
  let stampProvider: MockStampProvider;
  let inboundHandler: InboundEmailHandler;
  let outboundDelivery: OutboundEmailDelivery;

  const mockRelayDirectory = new Map<string, { accountAddress: string; isTombstoned?: boolean }>([
    ['alice', { accountAddress: '0xalice_1234567890123456789012345678901234' }],
    ['bob_deactivated', { accountAddress: '0xbob_1234567890123456789012345678901234', isTombstoned: true }],
  ]);

  beforeEach(() => {
    ledger = new CreditLedger(':memory:');
    stampProvider = new MockStampProvider();

    inboundHandler = new InboundEmailHandler({
      gatewayDomain: 'frank.org',
      ledger,
      stampProvider,
      relayLookup: async (username) => mockRelayDirectory.get(username),
    });

    outboundDelivery = new OutboundEmailDelivery({
      gatewayDomain: 'frank.org',
      ledger,
    });
  });

  it('suppresses payment auto-reply on unauthenticated mail to prevent backscatter', async () => {
    const unauthenticatedEmail: InboundEmail = {
      messageId: '<fake_msg_1@spoofer.com>',
      fromAddress: 'victim@spoofer.com',
      fromDomain: 'spoofer.com',
      toAddress: 'alice@frank.org',
      localPart: 'alice',
      subject: 'Phishing Attempt',
      textBody: 'Please click here...',
      dkimValid: false, // Spoofed / unauthenticated
      spfValid: false,
      rawRfc822: new TextEncoder().encode('...'),
    };

    const result = await inboundHandler.processInboundEmail(unauthenticatedEmail);
    expect(result.status).toBe('held');
    expect(result.shouldSendAutoReply).toBe(false); // No backscatter!
    expect(stampProvider.sentMessages.length).toBe(0);
  });

  it('rejects email to tombstoned deactivated handles', async () => {
    const emailToTombstone: InboundEmail = {
      messageId: '<valid_msg@trusted.com>',
      fromAddress: 'sender@trusted.com',
      fromDomain: 'trusted.com',
      toAddress: 'bob_deactivated@frank.org',
      localPart: 'bob_deactivated',
      subject: 'Are you there?',
      textBody: 'Hello Bob...',
      dkimValid: true,
      spfValid: true,
      rawRfc822: new TextEncoder().encode('...'),
    };

    const result = await inboundHandler.processInboundEmail(emailToTombstone);
    expect(result.status).toBe('rejected_tombstone');
    expect(stampProvider.sentMessages.length).toBe(0);
  });

  it('complete multi-turn flow: hold -> purchase -> delivery -> reply with allowance -> free return email', async () => {
    // Step 1: DKIM-authenticated email arrives from sender with 0 credits
    const firstContact: InboundEmail = {
      messageId: '<job_offer@recruiter.com>',
      fromAddress: 'recruiter@recruiter.com',
      fromDomain: 'recruiter.com',
      toAddress: 'alice@frank.org',
      localPart: 'alice',
      subject: 'Principal Architect Role',
      textBody: 'Hi Alice, we would love to connect about an open role.',
      dkimValid: true, // Valid DKIM!
      spfValid: true,
      rawRfc822: new TextEncoder().encode('Hi Alice, we would love to connect about an open role.'),
    };

    const step1 = await inboundHandler.processInboundEmail(firstContact);
    expect(step1.status).toBe('held');
    expect(step1.shouldSendAutoReply).toBe(true);
    expect(step1.paymentLink).toContain('https://frank.org/pay/');
    expect(stampProvider.sentMessages.length).toBe(0);

    // Step 2: Sender pays via payment link
    ledger.addCredits('recruiter@recruiter.com', 5, 'stripe_ch_001', 'stripe');
    const held = ledger.releaseHeldMessage(step1.heldMessageId!);
    expect(held).toBeDefined();

    // Consume 1 credit & stamp for Alice
    ledger.consumeCredit(held!.senderEmail, held!.recipientAddress);
    await stampProvider.stampAndSendDirectMessage({
      recipientAddress: held!.recipientAddress,
      text: `[Email from ${held!.senderEmail}]\nSubject: ${held!.subject}\n\n${new TextDecoder().decode(held!.rawRfc822)}`,
    });

    expect(ledger.getBalance('recruiter@recruiter.com')).toBe(4);
    expect(stampProvider.sentMessages.length).toBe(1);
    expect(stampProvider.sentMessages[0].recipientAddress).toBe('0xalice_1234567890123456789012345678901234');

    // Step 3: Alice replies on Frank to recruiter
    const aliceReply = await outboundDelivery.processOutboundDirectMessage({
      conversationId: 'conv_alice_recruiter',
      frankMessageId: 'frank_msg_reply_1',
      senderFrankAddress: '0xalice_1234567890123456789012345678901234',
      recipientEmail: 'recruiter@recruiter.com',
      subject: 'Re: Principal Architect Role',
      bodyText: 'Thanks! I would be interested in seeing the JD.',
    });

    expect(aliceReply.renderedEmail).toContain('Subject: Re: Principal Architect Role');
    expect(aliceReply.renderedEmail).toContain('Sent via Frank. Reply to this email to continue the thread for free');
    expect(aliceReply.grantedReplyAllowance).toBe(3);

    // Recruiter now has 3 free replies scoped to Alice
    expect(ledger.getThreadAllowance('recruiter@recruiter.com', '0xalice_1234567890123456789012345678901234')).toBe(3);

    // Step 4: Recruiter sends second email back to Alice
    const recruiterReply: InboundEmail = {
      messageId: '<jd_attach@recruiter.com>',
      fromAddress: 'recruiter@recruiter.com',
      fromDomain: 'recruiter.com',
      toAddress: 'alice@frank.org',
      localPart: 'alice',
      subject: 'Re: Principal Architect Role',
      textBody: 'Here is the job description link...',
      dkimValid: true,
      spfValid: true,
      inReplyTo: aliceReply.rfc822MessageId,
      rawRfc822: new TextEncoder().encode('Here is the job description link...'),
    };

    const step4 = await inboundHandler.processInboundEmail(recruiterReply);
    expect(step4.status).toBe('delivered'); // Delivered immediately without purchasing!

    // Consumed 1 reply allowance, global purchased credits remain at 4!
    expect(ledger.getThreadAllowance('recruiter@recruiter.com', '0xalice_1234567890123456789012345678901234')).toBe(2);
    expect(ledger.getBalance('recruiter@recruiter.com')).toBe(4);
    expect(stampProvider.sentMessages.length).toBe(2);
  });
});
