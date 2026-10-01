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
 * - 429 `mailbox_challenge_capacity` (recipient already holds the relay's maximum of 30 unexpired consumed challenges;
 *   `Retry-After: 60`): {@link MonadMailboxChallengeCapacityError}, not retried in-call because
 *   capacity only returns when challenges expire. Replay/expiry remain 401.
 * - Other 429 (Retry-After) and 503 (`mailbox_auth_retryable` at read capacity), plus network failures:
 *   retried with bounded exponential backoff (honouring Retry-After), then
 *   {@link MonadMailboxRetryableError}.
 *
 * The relay keeps at most 30 unexpired consumed challenges per recipient (60 s TTL), so more than
 * 30 authenticated requests inside 60 s are refused; {@link fetchMonadMailboxInbox} therefore asks
 * for 100 rows per page (the maximum) and a caller that gets a truncated result simply polls again.
 */
import axios from 'axios'
import { cryptoBackend } from '@frank/nakamoto'

import __pb_monad_message_pb from './monad_message_pb'
const { StoredMonadMessages, MonadStampedMessage } = __pb_monad_message_pb
// Type-only back-edge (erased at compile time), same as `./monad-message-feed.ts` had.
import type {
  MonadStampedMessageProto,
  StoredMonadMessageProto,
} from '@frank/wallet/monad-stamp-client'

/** `MAILBOX_AUTH_DOMAIN` in `monad_message.rs`. */
export const MAILBOX_AUTH_DOMAIN = 'frank:mailbox-http-auth:v2'
/** `MAX_PRIVATE_MAILBOX_PAGE` in `monad_message.rs`. */
export const MAILBOX_MAX_PAGE_LIMIT = 100
export const MAILBOX_NEXT_CURSOR_HEADER = 'x-frank-mailbox-next-cursor'

export type MailboxResource = 'inbox' | 'recovery' | 'recovery_ack'

/** Wire form of the challenge JSON (`MailboxChallengeBody`). */
export interface MailboxChallenge {
  epoch: string
  nonce: string
  expires_at_ms: number
  token: string
  signing_domain: string
  resource: MailboxResource
  since: number
  cursor: string | null
  limit: number
  max_bytes: number
  network_tag: string
  recovery_payload_hash: string | null
  recovery_obligation_id: string | null
}

/** DER ECDSA signer over a 32-byte digest, e.g. `digest => identity.signHash(Buffer.from(digest))`. */
export type MailboxDigestSigner = (
  digest: Uint8Array,
) => Uint8Array | Promise<Uint8Array>

/** Minimal HTTP surface so tests can run the client against an in-process contract mock. Must
 * resolve (not throw) for every HTTP status and reject only when no response was received. */
export interface MailboxHttpResponse {
  status: number
  headers: Record<string, string | undefined>
  data: ArrayBuffer | Uint8Array | string | unknown
}
export interface MailboxHttpRequest {
  method: 'get' | 'post'
  url: string
  params?: Record<string, string | number | undefined>
  headers?: Record<string, string>
}
export type MailboxHttp = (
  request: MailboxHttpRequest,
) => Promise<MailboxHttpResponse>

const defaultHttp: MailboxHttp = async request => {
  const response = await axios({
    method: request.method,
    url: request.url,
    params: request.params,
    headers: request.headers,
    responseType: 'arraybuffer',
    validateStatus: () => true,
  })
  return {
    status: response.status,
    headers: response.headers as Record<string, string | undefined>,
    data: response.data,
  }
}

