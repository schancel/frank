import { CreditLedger } from '../ledger/credit-ledger';
import { OutboundMtaWorker } from '../mta/outbound-worker';
import { extractEmailAddress, extractEmailParty } from '../smtp/smtp-listener';
import type {
  ActiveChain,
  DirectMessageReceived,
  WalletHandle,
} from '@frank/wallet/chain/active-chain';
import type { EmailItem, TextItem } from '@frank/cashweb/types/messages';

export interface RelayMailboxListenerOptions {
  readonly gatewayDomain: string;
  readonly activeChain: ActiveChain;
  readonly wallet: WalletHandle;
  readonly ledger: CreditLedger;
  readonly outboundWorker: OutboundMtaWorker;
  readonly relayUrl?: string;
  readonly pollIntervalMs?: number;
  readonly maxNewThreadsPerDay?: number;
}

export class RelayMailboxListener {
  private readonly gatewayDomain: string;
  private readonly activeChain: ActiveChain;
  private readonly wallet: WalletHandle;
  private readonly ledger: CreditLedger;
  private readonly outboundWorker: OutboundMtaWorker;
  private readonly relayUrl?: string;
  private readonly pollIntervalMs: number;
  private readonly maxNewThreadsPerDay: number;

  private isRunning = false;
  private pollTimer?: NodeJS.Timeout;
  private lastPolledTimeMs = 0;
  private processingLock = false;

  constructor(options: RelayMailboxListenerOptions) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase().trim();
    this.activeChain = options.activeChain;
    this.wallet = options.wallet;
    this.ledger = options.ledger;
    this.outboundWorker = options.outboundWorker;
    this.relayUrl = options.relayUrl;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.maxNewThreadsPerDay = options.maxNewThreadsPerDay ?? 50;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastPolledTimeMs = Date.now() - 60_000; // Look back 1 minute on startup

    // Run first poll immediately
    await this.pollOnce();

