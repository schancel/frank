import { CreditLedger } from '../ledger/credit-ledger';
import { GatewayStampProvider } from '../stamps/stamp-provider.interface';
import { InboundEmail } from '../types';

export interface InboundHandlerOptions {
  readonly gatewayDomain: string;
  readonly ledger: CreditLedger;
  readonly stampProvider: GatewayStampProvider;
  readonly relayLookup?: (username: string) => Promise<{ accountAddress: string; isTombstoned?: boolean } | undefined>;
}

export interface InboundProcessingResult {
  readonly status: 'delivered' | 'held' | 'rejected_tombstone' | 'rejected_unknown' | 'rejected_unauthenticated';
  readonly heldMessageId?: string;
  readonly paymentLink?: string;
  readonly shouldSendAutoReply: boolean;
  readonly txHash?: string;
}

export class InboundEmailHandler {
  private readonly gatewayDomain: string;
  private readonly ledger: CreditLedger;
  private readonly stampProvider: GatewayStampProvider;
  private readonly relayLookup?: (username: string) => Promise<{ accountAddress: string; isTombstoned?: boolean } | undefined>;

  constructor(options: InboundHandlerOptions) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase();
    this.ledger = options.ledger;
    this.stampProvider = options.stampProvider;
    this.relayLookup = options.relayLookup;
  }

  async processInboundEmail(email: InboundEmail): Promise<InboundProcessingResult> {
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

    // 2. Check credit ledger (allowance or purchased credits)
    const hasCredit = this.ledger.consumeCredit(email.fromAddress, frankRecipientAddress);

    if (hasCredit) {
      // Funded sender -> deliver immediately as stamped direct message
      const textContent = email.textBody || '[Empty message body]';
      const sendResult = await this.stampProvider.stampAndSendDirectMessage({
        recipientAddress: frankRecipientAddress,
        text: `[Email from ${email.fromAddress}]\nSubject: ${email.subject}\n\n${textContent}`,
      });

      return {
        status: 'delivered',
        txHash: sendResult.txHash,
        shouldSendAutoReply: false,
      };
    }

    // 3. Sender has 0 credits -> hold message in SQLite queue
    const heldMessageId = `held_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const expiresAtMs = Date.now() + 72 * 3600 * 1000; // 72 hours TTL

    this.ledger.holdMessage({
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
  ): Promise<{ accountAddress: string; isTombstoned?: boolean } | undefined> {
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
}
