import { CreditLedger } from '../ledger/credit-ledger';
import { OutboundEmailDelivery, OutboundDirectMessage } from './outbound-delivery';
import { DkimSigner } from './dkim-signer';
import { MxDirectTransport, MxDeliveryResult } from './mx-transport';

export interface OutboundMtaWorkerOptions {
  readonly gatewayDomain: string;
  readonly ledger: CreditLedger;
  readonly delivery: OutboundEmailDelivery;
  readonly dkimSigner: DkimSigner;
  readonly mxTransport: MxDirectTransport;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface OutboundDispatchResult {
  readonly success: boolean;
  readonly rfc822MessageId: string;
  readonly spooled: boolean;
  readonly spoolJobId?: number;
  readonly responseCode?: number;
  readonly responseMessage?: string;
  readonly error?: string;
}

export interface SpoolProcessingSummary {
  readonly processed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
}

/**
 * Calculates exponential backoff in milliseconds: base * 2^attempts, capped at max.
 * Defaults: base = 1m (60,000 ms), max = 72h (259,200,000 ms).
 */
export function calculateBackoffMs(
  attempts: number,
  baseBackoffMs = 60_000,
  maxBackoffMs = 72 * 3600 * 1000
): number {
  const backoff = baseBackoffMs * Math.pow(2, attempts);
  return Math.min(backoff, maxBackoffMs);
}

/**
 * Determines whether an MX delivery failure is temporary (retriable) or permanent.
 * 4xx SMTP codes, socket timeouts, connection refused, or DNS network errors are temporary.
 * 5xx SMTP codes are permanent rejections.
 */
export function isTemporaryFailure(result: MxDeliveryResult): boolean {
  if (result.success) {
    return false;
  }
  if (result.responseCode !== undefined) {
    return result.responseCode >= 400 && result.responseCode < 500;
  }
  // Socket errors, timeouts, network unreachability without response code
  return true;
}

/**
 * Outbound MTA Worker orchestrates message rendering, DKIM signing, direct MX delivery,
 * and reliable spool retry queue with exponential backoff.
 */
export class OutboundMtaWorker {
  private readonly gatewayDomain: string;
  private readonly ledger: CreditLedger;
  private readonly delivery: OutboundEmailDelivery;
  private readonly dkimSigner: DkimSigner;
  private readonly mxTransport: MxDirectTransport;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private spoolTimer?: NodeJS.Timeout;

  constructor(options: OutboundMtaWorkerOptions) {
    this.gatewayDomain = options.gatewayDomain.toLowerCase().trim();
    this.ledger = options.ledger;
    this.delivery = options.delivery;
    this.dkimSigner = options.dkimSigner;
    this.mxTransport = options.mxTransport;
    this.baseBackoffMs = options.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 72 * 3600 * 1000;
  }

  /**
   * Dispatches an outbound direct message:
   * 1. Renders RFC 5322 MIME message via OutboundEmailDelivery.
   * 2. Signs with DkimSigner.
   * 3. Attempts direct delivery via MxDirectTransport.deliver.
   * 4. If temporary failure, enqueues to outbound_spool with exponential backoff.
   */
  async dispatchMessage(dm: OutboundDirectMessage): Promise<OutboundDispatchResult> {
    const deliveryResult = await this.delivery.processOutboundDirectMessage(dm);
    const signedEmail = this.dkimSigner.sign(deliveryResult.renderedEmail);
    const fromAddress = `${dm.senderFrankAddress}@${this.gatewayDomain}`;

    const mxResult = await this.mxTransport.deliver({
      fromAddress,
      toAddress: dm.recipientEmail,
      rawRfc822: Buffer.from(signedEmail, 'utf-8'),
    });

    if (mxResult.success) {
      return {
        success: true,
        rfc822MessageId: deliveryResult.rfc822MessageId,
        spooled: false,
        responseCode: mxResult.responseCode,
        responseMessage: mxResult.responseMessage,
      };
    }

    // Handle failure
    if (isTemporaryFailure(mxResult)) {
      const now = Date.now();
      const backoffMs = calculateBackoffMs(0, this.baseBackoffMs, this.maxBackoffMs);
      const nextAttemptAt = now + backoffMs;

      const spoolJobId = this.ledger.enqueueOutboundSpool({
        recipientEmail: dm.recipientEmail,
        fromAddress,
        rawRfc822: signedEmail,
        nextAttemptAt,
      });

      return {
        success: false,
        rfc822MessageId: deliveryResult.rfc822MessageId,
        spooled: true,
        spoolJobId,
        responseCode: mxResult.responseCode,
        responseMessage: mxResult.responseMessage,
        error: mxResult.error,
      };
    }

    // Permanent 5xx failure: do not spool
    return {
      success: false,
      rfc822MessageId: deliveryResult.rfc822MessageId,
      spooled: false,
      responseCode: mxResult.responseCode,
      responseMessage: mxResult.responseMessage,
      error: mxResult.error,
    };
  }

  /**
   * Sweeps pending spool jobs ready for retry and attempts re-delivery,
   * updating attempt counters and exponential backoff timestamps.
   */
  async processSpool(nowMs?: number): Promise<SpoolProcessingSummary> {
    const now = nowMs ?? Date.now();
    const pendingJobs = this.ledger.getPendingOutboundJobs(now);

    let succeeded = 0;
    let retried = 0;
    let failed = 0;

    for (const job of pendingJobs) {
      const mxResult = await this.mxTransport.deliver({
        fromAddress: job.fromAddress,
        toAddress: job.recipientEmail,
        rawRfc822: Buffer.from(job.rawRfc822, 'utf-8'),
      });

      if (mxResult.success) {
        this.ledger.markOutboundJobSuccess(job.id);
        succeeded++;
      } else {
        if (isTemporaryFailure(mxResult)) {
          const backoffMs = calculateBackoffMs(job.attempts, this.baseBackoffMs, this.maxBackoffMs);
          const isRetriable = this.ledger.markOutboundJobFailed(
            job.id,
            mxResult.error || 'Temporary delivery error',
            now,
            backoffMs
          );
          if (isRetriable) {
            retried++;
          } else {
            failed++;
          }
        } else {
          // Permanent failure (5xx)
          this.ledger.markOutboundJobFailed(
            job.id,
            mxResult.error || 'Permanent delivery failure',
            now,
            0
          );
          failed++;
        }
      }
    }

    return {
      processed: pendingJobs.length,
      succeeded,
      retried,
      failed,
    };
  }

  /**
   * Starts background spool processing timer.
   */
  startSpoolProcessor(intervalMs = 60_000): void {
    if (this.spoolTimer) return;
    this.spoolTimer = setInterval(() => {
      this.processSpool().catch((err) => {
        console.error('[outbound-worker] Background spool processing failed:', err);
      });
    }, intervalMs);
  }

  /**
   * Stops background spool processing timer.
   */
  stopSpoolProcessor(): void {
    if (this.spoolTimer) {
      clearInterval(this.spoolTimer);
      this.spoolTimer = undefined;
    }
  }
}
