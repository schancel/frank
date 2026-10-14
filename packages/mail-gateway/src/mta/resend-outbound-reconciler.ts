import { Resend } from 'resend';
import { MailJournal } from '../ledger/mail-journal';
import { readHeaderSection } from '../rfc/message-headers';
import type { OutboundJobRecord } from '../types';

export interface SentMailEvidence {
  readonly id: string;
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly createdAt: string;
}

export interface SentMailPage {
  readonly messages: readonly SentMailEvidence[];
  readonly hasMore: boolean;
}

export interface SentMailEvidencePort {
  list(after?: string): Promise<SentMailPage>;
}

/** Read-only provider lookup. Its absence of evidence never authorizes a resend. */
export function createResendSentMailEvidencePort(apiKey: string): SentMailEvidencePort {
  if (!apiKey) throw new Error('Resend API key is required');
  const resend = new Resend(apiKey);
  return {
    async list(after) {
      const response = await resend.emails.list({ limit: 100, ...(after ? { after } : {}) });
      if (response.error || !response.data) throw new Error('Resend sent-email listing failed');
      return {
        hasMore: response.data.has_more,
        messages: response.data.data.map((email) => ({
          id: email.id,
          messageId: email.message_id,
          from: email.from,
          to: email.to,
          createdAt: email.created_at,
        })),
      };
    },
  };
}

function exactFrom(providerFrom: string, expected: string): boolean {
  const from = providerFrom.trim().toLowerCase();
  return from === expected || from.endsWith(`<${expected}>`);
}

function headerFromAddress(job: OutboundJobRecord, gatewayDomain: string): string | undefined {
  if (job.signedRfc822.kind !== 'inline') return undefined;
  const fromValues = readHeaderSection(job.signedRfc822.bytes)
    .fields.filter(([name]) => name === 'from')
    .map(([, value]) => value.trim());
  if (fromValues.length !== 1) return undefined;
  const raw = fromValues[0];
  const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>$/);
  const candidate = (angle ? angle[1] : raw).toLowerCase();
  return candidate.endsWith(`@${gatewayDomain}`) ? candidate : undefined;
}

function matches(job: OutboundJobRecord, evidence: SentMailEvidence, gatewayDomain: string): boolean {
  const createdAtMs = Date.parse(evidence.createdAt);
  const inlineFrom = headerFromAddress(job, gatewayDomain);
  const expectedAliasFrom = `${job.senderLocalPart}@${gatewayDomain}`;
  return (
    Number.isFinite(createdAtMs) &&
    job.submissionStartedAtMs !== undefined &&
    createdAtMs >= job.submissionStartedAtMs - 5 * 60_000 &&
    evidence.messageId === job.rfcMessageId &&
    (exactFrom(evidence.from, expectedAliasFrom) ||
      (inlineFrom !== undefined && exactFrom(evidence.from, inlineFrom))) &&
    evidence.to.some((address) => address.toLowerCase() === job.recipientEmail)
  );
}

/** Confirm only exact provider evidence for a claimed job; never infer rejection from absence. */
export class ResendOutboundReconciler {
  constructor(private readonly journal: MailJournal, private readonly port: SentMailEvidencePort) {}

  async reconcile(
    limitJobs = 100,
    maxPages = 20,
    afterJobId = 0,
    providerAfter?: string
  ): Promise<{
    confirmed: number;
    unresolved: number;
    pages: number;
    /** Continue the same job batch from the next provider page. */
    nextProviderAfter?: string;
    /** Once provider pages are exhausted, move to the next job batch. */
    nextJobId?: number;
  }> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
      throw new Error('maxPages must be an integer from 1 to 1000');
    }
    const jobs = this.journal.listUncertainOutboundJobs(limitJobs, afterJobId);
    const remaining = new Map(jobs.map((job) => [job.jobId, job]));
    let after = providerAfter;
    let pages = 0;
    let hasMore = false;
    while (remaining.size > 0 && pages < maxPages) {
      const page = await this.port.list(after);
      pages += 1;
      hasMore = page.hasMore;
      for (const evidence of page.messages) {
        for (const [id, job] of remaining) {
          if (!matches(job, evidence, this.journal.gatewayDomain)) continue;
          this.journal.confirmOutboundJobAccepted(id, evidence.id);
          remaining.delete(id);
        }
      }
      if (!hasMore) break;
      const lastId = page.messages.at(-1)?.id;
      if (!lastId || lastId === after) throw new Error('Resend sent-email pagination did not advance');
      after = lastId;
    }
    return {
      confirmed: jobs.length - remaining.size,
      unresolved: remaining.size,
      pages,
      ...(remaining.size > 0 && hasMore ? { nextProviderAfter: after } : {}),
      ...(jobs.length === limitJobs && (remaining.size === 0 || !hasMore)
        ? { nextJobId: jobs.at(-1)!.jobId } : {}),
    };
  }
}
