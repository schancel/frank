import { JournaledFrankMailbox } from '../relay/journaled-frank-mailbox';
import { JournaledInboundSend } from '../relay/journaled-inbound-send';
import { JournaledOutboundWorker } from '../mta/journaled-outbound-worker';
import { ResendOutboundReconciler } from '../mta/resend-outbound-reconciler';

export interface JournaledMailRuntimeOptions {
  readonly inbound: JournaledInboundSend;
  readonly frankMailbox: JournaledFrankMailbox;
  readonly outbound: JournaledOutboundWorker;
  readonly outboundReconciler: ResendOutboundReconciler;
  readonly now?: () => number;
}

/**
 * One host-owned recovery pass. Each component owns its durable fact: the mail
 * journal owns admission, mailbox position and SMTP jobs; the wallet owns paid
 * message attempts. Cursors here only pace bounded scans and are safe to lose
 * on restart. No transport is started by this class.
 */
export class JournaledMailRuntime {
  private readonly inbound: JournaledInboundSend;
  private readonly frankMailbox: JournaledFrankMailbox;
  private readonly outbound: JournaledOutboundWorker;
  private readonly outboundReconciler: ResendOutboundReconciler;
  private readonly now: () => number;
  private inboundAfterSlotId = 0;
  private heldAfter?: { scopeAccount: string; mailKey: string };
  private outboundAfterJobId = 0;
  private outboundProviderAfter?: string;
  private running = false;

  constructor(options: JournaledMailRuntimeOptions) {
    this.inbound = options.inbound;
    this.frankMailbox = options.frankMailbox;
    this.outbound = options.outbound;
    this.outboundReconciler = options.outboundReconciler;
    this.now = options.now ?? Date.now;
  }

  /**
   * Process durable work before a host acknowledges readiness. A failed pass
   * fails readiness; the next pass restarts from the same persisted records.
   */
  async runOnce(): Promise<void> {
    if (this.running) throw new Error('Mail runtime pass already in progress');
    this.running = true;
    try {
      const failures: string[] = [];
      const stage = async (name: string, run: () => Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.name : typeof error}`);
        }
      };
      await stage('held release', async () => {
        const released = await this.inbound.releaseHeld(100, this.heldAfter);
        this.heldAfter = released.nextAfter;
        if (released.errors.length) failures.push(`held release items: ${released.errors.length}`);
      });
      await stage('Frank send recovery', async () => {
        const recovered = await this.inbound.recover(100, this.inboundAfterSlotId);
        this.inboundAfterSlotId = recovered.nextAfterSlotId;
        if (recovered.errors.length) failures.push(`Frank send recovery items: ${recovered.errors.length}`);
      });
      await stage('Frank mailbox', async () => { await this.frankMailbox.pollOnce(); });
      await stage('outbound SMTP', async () => { await this.outbound.dispatchDue(this.now(), 100); });
      await stage('outbound reconciliation', async () => {
        const evidence = await this.outboundReconciler.reconcile(
          100, 20, this.outboundAfterJobId, this.outboundProviderAfter
        );
        if (evidence.nextProviderAfter) {
          this.outboundProviderAfter = evidence.nextProviderAfter;
        } else {
          this.outboundProviderAfter = undefined;
          this.outboundAfterJobId = evidence.nextJobId ?? 0;
        }
      });
      if (failures.length) throw new Error(`Mail runtime pass encountered item failures (${failures.join(', ')})`);
    } finally {
      this.running = false;
    }
  }
}