export interface MailboxRetryOptions {
  /** Attempts per request including the first. Default 4. */
  maxAttempts?: number
  /** First backoff delay; doubles per attempt. Default 500 ms. */
  baseDelayMs?: number
  /** Upper bound for one exponential-backoff delay. Default 15 000 ms. */
  maxDelayMs?: number
  /** Upper bound for a relay-supplied Retry-After (non-capacity 429). Default 60 000 ms. */
  maxRetryAfterMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface MailboxAuthParams {
  relayBaseUrl: string
  /** `0x`-prefixed 20-byte recipient address (identity address). */
  recipient: string
  signDigest: MailboxDigestSigner
  retry?: MailboxRetryOptions
  http?: MailboxHttp
}

// --- errors ---------------------------------------------------------------------------------

export class MonadMailboxError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
  }
}
/** The relay answered 404 for a mailbox route: no mailbox there (disabled or too old). */
export class MonadMailboxUnavailableError extends MonadMailboxError {}
export class MonadMailboxAuthError extends MonadMailboxError {
  readonly phase: 'challenge' | 'request'
  constructor(message: string, phase: 'challenge' | 'request', code?: string) {
    super(message, 401, code)
    this.phase = phase
  }
}
export class MonadMailboxStaleCursorError extends MonadMailboxError {}
export class MonadMailboxRequestError extends MonadMailboxError {}
export class MonadMailboxRecordTooLargeError extends MonadMailboxError {}
export class MonadMailboxRecoveryActiveError extends MonadMailboxError {}
/** Still failing after the retry budget; safe to try again later. */
export class MonadMailboxRetryableError extends MonadMailboxError {}
/** 429 `mailbox_challenge_capacity`: the recipient already has the relay's maximum number of
 * unexpired consumed challenges (8). Capacity only returns when they expire, so this is NOT
 * retried inside a call; `retryAfterMs` is the relay's `Retry-After` (60 s). */
export class MonadMailboxChallengeCapacityError extends MonadMailboxRetryableError {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message, 429, 'mailbox_challenge_capacity')
    this.retryAfterMs = retryAfterMs
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
    throw new MonadMailboxProtocolError(`malformed ${name} in mailbox data`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function i64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) {
    throw new MonadMailboxProtocolError(`integer ${value} is not exactly i64`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt(value), false)
  return out
}
function u64be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MonadMailboxProtocolError(`integer ${value} is not exactly u64`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}
function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function recipientBytes(recipient: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new MonadMailboxRequestError(
      `recipient must be a 0x-prefixed 20-byte address, got ${recipient}`,
    )
  }
  return hexToBytes(recipient.slice(2), 20, 'recipient')
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Exact bytes the relay's `mailbox_auth_preimage` produces (and the recipient must sign after
 * SHA-256). Built only from the challenge JSON, mirroring the Rust test helper
 * `client_mailbox_auth_preimage`. */
export function buildMailboxAuthPreimage(
  challenge: MailboxChallenge,
  recipient: string,
): Uint8Array {
  const text = new TextEncoder()
  const [method, path, tag] = (
    {
      inbox: ['GET', 'inbox/', 1],
      recovery: ['GET', 'recovery/', 2],
      recovery_ack: ['POST', 'recovery-ack/', 3],
    } as const
  )[challenge.resource] ?? [undefined, undefined, undefined]
  if (method === undefined) {
    throw new MonadMailboxProtocolError(
      `unexpected mailbox resource ${String(challenge.resource)}`,
    )
  }
  const parts: Uint8Array[] = [
    text.encode(challenge.signing_domain),
    Uint8Array.of(0),
    hexToBytes(challenge.epoch, 32, 'epoch'),
    hexToBytes(challenge.nonce, 32, 'nonce'),
    i64be(challenge.expires_at_ms),
    hexToBytes(challenge.token, 32, 'token'),
    text.encode(`${method}\0/message/monad/${path}`),
    Uint8Array.of(tag),
    recipientBytes(recipient),
    i64be(challenge.since),
  ]
  if (challenge.cursor === null || challenge.cursor === undefined) {
    parts.push(Uint8Array.of(0))
  } else {
    const cursor = text.encode(challenge.cursor)
    parts.push(Uint8Array.of(1), u32be(cursor.length), cursor)
  }
  parts.push(u64be(challenge.limit), u64be(challenge.max_bytes))
  if (challenge.resource === 'recovery_ack') {
    parts.push(
      hexToBytes(challenge.recovery_payload_hash ?? '', 32, 'payload hash'),
      hexToBytes(challenge.recovery_obligation_id ?? '', 32, 'obligation id'),
    )
  }
  const networkTag = hexToBytes(challenge.network_tag, undefined, 'network_tag')
  parts.push(u32be(networkTag.length), networkTag)
  return concatBytes(parts)
}

