import { CreditLedger } from '../ledger/credit-ledger';
import { ThreadMappingRecord } from '../types';

export interface OutboundDirectMessage {
  readonly conversationId: string;
  readonly frankMessageId: string;
  readonly senderFrankAddress: string;
  readonly recipientEmail: string;
  readonly bodyText: string;
  readonly subject?: string;
  readonly inReplyToFrankMessageId?: string;
}

export interface OutboundDeliveryResult {
  readonly rfc822MessageId: string;
  readonly inReplyToRfc822?: string;
  readonly renderedEmail: string;
  readonly grantedReplyAllowance: number;
}

export class OutboundEmailDelivery {
  private readonly gatewayDomain: string;
  private readonly ledger: CreditLedger;

  constructor(options: { gatewayDomain: string; ledger: CreditLedger }) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase();
    this.ledger = options.ledger;
  }

  async processOutboundDirectMessage(
    dm: OutboundDirectMessage
  ): Promise<OutboundDeliveryResult> {
    const canonicalRecipient = dm.recipientEmail.toLowerCase().trim();
    const now = Date.now();
    const rfc822MessageId = `<frank_${dm.frankMessageId}_${now}@${this.gatewayDomain}>`;

    // 1. Threading lookup
    let inReplyToRfc822: string | undefined;
    if (dm.inReplyToFrankMessageId) {
      const parentMapping = this.ledger.getThreadMappingByFrankMessageId(
        dm.conversationId,
        dm.inReplyToFrankMessageId
      );
      if (parentMapping) {
        inReplyToRfc822 = parentMapping.rfc822MessageId;
      }
    }

    // 2. Grant reply allowance back to this email sender
    const allowanceCount = 3;
    this.ledger.grantReplyAllowance(
      canonicalRecipient,
      dm.senderFrankAddress,
      allowanceCount
    );

    // 3. Record thread mapping
    const subject = dm.subject || (inReplyToRfc822 ? 'Re: Frank Message' : 'Message from Frank');
    const mapping: ThreadMappingRecord = {
      conversationId: dm.conversationId,
      frankMessageId: dm.frankMessageId,
      rfc822MessageId,
      inReplyToRfc822,
      subject,
      createdAtMs: now,
    };
    this.ledger.recordThreadMapping(mapping);

    // 4. Construct RFC 5322 Email
    const fromHeader = `From: ${dm.senderFrankAddress} <${dm.senderFrankAddress}@${this.gatewayDomain}>`;
    const toHeader = `To: ${canonicalRecipient}`;
    const subjectHeader = `Subject: ${subject}`;
    const dateHeader = `Date: ${new Date(now).toUTCString()}`;
    const messageIdHeader = `Message-ID: ${rfc822MessageId}`;
    const inReplyToHeader = inReplyToRfc822 ? `In-Reply-To: ${inReplyToRfc822}\nReferences: ${inReplyToRfc822}` : '';

    const signupFooter = `\n\n---\nSent via Frank. Reply to this email to continue the thread for free, or sign up at https://frank.org.`;
    const fullBody = `${dm.bodyText}${signupFooter}`;

    const headers = [
      fromHeader,
      toHeader,
      subjectHeader,
      dateHeader,
      messageIdHeader,
      inReplyToHeader,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ]
      .filter((h) => h.length > 0)
      .join('\n');

    const renderedEmail = `${headers}\n\n${fullBody}`;

    return {
      rfc822MessageId,
      inReplyToRfc822,
      renderedEmail,
      grantedReplyAllowance: allowanceCount,
    };
  }
}
