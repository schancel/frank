/**
 * Client for the relay's authenticated, recipient-private canonical mailbox
 * (`backend/cashweb/cashweb-registry/src/http/monad_message_cbor.rs`, `monad_mailbox.rs`).
 *
 * A recipient reads its own mailbox by proving control of its directory P key for each request:
 *
 * 1. `POST /message/auth/:recipient?resource=<inbox|mailbox|mailbox_stream>&since&cursor&limit&max_bytes`
 *    returns a JSON challenge `{ epoch, nonce, expires_at_ms, token, signing_domain, resource, since,
 *    cursor, limit, max_bytes, network_tag }`: a stateless, server-MACed, 60 s, single-use token
 *    bound to the complete future request. The client refuses to sign a challenge that is
 *    malformed, expired, for another network, or does not echo exactly what it asked for.
 * 2. The client signs `SHA256(preimage)` with the P key where
 *    ```
 *    preimage = MAILBOX_AUTH_DOMAIN (UTF-8) || 0x00 || len(endpoint)(u32 BE) || endpoint (UTF-8)
 *               || epoch(32) || nonce(32) || expires_at_ms(i64 BE)
 *               || token(32) || method || 0x00 || "/message/monad/" || path-tag || resource-tag(1)
 *               || recipient(20) || since(i64 BE) || cursor-flag(1) [|| len(u32 BE) || cursor UTF-8]
 *               || limit(u64 BE) || max_bytes(u64 BE)
 *               || len(network_tag)(u32 BE) || network_tag
 *    ```
 *    The domain is a fixed constant, never taken from the challenge. `endpoint` is the relay
 *    endpoint exactly as the owner's own signed Directory Current names it, the one the
 *    connection reaches (an exact origin match wins over a loopback dev-proxy match). The relay
 *    verifies against its own configured endpoint, so a signature made for one relay is useless
 *    at another.
 * 3. The signed request carries `x-frank-mailbox-{epoch,nonce,expires-at-ms,token,signature}`
 *    headers; the WebSocket stream carries the same values as query parameters.
 */
import WebSocket from "isomorphic-ws";
import { cryptoBackend } from "@frank/nakamoto";

import {
  addressFromCompressedPubkey,
  compareBytes,
  toHex,
  verifyPreviewDirectoryEvidence,
} from "@frank/codec";
import type { Current } from "@frank/directory-admission";
import {
  awaitCanonicalAbort,
  canonicalNetworkDescriptor,
  canonicalMultipartStreamGuard,
  canonicalObject,
  CANONICAL_DM_MAX_BYTES,
  CANONICAL_DM_MAX_STATUS_BYTES,
  CANONICAL_TERMINAL_REASONS,
  decodeCanonicalTransactions,
  defaultCanonicalFetch,
  describeCanonicalParts,
  inspectCanonicalPair,
  installedCanonicalOrigin,
  matchesRelayOrigin,
  parseCanonicalJSON,
  parseCanonicalMultipart,
  readCanonicalResponse,
  type CanonicalExactParts,
  type CanonicalFetch,
  type CanonicalMultipartPart,
  type CanonicalSubmissionEcho,
} from "./canonical-dm-transport";

/** `MAILBOX_AUTH_DOMAIN` in `monad_mailbox.rs`. */
export const MAILBOX_AUTH_DOMAIN = "frank:mailbox-http-auth:v3";
export const MAILBOX_NEXT_CURSOR_HEADER = "x-frank-mailbox-next-cursor";
// The relay issues 60-second challenges using its own clock. Allow a small
// positive clock skew without accepting an unbounded future expiry.
const MAX_CANONICAL_CHALLENGE_FUTURE_MS = 65_000;

export type MailboxResource =
  | "inbox"
  | "recovery"
  | "recovery_ack"
  | "mailbox"
  | "mailbox_stream";

/** Wire form of the challenge JSON (`MailboxChallengeBody`). */
export interface MailboxChallenge {
  epoch: string;
  nonce: string;
  expires_at_ms: number;
  token: string;
  signing_domain: string;
  resource: MailboxResource;
  since: number;
  cursor: string | null;
  limit: number;
  max_bytes: number;
  network_tag: string;
  /** Present only in challenges of the earlier protobuf readers below. */
  recovery_payload_hash?: string | null;
  recovery_obligation_id?: string | null;
}

/** DER ECDSA signer over a 32-byte digest, e.g. `digest => identity.signHash(Buffer.from(digest))`. */
export type MailboxDigestSigner = (
  digest: Uint8Array
) => Uint8Array | Promise<Uint8Array>;

/** One relay HTTP response, whatever its status. */
export interface MailboxHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  data: ArrayBuffer | Uint8Array | string | unknown;
}
export interface MailboxRetryOptions {
  /** Attempts per request including the first. Default 4. */
  maxAttempts?: number;
  /** First backoff delay; doubles per attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound for one exponential-backoff delay. Default 15 000 ms. */
  maxDelayMs?: number;
  /** Upper bound for a relay-supplied Retry-After (non-capacity 429). Default 60 000 ms. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MailboxAuthParams {
  relayBaseUrl: string;
  /** `0x`-prefixed 20-byte recipient address (identity address). */
  recipient: string;
  signDigest: MailboxDigestSigner;
  retry?: MailboxRetryOptions;
}

// --- errors ---------------------------------------------------------------------------------

