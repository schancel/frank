import * as crypto from 'node:crypto';
import type { ActiveChain, WalletHandle } from '@frank/wallet/chain/active-chain';
import type { MessageItem } from '@frank/cashweb/types/messages';
import { CreditLedger } from '../ledger/credit-ledger';
import { MailJournal } from '../ledger/mail-journal';
import { mailKey } from '../rfc/mail-keys';
import { parseMessageId } from '../rfc/message-headers';
import { parseRawRfc822 } from '../smtp/smtp-listener';
import type { BlobStore } from '../storage/blob-store';
import type { FrankSendRecord, InboundEmail, StoredMailBytes } from '../types';

/**
 * Only a host that verified its receiving transport and authenticated the From
 * principal may construct this input. Untrusted Authentication-Results or DKIM
 * headers inside `email.rawRfc822` are not evidence by themselves.
 */
export interface VerifiedInboundMail {
  readonly email: InboundEmail;
  readonly verifiedTransportId: string;
  readonly authenticatedSenderEmail: string;
}

export interface JournaledInboundSendOptions {
  readonly chain: ActiveChain;
  readonly wallet: WalletHandle;
  readonly ledger: CreditLedger;
  readonly journal: MailJournal;
  readonly blobStore?: BlobStore;
}

export type InboundAdmission =
  | { readonly kind: 'queued'; readonly slot: FrankSendRecord; readonly duplicate: boolean }
  | { readonly kind: 'held' | 'echo' | 'duplicate' | 'refused' };

/**
 * The financial boundary for an authenticated mail delivered to a Frank user.
 * The journal owns mail identity/credit consumption; the wallet owns exact
 * encrypted bytes, signed stamp transactions, and their reconciliation.
 */
export class JournaledInboundSend {
  private readonly chain: ActiveChain;
  private readonly wallet: WalletHandle;
  private readonly ledger: CreditLedger;
  private readonly journal: MailJournal;
  private readonly blobStore?: BlobStore;

  constructor(options: JournaledInboundSendOptions) {
    this.chain = options.chain;
    this.wallet = options.wallet;
    this.ledger = options.ledger;
    this.journal = options.journal;
    this.blobStore = options.blobStore;
    if (this.chain.chainIdentifier !== this.journal.chainIdentifier) {
      throw new Error('Mail journal and wallet chain identifiers differ');
    }
    if (this.wallet.identity.address.raw.toLowerCase() !== this.journal.gatewayAccount) {
      throw new Error('Mail journal belongs to another gateway wallet');
    }
  }

  /** Admission and one credit debit commit together, before any wallet effect. */
  admit(mail: VerifiedInboundMail, scopeAccount: string, stampValue: bigint): InboundAdmission {
    if (!mail.verifiedTransportId) throw new Error('Verified transport identity is required');
    if (stampValue < 0n) throw new Error('Stamp value must be non-negative');
    const scope = scopeAccount.toLowerCase();
    if (!this.chain.parseAddress(scope)) throw new Error('Invalid Frank recipient');
    const sender = mail.authenticatedSenderEmail.toLowerCase().trim();
    const parsedSender = parseRawRfc822(mail.email.rawRfc822).fromAddress;
    if (sender !== mail.email.fromAddress.toLowerCase().trim() || sender !== parsedSender) {
      throw new Error('Authenticated sender and mail From header differ');
    }
    const key = mailKey(mail.email.rawRfc822);
    const dataSha256 = crypto.createHash('sha256').update(mail.email.rawRfc822).digest('hex');

    return this.ledger.atomic((): InboundAdmission => {
      const principalHasCredit =
        this.ledger.getBalance(sender) > 0 || this.ledger.getThreadAllowance(sender, scope) > 0;
      const admitted = this.journal.admitInboundEmail({
        scopeAccount: scope,
        mailKey: key,
        messageIdHeader: parseMessageId(mail.email.messageId),
        senderEmail: sender,
        dataSha256,
        raw: { kind: 'inline', bytes: mail.email.rawRfc822 },
        principalHasCredit,
      });
      if (admitted.kind === 'refused') return { kind: 'refused' };
      if (admitted.kind === 'echo') return { kind: 'echo' };
      if (admitted.email.disposition !== 'held') {
        if (admitted.email.disposition === 'relay' || admitted.email.disposition === 'released') {
          const existing = this.journal.relayInboundEmail({
            scopeAccount: scope,
            mailKey: key,
            stampValue: stampValue.toString(),
          });
          return { kind: 'queued', slot: existing.slot, duplicate: true };
        }
        return { kind: 'duplicate' };
      }
      if (!this.ledger.consumeCredit(sender, scope)) return { kind: 'held' };
      const relayed = this.journal.relayInboundEmail({
        scopeAccount: scope,
        mailKey: key,
        stampValue: stampValue.toString(),
        inReplyTo: mail.email.inReplyTo && parseMessageId(mail.email.inReplyTo),
        references: mail.email.references?.flatMap((id) => {
          const parsed = parseMessageId(id);
          return parsed ? [parsed] : [];
        }),
      });
      return { kind: 'queued', slot: relayed.slot, duplicate: false };
    });
  }