/** One SHA-256 of the mailbox auth preimage. Matches `Sha256::digest` in
 * `authenticate_private_recipient` (decision #501). Not double-SHA256. */
export function mailboxAuthDigest(preimage: Uint8Array): Uint8Array {
  // cryptoBackend rejects Buffer, which is a Uint8Array subclass.
  return cryptoBackend.sha256(Uint8Array.from(preimage))
}

// --- transport with retries -----------------------------------------------------------------

function defaultSleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function bodyBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data !== null && typeof data === 'object') {
    return new TextEncoder().encode(JSON.stringify(data))
  }
  return new Uint8Array()
}

function jsonBody(data: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes(data)))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function errorCode(response: MailboxHttpResponse): string | undefined {
  const code = jsonBody(response.data)?.error
  return typeof code === 'string' ? code : undefined
}

function retryAfterMs(response: MailboxHttpResponse): number | undefined {
  const header = response.headers['retry-after']
  if (header === undefined) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/** Marks a rejected HTTP call (no response received) as distinct from local errors. */
class NetworkFailure extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('network failure')
    this.cause = cause
  }
}

async function net(
  call: Promise<MailboxHttpResponse>,
): Promise<MailboxHttpResponse> {
  try {
    return await call
  } catch (err) {
    throw new NetworkFailure(err)
  }
}

class Backoff {
  private attempt = 0
  private readonly max: number
  private readonly base: number
  private readonly cap: number
  private readonly hintCap: number
  private readonly sleeper: (ms: number) => Promise<void>
  constructor(options: MailboxRetryOptions | undefined) {
    this.max = Math.max(1, options?.maxAttempts ?? 4)
    this.base = options?.baseDelayMs ?? 500
    this.cap = options?.maxDelayMs ?? 15_000
    this.hintCap = options?.maxRetryAfterMs ?? 60_000
    this.sleeper = options?.sleep ?? defaultSleep
  }
  /** Returns false when the budget is spent. */
  async wait(hintMs?: number): Promise<boolean> {
    this.attempt += 1
    if (this.attempt >= this.max) return false
    const exponential = this.base * 2 ** (this.attempt - 1)
    // Our own backoff is capped tightly, but a relay's explicit Retry-After is honoured up to a
    // separate, larger bound (retrying earlier than asked just burns attempts).
    await this.sleeper(
      Math.max(
        Math.min(this.cap, exponential),
        Math.min(this.hintCap, hintMs ?? 0),
      ),
    )
    return true
  }
}

function httpError(
  response: MailboxHttpResponse,
  phase: 'challenge' | 'request',
  what: string,
): MonadMailboxError {
  const code = errorCode(response)
  const detail = `${what}: HTTP ${response.status}${code ? ` ${code}` : ''}`
  switch (response.status) {
    case 404:
      return new MonadMailboxUnavailableError(
        `${detail}: the relay does not expose the private mailbox routes (mailbox disabled or relay too old); refusing to treat this as an empty inbox`,
        404,
        code,
      )
    case 401:
      return new MonadMailboxAuthError(
        `${detail}: recipient authentication was rejected (unregistered profile, bad signature, expired/replayed challenge, or a cursor the relay no longer authenticates)`,
        phase,
        code,
      )
    case 400:
      return code === 'invalid_mailbox_cursor'
        ? new MonadMailboxStaleCursorError(
            `${detail}: cursor is older than the requested since bound; restart the scan without it`,
            400,
            code,
          )
        : new MonadMailboxRequestError(detail, 400, code)
    case 413:
      return new MonadMailboxRecordTooLargeError(detail, 413, code)
    case 409:
      return new MonadMailboxRecoveryActiveError(detail, 409, code)
    default:
      return new MonadMailboxError(detail, response.status, code)
  }
}