    // Schedule regular polling
    this.pollTimer = setInterval(async () => {
      if (!this.isRunning) return;
      await this.pollOnce();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.processingLock) return;
    this.processingLock = true;
    try {
      const messages = await this.activeChain.directMessages.fetchSince({
        wallet: this.wallet,
        sinceMs: this.lastPolledTimeMs,
      });

      for (const msg of messages) {
        if (msg.receivedTime > this.lastPolledTimeMs) {
          this.lastPolledTimeMs = msg.receivedTime;
        }

        // Ignore outbound/own messages echoed in the mailbox
        if (msg.outbound) continue;

        await this.processDirectMessage(msg);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Suppress or log transient network/polling errors
      console.warn(`[RelayMailboxListener] Error polling relay mailbox: ${errMsg}`);
    } finally {
      this.processingLock = false;
    }
  }

  async processDirectMessage(msg: DirectMessageReceived): Promise<void> {
    const senderFrankAddress = msg.senderAddress.raw.toLowerCase();
    const conversationId = msg.conversationId;

    // Look for EmailItem or TextItem
    const emailItem = msg.items.find((i): i is EmailItem => i.type === 'email');
    const textItem = msg.items.find((i): i is TextItem => i.type === 'text');

    if (!emailItem && !textItem) {
      return; // Not a supported message format for email bridging
    }

    // 1. Thread lookup to determine if this is a reply to an existing email thread
    let existingThread = conversationId
      ? this.ledger.getLatestThreadMappingByConversationId(conversationId)
      : undefined;

    if (!existingThread && emailItem?.inReplyTo) {
      existingThread = this.ledger.getThreadMappingByRfc822Id(emailItem.inReplyTo);
    }

    if (existingThread) {
      // Existing thread -> Handle reply
      await this.handleThreadReply(msg, existingThread, emailItem, textItem);
    } else {
      // New thread initiation -> Check rate limit and dispatch
      await this.handleNewEmailInitiation(msg, emailItem, textItem);
    }
  }

  private async handleThreadReply(
    msg: DirectMessageReceived,
    thread: NonNullable<ReturnType<CreditLedger['getLatestThreadMappingByConversationId']>>,
    emailItem?: EmailItem,
    textItem?: TextItem
  ): Promise<void> {
    const senderFrankAddress = msg.senderAddress.raw.toLowerCase();
    const conversationId = msg.conversationId || thread.conversationId;
    const frankMessageId = msg.messageId || msg.payloadDigest;

    // Determine destination recipients
    let primaryRecipient: string;
    let ccRecipients: string[] = [];

    if (emailItem && emailItem.to && emailItem.to.length > 0) {
      // User explicitly specified To / Cc in their rich EmailItem composer
      primaryRecipient = emailItem.to[0].address.toLowerCase().trim();
      const restTo = emailItem.to.slice(1).map((p) => p.address.toLowerCase().trim());
      const rawCc = emailItem.cc ? emailItem.cc.map((p) => p.address.toLowerCase().trim()) : [];
      ccRecipients = [...restTo, ...rawCc];
    } else {
      // Standard email semantics based on thread mapping:
      // If thread has original sender_address, that is the primary recipient.
      primaryRecipient = (thread.senderAddress || '').toLowerCase().trim();
      if (!primaryRecipient && thread.toRecipientsJson) {
        try {
          const parsed = JSON.parse(thread.toRecipientsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            primaryRecipient = parsed[0].address;
          }
        } catch {}
      }

      // Multi-party thread detection: default to Reply-All convention
      let allOriginalRecipients: string[] = [];
      if (thread.toRecipientsJson) {
        try {
          const parsed = JSON.parse(thread.toRecipientsJson);
          if (Array.isArray(parsed)) {
            allOriginalRecipients.push(...parsed.map((p: any) => p.address?.toLowerCase().trim()));
          }
        } catch {}
      }
      if (thread.ccRecipientsJson) {
        try {
          const parsed = JSON.parse(thread.ccRecipientsJson);
          if (Array.isArray(parsed)) {
            allOriginalRecipients.push(...parsed.map((p: any) => p.address?.toLowerCase().trim()));
          }
        } catch {}
      }

      // Filter out primaryRecipient and gateway's own domain addresses
      ccRecipients = Array.from(
        new Set(
          allOriginalRecipients.filter(
            (addr) =>
              Boolean(addr) &&
              addr !== primaryRecipient &&
              !addr.endsWith(`@${this.gatewayDomain}`)
          )
        )
      );
    }

    if (!primaryRecipient || !primaryRecipient.includes('@')) {
      console.warn(
        `[RelayMailboxListener] Could not determine valid primary recipient for thread ${conversationId}`
      );
      return;
    }

    const bodyText = emailItem?.textBody || textItem?.text || '';
    let subject = emailItem?.subject || thread.subject || 'Re: Frank Message';
    if (!subject.toLowerCase().startsWith('re:')) {
      subject = `Re: ${subject}`;
    }

    await this.outboundWorker.dispatchMessage({
      conversationId,
      frankMessageId,
      senderFrankAddress,
      recipientEmail: primaryRecipient,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bodyText,
      htmlBody: emailItem?.htmlBody,
      subject,
      inReplyToFrankMessageId: thread.frankMessageId,
      senderHomeRelay: thread.senderHomeRelay,
    });
  }

  private async handleNewEmailInitiation(
    msg: DirectMessageReceived,
    emailItem?: EmailItem,
    textItem?: TextItem
  ): Promise<void> {
    const senderFrankAddress = msg.senderAddress.raw.toLowerCase();
    const conversationId =
      msg.conversationId ||
      `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const frankMessageId = msg.messageId || msg.payloadDigest;

    // Quota check: limit new outbound threads per Frank user per 24 hours
    const initiatedCount = this.ledger.countInitiatedThreadsInPast24Hours(senderFrankAddress);
    if (initiatedCount >= this.maxNewThreadsPerDay) {
      console.warn(
        `[RelayMailboxListener] Sender ${senderFrankAddress} exceeded daily new thread quota (${initiatedCount}/${this.maxNewThreadsPerDay})`
      );
      return;
    }

    let primaryRecipient: string | undefined;
    let ccRecipients: string[] = [];
    let subject = 'Message from Frank';
    let bodyText = '';

    if (emailItem) {
      if (emailItem.to && emailItem.to.length > 0) {
        primaryRecipient = emailItem.to[0].address.toLowerCase().trim();
        const otherTo = emailItem.to.slice(1).map((p) => p.address.toLowerCase().trim());
        const otherCc = emailItem.cc ? emailItem.cc.map((p) => p.address.toLowerCase().trim()) : [];
        ccRecipients = [...otherTo, ...otherCc];
      }
      subject = emailItem.subject || subject;
      bodyText = emailItem.textBody || '';
    } else if (textItem) {
      // Parse plain text message for headers: "To: ...", "Subject: ...", etc.
      const lines = textItem.text.split('\n');
      let bodyLines: string[] = [];
      let inBody = false;

      for (const line of lines) {
        if (inBody) {
          bodyLines.push(line);
          continue;
        }

        const trimmed = line.trim();
        if (trimmed === '') {
          inBody = true;
          continue;
        }

        const matchTo = trimmed.match(/^to:\s*(.+)$/i);
        if (matchTo) {
          const parts = matchTo[1].split(',').map((p) => extractEmailAddress(p.trim()));
          if (parts.length > 0 && parts[0].includes('@')) {
            primaryRecipient = parts[0];
            ccRecipients = parts.slice(1).filter((p) => p.includes('@'));
          }
          continue;
        }

        const matchCc = trimmed.match(/^cc:\s*(.+)$/i);
        if (matchCc) {
          const parts = matchCc[1].split(',').map((p) => extractEmailAddress(p.trim()));
          ccRecipients.push(...parts.filter((p) => p.includes('@')));
          continue;
        }

        const matchSubject = trimmed.match(/^subject:\s*(.+)$/i);
        if (matchSubject) {
          subject = matchSubject[1].trim();
          continue;
        }

        // If line doesn't look like a header, start of body
        inBody = true;
        bodyLines.push(line);
      }

      bodyText = bodyLines.join('\n').trim();
    }

    if (!primaryRecipient || !primaryRecipient.includes('@')) {
      console.warn(
        `[RelayMailboxListener] Could not parse destination email address from DM by ${senderFrankAddress}`
      );
      return;
    }

    await this.outboundWorker.dispatchMessage({
      conversationId,
      frankMessageId,
      senderFrankAddress,
      recipientEmail: primaryRecipient,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bodyText,
      htmlBody: emailItem?.htmlBody,
      subject,
    });
  }
}
