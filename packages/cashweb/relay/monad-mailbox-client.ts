/**
 * Client for the relay's authenticated, recipient-private Monad mailbox
 * (`backend/cashweb/cashweb-registry/src/http/monad_message.rs`, `monad_mailbox.rs`).
 *
 * PR #197 removed the unauthenticated `GET /message/monad?since=` and
 * `GET /message/monad/:payload_hash` routes. A recipient now reads its own inbox by proving control
 * of its registered identity key for each request:
 *
 * 1. `POST /message/monad/auth/:recipient?resource=<inbox|recovery|recovery_ack>&since&cursor&limit&max_bytes
 *    [&recovery_payload_hash&recovery_obligation_id]` returns a JSON challenge
 *    `{ epoch, nonce, expires_at_ms, token, signing_domain, resource, since, cursor, limit,
 *    max_bytes, network_tag, recovery_payload_hash, recovery_obligation_id }`. It is a stateless,
 *    server-MACed, 60 s, single-use token bound to the *complete* future request.
 * 2. The client signs `SHA256(preimage)` with the identity key (DER ECDSA, the same scheme as the
 *    profile registration signature) where
 *    ```
 *    preimage = signing_domain (UTF-8) || 0x00 || epoch(32) || nonce(32) || expires_at_ms(i64 BE)
 *               || token(32) || method || 0x00 || "/message/monad/" || path-tag || resource-tag(1)
 *               || recipient(20) || since(i64 BE) || cursor-flag(1) [|| len(u32 BE) || cursor UTF-8]
 *               || limit(u64 BE) || max_bytes(u64 BE)
 *               [|| recovery_payload_hash(32) || recovery_obligation_id(32)   (recovery_ack only)]
 *               || len(network_tag)(u32 BE) || network_tag
 *    ```
 *    with (method, path-tag, resource-tag) = (GET, "inbox/", 1) | (GET, "recovery/", 2) |
 *    (POST, "recovery-ack/", 3). The cursor is the opaque token exactly as the relay returned it.
 * 3. The signed request goes out with `x-frank-mailbox-{epoch,nonce,expires-at-ms,token,signature}`
 *    headers (signature is hex DER). Pages return `x-frank-mailbox-next-cursor` while more rows
 *    remain; the next request must bind and send that cursor unchanged.
 *
 * Failure semantics implemented here (all derived from the Rust handlers):
 * - 404 on any mailbox route: the relay has no mailbox (disabled, or predates it). Surfaced as
 *   {@link MonadMailboxUnavailableError}; never treated as an empty inbox.
 * - 401 `mailbox_auth_failed`: unknown recipient, bad signature, expired/replayed/foreign-epoch
 *   challenge, or a cursor the relay no longer authenticates (e.g. relay restart). A request-phase
 *   401 is retried once with a fresh challenge; then {@link MonadMailboxAuthError}.
 * - 400 `invalid_mailbox_cursor`: cursor older than `since` -> {@link MonadMailboxStaleCursorError}.
 * - 400 `invalid_mailbox_limit`, 413 `mailbox_record_exceeds_page_budget`: caller/protocol errors.
 * - 409 `recovery_obligation_is_active`: ack refused while the obligation is still active.
 * - 429 `mailbox_challenge_capacity` (recipient already holds the relay's maximum of 120 unexpired consumed challenges;
 *   `Retry-After: 60`): {@link MonadMailboxChallengeCapacityError}, not retried in-call because
 *   capacity only returns when challenges expire. Replay/expiry remain 401.
 * - Other 429 (Retry-After) and 503 (`mailbox_auth_retryable` at read capacity), plus network failures:
 *   retried with bounded exponential backoff (honouring Retry-After), then
 *   {@link MonadMailboxRetryableError}.
 *
 * The relay keeps at most 120 unexpired consumed challenges per recipient (60 s TTL), so more than
 * 120 authenticated requests inside 60 s are refused; {@link fetchMonadMailboxInbox} therefore asks
 * for 100 rows per page (the maximum) and a caller that gets a truncated result simply polls again.
 */
