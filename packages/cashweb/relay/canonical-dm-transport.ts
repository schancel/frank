/** Ordinary canonical DM transport. Structural checks here grant no directory or payment authority. */
import {
  addressFromCompressedPubkey,
  compareBytes,
  decodeCanonical,
  defaultContext,
  encodeCanonical,
  encodeDirectMessageCryptoContext,
  recipientPayloadDigest,
  toHex,
  validateFrame,
  type AccountRef,
  type DirectMessageCryptoContext,
} from '@frank/codec'
import { randomBytes, sha256 } from '@frank/crypto-box'
import { keccak_256 } from '@noble/hashes/sha3'

export const CANONICAL_DM_MAX_BYTES = 8 * 1024 * 1024
export const CANONICAL_DM_MAX_STATUS_BYTES = 16 * 1024
export const CANONICAL_DM_MAX_CONTEXT_BYTES = 4096
export const CANONICAL_DM_MAX_TRANSACTION_BYTES = 128 * 1024
const text = (value: string) => new TextEncoder().encode(value)
const utf8 = (value: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(value)
const same = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0

export interface CanonicalExactParts {
  readonly delivery: Uint8Array
  readonly context: Uint8Array
  readonly transactions: readonly Uint8Array[]
}
export interface CanonicalSubmissionEcho {
  readonly submission_identity: string
  readonly payload_hash: string
  readonly network: string
  readonly recipient: string
  readonly sender_t1: string
  readonly recipient_t1: string
  readonly delivery_sha256: string
  readonly context_sha256: string
  readonly transaction_hashes: readonly string[]
}
export interface CanonicalExactRequest {
  readonly parts: CanonicalExactParts
  readonly body: Uint8Array
  readonly contentType: string
  readonly identity: CanonicalSubmissionEcho
}
export const CANONICAL_TERMINAL_REASONS = [
  'stale_nonce',
  'verification_failed',
  'broadcast_rejected',
  'corrupt_reference',
  'insufficient_total',
  'expired',
  'attempts_exhausted',
  // The relay cannot deliver to the relay the recipient lives on. Decided before any payment
  // is broadcast: nothing was spent.
  'undeliverable',
  'sender_unpublished',
] as const
export type CanonicalTerminalReason =
  (typeof CANONICAL_TERMINAL_REASONS)[number]
export type CanonicalAcceptedBody =
  | { version: 1; phase: 'retained'; identity: CanonicalSubmissionEcho }
  | {
      version: 1
      phase: 'delivered'
      identity: CanonicalSubmissionEcho
      mailbox_committed_at_ms: number
    }
  | {
      version: 1
      phase: 'dead'
      identity: CanonicalSubmissionEcho
      reason: CanonicalTerminalReason
    }

export class CanonicalTransportError extends Error {
  constructor(
    readonly disposition: 'invalid' | 'uncertain',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CanonicalTransportError'
  }
}
function invalid(message: string): never {
  throw new CanonicalTransportError('invalid', message)
}
export function canonicalNetworkDescriptor(
  tag: 'MONT' | 'MON1' | 'MONR' | 'monad-testnet' | 'monad-mainnet' | string,
) {
  if (tag === 'MONT' || tag === 'monad-testnet')
    return { tag: 'MONT', network: 'monad-testnet', chainId: 10143n } as const
  if (tag === 'MON1' || tag === 'monad-mainnet')
    return { tag: 'MON1', network: 'monad-mainnet', chainId: 143n } as const
  if (tag === 'MONR' || tag === 'monad-regtest')
    return { tag: 'MONR', network: 'monad-regtest', chainId: 20143n } as const
  return invalid('Unknown installed Monad network descriptor')
}
function concat(
  parts: readonly Uint8Array[],
  limit = CANONICAL_DM_MAX_BYTES,
): Uint8Array {
  let size = 0
  for (const part of parts) {
    size += part.byteLength
    if (size > limit) invalid('Canonical byte limit')
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
function boundaryOf(
  contentType: string,
  media: 'multipart/form-data' | 'multipart/mixed',
): string {
  const found = new RegExp(`^${media}; boundary=([A-Za-z0-9-]{1,70})$`).exec(
    contentType,
  )
  if (!found) invalid('Exact bounded multipart Content-Type required')
  return found[1]
}
export interface CanonicalMultipartPart {
  readonly name: string
  readonly contentType: string
  readonly headers: Readonly<Record<string, string>>
  readonly bytes: Uint8Array
}
/** Bounded parser over a previously capped body. Returned byte ranges refer to that body. */
export function parseCanonicalMultipart(
  body: Uint8Array,
  contentType: string,
  media: 'multipart/form-data' | 'multipart/mixed',
  maxParts: number,
): readonly CanonicalMultipartPart[] {
  if (body.length > CANONICAL_DM_MAX_BYTES) invalid('Canonical byte limit')
  const boundary = boundaryOf(contentType, media)
  const opening = text(`--${boundary}`),
    delimiter = text(`\r\n--${boundary}`)
  const parts: CanonicalMultipartPart[] = []
  if (indexOf(body, opening) !== 0) invalid('Multipart preamble is forbidden')
  let at = opening.length
  for (;;) {
    if (same(body.subarray(at, at + 4), text('--\r\n'))) {
      if (at + 4 !== body.length)
        invalid('Multipart trailing bytes are forbidden')
      return parts
    }
    if (!same(body.subarray(at, at + 2), text('\r\n')))
      invalid('Invalid multipart boundary')
    at += 2
    const end = indexOf(body, text('\r\n\r\n'), at)
    if (end < 0 || end - at > 4096) invalid('Multipart header limit')
    if (parts.length >= maxParts) invalid('Multipart part limit')
    const rawHeaders = body.subarray(at, end)
    if (
      rawHeaders.some(
        byte => (byte < 32 && byte !== 13 && byte !== 10) || byte > 126,
      )
    )
      invalid('Non-ASCII multipart header')
    const headers: Record<string, string> = Object.create(null)
    const lines = utf8(rawHeaders).split('\r\n')
    if (
      !lines[0]?.startsWith('Content-Disposition: ') ||
      !lines[1]?.startsWith('Content-Type: ')
    )
      invalid('Multipart header order')
    for (const line of lines) {
      const match = /^([A-Za-z-]+): ([\x20-\x7e]+)$/.exec(line)
      if (!match) invalid('Invalid multipart header')
      const key = match[1].toLowerCase()
      if (
        headers[key] !== undefined ||
        ![
          'content-disposition',
          'content-type',
          'x-frank-submission-identity',
          'x-frank-mailbox-timestamp-ms',
          'x-frank-mailbox-direction',
        ].includes(key)
      )
        invalid('Duplicate or unsupported multipart header')
      headers[key] = match[2]
    }
    const disposition = media === 'multipart/form-data' ? 'form-data' : 'inline'
    const name = new RegExp(`^${disposition}; name="([a-z]+)"$`).exec(
      headers['content-disposition'] ?? '',
    )?.[1]
    if (!name || !headers['content-type'])
      invalid('Exact named multipart part required')
    const start = end + 4,
      next = indexOf(body, delimiter, start)
    if (next < 0) invalid('Truncated multipart body')
    parts.push({
      name,
      contentType: headers['content-type'],
      headers,
      bytes: body.subarray(start, next),
    })
    at = next + delimiter.length
  }
}
/** Incremental header/cardinality guard over the reader's fixed scratch buffer.
 * Full parsing still runs only after EOF; this guard never publishes partial records. */
export function canonicalMultipartStreamGuard(
  contentType: string,
  maxParts: number,
  maxInnerParts: number,
): (prefix: Uint8Array) => void {
  class Guard {
    private at = 0
    private count = 0
    private state: 'opening' | 'boundary' | 'header' | 'body' | 'closed' =
      'opening'
    private scanned = 0
    private child: Guard | undefined
    private readonly opening: Uint8Array
    private readonly delimiter: Uint8Array
    constructor(
      private readonly boundary: string,
      private readonly limit: number,
      private readonly nested: boolean,
    ) {
      this.opening = text(`--${boundary}`)
      this.delimiter = text(`\r\n--${boundary}`)
    }
    inspect(bytes: Uint8Array): void {
      for (;;) {
        if (this.state === 'closed') return
        if (this.state === 'opening') {
          if (bytes.length < this.opening.length) return
          if (!same(bytes.subarray(0, this.opening.length), this.opening))
            invalid('Multipart preamble is forbidden')
          this.at = this.opening.length
          this.state = 'boundary'
        }
        if (this.state === 'boundary') {
          if (bytes.length < this.at + 2) return
          if (same(bytes.subarray(this.at, this.at + 2), text('--'))) {
            this.state = 'closed'
            return
          }
          if (!same(bytes.subarray(this.at, this.at + 2), text('\r\n')))
            invalid('Invalid multipart boundary')
          if (++this.count > this.limit) invalid('Multipart part limit')
          this.at += 2
          this.scanned = this.at
          this.state = 'header'
        }
        if (this.state === 'header') {
          const end = indexOf(bytes, text('\r\n\r\n'), this.scanned)
          if (end < 0) {
            if (bytes.length - this.at > 4099) invalid('Multipart header limit')
            this.scanned = Math.max(this.at, bytes.length - 3)
            return
          }
          if (end - this.at > 4096) invalid('Multipart header limit')
          if (this.nested) {
            const headers = utf8(bytes.subarray(this.at, end)).split('\r\n')
            const childType = headers
              .find(line => line.startsWith('Content-Type: '))
              ?.slice(14)
            if (!childType) invalid('Nested multipart Content-Type required')
            this.child = new Guard(
              boundaryOf(childType, 'multipart/mixed'),
              maxInnerParts,
              false,
            )
          }
          this.at = end + 4
          this.scanned = this.at
          this.state = 'body'
        }
        if (this.state === 'body') {
          const next = indexOf(bytes, this.delimiter, this.scanned)
          if (next < 0) {
            this.child?.inspect(bytes.subarray(this.at))
            this.scanned = Math.max(
              this.at,
              bytes.length - this.delimiter.length + 1,
            )
            return
          }
          this.child?.inspect(bytes.subarray(this.at, next))
          this.child = undefined
          this.at = next + this.delimiter.length
          this.state = 'boundary'
        }
      }
    }
  }
  const guard = new Guard(
    boundaryOf(contentType, 'multipart/mixed'),
    maxParts,
    true,
  )
  return prefix => guard.inspect(prefix)
}
function field(
  map: ReadonlyMap<bigint, unknown>,
  key: number,
  length: number,
): Uint8Array {
  const value = map.get(BigInt(key))
  if (!(value instanceof Uint8Array) || value.length !== length)
    invalid('Invalid canonical context field')
  return value
}
function account(map: ReadonlyMap<bigint, unknown>, key: number): AccountRef {
  const value = map.get(BigInt(key))
  if (!(value instanceof Map) || value.size !== 2 || value.get(0n) !== 1n)
    invalid('Invalid canonical context account')
  return { keyType: 1, keyBytes: field(value, 1, 33) }
}
/** Exact structural descriptor only: no fresh admission, secret derivation, receipt or finality claim. */
export function describeCanonicalParts(
  parts: CanonicalExactParts,
): CanonicalSubmissionEcho {
  if (
    !(parts.delivery instanceof Uint8Array) ||
    !(parts.context instanceof Uint8Array) ||
    parts.delivery.length > CANONICAL_DM_MAX_BYTES ||
    parts.context.length > CANONICAL_DM_MAX_CONTEXT_BYTES ||
    !Array.isArray(parts.transactions) ||
    // None is the unpaid message; the count must still equal the delivery's payment members.
    parts.transactions.length > 64
  )
    invalid('Canonical part limits')
  let charged = parts.delivery.length + parts.context.length
  for (const raw of parts.transactions) {
    if (
      !(raw instanceof Uint8Array) ||
      raw.length < 1 ||
      raw.length > CANONICAL_DM_MAX_TRANSACTION_BYTES
    )
      invalid('Canonical transaction limit')
    charged += raw.length
    if (charged > CANONICAL_DM_MAX_BYTES) invalid('Canonical byte limit')
  }
  const pair = inspectCanonicalPair(parts)
  if (pair.transaction_hashes.length !== parts.transactions.length)
    invalid('Raw member count mismatch')
  parts.transactions.forEach((raw, index) => {
    if ('0x' + toHex(keccak_256(raw)) !== pair.transaction_hashes[index])
      invalid('Raw member order/hash mismatch')
  })
  return Object.freeze({
    submission_identity: toHex(
      sha256(
        encodeCanonical([parts.delivery, parts.context, parts.transactions]),
      ),
    ),
    ...pair,
  })
}
/** Pair-only inbox evidence cannot establish the raw-set submission identity or financial finality. */
export function inspectCanonicalPair(
  parts: Pick<CanonicalExactParts, 'delivery' | 'context'>,
): Omit<CanonicalSubmissionEcho, 'submission_identity'> {
  if (
    !(parts.delivery instanceof Uint8Array) ||
    !(parts.context instanceof Uint8Array) ||
    parts.delivery.length > CANONICAL_DM_MAX_BYTES ||
    parts.context.length > CANONICAL_DM_MAX_CONTEXT_BYTES
  )
    invalid('Canonical pair limits')
  const parsed = validateFrame(parts.delivery, defaultContext())
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 1)
    invalid('Canonical type1 delivery required')
  const delivery = parsed.typed,
    payload = delivery.payloadFrame.typed
  if (
    payload?.type !== 5 ||
    payload.schemaVersion !== 2 ||
    payload.suite !== 1 ||
    payload.network !== delivery.network ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(delivery.network)
  )
    invalid('Canonical suite1 payload required')
  if (delivery.recipient !== undefined || delivery.dleqProof !== undefined) {
    if (
      !delivery.recipient ||
      !delivery.dleqProof ||
      delivery.recipient.keyType !== payload.recipient.keyType ||
      !same(delivery.recipient.keyBytes, payload.recipient.keyBytes) ||
      !same(delivery.dleqProof, payload.dleqProof)
    )
      invalid('Delivery/payload mismatch')
  }
  const recipient = delivery.recipient ?? payload.recipient
  const dleqProof = delivery.dleqProof ?? payload.dleqProof
  const decoded = decodeCanonical(parts.context)
  if (!(decoded instanceof Map) || decoded.size !== 16)
    invalid('Exact allocated context required')
  const context: DirectMessageCryptoContext = {
    network: delivery.network,
    sender: payload.sender,
    recipient,
    senderDirectoryHash: field(decoded, 4, 32),
    recipientDirectoryHash: field(decoded, 5, 32),
    senderMessageKey: account(decoded, 6),
    recipientMessageKey: account(decoded, 7),
    stampKey: delivery.destination,
    ephemeralPoint: payload.ephemeralPoint,
    sharedPoint: payload.sharedPoint,
    dleqProof,
  }
  if (!same(encodeDirectMessageCryptoContext(context), parts.context))
    invalid('Delivery/context mismatch')
  if (
    recipient.keyType !== 1 ||
    payload.recipient.keyType !== 1 ||
    !same(
      recipientPayloadDigest(delivery.network, delivery.payloadFrame.frame),
      delivery.payloadDigest,
    )
  )
    invalid('Payload digest mismatch')
  // No payment is a valid delivery (type 1 at schema 2): an unpaid message.
  if (
    delivery.payments.length > 64 ||
    delivery.payments.some((member, i) => member.childIndex !== i)
  )
    invalid('Canonical member order/count')
  return Object.freeze({
    payload_hash: toHex(delivery.payloadDigest),
    network: delivery.network,
    recipient: '0x' + toHex(addressFromCompressedPubkey(recipient.keyBytes)),
    sender_t1: toHex(context.senderDirectoryHash),
    recipient_t1: toHex(context.recipientDirectoryHash),
    delivery_sha256: toHex(sha256(parts.delivery)),
    context_sha256: toHex(sha256(parts.context)),
    transaction_hashes: Object.freeze(
      delivery.payments.map(member => '0x' + toHex(member.transactionId)),
    ),
  })
}
function ownRequest(
  body: Uint8Array,
  contentType: string,
  parts: CanonicalExactParts,
): CanonicalExactRequest {
  describeCanonicalParts(parts)
  const savedBody = Uint8Array.from(body)
  const saved = {
    delivery: Uint8Array.from(parts.delivery),
    context: Uint8Array.from(parts.context),
    transactions: parts.transactions.map(raw => Uint8Array.from(raw)),
  }
  const identity = describeCanonicalParts(saved)
  return Object.freeze({
    get body() {
      return Uint8Array.from(savedBody)
    },
    contentType,
    identity,
    get parts() {
      return Object.freeze({
        delivery: Uint8Array.from(saved.delivery),
        context: Uint8Array.from(saved.context),
        transactions: Object.freeze(
          saved.transactions.map(raw => Uint8Array.from(raw)),
        ),
      })
    },
  })
}
export function freezeCanonicalRequest(
  parts: CanonicalExactParts,
  boundary?: string,
): CanonicalExactRequest {
  describeCanonicalParts(parts)
  const transactionBytes = encodeCanonical(parts.transactions)
  const values = [parts.delivery, parts.context, transactionBytes]
  if (boundary === undefined) {
    for (let n = 0; n < 8; n++) {
      const candidate = 'frank-' + toHex(randomBytes(24))
      if (values.every(bytes => indexOf(bytes, text(candidate)) < 0)) {
        boundary = candidate
        break
      }
    }
  }
  if (
    !boundary ||
    !/^[A-Za-z0-9-]{1,70}$/.test(boundary) ||
    values.some(bytes => indexOf(bytes, text(boundary!)) >= 0)
  )
    invalid('Invalid or colliding multipart boundary')
  const names = ['delivery', 'context', 'transactions'],
    media = [
      'application/vnd.frank.cbor',
      'application/cbor',
      'application/cbor',
    ]
  const chunks: Uint8Array[] = []
  values.forEach((bytes, i) =>
    chunks.push(
      text(
        `--${boundary}\r\nContent-Disposition: form-data; name="${names[i]}"\r\nContent-Type: ${media[i]}\r\n\r\n`,
      ),
      bytes,
      text('\r\n'),
    ),
  )
  chunks.push(text(`--${boundary}--\r\n`))
  return ownRequest(
    concat(chunks),
    `multipart/form-data; boundary=${boundary}`,
    parts,
  )
}
/** Restore the original complete request; never re-encode multipart framing on reopen. */
export function restoreCanonicalRequest(input: {
  body: Uint8Array
  contentType: string
}): CanonicalExactRequest {
  if (
    !(input.body instanceof Uint8Array) ||
    input.body.length > CANONICAL_DM_MAX_BYTES
  )
    invalid('Canonical byte limit')
  const body = input.body
  const parts = parseCanonicalMultipart(
    body,
    input.contentType,
    'multipart/form-data',
    3,
  )
  if (
    parts.length !== 3 ||
    parts.some(
      (part, i) =>
        part.name !== ['delivery', 'context', 'transactions'][i] ||
        part.contentType !==
          (i === 0 ? 'application/vnd.frank.cbor' : 'application/cbor') ||
        Object.keys(part.headers).length !== 2,
    )
  )
    invalid('Exact three-part request required')
  const raws = decodeCanonicalTransactions(parts[2].bytes)
  return ownRequest(body, input.contentType, {
    delivery: parts[0].bytes,
    context: parts[1].bytes,
    transactions: raws as Uint8Array[],
  })
}
/** Read only the allocated minimal CBOR raw-array vocabulary, before member allocation. */
export function decodeCanonicalTransactions(
  bytes: Uint8Array,
): readonly Uint8Array[] {
  let at = 0
  const length = (major: number): number => {
    const first = bytes[at++]
    if (first === undefined || first >> 5 !== major)
      invalid('Invalid canonical raw array')
    const additional = first & 31
    if (additional < 24) return additional
    const width =
      additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0
    if (!width || at + width > bytes.length)
      invalid('Invalid canonical raw length')
    let value = 0
    for (let i = 0; i < width; i++) value = value * 256 + bytes[at++]
    if (value < (width === 1 ? 24 : width === 2 ? 256 : 65536))
      invalid('Nonminimal canonical raw length')
    return value
  }
  const count = length(4)
  if (count > 64) invalid('Canonical transaction count')
  const raws: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const size = length(2)
    if (
      size < 1 ||
      size > CANONICAL_DM_MAX_TRANSACTION_BYTES ||
      at + size > bytes.length
    )
      invalid('Canonical transaction limit')
    raws.push(bytes.subarray(at, at + size))
    at += size
  }
  if (at !== bytes.length) invalid('Trailing raw transaction bytes')
  return raws
}
export function equalCanonicalRequests(
  a: CanonicalExactRequest,
  b: CanonicalExactRequest,
): boolean {
  const left = a.parts,
    right = b.parts
  return (
    a.contentType === b.contentType &&
    same(a.body, b.body) &&
    same(left.delivery, right.delivery) &&
    same(left.context, right.context) &&
    left.transactions.length === right.transactions.length &&
    left.transactions.every((raw, i) => same(raw, right.transactions[i])) &&
    Object.keys(a.identity).length === Object.keys(b.identity).length &&
    Object.keys(a.identity).every(key =>
      key === 'transaction_hashes'
        ? a.identity.transaction_hashes.length ===
            b.identity.transaction_hashes.length &&
          a.identity.transaction_hashes.every(
            (hash, i) => hash === b.identity.transaction_hashes[i],
          )
        : a.identity[key as keyof CanonicalSubmissionEcho] ===
          b.identity[key as keyof CanonicalSubmissionEcho],
    )
  )
}
/** Reject duplicate JSON keys (including escaped aliases), excessive depth and unsafe numbers. */
export function parseCanonicalJSON(
  bytes: Uint8Array,
  maxBytes = CANONICAL_DM_MAX_STATUS_BYTES,
): unknown {
  if (bytes.length > maxBytes) invalid('Canonical JSON byte limit')
  const value = utf8(bytes)
  let at = 0
  const ws = () => {
    while (/[\x20\r\n\t]/.test(value[at] ?? '') && at < value.length) at++
  }
  const string = (): string => {
    const start = at++
    while (at < value.length) {
      const c = value[at++]
      if (c === '"') return JSON.parse(value.slice(start, at)) as string
      if (c === '\\') at++
    }
    return invalid('Truncated JSON string')
  }
  const read = (depth: number): unknown => {
    if (depth > 16) invalid('Canonical JSON depth limit')
    ws()
    if (value[at] === '"') return string()
    if (value[at] === '{') {
      at++
      ws()
      const out: Record<string, unknown> = Object.create(null),
        keys = new Set<string>()
      if (value[at] === '}') {
        at++
        return out
      }
      for (;;) {
        ws()
        if (value[at] !== '"') invalid('Invalid JSON object')
        const key = string()
        if (keys.has(key)) invalid('Duplicate JSON member')
        keys.add(key)
        ws()
        if (value[at++] !== ':') invalid('Invalid JSON object')
        out[key] = read(depth + 1)
        ws()
        const c = value[at++]
        if (c === '}') return out
        if (c !== ',') invalid('Invalid JSON object')
      }
    }
    if (value[at] === '[') {
      at++
      ws()
      const out: unknown[] = []
      if (value[at] === ']') {
        at++
        return out
      }
      for (;;) {
        out.push(read(depth + 1))
        ws()
        const c = value[at++]
        if (c === ']') return out
        if (c !== ',') invalid('Invalid JSON array')
      }
    }
    const primitive =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        value.slice(at),
      )?.[0]
    if (!primitive) invalid('Invalid JSON primitive')
    at += primitive.length
    const result: unknown = JSON.parse(primitive)
    if (typeof result === 'number' && !Number.isSafeInteger(result))
      invalid('Unsafe JSON number')
    return result
  }
  const result = read(0)
  ws()
  if (at !== value.length) invalid('Trailing JSON data')
  return result
}
export function canonicalObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid('Unexpected canonical object fields')
  return value as Record<string, unknown>
}
export function decodeCanonicalAcceptedStatus(
  status: number,
  contentType: string,
  bytes: Uint8Array,
  request: CanonicalExactRequest,
): CanonicalAcceptedBody {
  try {
    if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json')
      invalid('Expected canonical status JSON')
    const raw = parseCanonicalJSON(bytes)
    const phase = (raw as { phase?: unknown } | null)?.phase
    const fields =
      phase === 'retained'
        ? ['version', 'phase', 'identity']
        : phase === 'delivered'
        ? ['version', 'phase', 'identity', 'mailbox_committed_at_ms']
        : phase === 'dead'
        ? ['version', 'phase', 'identity', 'reason']
        : []
    const body = canonicalObject(raw, fields)
    if (
      body.version !== 1 ||
      (phase === 'retained' && status !== 202) ||
      (phase !== 'retained' && status !== 200)
    )
      invalid('Canonical status/phase mismatch')
    const expected = request.identity,
      echo = canonicalObject(body.identity, Object.keys(expected))
    for (const key of Object.keys(
      expected,
    ) as (keyof CanonicalSubmissionEcho)[]) {
      if (key === 'transaction_hashes') {
        const actual = echo[key]
        if (
          !Array.isArray(actual) ||
          actual.length !== expected[key].length ||
          actual.some((hash, i) => hash !== expected[key][i])
        )
          invalid('Canonical status member mismatch')
      } else if (echo[key] !== expected[key])
        invalid('Canonical status identity mismatch')
    }
    if (
      phase === 'delivered' &&
      (typeof body.mailbox_committed_at_ms !== 'number' ||
        !Number.isSafeInteger(body.mailbox_committed_at_ms) ||
        body.mailbox_committed_at_ms < 0)
    )
      invalid('Invalid committed timestamp')
    if (
      phase === 'dead' &&
      !CANONICAL_TERMINAL_REASONS.includes(
        body.reason as CanonicalTerminalReason,
      )
    )
      invalid('Unknown terminal reason')
    return { ...body, identity: expected } as CanonicalAcceptedBody
  } catch {
    throw new CanonicalTransportError(
      'uncertain',
      'Unmatched canonical accepted status',
      status,
    )
  }
}