const isRetryableStatus = (status: number) => status === 429 || status === 503

/** Run `attempt` under the shared retry policy. `attempt` returns a response (any status) or
 * throws on a network-level failure. */
async function withRetries(
  retry: MailboxRetryOptions | undefined,
  what: string,
  attempt: () => Promise<MailboxHttpResponse>,
  phaseOf: (response: MailboxHttpResponse) => 'challenge' | 'request',
): Promise<MailboxHttpResponse> {
  const backoff = new Backoff(retry)
  let reauthenticated = false
  for (;;) {
    let response: MailboxHttpResponse | undefined
    let networkError: unknown
    try {
      response = await attempt()
    } catch (err) {
      // Only a failed HTTP round trip is retryable; signer/protocol errors are not.
      if (!(err instanceof NetworkFailure)) throw err
      networkError = err.cause
    }
    if (
      response !== undefined &&
      response.status >= 200 &&
      response.status < 300
    ) {
      return response
    }
    if (response === undefined) {
      if (!(await backoff.wait())) {
        throw new MonadMailboxRetryableError(
          `${what}: no response from relay (${
            networkError instanceof Error
              ? networkError.message
              : 'network error'
          })`,
        )
      }
      continue
    }
    if (
      response.status === 429 &&
      errorCode(response) === 'mailbox_challenge_capacity'
    ) {
      throw new MonadMailboxChallengeCapacityError(
        `${what}: HTTP 429 mailbox_challenge_capacity: too many unexpired authenticated requests for this recipient; retry after the relay's Retry-After`,
        retryAfterMs(response) ?? 60_000,
      )
    }
    if (isRetryableStatus(response.status)) {
      if (!(await backoff.wait(retryAfterMs(response)))) {
        throw new MonadMailboxRetryableError(
          `${what}: HTTP ${response.status} ${
            errorCode(response) ?? ''
          } persisted through the retry budget`.trim(),
          response.status,
          errorCode(response),
        )
      }
      continue
    }
    if (response.status === 401 && phaseOf(response) === 'request') {
      // Expired/replayed/foreign-epoch challenge: one immediate retry with a fresh challenge.
      if (!reauthenticated) {
        reauthenticated = true
        continue
      }
    }
    throw httpError(response, phaseOf(response), what)
  }
}

// --- challenge + signed request -------------------------------------------------------------

interface ChallengeRequest {
  resource: MailboxResource
  since?: number
  cursor?: string
  limit?: number
  maxBytes?: number
  recoveryPayloadHashHex?: string
  recoveryObligationIdHex?: string
}

function validateChallenge(
  challenge: MailboxChallenge,
  request: ChallengeRequest,
): void {
  const mismatches: string[] = []
  if (challenge.signing_domain !== MAILBOX_AUTH_DOMAIN) {
    mismatches.push('signing_domain')
  }
  if (challenge.resource !== request.resource) mismatches.push('resource')
  if (request.since !== undefined && challenge.since !== request.since) {
    mismatches.push('since')
  }
  if ((challenge.cursor ?? undefined) !== request.cursor) {
    mismatches.push('cursor')
  }
  if (request.limit !== undefined && challenge.limit !== request.limit) {
    mismatches.push('limit')
  }
  if (
    request.maxBytes !== undefined &&
    challenge.max_bytes !== request.maxBytes
  ) {
    mismatches.push('max_bytes')
  }
  if (
    request.recoveryPayloadHashHex !== undefined &&
    challenge.recovery_payload_hash !== request.recoveryPayloadHashHex
  ) {
    mismatches.push('recovery_payload_hash')
  }
  if (
    request.recoveryObligationIdHex !== undefined &&
    challenge.recovery_obligation_id !== request.recoveryObligationIdHex
  ) {
    mismatches.push('recovery_obligation_id')
  }
  if (mismatches.length > 0) {
    throw new MonadMailboxProtocolError(
      `relay challenge does not echo the requested ${mismatches.join(
        ', ',
      )}; refusing to sign`,
    )
  }
}

