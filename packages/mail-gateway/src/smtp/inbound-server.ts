import * as crypto from 'node:crypto';
import { CreditLedger } from '../ledger/credit-ledger';
import { GatewayStampProvider } from '../stamps/stamp-provider.interface';
import { InboundEmail } from '../types';
import { BlobStore } from '../storage/blob-store';
import type { MessageItem } from '@frank/cashweb/types/messages';
import { isOperationalLocalPart } from '../mailbox/operational-local-parts';
import { extractOpenPgpArmoredMessage, isOpenPgpArmoredMessage } from '../wkd/wkd';

export interface InboundRecipientResolution {
  readonly accountAddress: string;
  /** An issued thread alias fixes conversation routing, regardless of email headers or subject. */
  readonly conversationId?: string;
  readonly isTombstoned?: boolean;
  readonly isMoved?: boolean;
  readonly redirectTo?: string;
  readonly entry?: { content_type: string; raw_hex: string };
}

export interface InboundHandlerOptions {
  readonly gatewayDomain: string;
  readonly ledger: CreditLedger;
  readonly stampProvider: GatewayStampProvider;
  /** Must resolve only previously issued mailbox local parts, never arbitrary directory usernames. */
  readonly relayLookup?: (localPart: string) => Promise<InboundRecipientResolution | undefined>;
  readonly blobStore?: BlobStore;
}

export interface InboundProcessingResult {
  readonly status:
    | 'delivered'
    | 'held'
    | 'rejected_tombstone'
    | 'rejected_unknown'
    | 'rejected_reserved'
    | 'rejected_unauthenticated'
    | 'bounce';
  readonly heldMessageId?: string;
  readonly paymentLink?: string;
  readonly shouldSendAutoReply: boolean;
  readonly txHash?: string;
  readonly conversationId?: string;
  readonly inReplyToFrankMessageId?: string;
  readonly bounceRecipient?: string;
  readonly bounceNotificationSent?: boolean;
}

export function parseBounceDetails(
  email: InboundEmail,
  gatewayDomain: string
): {
  failedRecipient?: string;
  originalMessageId?: string;
  reason?: string;
} {
  const fullText = [
    email.subject,
    email.textBody,
    new TextDecoder().decode(email.rawRfc822),
  ].join('\n');

  let failedRecipient: string | undefined;

  const recipientPatterns = [
    /final-recipient:\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)>?/i,
    /original-recipient:\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)>?/i,
    /x-failed-recipients:\s*<?([^\s>;,]+@[^\s>;,]+)>?/i,
    /failed-recipient:\s*<?([^\s>;,]+@[^\s>;,]+)>?/i,
    /failed to deliver to\s*<?([^\s>;]+@[^\s>;]+)>?/i,
    /recipient address(?: rejected)?:\s*<?([^\s>;]+@[^\s>;]+)>?/i,
    /delivery to\s*<?([^\s>;]+@[^\s>;]+)>?\s*failed/i,
    /unable to deliver to\s*<?([^\s>;]+@[^\s>;]+)>?/i,
  ];

  for (const pattern of recipientPatterns) {
    const match = fullText.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim().toLowerCase();
      if (!candidate.endsWith(`@${gatewayDomain.toLowerCase()}`)) {
        failedRecipient = candidate;
        break;
      }
    }
  }

  if (!failedRecipient) {
    const toMatch = fullText.match(/\nTo:\s*<?([^\s>;]+@[^\s>;]+)>?/i);
    if (toMatch && toMatch[1]) {
      const candidate = toMatch[1].trim().toLowerCase();
      if (!candidate.endsWith(`@${gatewayDomain.toLowerCase()}`)) {
        failedRecipient = candidate;
      }
    }
  }

  let originalMessageId: string | undefined = email.inReplyTo;
  if (!originalMessageId) {
    const msgIdMatch = fullText.match(/(?:original-message-id|message-id):\s*(<[^>]+>)/i);
    if (msgIdMatch) {
      originalMessageId = msgIdMatch[1].trim();
    }
  }

  const reasonMatch = fullText.match(/(?:status|diagnostic-code):\s*(.+)/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : undefined;

  return { failedRecipient, originalMessageId, reason };
}

export class InboundEmailHandler {
  private readonly gatewayDomain: string;
  private readonly ledger: CreditLedger;
  private readonly stampProvider: GatewayStampProvider;
  private readonly relayLookup?: (username: string) => Promise<InboundRecipientResolution | undefined>;
  readonly blobStore?: BlobStore;