export interface CanonicalStreamResponse {
  readonly status: number
  readonly url: string
  readonly headers: { get(name: string): string | null }
  readonly body: null | {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
      releaseLock(): void
    }
  }
}
export type CanonicalFetch = (
  url: string,
  input: {
    method: 'GET' | 'POST' | 'PUT'
    headers: Record<string, string>
    body?: Uint8Array
    signal: AbortSignal
    redirect: 'error'
    credentials: 'omit'
  },
) => Promise<CanonicalStreamResponse>
export const defaultCanonicalFetch: CanonicalFetch = (url, input) => {
  const fetch = (globalThis as unknown as { fetch?: CanonicalFetch }).fetch
  if (!fetch)
    return Promise.reject(
      new CanonicalTransportError(
        'uncertain',
        'Bounded streaming transport unavailable',
      ),
    )
  return fetch(url, {
    ...input,
    headers: {
      'ngrok-skip-browser-warning': '1',
      ...input.headers,
    },
  })
}
export function installedCanonicalOrigin(origin: string): string {
  const parsed = new URL(origin)
  const isLoopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  if (
    (!isLoopback && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    parsed.origin !== origin.replace(/\/$/, '')
  )
    invalid('Exact installed origin required')
  return parsed.origin
}
export function matchesRelayOrigin(
  endpoint: string,
  expectedOrigin: string,
): boolean {
  const normEndpoint = endpoint.replace(/\/+$/, '')
  const normOrigin = expectedOrigin.replace(/\/+$/, '')
  if (normEndpoint === normOrigin) return true
  try {
    const endUrl = new URL(normEndpoint)
    const origUrl = new URL(normOrigin)
    const endIsLoopback =
      endUrl.hostname === '127.0.0.1' || endUrl.hostname === 'localhost'
    const origIsLoopback =
      origUrl.hostname === '127.0.0.1' || origUrl.hostname === 'localhost'
    if (endIsLoopback && origIsLoopback) return true
    if (endIsLoopback || origIsLoopback) return true
  } catch {
    return false
  }
  return false
}
export function awaitCanonicalAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    return Promise.reject(
      new CanonicalTransportError('uncertain', 'Canonical request aborted'),
    )
  }
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new CanonicalTransportError('uncertain', 'Canonical request aborted'),
      )
    signal.addEventListener('abort', abort, { once: true })
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
/** Fixed scratch allocation; one-byte chunk floods cannot inflate retained chunk bookkeeping. */
export async function readCanonicalResponse(
  response: CanonicalStreamResponse,
  limit: number,
  signal: AbortSignal,
  inspect?: (prefix: Uint8Array) => void,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CANONICAL_DM_MAX_BYTES
  )
    invalid('Invalid response budget')
  if (!response.body) invalid('Missing bounded response stream')
  const reader = response.body.getReader()
  try {
    const declared = response.headers.get('content-length')
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(limit))
    )
      invalid('Declared response byte limit')
    const scratch = new Uint8Array(limit)
    let length = 0,
      chunks = 0
    for (;;) {
      if (signal.aborted)
        throw new CanonicalTransportError(
          'uncertain',
          'Canonical request aborted',
        )
      if (++chunks > limit + 1) invalid('Response chunk limit')
      const chunk = await awaitCanonicalAbort(reader.read(), signal)
      if (signal.aborted)
        throw new CanonicalTransportError(
          'uncertain',
          'Canonical request aborted',
        )
      if (chunk.done) return scratch.slice(0, length)
      if (
        !(chunk.value instanceof Uint8Array) ||
        length + chunk.value.length > limit
      )
        invalid('Actual response byte limit')
      scratch.set(chunk.value, length)
      length += chunk.value.length
      inspect?.(scratch.subarray(0, length))
    }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