import axios from "axios";
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

import {
  StoredMonadMessages,
  MonadStampedMessage,
  MonadStampPayment,
  StoredMonadMessage,
} from "./monad-mailbox-compat";
export {
  StoredMonadMessages,
  MonadStampedMessage,
  MonadStampPayment,
  StoredMonadMessage,
};
// Type-only back-edge (erased at compile time), same as `./monad-message-feed.ts` had.
import type {
  MonadStampedMessageProto,
  StoredMonadMessageProto,
} from "@frank/wallet/monad-stamp-client";

/** `MAILBOX_AUTH_DOMAIN` in `monad_message.rs`. */
export const MAILBOX_AUTH_DOMAIN = "frank:mailbox-http-auth:v2";
/** `MAX_PRIVATE_MAILBOX_PAGE` in `monad_message.rs`. */
export const MAILBOX_MAX_PAGE_LIMIT = 100;
export const MAILBOX_NEXT_CURSOR_HEADER = "x-frank-mailbox-next-cursor";

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
  recovery_payload_hash: string | null;
  recovery_obligation_id: string | null;
}

/** DER ECDSA signer over a 32-byte digest, e.g. `digest => identity.signHash(Buffer.from(digest))`. */
export type MailboxDigestSigner = (
  digest: Uint8Array
) => Uint8Array | Promise<Uint8Array>;

/** Minimal HTTP surface so tests can run the client against an in-process contract mock. Must
 * resolve (not throw) for every HTTP status and reject only when no response was received. */
export interface MailboxHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  data: ArrayBuffer | Uint8Array | string | unknown;
}
export interface MailboxHttpRequest {
  method: "get" | "post";
  url: string;
  params?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}
export type MailboxHttp = (
  request: MailboxHttpRequest
) => Promise<MailboxHttpResponse>;

const defaultHttp: MailboxHttp = async (request) => {
  const response = await axios({
    method: request.method,
    url: request.url,
    params: request.params,
    headers: request.headers,
    responseType: "arraybuffer",
    validateStatus: () => true,
  });
  return {
    status: response.status,
    headers: response.headers as Record<string, string | undefined>,
    data: response.data,
  };
};

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
  http?: MailboxHttp;
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
 * SHA-256). Built only from the challenge JSON, mirroring the Rust test helper
 * `client_mailbox_auth_preimage`. */
