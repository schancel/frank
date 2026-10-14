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

  private extractSingleHeaderAddress(value: string): string | undefined {
    const trimmed = value.trim();
    const angleMatch = trimmed.match(/^(?:"(?:[^"\\]|\\.)*"|[^<>,"]+)?\s*<([^<>\s]+@[^<>\s]+)>$/);
    if (angleMatch) return angleMatch[1].toLowerCase();
    if (/^[^<>\s,]+@[^<>\s,]+$/.test(trimmed)) return trimmed.toLowerCase();
    return undefined;
  }

  private isAuthorizedFromLocalPart(localPart: string, scopeAccount: string, senderLocalPart: string): boolean {
    if (localPart === senderLocalPart) return true;
    const scope = scopeAccount.toLowerCase();
    if (localPart === scope || localPart === `u.${scope}`) return true;
    if (/^[a-z0-9][a-z0-9_-]{2,31}$/.test(localPart)) {
      try {
        const issued = this.journal.issuedMailbox(localPart);
        if (issued?.scopeAccount === scope) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async dispatch(jobId: number): Promise<'sent' | 'uncertain'> {
    const job = this.journal.findOutboundJob(jobId);
    if (!job) throw new Error('Unknown outbound job');
    const bytes = await this.resolveBytes(job.signedRfc822);
    const replyToAddress = `${job.senderLocalPart}@${this.gatewayDomain}`;
    const fields = readHeaderSection(bytes).fields;
    const replyToValues = fields.filter(([field]) => field === 'reply-to').map(([, value]) => value.trim().toLowerCase());
    if (replyToValues.length !== 1 || replyToValues[0] !== replyToAddress) {
      throw new Error('Signed outbound mail reply-to differs from its issued mailbox');
    }
    const fromValues = fields.filter(([field]) => field === 'from').map(([, value]) => value);
    const fromAddress = fromValues.length === 1 ? this.extractSingleHeaderAddress(fromValues[0]) : undefined;
    const fromParts = fromAddress?.split('@');
    if (
      !fromAddress ||
      !fromParts ||
      fromParts.length !== 2 ||
      fromParts[1] !== this.gatewayDomain ||
      !this.isAuthorizedFromLocalPart(fromParts[0], job.scopeAccount, job.senderLocalPart)
    ) {
      throw new Error('Signed outbound mail from differs from its issued mailbox');
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