export class MonadMailboxError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}
/** The relay answered 404 for a mailbox route: no mailbox there (disabled or too old). */
export class MonadMailboxUnavailableError extends MonadMailboxError {}
export class MonadMailboxAuthError extends MonadMailboxError {
  readonly phase: "challenge" | "request";
  constructor(message: string, phase: "challenge" | "request", code?: string) {
    super(message, 401, code);
    this.phase = phase;
  }
}
export class MonadMailboxStaleCursorError extends MonadMailboxError {}
export class MonadMailboxRequestError extends MonadMailboxError {}
export class MonadMailboxRecordTooLargeError extends MonadMailboxError {}
export class MonadMailboxRecoveryActiveError extends MonadMailboxError {}
/** The relay recovery endpoint has been retired (HTTP 410). */
export class MonadMailboxRecoveryRetiredError extends MonadMailboxError {}
/** Still failing after the retry budget; safe to try again later. */
export class MonadMailboxRetryableError extends MonadMailboxError {}
/** 429 `mailbox_challenge_capacity`: the recipient already has the relay's maximum number of
 * unexpired consumed challenges (120). Capacity only returns when they expire, so this is NOT
 * retried inside a call; `retryAfterMs` is the relay's `Retry-After` (60 s). */
export class MonadMailboxChallengeCapacityError extends MonadMailboxRetryableError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message, 429, "mailbox_challenge_capacity");
    this.retryAfterMs = retryAfterMs;
  }
}
/** The relay's challenge did not echo the request we made, or is malformed. */
export class MonadMailboxProtocolError extends MonadMailboxError {}

// --- preimage -------------------------------------------------------------------------------

function hexToBytes(hex: string, expected: number | undefined, name: string) {
  if (
    !/^(?:[0-9a-fA-F]{2})*$/.test(hex) ||
    (expected !== undefined && hex.length !== expected * 2)
  ) {
    throw new MonadMailboxProtocolError(`malformed ${name} in mailbox data`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function i64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) {
    throw new MonadMailboxProtocolError(`integer ${value} is not exactly i64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), false);
  return out;
}
function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MonadMailboxProtocolError(`integer ${value} is not exactly u64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}
function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function recipientBytes(recipient: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new MonadMailboxRequestError(
      `recipient must be a 0x-prefixed 20-byte address, got ${recipient}`
    );
  }
  return hexToBytes(recipient.slice(2), 20, "recipient");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Exact bytes the relay's `mailbox_auth_preimage` produces (and the recipient must sign after
 * SHA-256). `relayOrigin` is the origin of the relay the request goes to; the domain is the
 * constant {@link MAILBOX_AUTH_DOMAIN}, never the challenge's. */
export function buildMailboxAuthPreimage(
  challenge: MailboxChallenge,
  recipient: string,
  relayOrigin: string
): Uint8Array {
  const text = new TextEncoder();
  const [method, path, tag] = (
    {
      inbox: ["GET", "inbox/", 1],
      recovery: ["GET", "recovery/", 2],
      recovery_ack: ["POST", "recovery-ack/", 3],
      mailbox: ["GET", "mailbox/", 4],
      mailbox_stream: ["GET", "mailbox-ws/", 5],
    } as const
  )[challenge.resource] ?? [undefined, undefined, undefined];
  if (method === undefined) {
    throw new MonadMailboxProtocolError(
      `unexpected mailbox resource ${String(challenge.resource)}`
    );
  }
  const origin = text.encode(relayOrigin);
  const parts: Uint8Array[] = [
    text.encode(MAILBOX_AUTH_DOMAIN),
    Uint8Array.of(0),
    u32be(origin.length),
    origin,
    hexToBytes(challenge.epoch, 32, "epoch"),
    hexToBytes(challenge.nonce, 32, "nonce"),
    i64be(challenge.expires_at_ms),
    hexToBytes(challenge.token, 32, "token"),
    text.encode(`${method}\0/message/monad/${path}`),
    Uint8Array.of(tag),
    recipientBytes(recipient),
    i64be(challenge.since),
  ];
  if (challenge.cursor === null || challenge.cursor === undefined) {
    parts.push(Uint8Array.of(0));
  } else {
    const cursor = text.encode(challenge.cursor);
    parts.push(Uint8Array.of(1), u32be(cursor.length), cursor);
  }
  parts.push(u64be(challenge.limit), u64be(challenge.max_bytes));
  if (challenge.resource === "recovery_ack") {
    parts.push(
      hexToBytes(challenge.recovery_payload_hash ?? "", 32, "payload hash"),
      hexToBytes(challenge.recovery_obligation_id ?? "", 32, "obligation id")
    );
  }
  const networkTag = hexToBytes(
    challenge.network_tag,
    undefined,
    "network_tag"
  );
  parts.push(u32be(networkTag.length), networkTag);
  return concatBytes(parts);
}

/** One SHA-256 of the mailbox auth preimage. Matches `Sha256::digest` in
 * `authenticate_private_recipient` (decision #501). Not double-SHA256. */
export function mailboxAuthDigest(preimage: Uint8Array): Uint8Array {
  // cryptoBackend rejects Buffer, which is a Uint8Array subclass.
  return cryptoBackend.sha256(Uint8Array.from(preimage));
}

// --- transport with retries -----------------------------------------------------------------

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function bodyBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data !== null && typeof data === "object") {
    return new TextEncoder().encode(JSON.stringify(data));
  }
  return new Uint8Array();
}

