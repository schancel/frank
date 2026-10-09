import { CreditLedger } from '../ledger/credit-ledger';
import { ThreadMappingRecord } from '../types';
import {
  assertHeaderValue,
  parseMessageId,
  renderThreadHeaders,
  singleLineHeaderText,
} from '../rfc/message-headers';
import { isEnvelopeAddress } from './mx-transport';

/**
 * Thrown when a message cannot be rendered because a value destined for a
 * header is not valid for that header. It is raised before anything is
 * recorded, and the same message will be refused again however often it is
 * offered, so callers treat it as a permanent outcome.
 */
export class OutboundRenderRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRenderRefusal';
  }
}

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
// Printable ASCII without the characters that delimit parts of an address header.
const SENDER_NAME_PATTERN = /^[\x21\x23-\x27\x2a\x2b\x2d-\x3a\x3d\x3f\x41-\x5a\x5e-\x7e]+$/;

/**
 * Lowercases and trims an email address. Returns undefined when the value
 * holds a control character or is not an address the transport can deliver to.
 */
export function canonicalEmailAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) return undefined;
  const address = value.toLowerCase().trim();
  return isEnvelopeAddress(address) ? address : undefined;
}

/** A Cc entry is written as given, so it must already be a plain address. */
export function isHeaderAddress(value: unknown): value is string {
  return typeof value === 'string' && isEnvelopeAddress(value);
}

export interface OutboundDirectMessage {
  readonly conversationId: string;
  readonly frankMessageId: string;
  readonly senderFrankAddress: string;
  readonly recipientEmail: string;
  readonly ccRecipients?: string[];
  readonly bodyText: string;
  readonly htmlBody?: string;
  readonly subject?: string;
  readonly inReplyToFrankMessageId?: string;
  readonly senderHomeRelay?: string;
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
    // Every header value is checked here, before anything is recorded.
    const canonicalRecipient = canonicalEmailAddress(dm.recipientEmail);
    if (canonicalRecipient === undefined) {
      throw new OutboundRenderRefusal('recipient is not a valid email address');
    }
    if (typeof dm.senderFrankAddress !== 'string' || !SENDER_NAME_PATTERN.test(dm.senderFrankAddress)) {
      throw new OutboundRenderRefusal('sender address cannot be written in a From header');
    }
    const ccRecipients = dm.ccRecipients?.filter(isHeaderAddress);
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
        // Only a valid message ID is written; without one the reply goes out unthreaded.
        inReplyToRfc822 = parseMessageId(parentMapping.rfc822MessageId ?? '');
        if (inReplyToRfc822 === undefined) {
          console.warn(
            `[OutboundEmailDelivery] No valid message ID stored for the parent of ${dm.frankMessageId}; sending without thread headers`
          );
        }
      }
    }

    const subject =
      singleLineHeaderText(typeof dm.subject === 'string' ? dm.subject : '') ||
      (inReplyToRfc822 ? 'Re: Frank Message' : 'Message from Frank');
    const fromHeader = `From: ${dm.senderFrankAddress} <${dm.senderFrankAddress}@${this.gatewayDomain}>`;
    const toHeader = `To: ${canonicalRecipient}`;
    const ccHeader = ccRecipients && ccRecipients.length > 0 ? `Cc: ${ccRecipients.join(', ')}` : '';
    const subjectHeader = `Subject: ${subject}`;
    const dateHeader = `Date: ${new Date(now).toUTCString()}`;
    let threadHeaders: string;
    try {
      for (const header of [fromHeader, toHeader, ccHeader, subjectHeader, dateHeader]) {
        assertHeaderValue(header);
      }
      threadHeaders = renderThreadHeaders({
        messageId: rfc822MessageId,
        inReplyTo: inReplyToRfc822,
        references: inReplyToRfc822 ? [inReplyToRfc822] : [],
      })
        .replace(/\r\n/g, '\n')
        .replace(/\n$/, '');
    } catch (err: unknown) {
      throw new OutboundRenderRefusal(err instanceof Error ? err.message : String(err));
    }

    // 2. Grant reply allowance back to this email sender
    const allowanceCount = 3;
    this.ledger.grantReplyAllowance(
      canonicalRecipient,
      dm.senderFrankAddress,
      allowanceCount
    );

    // 3. Record thread mapping
    const mapping: ThreadMappingRecord = {
      conversationId: dm.conversationId,
      frankMessageId: dm.frankMessageId,
      rfc822MessageId,
      inReplyToRfc822,
      subject,
      senderAddress: dm.senderFrankAddress,
      toRecipientsJson: JSON.stringify([{ address: canonicalRecipient }]),
      ccRecipientsJson: ccRecipients ? JSON.stringify(ccRecipients.map((c) => ({ address: c }))) : undefined,
      senderHomeRelay: dm.senderHomeRelay,
      createdAtMs: now,
    };
    this.ledger.recordThreadMapping(mapping);

    // 4. Construct RFC 5322 Email
    const signupFooter = `\n\n---\nSent via Frank. Reply to this email to continue the thread for free, or sign up at https://frank.org.`;
    const fullBody = `${dm.bodyText}${signupFooter}`;

    const headers = [
      fromHeader,
      toHeader,
      ccHeader,
      subjectHeader,
      dateHeader,
      threadHeaders,
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