export function buildMailboxAuthPreimage(
  challenge: MailboxChallenge,
  recipient: string
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
  const parts: Uint8Array[] = [
    text.encode(challenge.signing_domain),
    Uint8Array.of(0),
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

async function net(
  call: Promise<MailboxHttpResponse>
): Promise<MailboxHttpResponse> {
  try {
    return await call;
  } catch (err) {
    throw new NetworkFailure(err);
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

async function signedRequest(
  auth: MailboxAuthParams,
  challengeRequest: ChallengeRequest,
  send: (
    challenge: MailboxChallenge,
    headers: Record<string, string>
  ) => Promise<MailboxHttpResponse>,
  what: string
): Promise<MailboxHttpResponse> {
  recipientBytes(auth.recipient); // fail locally on a malformed recipient, before any request
  const http = auth.http ?? defaultHttp;
  const base = auth.relayBaseUrl.replace(/\/+$/, "");
  // Track which step failed so a 401 is classified correctly.
  let phase: "challenge" | "request" = "challenge";
  return withRetries(
    auth.retry,
    what,
    async () => {
      phase = "challenge";
      const challengeResponse = await net(
        http({
          method: "post",
          url: `${base}/message/monad/auth/${auth.recipient}`,
          params: {
            resource: challengeRequest.resource,
            since: challengeRequest.since,
            cursor: challengeRequest.cursor,
            limit: challengeRequest.limit,
            max_bytes: challengeRequest.maxBytes,
            recovery_payload_hash: challengeRequest.recoveryPayloadHashHex,
            recovery_obligation_id: challengeRequest.recoveryObligationIdHex,
          },
        })
      );
      if (challengeResponse.status < 200 || challengeResponse.status >= 300) {
        return challengeResponse;
      }
      const challenge = jsonBody(challengeResponse.data) as
        | MailboxChallenge
        | undefined;
      if (challenge === undefined) {
        throw new MonadMailboxProtocolError(
          `${what}: malformed challenge JSON`
        );
      }
      validateChallenge(challenge, challengeRequest);
      const digest = mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient)
      );
      const signature = await auth.signDigest(digest);
      phase = "request";
      return net(
        send(challenge, {
          "x-frank-mailbox-epoch": challenge.epoch,
          "x-frank-mailbox-nonce": challenge.nonce,
          "x-frank-mailbox-expires-at-ms": String(challenge.expires_at_ms),
          "x-frank-mailbox-token": challenge.token,
          "x-frank-mailbox-signature": bytesToHex(signature),
        })
      );
    },
    () => phase
  );
}

// --- inbox ----------------------------------------------------------------------------------

function decodeStored(bytes: Uint8Array): StoredMonadMessageProto[] {
  const decoded = StoredMonadMessages.deserializeBinary(bytes);
  return decoded.getMessagesList().map((stored) => {
    const nested = stored.getMessage();
    return {
      message: nested
        ? {
            stampPayments: nested.getStampPaymentsList().map((payment) => ({
              childIndex: payment.getChildIndex(),
              rawTx: payment.getRawTx_asU8(),
            })),
            encryptedPayload: nested.getEncryptedPayload_asU8(),
            payloadHash: nested.getPayloadHash_asU8(),
          }
        : undefined,
      timestamp: stored.getTimestamp(),
      networkTag: stored.getNetworkTag_asU8(),
    };
  });
}

export interface MailboxInboxPage {
  messages: StoredMonadMessageProto[];
  /** Opaque token for the next page, absent on the last page. */
  nextCursor: string | undefined;
}

/** One authenticated inbox page: `GET /message/monad/inbox/:recipient`. */
export async function fetchMonadMailboxInboxPage(
  params: MailboxAuthParams & {
    sinceMs: number;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
  }
): Promise<MailboxInboxPage> {
  const http = params.http ?? defaultHttp;
  const base = params.relayBaseUrl.replace(/\/+$/, "");
  const limit = params.limit ?? MAILBOX_MAX_PAGE_LIMIT;
  const response = await signedRequest(
    params,
    {
      resource: "inbox",
      since: params.sinceMs,
      cursor: params.cursor,
      limit,
      maxBytes: params.maxBytes,
    },
    (challenge, headers) =>
      http({
        method: "get",
        url: `${base}/message/monad/inbox/${params.recipient}`,
        // The challenge fixed the effective limit/max_bytes; send exactly those.
        params: {
          since: challenge.since,
          cursor: challenge.cursor ?? undefined,
          limit: challenge.limit,
          max_bytes: challenge.max_bytes,
        },
        headers,
      }),
    "GET /message/monad/inbox"
  );
  return {
    messages: decodeStored(bodyBytes(response.data)),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER] || undefined,
  };
}

export interface MailboxInboxResult {
  messages: StoredMonadMessageProto[];
  /** Set when a later page failed (or the page budget ran out) after earlier pages succeeded.
   * `messages` is then a prefix that ends on a COMPLETE timestamp group: rows sharing the last
   * returned timestamp are dropped, because the relay's cursor is `(timestamp, payload_hash)` and
   * `since` is inclusive, so a caller that advances `since = lastTimestamp + 1` would otherwise
   * skip the rest of a half-fetched group forever. Advancing to `lastTimestamp + 1` is therefore
   * safe, and the dropped rows are refetched by the next poll. */
  truncatedBy?: MonadMailboxError;
}

/**
 * Every inbox row at or after `sinceMs`, following `x-frank-mailbox-next-cursor` until the relay
 * stops returning one. Rows are de-duplicated by payload hash. A failure on the *first* page
 * throws; a failure on a later page returns a complete-timestamp-group prefix with `truncatedBy` set
 * (the relay caps consumed challenges per recipient, so very large backlogs are drained over
 * several polls). If every row fetched so far shares one timestamp there is no safe prefix, so the
 * truncation error itself is thrown rather than returning an empty-looking success.
 */
export async function fetchMonadMailboxInbox(
  params: MailboxAuthParams & {
    sinceMs: number;
    pageLimit?: number;
    maxPages?: number;
  }
): Promise<MailboxInboxResult> {
  const maxPages = params.maxPages ?? 64;
  const seen = new Set<string>();
  const messages: StoredMonadMessageProto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let result: MailboxInboxPage;
    try {
      result = await fetchMonadMailboxInboxPage({
        ...params,
        cursor,
        limit: params.pageLimit,
      });
    } catch (err) {
      if (page > 0 && err instanceof MonadMailboxError) {
        return {
          messages: completeTimestampPrefix(messages, err),
          truncatedBy: err,
        };
      }
      throw err;
    }
    for (const stored of result.messages) {
      const key = stored.message ? bytesToHex(stored.message.payloadHash) : "";
      if (key !== "" && seen.has(key)) continue;
      if (key !== "") seen.add(key);
      messages.push(stored);
    }
    if (result.nextCursor === undefined) return { messages };
    if (result.nextCursor === cursor) {
      throw new MonadMailboxProtocolError(
        "relay returned the same mailbox cursor twice; aborting to avoid a loop"
      );
    }
    cursor = result.nextCursor;
  }
  const budget = new MonadMailboxRetryableError(
    `inbox scan stopped after ${maxPages} pages; poll again to continue`
  );
  return {
    messages: completeTimestampPrefix(messages, budget),
    truncatedBy: budget,
  };
}

