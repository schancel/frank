/**
 * In-process mock of the relay's private Monad mailbox that follows the Rust contract
 * (`backend/cashweb/cashweb-registry/src/http/monad_message.rs` + `monad_mailbox.rs`) closely
 * enough to catch client mistakes: it issues HMAC-bound challenges, verifies the recipient's
 * ECDSA signature over its OWN independently built preimage (not the client's), consumes nonces
 * (cap 8 per recipient, 60 s TTL), authenticates opaque HMAC cursors, enforces limit/byte budgets,
 * strict-forward `(timestamp, payload_hash)` paging, stale-cursor rejection, recovery paging and
 * acks, the 404 "mailbox disabled" behaviour, and read-capacity 503s.
 *
 * Test-only. It is deliberately a *second*, separate implementation of the preimage so the client's
 * builder is cross-checked (and both are pinned to vectors produced by the Rust function).
 */
import { createHash, createHmac, randomBytes } from 'crypto'
import { PublicKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import __pb_monad_message_pb from './monad_message_pb'
import type { MailboxHttp, MailboxHttpRequest } from './monad-mailbox-client'
const { StoredMonadMessage, StoredMonadMessages, MonadStampedMessage } =
  __pb_monad_message_pb
const { MonadStampPayment } = __pb_monad_message_pb

export const MOCK_MAX_PAGE = 100
export const MOCK_MAX_BYTES = 2 * 1024 * 1024 * 2 + 16 * 1024
const CHALLENGE_TTL_MS = 60_000
const MAX_USED_CHALLENGES = 8
const CURSOR_MAC_DOMAIN = Buffer.from('frank:mailbox-cursor-mac:v1\0')
const CHALLENGE_MAC_DOMAIN = Buffer.from('frank:mailbox-challenge-mac:v1\0')
const AUTH_DOMAIN = 'frank:mailbox-http-auth:v2'

export interface MockStoredMessage {
  recipient: string // lower-case 0x address
  timestamp: number
  payloadHash: Buffer // 32
  encryptedPayload: Buffer
  stampPayments?: Array<{ childIndex: number; rawTx: Buffer }>
  networkTag?: Buffer
}

export interface MockRecovery {
  recipient: string
  payloadHash: Buffer
  obligationId: Buffer
  canonicalMessage: Buffer // serialized MonadStampedMessage
  confirmedChildren: number[]
  lifecycle: string
}

export interface MockRelayOptions {
  /** `false` reproduces a relay with the mailbox disabled: no mailbox routes at all (404). */
  enabled?: boolean
  networkTag?: Buffer
  now?: () => number
}

export interface InjectedResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
}
/** Queue entries are consumed FIFO per route; `'network-error'` rejects like a dropped socket. */
export type Injection = InjectedResponse | 'network-error'

type Route = 'challenge' | 'inbox' | 'recovery' | 'ack'

const json = (status: number, body: unknown, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  data: new TextEncoder().encode(JSON.stringify(body)),
})

export class MockMailboxRelay {
  readonly enabled: boolean
  readonly networkTag: Buffer
  private readonly now: () => number
  private readonly epoch = randomBytes(32)
  private readonly secret = randomBytes(32)
  private readonly profiles = new Map<string, Buffer>()
  private readonly messages: MockStoredMessage[] = []
  private readonly recoveries: MockRecovery[] = []
  private readonly used = new Map<string, Map<string, number>>()
  private readonly injections: Record<Route, Injection[]> = {
    challenge: [],
    inbox: [],
    recovery: [],
    ack: [],
  }
  /** Every request received, in order (route, decoded query, headers). */
  readonly log: Array<{
    route: Route
    method: string
    url: string
    query: Record<string, string>
    status: number
  }> = []

  constructor(options: MockRelayOptions = {}) {
    this.enabled = options.enabled ?? true
    this.networkTag = options.networkTag ?? Buffer.from('MONT')
    this.now = options.now ?? (() => Date.now())
  }