async function signedRequest(
  auth: MailboxAuthParams,
  challengeRequest: ChallengeRequest,
  send: (
    challenge: MailboxChallenge,
    headers: Record<string, string>,
  ) => Promise<MailboxHttpResponse>,
  what: string,
): Promise<MailboxHttpResponse> {
  recipientBytes(auth.recipient) // fail locally on a malformed recipient, before any request
  const http = auth.http ?? defaultHttp
  const base = auth.relayBaseUrl.replace(/\/+$/, '')
  // Track which step failed so a 401 is classified correctly.
  let phase: 'challenge' | 'request' = 'challenge'
  return withRetries(
    auth.retry,
    what,
    async () => {
      phase = 'challenge'
      const challengeResponse = await net(
        http({
          method: 'post',
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
        }),
      )
      if (challengeResponse.status < 200 || challengeResponse.status >= 300) {
        return challengeResponse
      }
      const challenge = jsonBody(challengeResponse.data) as
        | MailboxChallenge
        | undefined
      if (challenge === undefined) {
        throw new MonadMailboxProtocolError(`${what}: malformed challenge JSON`)
      }
      validateChallenge(challenge, challengeRequest)
      const digest = mailboxAuthDigest(
        buildMailboxAuthPreimage(challenge, auth.recipient),
      )
      const signature = await auth.signDigest(digest)
      phase = 'request'
      return net(
        send(challenge, {
          'x-frank-mailbox-epoch': challenge.epoch,
          'x-frank-mailbox-nonce': challenge.nonce,
          'x-frank-mailbox-expires-at-ms': String(challenge.expires_at_ms),
          'x-frank-mailbox-token': challenge.token,
          'x-frank-mailbox-signature': bytesToHex(signature),
        }),
      )
    },
    () => phase,
  )
}

// --- inbox ----------------------------------------------------------------------------------

function decodeStored(bytes: Uint8Array): StoredMonadMessageProto[] {
  const decoded = StoredMonadMessages.deserializeBinary(bytes)
  return decoded.getMessagesList().map(stored => {
    const nested = stored.getMessage()
    return {
      message: nested
        ? {
            stampPayments: nested.getStampPaymentsList().map(payment => ({
              childIndex: payment.getChildIndex(),
              rawTx: payment.getRawTx_asU8(),
            })),
            encryptedPayload: nested.getEncryptedPayload_asU8(),
            payloadHash: nested.getPayloadHash_asU8(),
          }
        : undefined,
      timestamp: stored.getTimestamp(),
      networkTag: stored.getNetworkTag_asU8(),
    }
  })
}

export interface MailboxInboxPage {
  messages: StoredMonadMessageProto[]
  /** Opaque token for the next page, absent on the last page. */
  nextCursor: string | undefined
}