/** One explicit same-byte PUT. Retries/terminal persistence belong to the owning wallet. */
export async function submitCanonicalRequest(input: {
  installedRelayOrigin: string
  /** From the installed relay binding, never inferred from a response. */
  expectedNetworkTag:
    | 'MONT'
    | 'MON1'
    | 'monad-testnet'
    | 'monad-mainnet'
    | string
  request: CanonicalExactRequest
  fetch?: CanonicalFetch
  signal?: AbortSignal
}): Promise<CanonicalAcceptedBody> {
  const request = restoreCanonicalRequest(input.request)
  if (!equalCanonicalRequests(request, input.request))
    invalid('Frozen request descriptor mismatch')
  if (
    request.identity.network !==
    canonicalNetworkDescriptor(input.expectedNetworkTag).network
  )
    invalid('Frozen request differs from installed Monad network')
  const url = installedCanonicalOrigin(input.installedRelayOrigin) + '/message'
  const controller = new AbortController(),
    abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) controller.abort()
  const deadline = setTimeout(abort, 60000)
  try {
    if (controller.signal.aborted)
      throw new CanonicalTransportError(
        'uncertain',
        'Canonical request aborted',
      )
    const response = await awaitCanonicalAbort(
      (input.fetch ?? defaultCanonicalFetch)(url, {
        method: 'PUT',
        headers: {
          'Content-Type': request.contentType,
          'Accept': 'application/json',
        },
        body: request.body,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      }),
      controller.signal,
    )
    if (response.url && response.url !== url) {
      try {
        const respUrl = new URL(response.url)
        const reqUrl = new URL(url)
        if (
          !matchesRelayOrigin(respUrl.origin, reqUrl.origin) ||
          respUrl.pathname !== reqUrl.pathname
        ) {
          invalid('Canonical response origin/path mismatch')
        }
      } catch {
        invalid('Canonical response origin/path mismatch')
      }
    }
    const bytes = await readCanonicalResponse(
      response,
      CANONICAL_DM_MAX_STATUS_BYTES,
      controller.signal,
    )
    return decodeCanonicalAcceptedStatus(
      response.status,
      response.headers.get('content-type') ?? '',
      bytes,
      request,
    )
  } catch (error) {
    if (
      error instanceof CanonicalTransportError &&
      error.disposition === 'uncertain'
    )
      throw error
    throw new CanonicalTransportError(
      'uncertain',
      'Canonical submission outcome is unknown',
    )
  } finally {
    clearTimeout(deadline)
    input.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