  registerProfile(address: string, compressedPubKey: Uint8Array) {
    this.profiles.set(address.toLowerCase(), Buffer.from(compressedPubKey))
  }
  addMessage(message: MockStoredMessage) {
    this.messages.push({
      ...message,
      recipient: message.recipient.toLowerCase(),
    })
  }
  addRecovery(recovery: MockRecovery) {
    this.recoveries.push({
      ...recovery,
      recipient: recovery.recipient.toLowerCase(),
    })
  }
  hasRecovery(payloadHash: Buffer) {
    return this.recoveries.some(r => r.payloadHash.equals(payloadHash))
  }
  inject(route: Route, ...responses: Injection[]) {
    this.injections[route].push(...responses)
  }
  /** Number of consumed (authenticated) challenges for `recipient` right now. */
  usedChallenges(recipient: string) {
    return this.used.get(recipient.toLowerCase())?.size ?? 0
  }
  /** When set, every private read/ack answers 503 `mailbox_auth_retryable` (read capacity). */
  atCapacity = false

  readonly http: MailboxHttp = async (request: MailboxHttpRequest) => {
    const url = new URL(request.url)
    const path = url.pathname
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(request.params ?? {})) {
      if (v !== undefined) query[k] = String(v)
    }
    const route = ((): Route | undefined => {
      if (path.startsWith('/message/monad/auth/')) return 'challenge'
      if (path.startsWith('/message/monad/inbox/')) return 'inbox'
      if (path.endsWith('/ack') && path.startsWith('/message/monad/recovery/'))
        return 'ack'
      if (path.startsWith('/message/monad/recovery/')) return 'recovery'
      return undefined
    })()
    const respond = (r: {
      status: number
      headers: Record<string, string>
      data: unknown
    }) => {
      if (route) {
        this.log.push({
          route,
          method: request.method,
          url: request.url,
          query,
          status: r.status,
        })
      }
      return r
    }
    if (route === undefined || !this.enabled) {
      // Disabled mailbox (or unknown path): axum's fallback 404 with an empty body.
      return respond({ status: 404, headers: {}, data: new Uint8Array() })
    }
    const injected = this.injections[route].shift()
    if (injected === 'network-error') {
      this.log.push({
        route,
        method: request.method,
        url: request.url,
        query,
        status: 0,
      })
      throw new Error('socket hang up')
    }
    if (injected !== undefined) {
      return respond({
        status: injected.status,
        headers: injected.headers ?? {},
        data: new TextEncoder().encode(JSON.stringify(injected.body ?? {})),
      })
    }
    const method = request.method
    const headers = request.headers ?? {}
    try {
      if (route === 'challenge' && method === 'post') {
        return respond(this.issueChallenge(path, query))
      }
      if (route === 'inbox' && method === 'get') {
        return respond(this.readInbox(path, query, headers))
      }
      if (route === 'recovery' && method === 'get') {
        return respond(this.readRecovery(path, query, headers))
      }
      if (route === 'ack' && method === 'post') {
        return respond(this.ack(path, headers))
      }
    } catch (err) {
      if (err instanceof HttpFail) return respond(err.response)
      throw err
    }
    return respond({ status: 405, headers: {}, data: new Uint8Array() })
  }

  // --- binding / canonical bytes (mirrors MailboxRequestBinding::append_canonical) ------------

  private canonical(b: Binding): Buffer {
    const [method, p, tag] = {
      inbox: ['GET', 'inbox/', 1],
      recovery: ['GET', 'recovery/', 2],
      recovery_ack: ['POST', 'recovery-ack/', 3],
    }[b.resource] as [string, string, number]
    const parts: Buffer[] = [
      Buffer.from(`${method}\0/message/monad/${p}`),
      Buffer.from([tag]),
      b.recipient,
      i64(b.since),
    ]
    if (b.cursor === undefined) parts.push(Buffer.from([0]))
    else {
      const c = Buffer.from(b.cursor, 'utf8')
      parts.push(Buffer.from([1]), u32(c.length), c)
    }
    parts.push(u64(b.limit), u64(b.maxBytes))
    if (b.resource === 'recovery_ack') {
      parts.push(b.recoveryPayloadHash!, b.recoveryObligationId!)
    }
    return Buffer.concat(parts)
  }

  private mac(data: Buffer) {
    return createHmac('sha256', this.secret).update(data).digest()
  }

  private challengeToken(b: Binding, nonce: Buffer, expires: number) {
    return this.mac(
      Buffer.concat([
        CHALLENGE_MAC_DOMAIN,
        this.epoch,
        nonce,
        i64(expires),
        this.canonical(b),
      ]),
    )
  }

  private encodeCursor(
    recipient: Buffer,
    resource: 'inbox' | 'recovery',
    position: Buffer,
  ): string {
    const head = Buffer.concat([
      Buffer.from([1, resource === 'inbox' ? 1 : 2]),
      recipient,
      position,
    ])
    return Buffer.concat([
      head,
      this.mac(Buffer.concat([CURSOR_MAC_DOMAIN, head])),
    ]).toString('hex')
  }

  private decodeCursor(
    recipient: Buffer,
    resource: 'inbox' | 'recovery',
    token: string,
  ): Buffer | undefined {
    const positionLen = resource === 'inbox' ? 40 : 32
    if (token.length !== (2 + 20 + positionLen + 32) * 2) return undefined
    if (!/^[0-9a-f]+$/.test(token)) return undefined // uppercase spelling is rejected upstream
    const bytes = Buffer.from(token, 'hex')
    const head = bytes.subarray(0, 22 + positionLen)
    if (
      bytes[0] !== 1 ||
      bytes[1] !== (resource === 'inbox' ? 1 : 2) ||
      !bytes.subarray(2, 22).equals(recipient)
    ) {
      return undefined
    }
    const expected = this.mac(Buffer.concat([CURSOR_MAC_DOMAIN, head]))
    return expected.equals(bytes.subarray(22 + positionLen))
      ? bytes.subarray(22, 22 + positionLen).subarray(0)
      : undefined
  }

  private parseBinding(
    recipientHex: string,
    resource: Binding['resource'],
    q: {
      since?: string
      cursor?: string
      limit?: string
      max_bytes?: string
      recovery_payload_hash?: string
      recovery_obligation_id?: string
    },
  ): Binding {
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipientHex)) throw unauthorized()
    const recipient = Buffer.from(recipientHex.slice(2), 'hex')
    const since = q.since === undefined ? 0 : Number(q.since)
    if (!Number.isInteger(since) || since < 0)
      throw invalid('invalid_mailbox_limit')
    let limit: number
    let maxBytes: number
    if (resource === 'recovery_ack') {
      limit = 1
      maxBytes = 0
    } else {
      limit =
        q.limit === undefined
          ? resource === 'inbox'
            ? 50
            : 20
          : Number(q.limit)
      maxBytes =
        q.max_bytes === undefined ? MOCK_MAX_BYTES : Number(q.max_bytes)
      if (!Number.isInteger(limit) || limit < 1 || limit > MOCK_MAX_PAGE)
        throw invalid('invalid_mailbox_limit')
      if (
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MOCK_MAX_BYTES
      )
        throw invalid('invalid_mailbox_limit')
    }
    let cursorPosition: Buffer | undefined
    if (q.cursor !== undefined) {
      if (resource === 'recovery_ack') throw invalid('invalid_mailbox_limit')
      cursorPosition = this.decodeCursor(recipient, resource, q.cursor)
      if (cursorPosition === undefined) throw unauthorized()
    }
    const hex32 = (v: string | undefined) => {
      if (v === undefined || !/^[0-9a-f]{64}$/i.test(v))
        throw invalid('invalid_mailbox_limit')
      return Buffer.from(v, 'hex')
    }
    return {
      resource,
      recipient,
      since,
      cursor: q.cursor,
      cursorPosition,
      limit,
      maxBytes,
      recoveryPayloadHash:
        resource === 'recovery_ack'
          ? hex32(q.recovery_payload_hash)
          : undefined,
      recoveryObligationId:
        resource === 'recovery_ack'
          ? hex32(q.recovery_obligation_id)
          : undefined,
    }
  }

  // --- routes ---------------------------------------------------------------------------------

  private issueChallenge(path: string, q: Record<string, string>) {
    const recipientHex = path.split('/').pop()!
    const resource = q.resource as Binding['resource']
    if (!['inbox', 'recovery', 'recovery_ack'].includes(resource))
      throw invalid('invalid_mailbox_limit')
    if (
      resource === 'recovery' &&
      (Number(q.since ?? 0) !== 0 ||
        q.recovery_payload_hash ||
        q.recovery_obligation_id)
    )
      throw invalid('invalid_mailbox_limit')
    if (
      resource === 'inbox' &&
      (q.recovery_payload_hash || q.recovery_obligation_id)
    )
      throw invalid('invalid_mailbox_limit')
    if (
      resource === 'recovery_ack' &&
      (Number(q.since ?? 0) !== 0 || q.cursor || q.limit || q.max_bytes)
    )
      throw invalid('invalid_mailbox_limit')
    const b = this.parseBinding(recipientHex, resource, q)
    const nonce = randomBytes(32)
    const expires = this.now() + CHALLENGE_TTL_MS
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: new TextEncoder().encode(
        JSON.stringify({
          epoch: this.epoch.toString('hex'),
          nonce: nonce.toString('hex'),
          expires_at_ms: expires,
          token: this.challengeToken(b, nonce, expires).toString('hex'),
          signing_domain: AUTH_DOMAIN,
          resource,
          since: b.since,
          cursor: q.cursor ?? null,
          limit: b.limit,
          max_bytes: b.maxBytes,
          network_tag: this.networkTag.toString('hex'),
          recovery_payload_hash: b.recoveryPayloadHash?.toString('hex') ?? null,
          recovery_obligation_id:
            b.recoveryObligationId?.toString('hex') ?? null,
        }),
      ),
    }
  }

  private authenticate(b: Binding, headers: Record<string, string>) {
    const hex32 = (name: string) => {
      const v = headers[name]
      if (v === undefined || !/^[0-9a-f]{64}$/i.test(v)) throw unauthorized()
      return Buffer.from(v, 'hex')
    }
    const epoch = hex32('x-frank-mailbox-epoch')
    const nonce = hex32('x-frank-mailbox-nonce')
    const token = hex32('x-frank-mailbox-token')
    const expires = Number(headers['x-frank-mailbox-expires-at-ms'])
    const signatureHex = headers['x-frank-mailbox-signature']
    if (
      !Number.isInteger(expires) ||
      signatureHex === undefined ||
      signatureHex.length % 2 !== 0 ||
      signatureHex.length < 16 ||
      signatureHex.length > 144 ||
      !/^[0-9a-f]+$/i.test(signatureHex)
    )
      throw unauthorized()
    if (!epoch.equals(this.epoch) || expires < this.now()) throw unauthorized()
    const expectedToken = this.challengeToken(b, nonce, expires)
    if (!expectedToken.equals(token)) throw unauthorized()
    if (this.atCapacity)
      throw new HttpFail(json(503, { error: 'mailbox_auth_retryable' }))
    // Preimage built from the server's own binding, exactly like `mailbox_auth_preimage`.
    const preimage = Buffer.concat([
      Buffer.from(AUTH_DOMAIN),
      Buffer.from([0]),
      epoch,
      nonce,
      i64(expires),
      token,
      this.canonical(b),
      u32(this.networkTag.length),
      this.networkTag,
    ])
    const digest = createHash('sha256').update(preimage).digest()
    const key = this.profiles.get('0x' + b.recipient.toString('hex'))
    let valid = false
    try {
      const pub = new (PublicKey as unknown as new (b: Buffer) => PublicKey)(
        key ?? Buffer.alloc(33, 2),
      )
      const sig = bitcoreCrypto.Signature.fromDER(
        Buffer.from(signatureHex, 'hex'),
      )
      valid = bitcoreCrypto.ECDSA.verify(digest, sig, pub)
    } catch {
      valid = false
    }
    if (!(key !== undefined && valid)) throw unauthorized()
    // Consume the nonce (single use, per-recipient cap of 8 unexpired).
    const recipient = '0x' + b.recipient.toString('hex')
    const bucket = this.used.get(recipient) ?? new Map<string, number>()
    for (const [n, e] of bucket) if (e < this.now()) bucket.delete(n)
    if (
      bucket.has(nonce.toString('hex')) ||
      bucket.size >= MAX_USED_CHALLENGES
    ) {
      this.used.set(recipient, bucket)
      throw unauthorized()
    }
    bucket.set(nonce.toString('hex'), expires)
    this.used.set(recipient, bucket)
  }

  private readInbox(
    path: string,
    q: Record<string, string>,
    headers: Record<string, string>,
  ) {
    const recipientHex = path.split('/').pop()!
    const b = this.parseBinding(recipientHex, 'inbox', q)
    this.authenticate(b, headers)
    const recipient = '0x' + b.recipient.toString('hex')
    let cursor: { timestamp: number; hash: Buffer } | undefined
    if (b.cursorPosition !== undefined) {
      cursor = {
        timestamp: Number(b.cursorPosition.readBigInt64BE(0)),
        hash: b.cursorPosition.subarray(8, 40),
      }
      if (cursor.timestamp < b.since) {
        throw new HttpFail(json(400, { error: 'invalid_mailbox_cursor' }))
      }
    }
    const rows = this.messages
      .filter(m => m.recipient === recipient && m.timestamp >= b.since)
      .sort(
        (x, y) =>
          x.timestamp - y.timestamp ||
          Buffer.compare(x.payloadHash, y.payloadHash),
      )
      .filter(
        m =>
          cursor === undefined ||
          m.timestamp > cursor.timestamp ||
          (m.timestamp === cursor.timestamp &&
            Buffer.compare(m.payloadHash, cursor.hash) > 0),
      )
    const page: MockStoredMessage[] = []
    let bytes = 0
    let hasMore = false
    for (const row of rows) {
      if (page.length === b.limit) {
        hasMore = true
        break
      }
      const stored = toStored(row)
      const len = stored.serializeBinary().length
      const added = 1 + varintLen(len) + len
      if (bytes + added > b.maxBytes) {
        if (page.length === 0) {
          throw new HttpFail(
            json(413, { error: 'mailbox_record_exceeds_page_budget' }),
          )
        }
        hasMore = true
        break
      }
      bytes += added
      page.push(row)
    }
    const body = new StoredMonadMessages()
    for (const row of page) body.addMessages(toStored(row))
    const headersOut: Record<string, string> = {
      'content-type': 'application/x-protobuf',
    }
    if (hasMore) {
      const last = page[page.length - 1]
      headersOut['x-frank-mailbox-next-cursor'] = this.encodeCursor(
        b.recipient,
        'inbox',
        Buffer.concat([i64(last.timestamp), last.payloadHash]),
      )
    }
    return { status: 200, headers: headersOut, data: body.serializeBinary() }
  }

  private readRecovery(
    path: string,
    q: Record<string, string>,
    headers: Record<string, string>,
  ) {
    const recipientHex = path.split('/').pop()!
    const b = this.parseBinding(recipientHex, 'recovery', q)
    this.authenticate(b, headers)
    const recipient = '0x' + b.recipient.toString('hex')
    const rows = this.recoveries
      .filter(r => r.recipient === recipient)
      .sort((x, y) => Buffer.compare(x.payloadHash, y.payloadHash))
      .filter(
        r =>
          b.cursorPosition === undefined ||
          Buffer.compare(r.payloadHash, b.cursorPosition) > 0,
      )
    const page = rows.slice(0, b.limit)
    const hasMore = rows.length > page.length
    const headersOut: Record<string, string> = {
      'content-type': 'application/json',
    }
    const body: Record<string, unknown> = {
      recoveries: page.map(r => ({
        payload_hash: r.payloadHash.toString('hex'),
        obligation_id: r.obligationId.toString('hex'),
        canonical_message: r.canonicalMessage.toString('hex'),
        confirmed_children: r.confirmedChildren,
        lifecycle: r.lifecycle,
      })),
    }
    if (hasMore) {
      const cursor = this.encodeCursor(
        b.recipient,
        'recovery',
        page[page.length - 1].payloadHash,
      )
      body.next_cursor = cursor
      headersOut['x-frank-mailbox-next-cursor'] = cursor
    }
    return {
      status: 200,
      headers: headersOut,
      data: new TextEncoder().encode(JSON.stringify(body)),
    }
  }

  private ack(path: string, headers: Record<string, string>) {
    const [, , , , recipientHex, payloadHashHex, obligationHex] =
      path.split('/')
    if (
      !/^[0-9a-f]{64}$/.test(payloadHashHex ?? '') ||
      !/^[0-9a-f]{64}$/.test(obligationHex ?? '')
    )
      throw invalid('invalid_mailbox_limit')
    const b = this.parseBinding(recipientHex, 'recovery_ack', {
      recovery_payload_hash: payloadHashHex,
      recovery_obligation_id: obligationHex,
    })
    this.authenticate(b, headers)
    const recipient = '0x' + b.recipient.toString('hex')
    const index = this.recoveries.findIndex(
      r =>
        r.payloadHash.toString('hex') === payloadHashHex &&
        r.obligationId.toString('hex') === obligationHex,
    )
    if (index < 0) return { status: 204, headers: {}, data: new Uint8Array() }
    const record = this.recoveries[index]
    if (record.recipient !== recipient) throw unauthorized()
    if (!record.lifecycle.startsWith('terminal:')) {
      throw new HttpFail(json(409, { error: 'recovery_obligation_is_active' }))
    }
    this.recoveries.splice(index, 1)
    return { status: 204, headers: {}, data: new Uint8Array() }
  }
}