function jsonBody(data: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes(data)));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(response: MailboxHttpResponse): string | undefined {
  const code = jsonBody(response.data)?.error;
  return typeof code === "string" ? code : undefined;
}

function retryAfterMs(response: MailboxHttpResponse): number | undefined {
  const header = response.headers["retry-after"];
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Marks a rejected HTTP call (no response received) as distinct from local errors. */
class NetworkFailure extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("network failure");
    this.cause = cause;
  }
}

class Backoff {
  private attempt = 0;
  private readonly max: number;
  private readonly base: number;
  private readonly cap: number;
  private readonly hintCap: number;
  private readonly sleeper: (ms: number) => Promise<void>;
  constructor(options: MailboxRetryOptions | undefined) {
    this.max = Math.max(1, options?.maxAttempts ?? 4);
    this.base = options?.baseDelayMs ?? 500;
    this.cap = options?.maxDelayMs ?? 15_000;
    this.hintCap = options?.maxRetryAfterMs ?? 60_000;
    this.sleeper = options?.sleep ?? defaultSleep;
  }
  /** Returns false when the budget is spent. */
  async wait(hintMs?: number): Promise<boolean> {
    this.attempt += 1;
    if (this.attempt >= this.max) return false;
    const exponential = this.base * 2 ** (this.attempt - 1);
    // Our own backoff is capped tightly, but a relay's explicit Retry-After is honoured up to a
    // separate, larger bound (retrying earlier than asked just burns attempts).
    await this.sleeper(
      Math.max(
        Math.min(this.cap, exponential),
        Math.min(this.hintCap, hintMs ?? 0)
      )
    );
    return true;
  }
}

function httpError(
  response: MailboxHttpResponse,
  phase: "challenge" | "request",
  what: string
): MonadMailboxError {
  const code = errorCode(response);
  const detail = `${what}: HTTP ${response.status}${code ? ` ${code}` : ""}`;
  switch (response.status) {
    case 404:
      return new MonadMailboxUnavailableError(
        `${detail}: the relay does not expose the private mailbox routes (mailbox disabled or relay too old); refusing to treat this as an empty inbox`,
        404,
        code
      );
    case 401:
      return new MonadMailboxAuthError(
        `${detail}: recipient authentication was rejected (unregistered profile, bad signature, expired/replayed challenge, or a cursor the relay no longer authenticates)`,
        phase,
        code
      );
    case 400:
      return code === "invalid_mailbox_cursor"
        ? new MonadMailboxStaleCursorError(
            `${detail}: cursor is older than the requested since bound; restart the scan without it`,
            400,
            code
          )
        : new MonadMailboxRequestError(detail, 400, code);
    case 413:
      return new MonadMailboxRecordTooLargeError(detail, 413, code);
    case 409:
      return new MonadMailboxRecoveryActiveError(detail, 409, code);
    case 410:
      return new MonadMailboxRecoveryRetiredError(detail, 410, code);
    default:
      return new MonadMailboxError(detail, response.status, code);
  }
}

const isRetryableStatus = (status: number) => status === 429 || status === 503;

/** Run `attempt` under the shared retry policy. `attempt` returns a response (any status) or
 * throws on a network-level failure. */
async function withRetries(
  retry: MailboxRetryOptions | undefined,
  what: string,
  attempt: () => Promise<MailboxHttpResponse>,
  phaseOf: (response: MailboxHttpResponse) => "challenge" | "request"
): Promise<MailboxHttpResponse> {
  const backoff = new Backoff(retry);
  let reauthenticated = false;
  for (;;) {
    let response: MailboxHttpResponse | undefined;
    let networkError: unknown;
    try {
      response = await attempt();
    } catch (err) {
      // Only a failed HTTP round trip is retryable; signer/protocol errors are not.
      if (!(err instanceof NetworkFailure)) throw err;
      networkError = err.cause;
    }
    if (
      response !== undefined &&
      response.status >= 200 &&
      response.status < 300
    ) {
      return response;
    }
    if (response === undefined) {
      if (!(await backoff.wait())) {
        throw new MonadMailboxRetryableError(
          `${what}: no response from relay (${
            networkError instanceof Error
              ? networkError.message
              : "network error"
          })`
        );
      }
      continue;
    }
    if (
      response.status === 429 &&
      errorCode(response) === "mailbox_challenge_capacity"
    ) {
      throw new MonadMailboxChallengeCapacityError(
        `${what}: HTTP 429 mailbox_challenge_capacity: too many unexpired authenticated requests for this recipient; retry after the relay's Retry-After`,
        retryAfterMs(response) ?? 60_000
      );
    }
    if (isRetryableStatus(response.status)) {
      if (!(await backoff.wait(retryAfterMs(response)))) {
        throw new MonadMailboxRetryableError(
          `${what}: HTTP ${response.status} ${
            errorCode(response) ?? ""
          } persisted through the retry budget`.trim(),
          response.status,
          errorCode(response)
        );
      }
      continue;
    }
    if (response.status === 401 && phaseOf(response) === "request") {
      // Expired/replayed/foreign-epoch challenge: one immediate retry with a fresh challenge.
      if (!reauthenticated) {
        reauthenticated = true;
        continue;
      }
    }
    throw httpError(response, phaseOf(response), what);
  }
}

// --- challenge + signed request -------------------------------------------------------------

