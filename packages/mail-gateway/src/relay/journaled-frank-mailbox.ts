import * as crypto from 'node:crypto';
import type { ActiveChain, DirectMessageReceived, WalletHandle } from '@frank/wallet/chain/active-chain';
import { MailJournal } from '../ledger/mail-journal';

export interface JournaledFrankMailboxOptions {
  readonly chain: ActiveChain;
  readonly wallet: WalletHandle;
  readonly journal: MailJournal;
  /** Must commit the message disposition and every resulting outbound job before resolving. */
  readonly handle: (message: DirectMessageReceived) => Promise<void>;
}

/**
 * A durable inclusive read position for the gateway's Frank mailbox. This is
 * deliberately separate from rendering and delivery: a host's handler must
 * finish all journal writes before the cursor can move. Replays are expected.
 */
export class JournaledFrankMailbox {
  private readonly chain: ActiveChain;
  private readonly wallet: WalletHandle;
  private readonly journal: MailJournal;
  private readonly handle: JournaledFrankMailboxOptions['handle'];
  private polling = false;

  constructor(options: JournaledFrankMailboxOptions) {
    this.chain = options.chain;
    this.wallet = options.wallet;
    this.journal = options.journal;
    this.handle = options.handle;
    if (this.chain.chainIdentifier !== this.journal.chainIdentifier) {
      throw new Error('Mail journal and wallet chain identifiers differ');
    }
    if (this.wallet.identity.address.raw.toLowerCase() !== this.journal.gatewayAccount) {
      throw new Error('Mail journal belongs to another gateway wallet');
    }
  }

  async pollOnce(): Promise<{ processed: number; cursorMs: number }> {
    if (this.polling) throw new Error('Frank mailbox poll already in progress');
    this.polling = true;
    try {
      const start = this.journal.frankCursor().cursorMs ?? 0;
      let incompleteFloor: number | undefined;
      let newest = start;
      const quarantined: Array<{ time: number; identity: string }> = [];
      const messages = await this.chain.directMessages.fetchSince({
        wallet: this.wallet,
        sinceMs: start,
        onIncompleteTimestamp: (time) => {
          if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid incomplete mailbox timestamp');
          incompleteFloor = Math.min(incompleteFloor ?? time, time);
        },
        onQuarantinedTimestamp: (time, identity) => {
          if (!Number.isSafeInteger(time) || time < 0 || !identity) {
            throw new Error('Invalid quarantined mailbox receipt');
          }
          quarantined.push({ time, identity });
        },
      });

      for (const item of quarantined) {
        // Some terminally unreadable rows have only a relay submission identity.
        const digest = /^[0-9a-f]{64}$/.test(item.identity)
          ? item.identity
          : crypto.createHash('sha256').update(`mailbox-quarantine:${item.identity}`).digest('hex');
        this.journal.recordFrankMessage({
          outcome: 'quarantined', payloadDigest: digest, receivedTimeMs: item.time, stampValue: '0',
        });
        newest = Math.max(newest, item.time);
      }

      for (const message of messages) {
        if (!Number.isSafeInteger(message.receivedTime) || message.receivedTime < 0) {
          throw new Error('Invalid Frank message timestamp');
        }
        if (!message.outbound) {
          await this.handle(message);
          if (!this.journal.findFrankInbound(message.payloadDigest)) {
            throw new Error('Frank message handler returned without a durable journal disposition');
          }
        }
        newest = Math.max(newest, message.receivedTime);
      }

      // The position is inclusive: messages sharing this timestamp are offered
      // again after a restart and deduplicated by their journal record.
      const next = Math.min(newest, incompleteFloor ?? newest);
      this.journal.setFrankCursor(next, incompleteFloor);
      return { processed: messages.length, cursorMs: next };
    } finally {
      this.polling = false;
    }
  }
}