/** One authenticated inbox page: `GET /message/monad/inbox/:recipient`. */
export async function fetchMonadMailboxInboxPage(
  params: MailboxAuthParams & {
    sinceMs: number
    cursor?: string
    limit?: number
    maxBytes?: number
  },
): Promise<MailboxInboxPage> {
  const http = params.http ?? defaultHttp
  const base = params.relayBaseUrl.replace(/\/+$/, '')
  const limit = params.limit ?? MAILBOX_MAX_PAGE_LIMIT
  const response = await signedRequest(
    params,
    {
      resource: 'inbox',
      since: params.sinceMs,
      cursor: params.cursor,
      limit,
      maxBytes: params.maxBytes,
    },
    (challenge, headers) =>
      http({
        method: 'get',
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
    'GET /message/monad/inbox',
  )
  return {
    messages: decodeStored(bodyBytes(response.data)),
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER] || undefined,
  }
}

export interface MailboxInboxResult {
  messages: StoredMonadMessageProto[]
  /** Set when a later page failed (or the page budget ran out) after earlier pages succeeded.
   * `messages` is then a prefix that ends on a COMPLETE timestamp group: rows sharing the last
   * returned timestamp are dropped, because the relay's cursor is `(timestamp, payload_hash)` and
   * `since` is inclusive, so a caller that advances `since = lastTimestamp + 1` would otherwise
   * skip the rest of a half-fetched group forever. Advancing to `lastTimestamp + 1` is therefore
   * safe, and the dropped rows are refetched by the next poll. */
  truncatedBy?: MonadMailboxError
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
    sinceMs: number
    pageLimit?: number
    maxPages?: number
  },
): Promise<MailboxInboxResult> {
  const maxPages = params.maxPages ?? 64
  const seen = new Set<string>()
  const messages: StoredMonadMessageProto[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    let result: MailboxInboxPage
    try {
      result = await fetchMonadMailboxInboxPage({
        ...params,
        cursor,
        limit: params.pageLimit,
      })
    } catch (err) {
      if (page > 0 && err instanceof MonadMailboxError) {
        return {
          messages: completeTimestampPrefix(messages, err),
          truncatedBy: err,
        }
      }
      throw err
    }
    for (const stored of result.messages) {
      const key = stored.message ? bytesToHex(stored.message.payloadHash) : ''
      if (key !== '' && seen.has(key)) continue
      if (key !== '') seen.add(key)
      messages.push(stored)
    }
    if (result.nextCursor === undefined) return { messages }
    if (result.nextCursor === cursor) {
      throw new MonadMailboxProtocolError(
        'relay returned the same mailbox cursor twice; aborting to avoid a loop',
      )
    }
    cursor = result.nextCursor
  }
  const budget = new MonadMailboxRetryableError(
    `inbox scan stopped after ${maxPages} pages; poll again to continue`,
  )
  return {
    messages: completeTimestampPrefix(messages, budget),
    truncatedBy: budget,
  }
}

/** Drop the trailing rows that share the last timestamp; throw `reason` if nothing would remain. */
function completeTimestampPrefix(
  messages: StoredMonadMessageProto[],
  reason: MonadMailboxError,
): StoredMonadMessageProto[] {
  const lastTimestamp = messages[messages.length - 1]?.timestamp
  let end = messages.length
  while (end > 0 && messages[end - 1].timestamp === lastTimestamp) end--
  if (end === 0) throw reason
  return messages.slice(0, end)
}

// --- recovery -------------------------------------------------------------------------------

/** One incomplete-delivery obligation (`ConfirmedPrefixBody`): the payment transactions of
 * `canonicalMessage` whose children are in `confirmedChildren` are confirmed on chain and pay
 * one-time addresses only this recipient can spend, even though the message never reached the
 * inbox. `lifecycle` is `pending`, `fully_confirmed`, `delivered` or `terminal:<reason>`; only
 * terminal obligations can be acknowledged. */
export interface MailboxRecoveryRecord {
  payloadHashHex: string
  obligationIdHex: string
  canonicalMessage: MonadStampedMessageProto
  confirmedChildren: number[]
  lifecycle: string
}

function decodeRecoveries(data: unknown): {
  records: MailboxRecoveryRecord[]
  nextCursor?: string
} {
  const body = jsonBody(data) as
    | {
        recoveries?: Array<{
          payload_hash: string
          obligation_id: string
          canonical_message: string
          confirmed_children: number[]
          lifecycle: string
        }>
        next_cursor?: string
      }
    | undefined
  if (body === undefined || !Array.isArray(body.recoveries)) {
    throw new MonadMailboxProtocolError('malformed recovery page JSON')
  }
  return {
    records: body.recoveries.map(r => {
      const nested = MonadStampedMessage.deserializeBinary(
        hexToBytes(r.canonical_message, undefined, 'canonical_message'),
      )
      return {
        payloadHashHex: r.payload_hash,
        obligationIdHex: r.obligation_id,
        canonicalMessage: {
          stampPayments: nested.getStampPaymentsList().map(payment => ({
            childIndex: payment.getChildIndex(),
            rawTx: payment.getRawTx_asU8(),
          })),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        },
        confirmedChildren: r.confirmed_children,
        lifecycle: r.lifecycle,
      }
    }),
    nextCursor: body.next_cursor,
  }
}

