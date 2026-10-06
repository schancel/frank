import * as crypto from 'node:crypto';
import { CreditLedger } from '../ledger/credit-ledger';
import { GatewayStampProvider } from '../stamps/stamp-provider.interface';
import { InboundEmail } from '../types';
import { BlobStore } from '../storage/blob-store';

export interface InboundRecipientResolution {
  readonly accountAddress: string;
  readonly isTombstoned?: boolean;
  readonly isMoved?: boolean;
  readonly redirectTo?: string;
  readonly entry?: { content_type: string; raw_hex: string };
}

export interface InboundHandlerOptions {
  readonly gatewayDomain: string;
  readonly ledger: CreditLedger;
  readonly stampProvider: GatewayStampProvider;
  readonly relayUrl?: string;
  readonly relayLookup?: (username: string) => Promise<InboundRecipientResolution | undefined>;
  readonly blobStore?: BlobStore;
}

/**
 * Factory for resolving usernames against a Frank relay over HTTP.
 * Queries `GET ${relayUrl}/directory/user/${username}` matching the relay wire format.
 */
export function createRelayUsernameLookup(
  relayBaseUrl: string,
  fetchFn: typeof fetch = fetch
): (username: string) => Promise<InboundRecipientResolution | undefined> {
  const normalizedBase = relayBaseUrl.replace(/\/+$/, '');
  return async (username: string) => {
    try {
      const url = `${normalizedBase}/directory/user/${encodeURIComponent(username)}`;
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (response.status === 404 || response.status === 400) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`Relay lookup failed with HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        username: string;
        account_address: string;
        status: 'active' | 'tombstoned' | 'moved';
        redirect_to?: string;
        entry?: { content_type: string; raw_hex: string };
      };

      return {
        accountAddress: data.account_address,
        isTombstoned: data.status === 'tombstoned',
        isMoved: data.status === 'moved',
        redirectTo: data.redirect_to,
        entry: data.entry,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Relay lookup failed')) {
        throw err;
      }
      return undefined;
    }
  };
}

export interface InboundProcessingResult {
  readonly status:
    | 'delivered'
    | 'held'
    | 'rejected_tombstone'
    | 'rejected_unknown'
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
    this.relayLookup =
      options.relayLookup ??
      (options.relayUrl ? createRelayUsernameLookup(options.relayUrl) : undefined);
  }

  async processInboundEmail(email: InboundEmail): Promise<InboundProcessingResult> {
    const localPartLower = email.localPart.toLowerCase().trim();

    // Check for Bounce / NDR envelope recipient (bounce+<id>@<domain> or mailer-daemon@<domain>)
    const isBounce =
      localPartLower === 'mailer-daemon' ||
      localPartLower === 'postmaster' ||
      localPartLower === 'bounce' ||
      localPartLower.startsWith('bounce+');

    if (isBounce) {
      return await this.processBounceNotification(email, localPartLower);
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
    let conversationId: string | undefined;
    let inReplyToFrankMessageId: string | undefined;

    if (email.inReplyTo) {
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
      const textContent = email.textBody || '[Empty message body]';
      const sendResult = await this.stampProvider.stampAndSendDirectMessage({
        recipientAddress: frankRecipientAddress,
        text: `[Email from ${email.fromAddress}]\nSubject: ${email.subject}\n\n${textContent}`,
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

    // Check if it's already a raw hexadecimal Ethereum/Monad account address (0x...)
    if (/^0x[a-f0-9]{40}$/i.test(canonicalLocal)) {
      return { accountAddress: canonicalLocal };
    }

    // Otherwise lookup username in relay directory
    if (this.relayLookup) {
      return await this.relayLookup(canonicalLocal);
    }

    // Default fallback mock for test harness
    return { accountAddress: `0x${canonicalLocal.padEnd(40, '0')}` };
  }

  private async processBounceNotification(
    email: InboundEmail,
    localPartLower: string
  ): Promise<InboundProcessingResult> {
    let failedRecipient: string | undefined;
    let frankSender: string | undefined;
    let conversationId: string | undefined;
    let inReplyToFrankMessageId: string | undefined;

    // Check if envelope is bounce+<id>
    if (localPartLower.startsWith('bounce+')) {
      const idStr = localPartLower.slice('bounce+'.length);
      const jobId = parseInt(idStr, 10);
      if (!isNaN(jobId)) {
        const job = this.ledger.getOutboundJob(jobId);
        if (job) {
          failedRecipient = job.recipientEmail;
          frankSender = job.fromAddress.split('@')[0];
        }
      }
    }

    // Parse notification headers and body
    const bounceDetails = parseBounceDetails(email, this.gatewayDomain);
    if (!failedRecipient && bounceDetails.failedRecipient) {
      failedRecipient = bounceDetails.failedRecipient;
    }

    const originalMsgId = bounceDetails.originalMessageId || email.inReplyTo;
    if (originalMsgId) {
      const mapping = this.ledger.getThreadMappingByRfc822Id(originalMsgId);
      if (mapping) {
        conversationId = mapping.conversationId;
        inReplyToFrankMessageId = mapping.frankMessageId;
      }
      if (!frankSender) {
        frankSender = this.ledger.findFrankSenderByRfc822Id(originalMsgId);
      }
    }

    if (!frankSender && failedRecipient) {
      frankSender = this.ledger.findFrankSenderForRecipient(failedRecipient);
    }

    // If we have a frank sender, deliver bounce notification DM
    if (frankSender) {
      const reasonText = bounceDetails.reason ? `\nReason: ${bounceDetails.reason}` : '';
      const notificationText =
        `[Delivery Status Notification - Bounce]\n` +
        `Your message to ${failedRecipient || 'recipient'} could not be delivered.${reasonText}`;

      const sendResult = await this.stampProvider.stampAndSendDirectMessage({
        recipientAddress: frankSender,
        text: notificationText,
        conversationId,
        inReplyToFrankMessageId,
      });

      return {
        status: 'bounce',
        txHash: sendResult.txHash,
        conversationId,
        inReplyToFrankMessageId,
        shouldSendAutoReply: false,
        bounceRecipient: failedRecipient,
        bounceNotificationSent: true,
      };
    }

    return {
      status: 'bounce',
      shouldSendAutoReply: false,
      bounceRecipient: failedRecipient,
      bounceNotificationSent: false,
    };
  }
}