  /**
   * Resume one durable slot. Repeating the wallet's stored message ID either
   * sends its first attempt or reconciles that same attempt; it cannot mint a
   * second payment. An unknown delivery outcome stays linked for another pass.
   */
  async resume(slotId: number): Promise<'delivered' | 'pending' | 'held'> {
    let slot = this.journal.findFrankSend(slotId);
    if (!slot) throw new Error('Unknown mail send slot');
    if (slot.state === 'delivered') return 'delivered';
    if (slot.state === 'held') return 'held';
    if (slot.sourceKind !== 'inbound_email') throw new Error('Send slot has a different source');

    if (!slot.payloadDigest) {
      const known = await this.chain.directMessages.attemptOf?.({
        wallet: this.wallet,
        messageId: slot.frankMessageId,
      });
      if (known) {
        if (slot.state === 'staged') this.journal.markFrankSendSending(slot.slotId);
        const linked = this.journal.linkFrankSend(slot.slotId, known.payloadDigest);
        if (linked.kind === 'held') return 'held';
        slot = linked.slot;
      }
    }

    if (!slot.payloadDigest) {
      const raw = await this.readSource(slot);
      const parsed = parseRawRfc822(raw);
      const recipient = this.chain.parseAddress(slot.scopeAccount);
      if (!recipient) throw new Error('Stored Frank recipient is invalid');
      const emailItem: MessageItem = {
        type: 'email',
        messageId: this.mailIdFor(slot),
        from: { address: parsed.fromAddress, name: parsed.fromName },
        to: parsed.toAddresses ?? [{ address: parsed.toAddress }],
        cc: parsed.ccAddresses,
        subject: parsed.subject,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      };
      this.journal.markFrankSendSending(slot.slotId);
      try {
        const sent = await this.chain.directMessages.send({
          wallet: this.wallet,
          recipient,
          messageId: slot.frankMessageId,
          conversationId: slot.conversationId,
          stampValue: BigInt(slot.stampValue),
          items: [emailItem],
          onEnvelopeDurable: async (digest) => {
            const linked = this.journal.linkFrankSend(slotId, digest);
            if (linked.kind === 'held') throw new Error('Mail send digest belongs to another slot');
          },
        });
        const current = this.journal.findFrankSend(slotId)!;
        if (!current.payloadDigest) this.journal.linkFrankSend(slotId, sent.payloadDigest);
      } catch (error) {
        // `send` can reject after signing or relay handoff. Keep the same ID and
        // let the wallet's own attempt record answer on the next recovery pass.
        const known = await this.chain.directMessages.attemptOf?.({
          wallet: this.wallet,
          messageId: slot.frankMessageId,
        });
        if (known && !this.journal.findFrankSend(slotId)?.payloadDigest) {
          const linked = this.journal.linkFrankSend(slotId, known.payloadDigest);
          if (linked.kind === 'held') return 'held';
        }
        throw error;
      }
      slot = this.journal.findFrankSend(slotId)!;
    }

    if (!slot.payloadDigest) return 'pending';
    const outcomes = await this.chain.directMessages.reconcileAttempts({
      wallet: this.wallet,
      payloadDigests: [slot.payloadDigest],
      onEnvelopeDurable: async (digest) => {
        const linked = this.journal.linkFrankSend(slotId, digest);
        if (linked.kind === 'held') throw new Error('Mail send digest belongs to another slot');
      },
    });
    const outcome = outcomes[slot.payloadDigest];
    if (outcome === 'delivered') {
      this.journal.markFrankSendDelivered(slotId);
      return 'delivered';
    }
    if (outcome === 'dead') {
      this.journal.holdFrankSend(slotId, 'wallet_delivery_dead');
      return 'held';
    }
    return 'pending';
  }

  /** One bounded recovery page. Continue from `nextAfterSlotId`, wrapping to zero after an empty page. */
  async recover(limit = 100, afterSlotId = 0): Promise<{
    attempted: number;
    delivered: number;
    pending: number;
    held: number;
    errors: Array<{ slotId: number; kind: string }>;
    nextAfterSlotId: number;
  }> {
    const slots = this.journal.listUnfinishedFrankSends(limit, afterSlotId);
    let delivered = 0;
    let pending = 0;
    let held = 0;
    const errors: Array<{ slotId: number; kind: string }> = [];
    for (const slot of slots) {
      if (slot.sourceKind !== 'inbound_email') continue;
      try {
        const result = await this.resume(slot.slotId);
        if (result === 'delivered') delivered++;
        else if (result === 'pending') pending++;
        else held++;
      } catch (error) {
        errors.push({ slotId: slot.slotId, kind: error instanceof Error ? error.name : typeof error });
      }
    }
    return {
      attempted: delivered + pending + held + errors.length,
      delivered,
      pending,
      held,
      errors,
      nextAfterSlotId: slots.at(-1)?.slotId ?? 0,
    };
  }

  private mailIdFor(slot: FrankSendRecord): string {
    const key = slot.sourceKey.slice(slot.scopeAccount.length + 1);
    const email = this.journal.findInboundEmail(slot.scopeAccount, key);
    if (!email) throw new Error('Send slot has no admitted email');
    return email.rfcMessageId;
  }

  private async readSource(slot: FrankSendRecord): Promise<Uint8Array> {
    const key = slot.sourceKey.slice(slot.scopeAccount.length + 1);
    const email = this.journal.findInboundEmail(slot.scopeAccount, key);
    if (!email?.raw) throw new Error('Send slot has no durable source bytes');
    return this.resolveBytes(email.raw);
  }

  private async resolveBytes(stored: StoredMailBytes): Promise<Uint8Array> {
    if (stored.kind === 'inline') return stored.bytes;
    const bytes = await this.blobStore?.get(stored.sha256);
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== stored.sha256) {
      throw new Error('Stored mail blob is missing or changed');
    }
    return bytes;
  }
}