  constructor(options: InboundHandlerOptions) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase();
    this.ledger = options.ledger;
    this.stampProvider = options.stampProvider;
    this.blobStore = options.blobStore;
    // Directory usernames do not by themselves issue email addresses. The host
    // must inject an explicit mailbox lookup; legacy relayUrl is not authority.
    this.relayLookup = options.relayLookup;
  }

  async processInboundEmail(email: InboundEmail): Promise<InboundProcessingResult> {
    const localPartLower = email.localPart.toLowerCase().trim();

    // SMTP DATA and its headers are untrusted. A forged bounce+jobId used to
    // trigger a paid Frank notification, so bounce processing stays closed
    // until an authenticated provider event can enter a separate adapter.
    if (isOperationalLocalPart(localPartLower) || localPartLower.startsWith('bounce+')) {
      return { status: 'rejected_reserved', shouldSendAutoReply: false };
    }

    // 1. Resolve recipient address
    const recipientResolution = await this.resolveRecipient(email.localPart);
    if (!recipientResolution) {
      return {
        status: 'rejected_unknown',
        shouldSendAutoReply: false,
      };
    }

    if (recipientResolution.isTombstoned) {
      return {
        status: 'rejected_tombstone',
        shouldSendAutoReply: false,
      };
    }

    const frankRecipientAddress = recipientResolution.accountAddress;

    // 2. Resolve or establish thread mapping (bridging Frank conversationId & threadId)
    let conversationId: string | undefined = recipientResolution.conversationId;
    let inReplyToFrankMessageId: string | undefined;

    if (!conversationId && email.inReplyTo) {
      const parent = this.ledger.getThreadMappingByRfc822Id(email.inReplyTo);
      if (parent) {
        conversationId = parent.conversationId;
        inReplyToFrankMessageId = parent.frankMessageId;
      }
    }

    if (!conversationId && email.references && email.references.length > 0) {
      for (let i = email.references.length - 1; i >= 0; i--) {
        const refParent = this.ledger.getThreadMappingByRfc822Id(email.references[i]);
        if (refParent) {
          conversationId = refParent.conversationId;
          inReplyToFrankMessageId = refParent.frankMessageId;
          break;
        }
      }
    }

    if (!conversationId) {
      // Deterministically derive a standard 16-byte UUID conversation ID from participant pair
      const participantsKey = [
        email.fromAddress.toLowerCase().trim(),
        frankRecipientAddress.toLowerCase().trim(),
      ]
        .sort()
        .join('#');
      const hash = crypto
        .createHash('sha256')
        .update(participantsKey)
        .digest('hex')
        .slice(0, 32);
      conversationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    }

    // 3. Check credit ledger (allowance or purchased credits)
    const hasCredit = this.ledger.consumeCredit(email.fromAddress, frankRecipientAddress);

    if (hasCredit) {
      // Funded sender -> deliver immediately as stamped direct message
      const armoredOpenPgp = isOpenPgpArmoredMessage(email.textBody)
        ? email.textBody
        : extractOpenPgpArmoredMessage(email.textBody, email.rawRfc822);
      const textContent = armoredOpenPgp || email.textBody || '[Empty message body]';

      const emailItem: MessageItem = {
        type: 'email',
        messageId: email.messageId,
        from: {
          address: email.fromAddress,
          name: email.fromName,
        },
        to:
          email.toAddresses && email.toAddresses.length > 0
            ? email.toAddresses.map((t) => ({ address: t.address, name: t.name }))
            : [{ address: email.toAddress }],
        cc: email.ccAddresses?.map((c) => ({ address: c.address, name: c.name })),
        subject: email.subject,
        textBody: textContent,
        htmlBody: email.htmlBody,
        inReplyTo: email.inReplyTo,
        references: email.references,
      };

      const fallbackText = `[Email from ${email.fromAddress}]\nSubject: ${email.subject}\n\n${textContent}`;

      const sendResult = await this.stampProvider.stampAndSendDirectMessage({
        recipientAddress: frankRecipientAddress,
        items: [
          emailItem,
          {
            type: 'text',
            text: fallbackText,
          },
        ],
        text: fallbackText,
        conversationId,
        inReplyToFrankMessageId,
      });

      // Record thread mapping for the incoming delivered message
      const frankMsgId =
        sendResult.txHash ||
        `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.ledger.recordThreadMapping({
        conversationId,
        frankMessageId: frankMsgId,
        rfc822MessageId: email.messageId,
        inReplyToRfc822: email.inReplyTo,
        subject: email.subject,
        senderAddress: email.fromAddress,
        toRecipientsJson: JSON.stringify(
          email.toAddresses && email.toAddresses.length > 0
            ? email.toAddresses
            : [{ address: email.toAddress }]
        ),
        ccRecipientsJson: email.ccAddresses ? JSON.stringify(email.ccAddresses) : undefined,
        createdAtMs: Date.now(),
      });

      return {
        status: 'delivered',
        txHash: sendResult.txHash,
        conversationId,
        inReplyToFrankMessageId,
        shouldSendAutoReply: false,
      };
    }

    // 3. Sender has 0 credits -> hold message in SQLite queue
    const heldMessageId = `held_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const expiresAtMs = Date.now() + 72 * 3600 * 1000; // 72 hours TTL

    await this.ledger.holdMessage({
      id: heldMessageId,
      senderEmail: email.fromAddress,
      recipientAddress: frankRecipientAddress,
      dkimDomain: email.fromDomain,
      subject: email.subject,
      rawRfc822: email.rawRfc822,
      createdAtMs: Date.now(),
      expiresAtMs,
    });

    const paymentLink = `https://${this.gatewayDomain}/pay/${heldMessageId}`;

    // Anti-backscatter guard: only send auto-reply if DKIM is valid and domain aligned
    const shouldSendAutoReply = email.dkimValid;

    return {
      status: 'held',
      heldMessageId,
      paymentLink,
      shouldSendAutoReply,
    };
  }

  private async resolveRecipient(
    localPart: string
  ): Promise<InboundRecipientResolution | undefined> {
    const canonicalLocal = localPart.toLowerCase().trim();

    // A bare address is not an issued mailbox. The configured lookup must be
    // backed by an issuance registry; without it, catch-all mail cannot spend credit.
    if (this.relayLookup) {
      return await this.relayLookup(canonicalLocal);
    }
    return undefined;
  }

}