/** One authenticated recovery page: `GET /message/monad/recovery/:recipient`. */
export async function fetchMonadMailboxRecoveryPage(
  params: MailboxAuthParams & {
    cursor?: string
    limit?: number
    maxBytes?: number
  },
): Promise<{ records: MailboxRecoveryRecord[]; nextCursor?: string }> {
  const http = params.http ?? defaultHttp
  const base = params.relayBaseUrl.replace(/\/+$/, '')
  const response = await signedRequest(
    params,
    {
      resource: 'recovery',
      cursor: params.cursor,
      limit: params.limit,
      maxBytes: params.maxBytes,
    },
    (challenge, headers) =>
      http({
        method: 'get',
        url: `${base}/message/monad/recovery/${params.recipient}`,
        params: {
          cursor: challenge.cursor ?? undefined,
          limit: challenge.limit,
          max_bytes: challenge.max_bytes,
        },
        headers,
      }),
    'GET /message/monad/recovery',
  )
  const page = decodeRecoveries(response.data)
  return {
    records: page.records,
    nextCursor: response.headers[MAILBOX_NEXT_CURSOR_HEADER] || page.nextCursor,
  }
}

/** Every recovery obligation, following cursors. Same first-page-throws / later-page-truncates
 * contract as {@link fetchMonadMailboxInbox}. */
export async function fetchMonadMailboxRecoveries(
  params: MailboxAuthParams & { pageLimit?: number; maxPages?: number },
): Promise<{
  records: MailboxRecoveryRecord[]
  truncatedBy?: MonadMailboxError
}> {
  const maxPages = params.maxPages ?? 16
  const records: MailboxRecoveryRecord[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    let result: { records: MailboxRecoveryRecord[]; nextCursor?: string }
    try {
      result = await fetchMonadMailboxRecoveryPage({
        ...params,
        cursor,
        limit: params.pageLimit,
      })
    } catch (err) {
      if (page > 0 && err instanceof MonadMailboxError) {
        return { records, truncatedBy: err }
      }
      throw err
    }
    records.push(...result.records)
    if (result.nextCursor === undefined) return { records }
    if (result.nextCursor === cursor) {
      throw new MonadMailboxProtocolError(
        'relay returned the same recovery cursor twice; aborting to avoid a loop',
      )
    }
    cursor = result.nextCursor
  }
  return {
    records,
    truncatedBy: new MonadMailboxRetryableError(
      `recovery scan stopped after ${maxPages} pages; poll again to continue`,
    ),
  }
}

/** Retire one terminal recovery obligation after the caller has durably imported it:
 * `POST /message/monad/recovery/:recipient/:payload_hash/:obligation_id/ack` (204; idempotent,
 * an already-absent, stale-id or other-recipient obligation ALSO answers 204 -- no existence
 * oracle -- so a 204 is NOT proof that the obligation existed or was retired). An obligation that is still active answers 409
 * -> {@link MonadMailboxRecoveryActiveError}. */
export async function ackMonadMailboxRecovery(
  params: MailboxAuthParams & {
    payloadHashHex: string
    obligationIdHex: string
  },
): Promise<void> {
  const http = params.http ?? defaultHttp
  const base = params.relayBaseUrl.replace(/\/+$/, '')
  for (const [name, value] of [
    ['payloadHashHex', params.payloadHashHex],
    ['obligationIdHex', params.obligationIdHex],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new MonadMailboxRequestError(
        `${name} must be 32 bytes of lower-case hex`,
      )
    }
  }
  await signedRequest(
    params,
    {
      resource: 'recovery_ack',
      recoveryPayloadHashHex: params.payloadHashHex,
      recoveryObligationIdHex: params.obligationIdHex,
    },
    (_challenge, headers) =>
      http({
        method: 'post',
        url: `${base}/message/monad/recovery/${params.recipient}/${params.payloadHashHex}/${params.obligationIdHex}/ack`,
        headers,
      }),
    'POST /message/monad/recovery/ack',
  )
}