/** Drop the trailing rows that share the last timestamp; throw `reason` if nothing would remain. */
function completeTimestampPrefix(
  messages: StoredMonadMessageProto[],
  reason: MonadMailboxError
): StoredMonadMessageProto[] {
  const lastTimestamp = messages[messages.length - 1]?.timestamp;
  let end = messages.length;
  while (end > 0 && messages[end - 1].timestamp === lastTimestamp) end--;
  if (end === 0) throw reason;
  return messages.slice(0, end);
}

// --- recovery -------------------------------------------------------------------------------

/** One incomplete-delivery obligation (`ConfirmedPrefixBody`): the payment transactions of
 * `canonicalMessage` whose children are in `confirmedChildren` are confirmed on chain and pay
 * one-time addresses only this recipient can spend, even though the message never reached the
 * inbox. `lifecycle` is `pending`, `fully_confirmed`, `delivered` or `terminal:<reason>`; only
 * terminal obligations can be acknowledged. */
export interface MailboxRecoveryRecord {
  payloadHashHex: string;
  obligationIdHex: string;
  canonicalMessage: MonadStampedMessageProto;
  confirmedChildren: number[];
  lifecycle: string;
}

function decodeRecoveries(data: unknown): {
  records: MailboxRecoveryRecord[];
  nextCursor?: string;
} {
  const body = jsonBody(data) as
    | {
        recoveries?: Array<{
          payload_hash: string;
          obligation_id: string;
          canonical_message: string;
          confirmed_children: number[];
          lifecycle: string;
        }>;
        next_cursor?: string;
      }
    | undefined;
  if (body === undefined || !Array.isArray(body.recoveries)) {
    throw new MonadMailboxProtocolError("malformed recovery page JSON");
  }
  return {
    records: body.recoveries.map((r) => {
      const nested = MonadStampedMessage.deserializeBinary(
        hexToBytes(r.canonical_message, undefined, "canonical_message")
      );
      return {
        payloadHashHex: r.payload_hash,
        obligationIdHex: r.obligation_id,
        canonicalMessage: {
          stampPayments: nested.getStampPaymentsList().map((payment) => ({
            childIndex: payment.getChildIndex(),
            rawTx: payment.getRawTx_asU8(),
          })),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        },
        confirmedChildren: r.confirmed_children,
        lifecycle: r.lifecycle,
      };
    }),
    nextCursor: body.next_cursor,
  };
}

