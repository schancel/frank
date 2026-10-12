import { Resend } from 'resend';
import type { JournaledInboundSend, InboundAdmission } from '../relay/journaled-inbound-send';
import { isOperationalLocalPart } from '../mailbox/operational-local-parts';
import { parseRawRfc822, extractEmailAddress } from './smtp-listener';
import type { InboundRecipientResolution } from './inbound-server';

const MAX_RAW_BYTES = 20 * 1024 * 1024;

export interface ResendWebhookHeaders {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

export interface ResendInboundPort {
  verify(body: string, headers: ResendWebhookHeaders, secret: string): unknown;
  retrieve(emailId: string): Promise<unknown>;
}

/** The SDK signs the event and retrieves server-computed authentication facts. */
export function createResendInboundPort(apiKey: string): ResendInboundPort {
  if (!apiKey) throw new Error('Resend API key is required');
  const resend = new Resend(apiKey);
  return {
    verify: (body, headers, secret) => resend.webhooks.verify({
      payload: body, headers: { ...headers }, webhookSecret: secret,
    }),
    retrieve: async (emailId) => {
      const result = await resend.emails.receiving.get(emailId);
      if (result.error || !result.data) throw new Error('Resend received email retrieval failed');
      return result.data;
    },
  };
}

export interface ResendInboundWebhookOptions {
  readonly port: ResendInboundPort;
  readonly webhookSecret: string;
  readonly gatewayDomain: string;
  readonly rawOrigins: readonly string[];
  readonly issuedMailboxLookup: (localPart: string) => Promise<InboundRecipientResolution | undefined>;
  readonly sender: JournaledInboundSend;
  readonly stampValue: bigint;
  readonly fetcher?: typeof fetch;
}

export type ResendInboundResult =
  | { readonly kind: 'ignored' | 'rejected_unauthenticated' | 'rejected_unknown'; readonly admissions: readonly [] }
  | { readonly kind: 'admitted'; readonly admissions: readonly InboundAdmission[] };

export class InvalidResendWebhookSignature extends Error {
  constructor() {
    super('Invalid Resend webhook signature');
    this.name = 'InvalidResendWebhookSignature';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Malformed Resend receiving event');
  return value as Record<string, unknown>;
}

function envelopeRecipient(value: unknown, domain: string): string {
  if (typeof value !== 'string') throw new Error('Malformed Resend envelope recipient');
  const address = value.trim().toLowerCase();
  const parts = address.split('@');
  if (parts.length !== 2 || parts[1] !== domain || !/^[a-z0-9][a-z0-9._+-]*$/.test(parts[0])) {
    throw new Error('Resend envelope recipient is outside the configured mail domain');
  }
  return parts[0];
}

async function readBoundedRaw(url: string, allowedOrigins: ReadonlySet<string>, fetcher: typeof fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !allowedOrigins.has(parsed.origin)) {
    throw new Error('Resend raw mail URL origin is not configured');
  }
  const response = await fetcher(parsed.href, { redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Resend raw mail download failed');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) throw new Error('Resend raw mail exceeds size limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      length += next.value.byteLength;
      if (length > MAX_RAW_BYTES) throw new Error('Resend raw mail exceeds size limit');
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

/** Signed Resend ingress. A successful return means every admitted recipient is durable, not delivered. */
export class ResendInboundWebhook {
  private readonly port: ResendInboundPort;
  private readonly secret: string;
  private readonly domain: string;
  private readonly rawOrigins: ReadonlySet<string>;
  private readonly issuedMailboxLookup: (localPart: string) => Promise<InboundRecipientResolution | undefined>;
  private readonly sender: JournaledInboundSend;
  private readonly stampValue: bigint;
  private readonly fetcher: typeof fetch;

  constructor(options: ResendInboundWebhookOptions) {
    if (!options.webhookSecret) throw new Error('Resend webhook secret is required');
    if (options.stampValue < 0n) throw new Error('Stamp value must be non-negative');
    this.port = options.port;
    this.secret = options.webhookSecret;
    this.domain = options.gatewayDomain.toLowerCase();
    this.rawOrigins = new Set(options.rawOrigins.map(origin => {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.origin !== origin)
        throw new Error('Resend raw mail origin must be an HTTPS origin');
      return origin;
    }));
    if (this.rawOrigins.size === 0) throw new Error('Resend raw mail origins must be configured');
    this.issuedMailboxLookup = options.issuedMailboxLookup;
    this.sender = options.sender;
    this.stampValue = options.stampValue;
    this.fetcher = options.fetcher ?? fetch;
  }

  async handle(rawBody: string, headers: ResendWebhookHeaders): Promise<ResendInboundResult> {
    let verified: unknown;
    try {
      verified = this.port.verify(rawBody, headers, this.secret);
    } catch {
      throw new InvalidResendWebhookSignature();
    }
    const event = record(verified);
    if (event.type !== 'email.received') return { kind: 'ignored', admissions: [] };
    const data = record(event.data);
    if (typeof data.email_id !== 'string' || !data.email_id) throw new Error('Missing Resend email ID');
    const retrieved = record(await this.port.retrieve(data.email_id));
    if (retrieved.id !== data.email_id) throw new Error('Resend retrieved email ID differs from signed event');

    // Resend computes this result at its receiving boundary. Never read auth from RFC822 headers.
    const auth = record(retrieved.authentication);
    if (auth.dmarc !== 'pass') return { kind: 'rejected_unauthenticated', admissions: [] };
    const receivedFor = retrieved.received_for;
    if (!Array.isArray(receivedFor) || receivedFor.length === 0) throw new Error('Missing Resend envelope recipients');
    const recipients = [...new Set(receivedFor.map(value => envelopeRecipient(value, this.domain)))];
    const scopes = await Promise.all(recipients.map(async localPart => {
      if (isOperationalLocalPart(localPart) || localPart.startsWith('bounce+')) return undefined;
      return this.issuedMailboxLookup(localPart);
    }));
    if (scopes.some(scope => !scope)) return { kind: 'rejected_unknown', admissions: [] };

    const rawDescriptor = record(retrieved.raw);
    if (typeof rawDescriptor.download_url !== 'string') throw new Error('Missing Resend raw mail URL');
    const raw = await readBoundedRaw(rawDescriptor.download_url, this.rawOrigins, this.fetcher);
    const parsed = parseRawRfc822(raw);
    const apiFrom = typeof retrieved.from === 'string' ? extractEmailAddress(retrieved.from) : '';
    if (apiFrom !== parsed.fromAddress) throw new Error('Resend From differs from raw mail');
    const admissions: InboundAdmission[] = [];
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index]!;
      const admission = this.sender.admit({
        email: parsed,
        verifiedTransportId: data.email_id,
        authenticatedSenderEmail: apiFrom,
      }, scope.accountAddress, this.stampValue, scope.conversationId, recipients[index]);
      if (admission.kind === 'refused') throw new Error('Mail journal refused inbound email admission');
      admissions.push(admission);
    }
    return { kind: 'admitted', admissions };
  }
}

/** HTTP boundary: acknowledge only after every accepted recipient has committed to the journal. */
export async function handleResendWebhookRequest(
  request: Request,
  importer: ResendInboundWebhook,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 64 * 1024) return new Response(null, { status: 413 });
  const headers = {
    id: request.headers.get('svix-id') ?? '',
    timestamp: request.headers.get('svix-timestamp') ?? '',
    signature: request.headers.get('svix-signature') ?? '',
  };
  if (!headers.id || !headers.timestamp || !headers.signature) return new Response(null, { status: 401 });
  if (!request.body) return new Response(null, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bodyLength = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      bodyLength += next.value.byteLength;
      if (bodyLength > 64 * 1024) return new Response(null, { status: 413 });
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bodyLength).toString('utf8');
  try {
    await importer.handle(body, headers);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof InvalidResendWebhookSignature) return new Response(null, { status: 401 });
    // Retry transient API, storage, and partial multi-recipient failures. The journal is idempotent.
    return new Response(null, { status: 503 });
  }
}