interface Binding {
  resource: 'inbox' | 'recovery' | 'recovery_ack'
  recipient: Buffer
  since: number
  cursor: string | undefined
  cursorPosition: Buffer | undefined
  limit: number
  maxBytes: number
  recoveryPayloadHash: Buffer | undefined
  recoveryObligationId: Buffer | undefined
}

class HttpFail {
  constructor(
    readonly response: {
      status: number
      headers: Record<string, string>
      data: Uint8Array
    },
  ) {}
}
const unauthorized = () =>
  new HttpFail(json(401, { error: 'mailbox_auth_failed' }))
const invalid = (code: string) => new HttpFail(json(400, { error: code }))

function i64(n: number) {
  const b = Buffer.alloc(8)
  b.writeBigInt64BE(BigInt(n))
  return b
}
function u64(n: number) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}
function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
function varintLen(n: number) {
  let len = 1
  while (n >= 0x80) {
    n = Math.floor(n / 128)
    len++
  }
  return len
}

export function toStored(row: MockStoredMessage) {
  const message = new MonadStampedMessage()
  message.setEncryptedPayload(new Uint8Array(row.encryptedPayload))
  message.setPayloadHash(new Uint8Array(row.payloadHash))
  for (const p of row.stampPayments ?? []) {
    const payment = new MonadStampPayment()
    payment.setChildIndex(p.childIndex)
    payment.setRawTx(new Uint8Array(p.rawTx))
    message.addStampPayments(payment)
  }
  const stored = new StoredMonadMessage()
  stored.setMessage(message)
  stored.setTimestamp(row.timestamp)
  stored.setNetworkTag(new Uint8Array(row.networkTag ?? Buffer.alloc(0)))
  return stored
}