/**
 * One authenticated recovery page: `GET /message/monad/recovery/:recipient`.
 * @deprecated Recovery endpoint is retired; stamp recovery is unified through the mailbox.
 */
export async function fetchMonadMailboxRecoveryPage(
  params: MailboxAuthParams & {
    cursor?: string;
    limit?: number;
    maxBytes?: number;
  }
): Promise<{ records: MailboxRecoveryRecord[]; nextCursor?: string }> {
  const http = params.http ?? defaultHttp;
  const base = params.relayBaseUrl.replace(/\/+$/, "");
  let response: MailboxHttpResponse;
  try {
    response = await signedRequest(
      params,
      {
        resource: "recovery",
        cursor: params.cursor,
        limit: params.limit,
        maxBytes: params.maxBytes,
      },
      (challenge, headers) =>
        http({
          method: "get",
          url: `${base}/message/monad/recovery/${params.recipient}`,
          params: {
            cursor: challenge.cursor ?? undefined,
            limit: challenge.limit,
            max_bytes: challenge.max_bytes,
          },
          headers,
        }),
      "GET /message/monad/recovery"
    );
  } catch (err) {
    if (err instanceof MonadMailboxRecoveryRetiredError) {
      return { records: [] };
    }
    throw err;
  }
  const page = decodeRecoveries(response.data);
  return {
    records: page.records,
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER] || page.nextCursor,
  };
}

/**
 * Every recovery obligation, following cursors. Same first-page-throws / later-page-truncates
 * contract as {@link fetchMonadMailboxInbox}.
 * @deprecated Recovery endpoint is retired; stamp recovery is unified through the mailbox.
 */
export async function fetchMonadMailboxRecoveries(
  params: MailboxAuthParams & { pageLimit?: number; maxPages?: number }
): Promise<{
  records: MailboxRecoveryRecord[];
  truncatedBy?: MonadMailboxError;
}> {
  const maxPages = params.maxPages ?? 16;
  const records: MailboxRecoveryRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let result: { records: MailboxRecoveryRecord[]; nextCursor?: string };
    try {
      result = await fetchMonadMailboxRecoveryPage({
        ...params,
        cursor,
        limit: params.pageLimit,
      });
    } catch (err) {
      if (err instanceof MonadMailboxRecoveryRetiredError) {
        return { records: [] };
      }
      if (page > 0 && err instanceof MonadMailboxError) {
        return { records, truncatedBy: err };
      }
      throw err;
    }
    records.push(...result.records);
    if (result.nextCursor === undefined) return { records };
    if (result.nextCursor === cursor) {
      throw new MonadMailboxProtocolError(
        "relay returned the same recovery cursor twice; aborting to avoid a loop"
      );
    }
    cursor = result.nextCursor;
  }
  return {
    records,
    truncatedBy: new MonadMailboxRetryableError(
      `recovery scan stopped after ${maxPages} pages; poll again to continue`
    ),
  };
}

/**
 * Retire one terminal recovery obligation after the caller has durably imported it:
 * `POST /message/monad/recovery/:recipient/:payload_hash/:obligation_id/ack` (204; idempotent,
 * an already-absent, stale-id or other-recipient obligation ALSO answers 204 -- no existence
 * oracle -- so a 204 is NOT proof that the obligation existed or was retired). An obligation that is still active answers 409
 * -> {@link MonadMailboxRecoveryActiveError}.
 * @deprecated Recovery endpoint is retired; stamp recovery is unified through the mailbox.
 */