interface ChallengeRequest {
  resource: MailboxResource;
  since?: number;
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  recoveryPayloadHashHex?: string;
  recoveryObligationIdHex?: string;
}

function validateChallenge(
  challenge: MailboxChallenge,
  request: ChallengeRequest
): void {
  const mismatches: string[] = [];
  if (challenge.signing_domain !== MAILBOX_AUTH_DOMAIN) {
    mismatches.push("signing_domain");
  }
  if (challenge.resource !== request.resource) mismatches.push("resource");
  if (request.since !== undefined && challenge.since !== request.since) {
    mismatches.push("since");
  }
  if ((challenge.cursor ?? undefined) !== request.cursor) {
    mismatches.push("cursor");
  }
  if (request.limit !== undefined && challenge.limit !== request.limit) {
    mismatches.push("limit");
  }
  if (
    request.maxBytes !== undefined &&
    challenge.max_bytes !== request.maxBytes
  ) {
    mismatches.push("max_bytes");
  }
  if (
    request.recoveryPayloadHashHex !== undefined &&
    challenge.recovery_payload_hash !== request.recoveryPayloadHashHex
  ) {
    mismatches.push("recovery_payload_hash");
  }
  if (
    request.recoveryObligationIdHex !== undefined &&
    challenge.recovery_obligation_id !== request.recoveryObligationIdHex
  ) {
    mismatches.push("recovery_obligation_id");
  }
  if (mismatches.length > 0) {
    throw new MonadMailboxProtocolError(
      `relay challenge does not echo the requested ${mismatches.join(
        ", "
      )}; refusing to sign`
    );
  }
}

// Canonical mailbox keeps the original P signing transcript, with an isolated HTTP namespace.
export interface CanonicalMailboxAuthParams extends MailboxAuthParams {
  /** Installed four-byte authentication tag or network identifier; e.g. 'MONT' | 'MON1' | 'MONR' | 'monad-testnet' | 'monad-mainnet'. */
  expectedNetworkTag:
    | "MONT"
    | "MON1"
    | "monad-testnet"
    | "monad-mainnet"
    | string;
  /** Compressed P locator, never admission authority. */
  subject: string;
  /** Must call the caller-owned public DirectoryStore.current with its trusted clock/relay context. */
  getCurrent(): Promise<Current>;
  fetch?: CanonicalFetch;
  signal?: AbortSignal;
}
export interface CanonicalMailboxPageParams extends CanonicalMailboxAuthParams {
  sinceMs?: number;
  cursor?: string;
  limit?: number;
  maxBytes?: number;
}
export interface CanonicalInboxRecord {
  readonly delivery: Uint8Array;
  readonly context: Uint8Array;
  /** Relay metadata: a pair cannot recompute the full raw-set index. */
  readonly submissionIdentity: string;
  readonly timestampMs: number;
}
export interface CanonicalRecoveryRecord extends CanonicalInboxRecord {
  readonly parts: CanonicalExactParts;
  readonly identity: CanonicalSubmissionEcho;
  readonly obligationId: string;
  readonly confirmedChildren: readonly number[];
  readonly lifecycle: string;
}
export interface CanonicalMailboxPage<T> {
  readonly records: readonly T[];
  /** Records the relay served whose delivery or context this client cannot decode or validate
   * (a shape or schema it does not read, or corrupt bytes). They are not messages and carry no
   * payment facts; they are listed so a reader can report them and move past them. Absent means
   * none. */
  readonly unreadable?: readonly CanonicalUnreadableRecord[];
  readonly nextCursor?: string;
}
/** What the relay's own record headers say about a record this client could not read. */
export interface CanonicalUnreadableRecord {
  readonly submissionIdentity: string;
  readonly timestampMs: number;
}
/** One record's pair, or undefined when this client cannot decode or validate it. That is a fact
 * about the one record, which any sender can cause; it must not fail the page it arrived on. The
 * page's own framing, limits and record headers are checked elsewhere and still fail the read. */
function canonicalReadablePair(
  parts: readonly CanonicalMultipartPart[]
): ReturnType<typeof inspectCanonicalPair> | undefined {
  try {
    return inspectCanonicalPair({
      delivery: parts[0].bytes,
      context: parts[1].bytes,
    });
  } catch {
    return undefined;
  }
}
const canonicalHex32 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function canonicalProtocol(message: string): never {
  throw new MonadMailboxProtocolError(message);
}
function canonicalCheckAbort(signal?: AbortSignal): void {
  if (signal?.aborted) canonicalProtocol("Canonical mailbox request aborted");
}
function canonicalPageBinding(
  params: CanonicalMailboxPageParams,
  resource: "inbox" | "recovery" | "mailbox"
): ChallengeRequest {
  const since = params.sinceMs ?? 0,
    limit = params.limit ?? (resource === "recovery" ? 20 : 50),
    maxBytes = params.maxBytes ?? CANONICAL_DM_MAX_BYTES;
  if (
    !Number.isSafeInteger(since) ||
    since < 0 ||
    (resource === "recovery" && since !== 0) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > CANONICAL_DM_MAX_BYTES ||
    (params.cursor !== undefined &&
      (params.cursor.length < 1 ||
        params.cursor.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(params.cursor)))
  )
    canonicalProtocol("Invalid bounded canonical page binding");
  return { resource, since, cursor: params.cursor, limit, maxBytes };
}
/** The owner's fresh admitted Directory Current, checked against the installed authority.
 * `endpoint` is the relay endpoint, exactly as the owner's signed statement names it, that the
 * connection origin reaches: an exact match wins over a loopback (dev proxy or tunnel) match.
 * It is the origin the mailbox preimage binds, and the one the relay checks against its own. */
