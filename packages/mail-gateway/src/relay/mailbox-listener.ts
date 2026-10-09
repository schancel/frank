import { CreditLedger } from '../ledger/credit-ledger';
import { OutboundMtaWorker } from '../mta/outbound-worker';
import { canonicalEmailAddress } from '../mta/outbound-delivery';
import type { OutboundDirectMessage } from '../mta/outbound-delivery';
import { singleLineHeaderText } from '../rfc/message-headers';
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

/** How many polls may try a message that failed before anything was passed on for sending. */
const MAX_HANDLING_ATTEMPTS = 3;

/** Set once a message has been passed to the outbound worker; from then on an email may exist. */
interface HandlingProgress {
  passedOnForSending: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPartyList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((party) => isRecord(party) && typeof party.address === 'string')
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/**
 * Checks every field of the decoded items that the listener reads. Decoding
 * does not check item shapes, so they are checked here before use. Returns
 * what is wrong, naming fields only and never their values, or undefined when
 * the items can be used.
 */
function messageItemsProblem(items: unknown): string | undefined {
  if (!Array.isArray(items)) return 'its items are not a list';
  if (!items.every((item) => isRecord(item) && typeof item.type === 'string')) {
    return 'one of its items is not an object with a type';
  }
  const email = items.find((item) => item.type === 'email');
  if (email) {
    if (!isPartyList(email.to)) return 'the To field of its email item is not a list of addresses';
    if (email.cc !== undefined && !isPartyList(email.cc)) {
      return 'the Cc field of its email item is not a list of addresses';
    }
    if (typeof email.subject !== 'string') return 'the subject of its email item is not text';
    if (typeof email.textBody !== 'string') return 'the body of its email item is not text';
    if (!isOptionalString(email.htmlBody)) return 'the HTML body of its email item is not text';
    if (!isOptionalString(email.inReplyTo)) return 'the reply reference of its email item is not text';
  }
  const text = items.find((item) => item.type === 'text');
  if (text && typeof text.text !== 'string') return 'the text of its text item is not text';
  return undefined;
}

/** Names the kind of an error without repeating its message, which could quote message content. */
function errorKind(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
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
  /**
   * Messages already handled in this process, by identity, with the time each
   * was received. A bridged message is also answered durably by its thread
   * mapping; a message that was not bridged is remembered only here. Entries
   * older than the cursor are dropped, because the fetch cannot return them again.
   */
  private readonly handled = new Map<string, number>();
  /** Failed attempts so far for messages that will be tried again, with their received time. */
  private readonly attempts = new Map<string, { count: number; receivedMs: number }>();
  private unexpectedFailures = 0;

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

      // The fetch returns messages at or after the cursor, so the newest ones
      // come back on every poll. Each is handled once, by identity.
      let newestMs = this.lastPolledTimeMs;
      let tryAgainFromMs: number | undefined;
      for (const msg of messages) {
        const receivedMs = Number.isFinite(msg.receivedTime) ? msg.receivedTime : this.lastPolledTimeMs;
        if (receivedMs > newestMs) newestMs = receivedMs;

        // Ignore outbound/own messages echoed in the mailbox
        if (msg.outbound) continue;

        const tryAgain = await this.handleFetchedMessage(msg, receivedMs);
        if (tryAgain && (tryAgainFromMs === undefined || receivedMs < tryAgainFromMs)) {
          tryAgainFromMs = receivedMs;
        }
      }
      // A message that will be tried again keeps the cursor at its time; the
      // messages after it were handled above and are skipped when they return.
      this.lastPolledTimeMs = tryAgainFromMs ?? newestMs;
      this.forgetBefore(this.lastPolledTimeMs);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Suppress or log transient network/polling errors
      console.warn(`[RelayMailboxListener] Error polling relay mailbox: ${errMsg}`);
    } finally {
      this.processingLock = false;
    }
  }

  /** Number of unexpected failures while handling fetched messages since this listener was created. */
  get unexpectedFailureCount(): number {
    return this.unexpectedFailures;
  }

  /** Number of messages currently remembered in memory as handled. */
  get rememberedMessageCount(): number {
    return this.handled.size;
  }

  /**
   * Handles one fetched message at most once and never throws. Returns true
   * when the message should be offered again on a later poll.
   *
   * A failure before the message is passed on for sending has recorded and
   * sent nothing, so it is tried again on a bounded number of polls. A failure
   * after that point may have left an email with the transport, so the message
   * is not handled again.
   */
  private async handleFetchedMessage(msg: DirectMessageReceived, receivedMs: number): Promise<boolean> {
    const sender =
      typeof msg.senderAddress?.raw === 'string' ? msg.senderAddress.raw.toLowerCase() : '';
    const frankMessageId =
      (typeof msg.messageId === 'string' && msg.messageId) ||
      (typeof msg.payloadDigest === 'string' && msg.payloadDigest) ||
      '';
    if (!sender || !frankMessageId) {
      const key = `unidentified\n${receivedMs}`;
      if (!this.handled.has(key)) {
        this.handled.set(key, receivedMs);
        console.warn(
          `[RelayMailboxListener] A message received at ${receivedMs} has no sender or no identity and was not bridged`
        );
      }
      return false;
    }

    const key = `${sender}\n${frankMessageId}`;
    if (this.handled.has(key)) return false;

    const progress: HandlingProgress = { passedOnForSending: false };
    try {
      // The thread mapping written when a message is bridged is the durable
      // record that it was handled; it also answers after a restart.
      if (!this.ledger.hasThreadMappingForFrankMessage(sender, frankMessageId)) {
        await this.bridgeDirectMessage(msg, progress);
      }
      this.handled.set(key, receivedMs);
      this.attempts.delete(key);
      return false;
    } catch (err: unknown) {
      this.unexpectedFailures++;
      const kind = errorKind(err);
      if (progress.passedOnForSending) {
        this.handled.set(key, receivedMs);
        this.attempts.delete(key);
        console.error(
          `[RelayMailboxListener] Handling message ${frankMessageId} failed after it was passed on for sending (${kind}); an email may or may not have been sent, and the message will not be handled again`
        );
        return false;
      }
      const count = (this.attempts.get(key)?.count ?? 0) + 1;
      if (count >= MAX_HANDLING_ATTEMPTS) {
        this.handled.set(key, receivedMs);
        this.attempts.delete(key);
        console.error(
          `[RelayMailboxListener] Handling message ${frankMessageId} failed ${count} times before anything was sent (${kind}); it will not be tried again`
        );
        return false;
      }
      this.attempts.set(key, { count, receivedMs });
      console.error(
        `[RelayMailboxListener] Handling message ${frankMessageId} failed before anything was sent (${kind}); attempt ${count} of ${MAX_HANDLING_ATTEMPTS}, it will be tried again`
      );
      return true;
    }
  }

  /** Drops what is remembered about messages received before the cursor. */
  private forgetBefore(cursorMs: number): void {
    for (const [key, receivedMs] of this.handled) {
      if (receivedMs < cursorMs) this.handled.delete(key);
    }
    for (const [key, attempt] of this.attempts) {
      if (attempt.receivedMs < cursorMs) this.attempts.delete(key);
    }
  }

  /**
   * Bridges one message to email. It does not remember the message: a caller
   * that may see the same message again goes through `pollOnce`.
   */
  async processDirectMessage(msg: DirectMessageReceived): Promise<void> {
    await this.bridgeDirectMessage(msg, { passedOnForSending: false });
  }

  private async bridgeDirectMessage(
    msg: DirectMessageReceived,
    progress: HandlingProgress
  ): Promise<void> {
    const conversationId = msg.conversationId;

    const problem = messageItemsProblem(msg.items);
    if (problem) {
      console.warn(
        `[RelayMailboxListener] Message ${msg.messageId || msg.payloadDigest} was not bridged: ${problem}`
      );
      return;
    }

    // Look for EmailItem or TextItem
    const emailItem = msg.items.find((i): i is EmailItem => i.type === 'email');
    const textItem = msg.items.find((i): i is TextItem => i.type === 'text');

    if (!emailItem && !textItem) {
      // Not a supported message format for email bridging
      console.warn(
        `[RelayMailboxListener] Message ${msg.messageId || msg.payloadDigest} was not bridged: it has no email or text item`
      );
      return;
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
      await this.handleThreadReply(msg, existingThread, progress, emailItem, textItem);
    } else {
      // New thread initiation -> Check rate limit and dispatch
      await this.handleNewEmailInitiation(msg, progress, emailItem, textItem);
    }
  }

  private async handleThreadReply(
    msg: DirectMessageReceived,
    thread: NonNullable<ReturnType<CreditLedger['getLatestThreadMappingByConversationId']>>,
    progress: HandlingProgress,
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
      primaryRecipient = emailItem.to[0].address;
      const restTo = emailItem.to.slice(1).map((p) => p.address);
      const rawCc = emailItem.cc ? emailItem.cc.map((p) => p.address) : [];
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

    const recipientEmail = canonicalEmailAddress(primaryRecipient);
    if (!recipientEmail) {
      console.warn(
        `[RelayMailboxListener] Could not determine valid primary recipient for thread ${conversationId}`
      );
      return;
    }
    ccRecipients = this.validCcRecipients(ccRecipients, frankMessageId);

    const bodyText = emailItem?.textBody || textItem?.text || '';
    let subject =
      this.singleLineSubject(emailItem?.subject || thread.subject || '', frankMessageId) ||
      'Re: Frank Message';
    if (!subject.toLowerCase().startsWith('re:')) {
      subject = `Re: ${subject}`;
    }

    await this.passOnForSending(progress, {
      conversationId,
      frankMessageId,
      senderFrankAddress,
      recipientEmail,
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
    progress: HandlingProgress,
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
        primaryRecipient = emailItem.to[0].address;
        const otherTo = emailItem.to.slice(1).map((p) => p.address);
        const otherCc = emailItem.cc ? emailItem.cc.map((p) => p.address) : [];
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

    const recipientEmail = canonicalEmailAddress(primaryRecipient);
    if (!recipientEmail) {
      console.warn(
        `[RelayMailboxListener] Could not parse destination email address from DM by ${senderFrankAddress}`
      );
      return;
    }
    ccRecipients = this.validCcRecipients(ccRecipients, frankMessageId);
    subject = this.singleLineSubject(subject, frankMessageId) || 'Message from Frank';

    await this.passOnForSending(progress, {
      conversationId,
      frankMessageId,
      senderFrankAddress,
      recipientEmail,
      ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
      bodyText,
      htmlBody: emailItem?.htmlBody,
      subject,
    });
  }

  private async passOnForSending(
    progress: HandlingProgress,
    dm: OutboundDirectMessage
  ): Promise<void> {
    progress.passedOnForSending = true;
    await this.outboundWorker.dispatchMessage(dm);
  }

  /** Keeps the Cc entries that are email addresses; the others are left out of the message. */
  private validCcRecipients(entries: readonly unknown[], frankMessageId: string): string[] {
    const valid: string[] = [];
    for (const entry of entries) {
      const address = canonicalEmailAddress(entry);
      if (address) {
        valid.push(address);
      } else {
        console.warn(
          `[RelayMailboxListener] Left out a Cc entry of message ${frankMessageId} that is not an email address`
        );
      }
    }
    return valid;
  }

  /** Returns the subject as one line of text, as it will be written in the email. */
  private singleLineSubject(subject: unknown, frankMessageId: string): string {
    const text = typeof subject === 'string' ? subject : '';
    const singleLine = singleLineHeaderText(text);
    if (singleLine !== text.trim()) {
      console.warn(
        `[RelayMailboxListener] Subject of message ${frankMessageId} was written as a single line`
      );
    }
    return singleLine;
  }
}
