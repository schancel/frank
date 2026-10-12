import * as crypto from 'node:crypto';
import { MailJournal } from '../ledger/mail-journal';
import { readHeaderSection } from '../rfc/message-headers';
import type { BlobStore } from '../storage/blob-store';
import type { StoredMailBytes } from '../types';

/** One provider call. A thrown error is always an unknown acceptance outcome. */
export interface OutboundMailPort {
  submit(input: {
    readonly fromAddress: string;
    readonly recipientEmail: string;
    readonly signedRfc822: Uint8Array;
  }): Promise<void>;
}

export interface JournaledOutboundWorkerOptions {
  readonly journal: MailJournal;
  readonly port: OutboundMailPort;
  readonly gatewayDomain: string;
  readonly blobStore?: BlobStore;
}

/**
 * The journal owns the job and its provider-attempt state. A crash or timeout
 * after claiming a job leaves it for operator reconciliation, never automatic
 * resubmission of mail that may already have left the provider.
 */
export class JournaledOutboundWorker {
  private readonly journal: MailJournal;
  private readonly port: OutboundMailPort;
  private readonly gatewayDomain: string;
  private readonly blobStore?: BlobStore;

  constructor(options: JournaledOutboundWorkerOptions) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(options.gatewayDomain)) {
      throw new Error('Invalid gateway domain');
    }
    this.journal = options.journal;
    this.port = options.port;
    this.gatewayDomain = options.gatewayDomain;
    this.blobStore = options.blobStore;
  }

  async dispatch(jobId: number): Promise<'sent' | 'uncertain'> {
    const job = this.journal.findOutboundJob(jobId);
    if (!job) throw new Error('Unknown outbound job');
    const bytes = await this.resolveBytes(job.signedRfc822);
    const fromAddress = `${job.senderLocalPart}@${this.gatewayDomain}`;
    const fields = readHeaderSection(bytes).fields;
    for (const name of ['from', 'reply-to']) {
      const values = fields.filter(([field]) => field === name).map(([, value]) => value.trim().toLowerCase());
      if (values.length !== 1 || values[0] !== fromAddress) {
        throw new Error(`Signed outbound mail ${name} differs from its issued mailbox`);
      }
    }
    this.journal.claimOutboundJob(jobId);
    try {
      await this.port.submit({
        fromAddress,
        recipientEmail: job.recipientEmail,
        signedRfc822: bytes,
      });
    } catch (error) {
      const current = this.journal.findOutboundJob(jobId);
      if (current?.state === 'bounced') return 'uncertain';
      this.journal.markOutboundJobUncertain(
        jobId,
        error instanceof Error ? error.message : String(error)
      );
      return 'uncertain';
    }
    const current = this.journal.findOutboundJob(jobId);
    if (current?.state === 'bounced') return 'sent';
    this.journal.markOutboundJobSent(jobId);
    return 'sent';
  }

  async dispatchDue(nowMs: number, limit = 100): Promise<{ sent: number; uncertain: number }> {
    const due = this.journal.listDueOutboundJobs(nowMs, limit);
    let sent = 0;
    let uncertain = 0;
    for (const job of due) {
      const result = await this.dispatch(job.jobId);
      if (result === 'sent') sent += 1;
      else uncertain += 1;
    }
    return { sent, uncertain };
  }

  private async resolveBytes(stored: StoredMailBytes): Promise<Uint8Array> {
    if (stored.kind === 'inline') return stored.bytes;
    const bytes = await this.blobStore?.get(stored.sha256);
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== stored.sha256) {
      throw new Error('Stored outbound mail blob is missing or changed');
    }
    return bytes;
  }
}