async function canonicalCurrent(
  auth: CanonicalMailboxAuthParams,
  origin: string
): Promise<{ head: string; endpoint: string }> {
  canonicalCheckAbort(auth.signal);
  if (
    !/^(02|03)[0-9a-f]{64}$/.test(auth.subject) ||
    !/^0x[0-9a-f]{40}$/.test(auth.recipient)
  )
    canonicalProtocol("Invalid canonical P locator/address");
  const subject = hexToBytes(auth.subject, 33, "P subject");
  if ("0x" + toHex(addressFromCompressedPubkey(subject)) !== auth.recipient)
    canonicalProtocol("Canonical P locator/address mismatch");
  const descriptor = canonicalNetworkDescriptor(auth.expectedNetworkTag);
  const current = auth.signal
    ? await awaitCanonicalAbort(auth.getCurrent(), auth.signal)
    : await auth.getCurrent();
  canonicalCheckAbort(auth.signal);
  if (
    current.kind !== "current" ||
    current.evidence.kind !== "historical-evidence" ||
    current.status.forked
  )
    canonicalProtocol("Fresh admitted Directory Current required");
  const evidence = verifyPreviewDirectoryEvidence(
    current.evidence.attestation,
    descriptor.network
  );
  const statement = evidence.statement;
  const equal = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;
  const keyEqual = (
    a: { keyType: number; keyBytes: Uint8Array },
    b: { keyType: number; keyBytes: Uint8Array }
  ) => a.keyType === b.keyType && equal(a.keyBytes, b.keyBytes);
  const stamp = statement.preview;
  const checked =
    current.status.checkedTime.seconds * 1000000000n +
    BigInt(current.status.checkedTime.nanoseconds);
  const expires =
    statement.expiry.seconds * 1000000000n +
    BigInt(statement.expiry.nanoseconds);
  if (
    statement.subject.keyType !== 1 ||
    !equal(statement.subject.keyBytes, subject) ||
    !equal(evidence.statementFrame.frame, current.evidence.statement) ||
    !equal(evidence.statementHash, current.evidence.hash) ||
    !current.status.head ||
    !equal(current.status.head, evidence.statementHash) ||
    current.revision !== statement.revision ||
    current.status.revision !== current.revision ||
    !keyEqual(current.messageKey, stamp.messageDhKey) ||
    !keyEqual(current.stampKey, statement.stampKey) ||
    current.generations[0] !== stamp.mailboxKeyGeneration ||
    current.generations[1] !== stamp.stampKeyGeneration ||
    checked >= expires
  )
    canonicalProtocol(
      "Directory Current does not match installed canonical P authority"
    );
  const relay =
    statement.relays.find(
      (relay) => relay.endpoint.replace(/\/+$/, "") === origin
    ) ??
    statement.relays.find((relay) =>
      matchesRelayOrigin(relay.endpoint, origin)
    );
  if (relay === undefined)
    canonicalProtocol(
      "Directory Current does not match installed canonical P authority"
    );
  return { head: toHex(evidence.statementHash), endpoint: relay.endpoint };
}
function canonicalQuery(
  request: ChallengeRequest,
  challenge?: MailboxChallenge
): string {
  const query = new URLSearchParams();
  if (!challenge) query.set("resource", request.resource);
  query.set("since", String(challenge?.since ?? request.since ?? 0));
  const cursor = challenge?.cursor ?? request.cursor;
  if (cursor !== undefined && cursor !== null) query.set("cursor", cursor);
  query.set("limit", String(challenge?.limit ?? request.limit ?? 1));
  query.set(
    "max_bytes",
    String(challenge?.max_bytes ?? request.maxBytes ?? CANONICAL_DM_MAX_BYTES)
  );
  if (request.recoveryPayloadHashHex !== undefined)
    query.set("recovery_payload_hash", request.recoveryPayloadHashHex);
  if (request.recoveryObligationIdHex !== undefined)
    query.set("recovery_obligation_id", request.recoveryObligationIdHex);
  return query.toString();
}
async function canonicalRoundTrip(
  auth: CanonicalMailboxAuthParams,
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  budget: number
): Promise<MailboxHttpResponse> {
  canonicalCheckAbort(auth.signal);
  const controller = new AbortController(),
    abort = () => controller.abort();
  auth.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 60000);
  try {
    let response;
    try {
      response = await awaitCanonicalAbort(
        (auth.fetch ?? defaultCanonicalFetch)(url, {
          method,
          headers,
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
        }),
        controller.signal
      );
    } catch (error) {
      canonicalCheckAbort(auth.signal);
      throw new NetworkFailure(error);
    }
    if (response.url !== url)
      canonicalProtocol("Canonical mailbox response origin/path mismatch");
    const responseHeaders: Record<string, string | undefined> = {};
    for (const name of [
      "content-type",
      "retry-after",
      MAILBOX_NEXT_CURSOR_HEADER,
    ])
      responseHeaders[name] = response.headers.get(name) ?? undefined;
    const cursor = responseHeaders[MAILBOX_NEXT_CURSOR_HEADER];
    if (
      cursor !== undefined &&
      (cursor.length < 1 ||
        cursor.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(cursor))
    )
      canonicalProtocol("Invalid bounded opaque cursor");
    // Fixed logical header charge: 27 name bytes + ': ' + value + CRLF.
    const allowance =
      response.status === 200 && method === "GET"
        ? budget - (cursor === undefined ? 0 : 31 + cursor.length)
        : Math.min(budget, CANONICAL_DM_MAX_STATUS_BYTES);
    if (allowance < 1)
      canonicalProtocol("Cursor exceeds complete page byte budget");
    const guard =
      response.status === 200 && method === "GET"
        ? canonicalMultipartStreamGuard(
            responseHeaders["content-type"] ?? "",
            Number(new URL(url).searchParams.get("limit")),
            url.includes("/recovery/") ? 4 : 2
          )
        : undefined;
    return {
      status: response.status,
      headers: responseHeaders,
      data: await readCanonicalResponse(
        response,
        allowance,
        controller.signal,
        guard
      ),
    };
  } finally {
    clearTimeout(timeout);
    auth.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
async function canonicalSignedRequest(
  auth: CanonicalMailboxAuthParams,
  request: ChallengeRequest,
  path: string
): Promise<MailboxHttpResponse> {
  canonicalCheckAbort(auth.signal);
  const controller = new AbortController(),
    abort = () => controller.abort();
  auth.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 60000);
  try {
    return await awaitCanonicalAbort(
      canonicalSignedRequestWithin(
        { ...auth, signal: controller.signal },
        request,
        path
      ),
      controller.signal
    );
  } finally {
    clearTimeout(timeout);
    auth.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
/** The relay's challenge, refused before anything is signed unless it is well formed, unexpired,
 * for this network, and echoes exactly the request the client asked for. Every canonical signer
 * (HTTP pages and the WebSocket stream) goes through here. */
function canonicalChallenge(
  response: MailboxHttpResponse,
  request: ChallengeRequest,
  descriptor: ReturnType<typeof canonicalNetworkDescriptor>
): MailboxChallenge {
  if (
    (response.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    canonicalProtocol("Canonical challenge JSON required");
  const raw = canonicalObject(parseCanonicalJSON(bodyBytes(response.data)), [
    "epoch",
    "nonce",
    "expires_at_ms",
    "token",
    "signing_domain",
    "resource",
    "since",
    "cursor",
    "limit",
    "max_bytes",
    "network_tag",
  ]);
  const challenge = raw as unknown as MailboxChallenge;
  validateChallenge(challenge, request);
  const challengeNow = Date.now();
  if (
    !canonicalHex32(challenge.epoch) ||
    !canonicalHex32(challenge.nonce) ||
    !canonicalHex32(challenge.token) ||
    !Number.isSafeInteger(challenge.expires_at_ms) ||
    challenge.expires_at_ms <= challengeNow ||
    challenge.expires_at_ms >
      challengeNow + MAX_CANONICAL_CHALLENGE_FUTURE_MS ||
    (challenge.network_tag !==
      bytesToHex(new TextEncoder().encode(descriptor.tag)) &&
      challenge.network_tag !==
        bytesToHex(new TextEncoder().encode(descriptor.network)))
  )
    canonicalProtocol(
      "Malformed or foreign canonical challenge; refusing to sign"
    );
  return challenge;
}
async function canonicalSignedRequestWithin(
  auth: CanonicalMailboxAuthParams,
  request: ChallengeRequest,
  path: string
): Promise<MailboxHttpResponse> {
  const origin = installedCanonicalOrigin(auth.relayBaseUrl);
  const descriptor = canonicalNetworkDescriptor(auth.expectedNetworkTag);
  // Local eligibility precedes the first challenge. Each retry obtains actual fresh Current again.
  await canonicalCurrent(auth, origin);
  let phase: "challenge" | "request" = "challenge";
  return withRetries(
    auth.retry,
    "Canonical private mailbox",
    async () => {
      phase = "challenge";
      const { head, endpoint } = await canonicalCurrent(auth, origin);
      const challengeURL = `${origin}/message/auth/${
        auth.recipient
      }?${canonicalQuery(request)}`;
      const response = await canonicalRoundTrip(
        auth,
        challengeURL,
        "POST",
        {
          "x-frank-mailbox-subject": auth.subject,
          Accept: "application/json",
        },
        CANONICAL_DM_MAX_STATUS_BYTES
      );
      if (response.status !== 200) return response;
      const challenge = canonicalChallenge(response, request, descriptor);
      canonicalCheckAbort(auth.signal);
      const signing = Promise.resolve(
        auth.signDigest(
          mailboxAuthDigest(
            buildMailboxAuthPreimage(challenge, auth.recipient, endpoint)
          )
        )
      );
      const signature = auth.signal
        ? await awaitCanonicalAbort(signing, auth.signal)
        : await signing;
      canonicalCheckAbort(auth.signal);
      if (
        !(signature instanceof Uint8Array) ||
        signature.length < 8 ||
        signature.length > 80
      )
        canonicalProtocol("Invalid bounded P signature");
      if (
        (await canonicalCurrent(auth, origin)).head !== head ||
        Date.now() >= challenge.expires_at_ms
      )
        canonicalProtocol(
          "Canonical authority/challenge changed while signing"
        );
      phase = "request";
      const headers = {
        "x-frank-mailbox-subject": auth.subject,
        "x-frank-mailbox-epoch": challenge.epoch,
        "x-frank-mailbox-nonce": challenge.nonce,
        "x-frank-mailbox-expires-at-ms": String(challenge.expires_at_ms),
        "x-frank-mailbox-token": challenge.token,
        "x-frank-mailbox-signature": bytesToHex(signature),
        Accept:
          request.resource === "recovery_ack"
            ? "application/json"
            : "multipart/mixed",
      };
      const url =
        `${origin}/message/${path}` +
        (request.resource === "recovery_ack"
          ? ""
          : `?${canonicalQuery(request, challenge)}`);
      return canonicalRoundTrip(
        auth,
        url,
        request.resource === "recovery_ack" ? "POST" : "GET",
        headers,
        request.resource === "recovery_ack"
          ? CANONICAL_DM_MAX_STATUS_BYTES
          : request.maxBytes ?? CANONICAL_DM_MAX_BYTES
      );
    },
    () => phase
  );
}
function canonicalRecordParts(
  outer: CanonicalMultipartPart,
  count: number
): readonly CanonicalMultipartPart[] {
  const hasDirection = outer.headers["x-frank-mailbox-direction"] !== undefined;
  const expectedHeaderCount = hasDirection ? 5 : 4;
  if (
    outer.name !== "record" ||
    Object.keys(outer.headers).length !== expectedHeaderCount ||
    !canonicalHex32(outer.headers["x-frank-submission-identity"]) ||
    !/^(0|[1-9][0-9]*)$/.test(
      outer.headers["x-frank-mailbox-timestamp-ms"] ?? ""
    ) ||
    !Number.isSafeInteger(Number(outer.headers["x-frank-mailbox-timestamp-ms"]))
  )
    canonicalProtocol("Invalid canonical record headers");
  const parts = parseCanonicalMultipart(
    outer.bytes,
    outer.contentType,
    "multipart/mixed",
    count
  );
  const names = ["delivery", "context", "transactions", "recovery"],
    media = [
      "application/vnd.frank.cbor",
      "application/cbor",
      "application/cbor",
      "application/json",
    ];
  if (
    parts.length !== count ||
    parts.some(
      (part, i) =>
        part.name !== names[i] ||
        part.contentType !== media[i] ||
        Object.keys(part.headers).length !== 2
    )
  )
    canonicalProtocol("Invalid canonical record parts");
  return parts;
}
function canonicalPageRecords(
  response: MailboxHttpResponse,
  limit: number
): readonly CanonicalMultipartPart[] {
  if (response.status !== 200)
    canonicalProtocol("Canonical page must use HTTP200");
  return parseCanonicalMultipart(
    bodyBytes(response.data),
    response.headers["content-type"] ?? "",
    "multipart/mixed",
    limit
  );
}
/** Complete page only: opening/financial authority remains with public B and the wallet owner. */
export async function fetchCanonicalInboxPage(
  params: CanonicalMailboxPageParams
): Promise<CanonicalMailboxPage<CanonicalInboxRecord>> {
  const binding = canonicalPageBinding(params, "inbox");
  const response = await canonicalSignedRequest(
    params,
    binding,
    `inbox/${params.recipient}`
  );
  const seen = new Set<string>();
  const records: CanonicalInboxRecord[] = [];
  const unreadable: CanonicalUnreadableRecord[] = [];
  for (const outer of canonicalPageRecords(response, binding.limit!)) {
    const parts = canonicalRecordParts(outer, 2);
    const submissionIdentity = outer.headers["x-frank-submission-identity"];
    const timestampMs = Number(outer.headers["x-frank-mailbox-timestamp-ms"]);
    const pair = canonicalReadablePair(parts);
    if (pair === undefined) {
      unreadable.push(Object.freeze({ submissionIdentity, timestampMs }));
      continue;
    }
    if (
      pair.network !==
        canonicalNetworkDescriptor(params.expectedNetworkTag).network ||
      pair.recipient !== params.recipient ||
      seen.has(pair.payload_hash)
    )
      canonicalProtocol("Canonical inbox recipient/network/duplicate mismatch");
    seen.add(pair.payload_hash);
    records.push(
      Object.freeze({
        delivery: Uint8Array.from(parts[0].bytes),
        context: Uint8Array.from(parts[1].bytes),
        submissionIdentity,
        timestampMs,
      })
    );
  }
  canonicalCheckAbort(params.signal);
  return Object.freeze({
    records: Object.freeze(records),
    unreadable: Object.freeze(unreadable),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER],
  });
}

export interface CanonicalMailboxRecord {
  readonly direction: "in" | "out";
  readonly delivery: Uint8Array;
  readonly context: Uint8Array;
  readonly submissionIdentity: string;
  readonly timestampMs: number;
}

/** Complete mailbox page: contains both inbound and outbound messages. */
export async function fetchCanonicalMailboxPage(
  params: CanonicalMailboxPageParams
): Promise<CanonicalMailboxPage<CanonicalMailboxRecord>> {
  const binding = canonicalPageBinding(params, "mailbox");
  const response = await canonicalSignedRequest(
    params,
    binding,
    `mailbox/${params.recipient}`
  );
  const seen = new Set<string>();
  const expectedNetwork = canonicalNetworkDescriptor(
    params.expectedNetworkTag
  ).network;
  const records: CanonicalMailboxRecord[] = [];
  const unreadable: CanonicalUnreadableRecord[] = [];
  for (const outer of canonicalPageRecords(response, binding.limit!)) {
    const parts = canonicalRecordParts(outer, 2);
    // The relay's own framing is checked for every record, readable or not.
    const direction = outer.headers["x-frank-mailbox-direction"];
    if (direction !== "in" && direction !== "out")
      canonicalProtocol("Combined mailbox requires explicit in/out direction");
    const submissionIdentity = outer.headers["x-frank-submission-identity"];
    const timestampMs = Number(outer.headers["x-frank-mailbox-timestamp-ms"]);
    const pair = canonicalReadablePair(parts);
    if (pair === undefined) {
      unreadable.push(Object.freeze({ submissionIdentity, timestampMs }));
      continue;
    }
    if (pair.network !== expectedNetwork || seen.has(pair.payload_hash)) {
      canonicalProtocol("Canonical mailbox network or duplicate mismatch");
    }
    seen.add(pair.payload_hash);
    records.push(
      Object.freeze({
        direction,
        delivery: Uint8Array.from(parts[0].bytes),
        context: Uint8Array.from(parts[1].bytes),
        submissionIdentity,
        timestampMs,
      })
    );
  }
  canonicalCheckAbort(params.signal);
  return Object.freeze({
    records: Object.freeze(records),
    unreadable: Object.freeze(unreadable),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER],
  });
}

export interface CanonicalMailboxStreamParams
  extends CanonicalMailboxAuthParams {
  readonly onRecord: (record: CanonicalMailboxRecord) => void;
  readonly onError?: (error: Error) => void;
  readonly onReady?: () => void;
  readonly onClose?: () => void;
}

export interface CanonicalMailboxStreamHandle {
  close: () => void;
}

/** Connects to authenticated WebSocket mailbox stream (/message/monad/cbor/mailbox/:address/ws). */
export async function connectCanonicalMailboxStream(
  params: CanonicalMailboxStreamParams
): Promise<CanonicalMailboxStreamHandle> {
  const origin = installedCanonicalOrigin(params.relayBaseUrl);
  const descriptor = canonicalNetworkDescriptor(params.expectedNetworkTag);
  const { endpoint } = await canonicalCurrent(params, origin);
  const request: ChallengeRequest = {
    resource: "mailbox_stream",
    since: 0,
    limit: 1,
    maxBytes: 0,
  };
  const challengeURL = `${origin}/message/auth/${
    params.recipient
  }?${canonicalQuery(request)}`;

  const response = await canonicalRoundTrip(
    params,
    challengeURL,
    "POST",
    {
      "x-frank-mailbox-subject": params.subject,
      Accept: "application/json",
    },
    CANONICAL_DM_MAX_STATUS_BYTES
  );
  if (response.status !== 200) {
    throw new MonadMailboxProtocolError(
      `challenge request failed with status ${response.status}`
    );
  }
  const challenge = canonicalChallenge(response, request, descriptor);
  const preimage = buildMailboxAuthPreimage(
    challenge,
    params.recipient,
    endpoint
  );
  const signature = await params.signDigest(mailboxAuthDigest(preimage));

  const wsOrigin = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const query = new URLSearchParams({
    epoch: challenge.epoch,
    nonce: challenge.nonce,
    token: challenge.token,
    expires_at_ms: String(challenge.expires_at_ms),
    signature: bytesToHex(signature),
    subject: params.subject,
  });
  if (
    origin.includes("ngrok") ||
    (typeof window !== "undefined" &&
      window.location?.hostname?.includes("ngrok"))
  ) {
    query.set("ngrok-skip-browser-warning", "1");
  }
  const wsUrl = `${wsOrigin}/message/mailbox/${
    params.recipient
  }/ws?${query.toString()}`;

  const ws = new WebSocket(wsUrl);
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    if (!closed) {
      closed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };

  if (params.signal) {
    params.signal.addEventListener("abort", cleanup, { once: true });
  }

  ws.onopen = () => {
    params.onReady?.();
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          if (typeof (ws as any).ping === "function") {
            (ws as any).ping();
          } else {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        } catch {
          // ignore
        }
      }
    }, 15_000);
  };

  ws.onclose = () => {
    cleanup();
    params.onClose?.();
  };

  ws.onerror = (event: unknown) => {
    const error =
      event instanceof Error
        ? event
        : new Error(
            (event as { message?: string })?.message ?? "WebSocket stream error"
          );
    params.onError?.(error);
  };

  ws.onmessage = (event: { data: unknown }) => {
    try {
      const dataStr =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(bodyBytes(event.data));
      const parsed = JSON.parse(dataStr);
      if (parsed.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // ignore
        }
        return;
      }
      if (parsed.type === "pong") {
        return;
      }
      if (parsed.direction === "in" || parsed.direction === "out") {
        const record: CanonicalMailboxRecord = {
          direction: parsed.direction,
          delivery: hexToBytes(parsed.delivery, undefined, "delivery"),
          context: hexToBytes(parsed.context, undefined, "context"),
          submissionIdentity: parsed.submission_identity,
          timestampMs: Number(parsed.timestamp_ms),
        };
        params.onRecord(record);
      }
    } catch (err) {
      params.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  if (typeof (ws as any).on === "function") {
    try {
      (ws as any).on("ping", (data: any) => {
        try {
          (ws as any).pong(data);
        } catch {
          // ignore
        }
      });
      (ws as any).on("pong", () => {
        // clean pong handling
      });
    } catch {
      // ignore
    }
  }

  return {
    close: cleanup,
  };
}