export async function ackMonadMailboxRecovery(
  params: MailboxAuthParams & {
    payloadHashHex: string;
    obligationIdHex: string;
  }
): Promise<void> {
  const http = params.http ?? defaultHttp;
  const base = params.relayBaseUrl.replace(/\/+$/, "");
  for (const [name, value] of [
    ["payloadHashHex", params.payloadHashHex],
    ["obligationIdHex", params.obligationIdHex],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new MonadMailboxRequestError(
        `${name} must be 32 bytes of lower-case hex`
      );
    }
  }
  try {
    await signedRequest(
      params,
      {
        resource: "recovery_ack",
        recoveryPayloadHashHex: params.payloadHashHex,
        recoveryObligationIdHex: params.obligationIdHex,
      },
      (_challenge, headers) =>
        http({
          method: "post",
          url: `${base}/message/monad/recovery/${params.recipient}/${params.payloadHashHex}/${params.obligationIdHex}/ack`,
          headers,
        }),
      "POST /message/monad/recovery/ack"
    );
  } catch (err) {
    if (err instanceof MonadMailboxRecoveryRetiredError) return;
    throw err;
  }
}

// Canonical mailbox keeps the original P signing transcript, with an isolated HTTP namespace.
export interface CanonicalMailboxAuthParams
  extends Omit<MailboxAuthParams, "http"> {
  /** Installed four-byte authentication tag or network identifier; e.g. 'MONT' | 'MON1' | 'monad-testnet' | 'monad-mainnet'. */
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
  readonly nextCursor?: string;
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
async function canonicalCurrent(
  auth: CanonicalMailboxAuthParams,
  origin: string
): Promise<string> {
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
    checked >= expires ||
    !statement.relays.some((relay) =>
      matchesRelayOrigin(relay.endpoint, origin)
    )
  )
    canonicalProtocol(
      "Directory Current does not match installed canonical P authority"
    );
  return toHex(evidence.statementHash);
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
      const head = await canonicalCurrent(auth, origin);
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
      if (
        (response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        canonicalProtocol("Canonical challenge JSON required");
      const raw = canonicalObject(
        parseCanonicalJSON(bodyBytes(response.data)),
        [
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
          "recovery_payload_hash",
          "recovery_obligation_id",
        ]
      );
      const challenge = raw as unknown as MailboxChallenge;
      validateChallenge(challenge, request);
      if (
        !canonicalHex32(challenge.epoch) ||
        !canonicalHex32(challenge.nonce) ||
        !canonicalHex32(challenge.token) ||
        !Number.isSafeInteger(challenge.expires_at_ms) ||
        challenge.expires_at_ms <= Date.now() ||
        challenge.expires_at_ms > Date.now() + 60000 ||
        challenge.network_tag !==
          bytesToHex(new TextEncoder().encode(descriptor.tag)) ||
        challenge.recovery_payload_hash !==
          (request.recoveryPayloadHashHex ?? null) ||
        challenge.recovery_obligation_id !==
          (request.recoveryObligationIdHex ?? null)
      )
        canonicalProtocol(
          "Malformed or foreign canonical challenge; refusing to sign"
        );
      canonicalCheckAbort(auth.signal);
      const signing = Promise.resolve(
        auth.signDigest(
          mailboxAuthDigest(buildMailboxAuthPreimage(challenge, auth.recipient))
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
        (await canonicalCurrent(auth, origin)) !== head ||
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
  const records = canonicalPageRecords(response, binding.limit!).map(
    (outer) => {
      const parts = canonicalRecordParts(outer, 2);
      const pair = inspectCanonicalPair({
        delivery: parts[0].bytes,
        context: parts[1].bytes,
      });
      if (
        pair.network !==
          canonicalNetworkDescriptor(params.expectedNetworkTag).network ||
        pair.recipient !== params.recipient ||
        seen.has(pair.payload_hash)
      )
        canonicalProtocol(
          "Canonical inbox recipient/network/duplicate mismatch"
        );
      seen.add(pair.payload_hash);
      return Object.freeze({
        delivery: Uint8Array.from(parts[0].bytes),
        context: Uint8Array.from(parts[1].bytes),
        submissionIdentity: outer.headers["x-frank-submission-identity"],
        timestampMs: Number(outer.headers["x-frank-mailbox-timestamp-ms"]),
      });
    }
  );
  canonicalCheckAbort(params.signal);
  return Object.freeze({
    records: Object.freeze(records),
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
  const records = canonicalPageRecords(response, binding.limit!).map(
    (outer) => {
      const parts = canonicalRecordParts(outer, 2);
      const pair = inspectCanonicalPair({
        delivery: parts[0].bytes,
        context: parts[1].bytes,
      });
      const direction = outer.headers["x-frank-mailbox-direction"];
      if (direction !== "in" && direction !== "out")
        canonicalProtocol(
          "Combined mailbox requires explicit in/out direction"
        );
      const expectedNetwork = canonicalNetworkDescriptor(
        params.expectedNetworkTag
      ).network;
      if (pair.network !== expectedNetwork || seen.has(pair.payload_hash)) {
        canonicalProtocol("Canonical mailbox network or duplicate mismatch");
      }
      seen.add(pair.payload_hash);
      return Object.freeze({
        direction,
        delivery: Uint8Array.from(parts[0].bytes),
        context: Uint8Array.from(parts[1].bytes),
        submissionIdentity: outer.headers["x-frank-submission-identity"],
        timestampMs: Number(outer.headers["x-frank-mailbox-timestamp-ms"]),
      });
    }
  );
  canonicalCheckAbort(params.signal);
  return Object.freeze({
    records: Object.freeze(records),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER],
  });
}

export interface CanonicalMailboxStreamParams
  extends CanonicalMailboxAuthParams {
  readonly onRecord: (record: CanonicalMailboxRecord) => void;
  readonly onError?: (error: Error) => void;
  readonly onReady?: () => void;
}

export interface CanonicalMailboxStreamHandle {
  close: () => void;
}

/** Connects to authenticated WebSocket mailbox stream (/message/monad/cbor/mailbox/:address/ws). */
export async function connectCanonicalMailboxStream(
  params: CanonicalMailboxStreamParams
): Promise<CanonicalMailboxStreamHandle> {
  const origin = installedCanonicalOrigin(params.relayBaseUrl);
  await canonicalCurrent(params, origin);
  const challengeURL = `${origin}/message/auth/${
    params.recipient
  }?${canonicalQuery({
    resource: "mailbox_stream",
    since: 0,
    limit: 1,
    maxBytes: 0,
  })}`;

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
    "recovery_payload_hash",
    "recovery_obligation_id",
  ]);
  const challenge = raw as unknown as MailboxChallenge;
  const preimage = buildMailboxAuthPreimage(challenge, params.recipient);
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

  const cleanup = () => {
    if (!closed) {
      closed = true;
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

  return {
    close: cleanup,
  };
}
/**
 * Complete recovery page.
 * @deprecated Recovery endpoint is retired; stamp recovery is unified through the mailbox.
 */
export async function fetchCanonicalRecoveryPage(
  params: CanonicalMailboxPageParams
): Promise<CanonicalMailboxPage<CanonicalRecoveryRecord>> {
  const binding = canonicalPageBinding(params, "recovery");
  let response: MailboxHttpResponse;
  try {
    response = await canonicalSignedRequest(
      params,
      binding,
      `recovery/${params.recipient}`
    );
  } catch (err) {
    if (err instanceof MonadMailboxRecoveryRetiredError) {
      return Object.freeze({ records: Object.freeze([]) });
    }
    throw err;
  }
  if (response.status === 410) {
    return Object.freeze({ records: Object.freeze([]) });
  }
  const seen = new Set<string>();
  const records = canonicalPageRecords(response, binding.limit!).map(
    (outer) => {
      const parts = canonicalRecordParts(outer, 4);
      const ranges: CanonicalExactParts = {
        delivery: parts[0].bytes,
        context: parts[1].bytes,
        transactions: decodeCanonicalTransactions(parts[2].bytes),
      };
      const identity = describeCanonicalParts(ranges);
      const metadata = canonicalObject(parseCanonicalJSON(parts[3].bytes), [
        "version",
        "submission_identity",
        "payload_hash",
        "obligation_id",
        "confirmed_children",
        "lifecycle",
      ]);
      const indices = metadata.confirmed_children,
        lifecycle = metadata.lifecycle;
      const terminal =
        typeof lifecycle === "string" &&
        lifecycle.startsWith("terminal:") &&
        CANONICAL_TERMINAL_REASONS.some(
          (reason) => lifecycle === `terminal:${reason}`
        );
      if (
        identity.network !==
          canonicalNetworkDescriptor(params.expectedNetworkTag).network ||
        identity.recipient !== params.recipient ||
        metadata.version !== 1 ||
        metadata.submission_identity !== identity.submission_identity ||
        outer.headers["x-frank-submission-identity"] !==
          identity.submission_identity ||
        metadata.payload_hash !== identity.payload_hash ||
        !canonicalHex32(metadata.obligation_id) ||
        !Array.isArray(indices) ||
        indices.some(
          (index, i) =>
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= ranges.transactions.length ||
            (i > 0 && index <= indices[i - 1])
        ) ||
        typeof lifecycle !== "string" ||
        !(
          ["pending", "fully_confirmed", "delivered"].includes(lifecycle) ||
          terminal
        ) ||
        seen.has(metadata.obligation_id)
      )
        canonicalProtocol("Canonical recovery identity/metadata mismatch");
      seen.add(metadata.obligation_id);
      const exact: CanonicalExactParts = {
        delivery: Uint8Array.from(ranges.delivery),
        context: Uint8Array.from(ranges.context),
        transactions: Object.freeze(
          ranges.transactions.map((raw) => Uint8Array.from(raw))
        ),
      };
      return Object.freeze({
        delivery: exact.delivery,
        context: exact.context,
        parts: Object.freeze(exact),
        identity,
        submissionIdentity: identity.submission_identity,
        timestampMs: Number(outer.headers["x-frank-mailbox-timestamp-ms"]),
        obligationId: metadata.obligation_id,
        confirmedChildren: Object.freeze([...indices]) as readonly number[],
        lifecycle,
      });
    }
  );
  canonicalCheckAbort(params.signal);
  return Object.freeze({
    records: Object.freeze(records),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER],
  });
}
/**
 * Caller must durably import recovery before ack. This never acknowledges a wallet workflow.
 * @deprecated Recovery endpoint is retired; stamp recovery is unified through the mailbox.
 */
export async function ackCanonicalRecovery(
  params: CanonicalMailboxAuthParams & {
    payloadHashHex: string;
    obligationIdHex: string;
  }
): Promise<void> {
  if (
    !canonicalHex32(params.payloadHashHex) ||
    !canonicalHex32(params.obligationIdHex)
  )
    canonicalProtocol("Exact recovery T3/obligation required");
  let response: MailboxHttpResponse;
  try {
    response = await canonicalSignedRequest(
      params,
      {
        resource: "recovery_ack",
        since: 0,
        limit: 1,
        maxBytes: 0,
        recoveryPayloadHashHex: params.payloadHashHex,
        recoveryObligationIdHex: params.obligationIdHex,
      },
      `recovery/${params.recipient}/${params.payloadHashHex}/${params.obligationIdHex}/ack`
    );
  } catch (err) {
    if (err instanceof MonadMailboxRecoveryRetiredError) return;
    throw err;
  }
  if (response.status === 410) return;
  if (
    response.status !== 200 ||
    (response.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== "application/json"
  )
    canonicalProtocol("Exact durable canonical acknowledgement required");
  const body = canonicalObject(parseCanonicalJSON(bodyBytes(response.data)), [
    "version",
    "acknowledged",
    "payload_hash",
    "obligation_id",
  ]);
  if (
    body.version !== 1 ||
    body.acknowledged !== true ||
    body.payload_hash !== params.payloadHashHex ||
    body.obligation_id !== params.obligationIdHex
  )
    canonicalProtocol("Canonical acknowledgement identity mismatch");
  canonicalCheckAbort(params.signal);
}
