// Stage 8.1 (type-specific limits), 8.2 (CDDL structure and ranges) and 8.3 (allocated
// identifiers) for the version-1 payload schemas.
import type { FrankValue } from './cbor'
import {
  ENCRYPTION_SUITE_DM_AUTH_XCHACHA,
  ENCRYPTION_SUITE_PROOF,
  I64_MAX,
  I64_MIN,
  MAX_CIPHERTEXT_BYTES,
  MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
  MAX_JOURNAL_FACTS,
  MAX_MESSAGE_ITEMS_PER_ARRAY,
  MAX_OPAQUE_SECTIONS,
  MAX_PAYMENT_MEMBERS,
  MAX_RELAY_BINDINGS,
  MAX_SIGNATURES,
  MAX_FRAME_BYTES,
  MAX_TEXT_STRING_BYTES,
  MAX_TOPIC_BODY_BYTES,
  MAX_TOPIC_FRAME_BYTES,
  MAX_TOPIC_VOTE_FRAME_BYTES,
  MAX_FORUM_VIEW_BYTES,
  MAX_FORUM_PAGE_BYTES,
  MAX_FORUM_ROWS,
  MAX_FORUM_ENTRIES,
  MAX_FORUM_CURSOR_BYTES,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TEXT_MESSAGE_ITEM,
  TYPE_BLACKJACK_MESSAGE_ITEM,
  TYPE_STEALTH_MESSAGE_ITEM,
  TYPE_CHANNEL_UPDATE,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
  MAX_FORWARDING_DELIVERY_FRAME_BYTES,
  MAX_BLACKJACK_FRAME_BYTES,
  MAX_CHANNEL_UPDATE_FRAME_BYTES,
  MAX_CHANNEL_ALLOCATIONS,
  MAX_CHANNEL_PARTICIPANTS,
  MAX_CHANNEL_SIGNATURES,
  MAX_CHANNEL_APP_STATE_BYTES,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
  TYPE_FORUM_VIEW,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  U32_MAX,
  U64_MAX,
} from './constants'
import { ErrorCategory, ErrorStage, FrankCodecError } from './errors'
import { isCompressedPoint, isProofEncoding } from './point'
import type {
  AccountRef,
  DirectMessageDelivery,
  ForwardingDeliveryEnvelope,
  DraftPayload,
  JournalFact,
  KeyTransition,
  OpaqueSection,
  PaymentMember,
  PaymentTransfer,
  StealthMetadata,
  ProfileEntry,
  ProfileHeader,
  RelayBinding,
  SignatureEntry,
  Timestamp,
  UnknownFields,
  ForumContent,
  ForumCursor,
  ForumAggregate,
  TopicPost,
  BlackjackMessageItem,
  BlackjackHandMessageItem,
  BlackjackHandV3MessageItem,
  ChainAllocation,
  ChannelUpdateItem,
  ParticipantBalance,
} from './types'

function fail(
  category: ErrorCategory,
  stage: ErrorStage,
  path: string,
  message: string,
): FrankCodecError {
  return new FrankCodecError(category, stage, message, path)
}

const bad = (path: string, message: string) =>
  fail('schema', '8.2', path, message)

// ---------------------------------------------------------------------------------------------
// Value getters (8.2)
// ---------------------------------------------------------------------------------------------

function isMap(
  v: FrankValue | undefined,
): v is ReadonlyMap<bigint, FrankValue> {
  return v instanceof Map
}

function uintRange(
  v: FrankValue | undefined,
  path: string,
  min: bigint,
  max: bigint,
): bigint {
  if (typeof v !== 'bigint') throw bad(path, 'expected an unsigned integer')
  if (v < min || v > max) throw bad(path, `integer outside ${min}..${max}`)
  return v
}

function u32ish(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): number {
  return Number(uintRange(v, path, BigInt(min), BigInt(max)))
}

function bstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): Uint8Array {
  if (!(v instanceof Uint8Array)) throw bad(path, 'expected a byte string')
  if (v.length < min || v.length > max)
    throw bad(path, `byte string size outside ${min}..${max}`)
  return v
}

function tstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): string {
  if (typeof v !== 'string') throw bad(path, 'expected a text string')
  return textSize(v, path, min, max)
}

function textSize(v: string, path: string, min: number, max: number): string {
  // .size counts UTF-8 bytes; the decoded string is well-formed, so count code points.
  let n = 0
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  if (n < min || n > max) throw bad(path, `text size outside ${min}..${max}`)
  return v
}

const NETWORK_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/

function networkTag(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 64)
  if (!NETWORK_TAG.test(s)) throw bad(path, 'network tag does not match S1')
  return s
}

// S4: scheme, then only bytes 0x21..0x7e excluding " < > \ ^ ` { | }.
const ENDPOINT = /^[A-Za-z][A-Za-z0-9+.-]*:[!#-;=?-[\]_a-z~]*$/

function endpoint(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 2048)
  // The class above is bytes 21,23-3b,3d,3f-5b,5d,5f,61-7a,7e: everything 21-7e except
  // 22 " 3c < 3e > 5c \ 5e ^ 60 ` 7b { 7c | 7d }.
  if (!ENDPOINT.test(s)) throw bad(path, 'endpoint violates S4')
  return s
}

const FORBIDDEN_TEXT_CONTROL_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

function conversationName(v: FrankValue | undefined, path: string): string {
  const s = tstr(v, path, 1, 512)
  if (s.trim().length === 0) {
    throw bad(path, 'conversation name cannot be whitespace-only')
  }
  if (FORBIDDEN_TEXT_CONTROL_CHARACTER.test(s)) {
    throw bad(path, 'conversation name contains forbidden control character')
  }
  return s
}

const KEY_LENGTHS: ReadonlyMap<number, number> = new Map([
  [1, 33],
  [2, 32],
  [3, 32],
])

function asList(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): FrankValue[] {
  if (!Array.isArray(v)) throw bad(path, 'expected an array')
  if (v.length < min || v.length > max)
    throw bad(path, `array size outside ${min}..${max}`)
  return v
}

interface MapView {
  get(k: number): FrankValue | undefined
  has(k: number): boolean
  unknown: UnknownFields
}

/**
 * Checks a map against its declared keys. `open` maps (CDDL `* uint => frank-value`) retain
 * undeclared keys only when the enclosing frame is read through V6.3 (`allowUnknown`);
 * otherwise C12 makes an undeclared key a schema error. Closed maps never allow one.
 */
function fields(
  v: FrankValue | undefined,
  path: string,
  required: readonly number[],
  optional: readonly number[],
  open: boolean,
  allowUnknown: boolean,
): MapView {
  if (!isMap(v)) throw bad(path, 'expected a map')
  for (const k of required) {
    if (!v.has(BigInt(k))) throw bad(path, `missing required key ${k}`)
  }
  const unknown = new Map<bigint, FrankValue>()
  for (const [k, val] of v) {
    const n = k <= BigInt(U32_MAX) ? Number(k) : -1
    if (required.includes(n) || optional.includes(n)) continue
    if (open && allowUnknown) unknown.set(k, val)
    else throw bad(path, `undeclared key ${k} (C12)`)
  }
  return { get: k => v.get(BigInt(k)), has: k => v.has(BigInt(k)), unknown }
}

function account(v: FrankValue | undefined, path: string): AccountRef {
  const m = fields(v, path, [0, 1], [], false, false)
  const keyType = u32ish(m.get(0), `${path}.0`, 0, 65535)
  const keyBytes = bstr(m.get(1), `${path}.1`, 1, 128)
  const expected = KEY_LENGTHS.get(keyType)
  if (expected !== undefined && keyBytes.length !== expected) {
    throw bad(
      `${path}.1`,
      `key type ${keyType} requires ${expected} key bytes (S2)`,
    )
  }
  return { keyType, keyBytes }
}

function directoryAccount(
  v: FrankValue | undefined,
  path: string,
  preview: boolean,
): AccountRef {
  const key = account(v, path)
  if (preview && key.keyType !== 1)
    throw bad(path, 'directory preview key type must be 1')
  return key
}

/** A type-5 stamp point (T3b encoding rules): 33 compressed bytes on the curve. */
function point(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 33, 33)
  if (!isCompressedPoint(b))
    throw bad(path, 'not a valid compressed secp256k1 point (T3b)')
  return b
}

/** The type-5 DLEQ proof `c || s` (T3b encoding rules): 64 bytes, both scalars in 1..n-1. */
function proof(v: FrankValue | undefined, path: string): Uint8Array {
  const b = bstr(v, path, 64, 64)
  if (!isProofEncoding(b)) throw bad(path, 'proof scalar outside 1..n-1 (T3b)')
  return b
}

function timestamp(v: FrankValue | undefined, path: string): Timestamp {
  const m = fields(v, path, [0, 1], [], false, false)
  const seconds = m.get(0)
  if (typeof seconds !== 'bigint' || seconds < I64_MIN || seconds > I64_MAX) {
    throw bad(`${path}.0`, 'seconds must be an i64')
  }
  return { seconds, nanoseconds: u32ish(m.get(1), `${path}.1`, 0, 999999999) }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.1
// ---------------------------------------------------------------------------------------------

/** Root frame length limits of R2 and R3. Only a root frame is charged. */
export function checkRootFrameLimit(
  typeId: number,
  frameLength: number,
  schemaVersion = 1,
): boolean {
  if (typeId === TYPE_BLACKJACK_MESSAGE_ITEM)
    return frameLength <= MAX_BLACKJACK_FRAME_BYTES
  if (typeId === TYPE_CHANNEL_UPDATE)
    return frameLength <= MAX_CHANNEL_UPDATE_FRAME_BYTES
  if (typeId === TYPE_FORWARDING_DELIVERY_ENVELOPE)
    return frameLength <= MAX_FORWARDING_DELIVERY_FRAME_BYTES
  if (typeId === TYPE_DIRECTORY_STATEMENT && schemaVersion >= 4)
    return frameLength <= 262_144
  if (typeId === TYPE_DIRECT_MESSAGE_DELIVERY) return frameLength <= 1_048_576
  if (typeId === TYPE_DIRECTORY_ATTESTATION) return frameLength <= 262_144
  if (typeId === TYPE_TOPIC_POST || typeId === TYPE_TOPIC_POST_SUBMISSION)
    return frameLength <= MAX_TOPIC_FRAME_BYTES
  if (typeId === TYPE_TOPIC_VOTE_SUBMISSION)
    return frameLength <= MAX_TOPIC_VOTE_FRAME_BYTES
  if (typeId === TYPE_FORUM_VIEW || typeId === TYPE_FORUM_OPERATION_STATUS)
    return frameLength <= MAX_FORUM_VIEW_BYTES
  if (typeId === TYPE_FORUM_TOPIC_PAGE || typeId === TYPE_FORUM_DISCOVERY_PAGE)
    return frameLength <= MAX_FORUM_PAGE_BYTES
  return frameLength <= MAX_FRAME_BYTES
}

function tooMany(v: FrankValue | undefined, limit: number): boolean {
  return Array.isArray(v) && v.length > limit
}

/** Closed schema-1 shapes, also closed when projected from a compatible future envelope. */
function blackjackPayload(payload: FrankValue): BlackjackMessageItem {
  const P = 'root/payload'
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  const action = u32ish(payload.get(1n), `${P}.1`, 0, 6)
  const card = (v: FrankValue | undefined, path: string) =>
    u32ish(v, path, 0, 51)
  const hand = (
    v: FrankValue | undefined,
    key: number,
    min: number,
    max: number,
  ) =>
    asList(v, `${P}.${key}`, min, max).map((c, i) =>
      card(c, `${P}.${key}[${i}]`),
    )
  const read = (required: number[], optional: number[] = []) => {
    const m = fields(payload, P, [0, 1, ...required], optional, false, false)
    return {
      m,
      base: { type: 18 as const, gameId: tstr(m.get(0), `${P}.0`, 1, 128) },
    }
  }
  switch (action) {
    case 0: {
      const { m, base } = read([2])
      return {
        ...base,
        action: 'bet',
        wagerTxHash: bstr(m.get(2), `${P}.2`, 32, 32),
      }
    }
    case 1: {
      const { m, base } = read([4, 5, 6])
      return {
        ...base,
        action: 'deal',
        serverSeedHash: bstr(m.get(4), `${P}.4`, 32, 32),
        playerCards: hand(m.get(5), 5, 2, 2),
        dealerUpCard: card(m.get(6), `${P}.6`),
      }
    }
    case 2: {
      const { m, base } = read([], [5])
      return m.has(5)
        ? { ...base, action: 'hit', playerCards: hand(m.get(5), 5, 3, 52) }
        : { ...base, action: 'hit' }
    }
    case 3:
      return { ...read([]).base, action: 'stand' }
    case 4: {
      if (payload.has(3n) === payload.has(5n))
        throw bad(P, 'double requires exactly one request/response form')
      const { m, base } = read(payload.has(3n) ? [3] : [5])
      return m.has(3)
        ? {
            ...base,
            action: 'double',
            doubleWagerTxHash: bstr(m.get(3), `${P}.3`, 32, 32),
          }
        : { ...base, action: 'double', playerCards: hand(m.get(5), 5, 3, 3) }
    }
    case 5: {
      const { m, base } = read([7, 8, 9])
      const seed = tstr(m.get(8), `${P}.8`, 64, 64)
      if (seed.length !== 64 || !/^[0-9a-f]+$/.test(seed))
        throw bad(`${P}.8`, 'seed must be 64 lowercase ASCII hex characters')
      const outcome = [
        'player_win',
        'dealer_win',
        'push',
        'player_blackjack',
      ] as const
      return {
        ...base,
        action: 'reveal',
        dealerCards: hand(m.get(7), 7, 2, 52),
        serverSeed: seed,
        outcome: outcome[u32ish(m.get(9), `${P}.9`, 0, 3)],
      }
    }
    default: {
      const { m, base } = read([10, 11], [12, 13])
      const result: BlackjackMessageItem = {
        ...base,
        action: 'welcome',
        minWagerWei: bstr(m.get(10), `${P}.10`, 32, 32),
        maxWagerWei: bstr(m.get(11), `${P}.11`, 32, 32),
      }
      if (m.has(12)) result.feeHintWei = bstr(m.get(12), `${P}.12`, 32, 32)
      if (m.has(13)) {
        result.rules = tstr(m.get(13), `${P}.13`, 0, 1200)
        if (result.rules.length > 400)
          throw bad(`${P}.13`, 'rules exceed 400 UTF-16 units')
      }
      return result
    }
  }
}

/** Closed schema-2 shapes: one peer-to-peer hand. No shape carries an amount of money. */
function blackjackHandPayload(payload: FrankValue): BlackjackHandMessageItem {
  const P = 'root/payload'
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  // Codes 16..25: disjoint from schema 1's 0..6, so no reader can take one for the other.
  const action = u32ish(payload.get(1n), `${P}.1`, 16, 25) - 16
  const hand = (
    v: FrankValue | undefined,
    key: number,
    min: number,
    max: number,
  ) =>
    asList(v, `${P}.${key}`, min, max).map((c, i) =>
      u32ish(c, `${P}.${key}[${i}]`, 0, 51),
    )
  const read = (required: number[]) => {
    const m = fields(payload, P, [0, 1, ...required], [], false, false)
    // Fixed form, so a game id is always safe to use as a key: 32 lowercase hex characters.
    const gameId = tstr(m.get(0), `${P}.0`, 32, 32)
    if (!/^[0-9a-f]{32}$/.test(gameId))
      throw bad(`${P}.0`, 'game id must be 32 lowercase ASCII hex characters')
    return {
      m,
      base: { type: 18 as const, schema: 2 as const, gameId },
    }
  }
  const hash = (m: MapView, key: number) =>
    bstr(m.get(key), `${P}.${key}`, 32, 32)
  switch (action) {
    case 0: {
      const dealer = u32ish(payload.get(2n), `${P}.2`, 0, 1) === 0
      const { m, base } = read(dealer ? [2, 3, 4] : [2, 3])
      return dealer
        ? {
            ...base,
            action: 'challenge',
            role: 'dealer',
            maxBetWei: hash(m, 3),
            commitment: hash(m, 4),
          }
        : {
            ...base,
            action: 'challenge',
            role: 'player',
            maxBetWei: hash(m, 3),
          }
    }
    case 1: {
      const { m, base } = read([3, 4])
      return {
        ...base,
        action: 'accept',
        maxBetWei: hash(m, 3),
        commitment: hash(m, 4),
      }
    }
    case 2:
      return { ...read([]).base, action: 'bet' }
    case 3: {
      const { m, base } = read([5, 6])
      return {
        ...base,
        action: 'deal',
        playerCards: hand(m.get(5), 5, 2, 2),
        dealerUpCard: u32ish(m.get(6), `${P}.6`, 0, 51),
      }
    }
    case 4:
      return { ...read([]).base, action: 'hit' }
    case 5:
      return { ...read([]).base, action: 'stand' }
    case 6:
      return { ...read([]).base, action: 'double' }
    case 7: {
      const { m, base } = read([5])
      return { ...base, action: 'card', playerCards: hand(m.get(5), 5, 3, 52) }
    }
    case 8: {
      const { m, base } = read([7, 8, 9])
      const seed = tstr(m.get(8), `${P}.8`, 64, 64)
      if (seed.length !== 64 || !/^[0-9a-f]+$/.test(seed))
        throw bad(`${P}.8`, 'seed must be 64 lowercase ASCII hex characters')
      const outcome = [
        'player_win',
        'dealer_win',
        'push',
        'player_blackjack',
      ] as const
      return {
        ...base,
        action: 'reveal',
        dealerCards: hand(m.get(7), 7, 2, 52),
        seed,
        outcome: outcome[u32ish(m.get(9), `${P}.9`, 0, 3)],
      }
    }
    default: {
      const { m, base } = read([10])
      return { ...base, action: 'refund', ref: hash(m, 10) }
    }
  }
}

/** Closed schema-3 shapes: a hand whose cards come from both sides' entropy. No shape states a
 * card, an outcome or an amount of money. */
function blackjackHandV3Payload(
  payload: FrankValue,
): BlackjackHandV3MessageItem {
  const P = 'root/payload'
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  // Codes 32..41: disjoint from schema 1's 0..6 and schema 2's 16..25.
  const action = u32ish(payload.get(1n), `${P}.1`, 32, 41) - 32
  const read = (required: number[]) => {
    const m = fields(payload, P, [0, 1, 11, ...required], [], false, false)
    const gameId = tstr(m.get(0), `${P}.0`, 32, 32)
    if (!/^[0-9a-f]{32}$/.test(gameId))
      throw bad(`${P}.0`, 'game id must be 32 lowercase ASCII hex characters')
    // A challenge is message 0 of its hand; every other message follows one.
    const seq =
      action === 0
        ? u32ish(m.get(11), `${P}.11`, 0, 0)
        : u32ish(m.get(11), `${P}.11`, 1, 255)
    return { m, base: { type: 18 as const, schema: 3 as const, gameId, seq } }
  }
  const hash = (m: MapView, key: number) =>
    bstr(m.get(key), `${P}.${key}`, 32, 32)
  switch (action) {
    case 0: {
      const dealer = u32ish(payload.get(2n), `${P}.2`, 0, 1) === 0
      const { m, base } = read(dealer ? [2, 3, 4] : [2, 3])
      return dealer
        ? {
            ...base,
            action: 'challenge',
            role: 'dealer',
            maxBetWei: hash(m, 3),
            commitment: hash(m, 4),
          }
        : {
            ...base,
            action: 'challenge',
            role: 'player',
            maxBetWei: hash(m, 3),
          }
    }
    case 1: {
      const { m, base } = read([3, 4, 12])
      return {
        ...base,
        action: 'accept',
        maxBetWei: hash(m, 3),
        commitment: hash(m, 4),
        prev: hash(m, 12),
      }
    }
    case 2: {
      const { m, base } = read([4, 12])
      return {
        ...base,
        action: 'bet',
        commitment: hash(m, 4),
        prev: hash(m, 12),
      }
    }
    case 9: {
      const { m, base } = read([10, 12])
      return { ...base, action: 'refund', ref: hash(m, 10), prev: hash(m, 12) }
    }
    default: {
      const { m, base } = read([12, 13])
      const names = [
        'deal',
        'hit',
        'stand',
        'double',
        'card',
        'reveal',
      ] as const
      return {
        ...base,
        action: names[action - 3],
        link: hash(m, 13),
        prev: hash(m, 12),
      }
    }
  }
}

/** Reads R2-R4 counts from the decoded fields, before typed conversion. */
export function checkTypeLimits(
  typeId: number,
  payload: FrankValue,
  schemaVersion = 1,
): void {
  if (!isMap(payload)) return
  const over = (what: string): never => {
    throw fail(
      'resource',
      '8.1',
      'root/payload',
      `${what} exceeds its limit (R2-R4)`,
    )
  }
  const f = (k: number) => payload.get(BigInt(k))
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY:
    case TYPE_FORWARDING_DELIVERY_ENVELOPE:
      if (tooMany(f(4), MAX_PAYMENT_MEMBERS)) over('payment members')
      break
    case TYPE_DIRECTORY_ATTESTATION:
      if (tooMany(f(1), MAX_SIGNATURES)) over('signatures')
      break
    case TYPE_MAILBOX_CHECKPOINT:
      if (tooMany(f(4), MAX_JOURNAL_FACTS)) over('journal facts')
      if (tooMany(f(5), MAX_OPAQUE_SECTIONS)) over('opaque sections')
      break
    case TYPE_DIRECTORY_STATEMENT:
      if (tooMany(f(4), MAX_RELAY_BINDINGS)) over('relay bindings')
      break
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      if (schemaVersion >= 2) {
        const e = f(4)
        if (
          e instanceof Uint8Array &&
          e.length > MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES
        )
          over('crypto-box envelope')
      } else {
        const c = f(5)
        if (c instanceof Uint8Array && c.length > MAX_CIPHERTEXT_BYTES)
          over('ciphertext')
      }
      break
    }
    case TYPE_TOPIC_POST: {
      const b = f(3)
      if (b instanceof Uint8Array && b.length > MAX_TOPIC_BODY_BYTES)
        over('topic body')
      break
    }
    case TYPE_FORUM_TOPIC_PAGE:
    case TYPE_FORUM_DISCOVERY_PAGE:
      if (tooMany(f(typeId === TYPE_FORUM_TOPIC_PAGE ? 4 : 2), MAX_FORUM_ROWS))
        over('Forum rows')
      for (const key of typeId === TYPE_FORUM_TOPIC_PAGE ? [5, 7] : [3, 5]) {
        const cursor = f(key)
        if (
          cursor instanceof Uint8Array &&
          cursor.length > MAX_FORUM_CURSOR_BYTES
        )
          over('Forum cursor')
      }
      break
    case TYPE_MESSAGE_CONTENT_REVISION:
      if (tooMany(f(1), MAX_MESSAGE_ITEMS_PER_ARRAY)) over('message items')
      break
    case TYPE_CONTAINER_MESSAGE_ITEM:
      if (tooMany(f(0), MAX_MESSAGE_ITEMS_PER_ARRAY)) over('message items')
      break
    case TYPE_CHANNEL_UPDATE: {
      const appState = f(4)
      if (
        appState instanceof Uint8Array &&
        appState.length > MAX_CHANNEL_APP_STATE_BYTES
      )
        over('app state')
      if (tooMany(f(3), MAX_CHANNEL_ALLOCATIONS)) over('chain allocations')
      if (tooMany(f(5), MAX_CHANNEL_SIGNATURES)) over('channel signatures')
      break
    }
    default:
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.2
// ---------------------------------------------------------------------------------------------

const framed = (v: FrankValue | undefined, path: string): Uint8Array =>
  bstr(v, path, 9, MAX_FRAME_BYTES)

function paymentMember(v: FrankValue | undefined, path: string): PaymentMember {
  const m = fields(v, path, [0, 1, 2, 3, 4], [5], false, false)
  const rawVal = m.get(2)
  let value: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    value = bstr(rawVal, `${path}.2`, 32, 32)
  } else if (typeof rawVal === 'bigint') {
    value = uintRange(rawVal, `${path}.2`, 0n, 0xffffffffffffffffn)
  } else {
    throw bad(`${path}.2`, 'expected a 32-byte string or an unsigned integer')
  }
  return {
    childIndex: u32ish(m.get(0), `${path}.0`, 0, 2147483647),
    transactionId: bstr(m.get(1), `${path}.1`, 1, 128),
    value,
    address: bstr(m.get(3), `${path}.3`, 1, 128),
    commitment: bstr(m.get(4), `${path}.4`, 32, 32),
    vout: m.has(5) ? u32ish(m.get(5), `${path}.5`, 0, 4294967295) : undefined,
  }
}

export function stealthMetadata(
  v: FrankValue | undefined,
  path = 'stealth-metadata',
): StealthMetadata {
  const m = fields(v, path, [0], [1], false, false)
  let viewTag: number | Uint8Array | undefined
  if (m.has(1)) {
    const rawTag = m.get(1)
    if (typeof rawTag === 'bigint') {
      viewTag = u32ish(rawTag, `${path}.1`, 0, 65535)
    } else if (rawTag instanceof Uint8Array) {
      viewTag = bstr(rawTag, `${path}.1`, 1, 32)
    } else {
      throw bad(`${path}.1`, 'expected an unsigned integer or a byte string')
    }
  }
  return {
    ephemeralPubKey: account(m.get(0), `${path}.0`),
    ...(viewTag !== undefined ? { viewTag } : {}),
  }
}

export function paymentTransfer(
  v: FrankValue | undefined,
  path = 'payment-transfer',
): PaymentTransfer {
  const m = fields(v, path, [0, 1, 3, 4], [2, 5, 6, 7], false, false)
  const rawVal = m.get(4)
  let value: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    value = bstr(rawVal, `${path}.4`, 32, 32)
  } else if (typeof rawVal === 'bigint') {
    value = uintRange(rawVal, `${path}.4`, 0n, U64_MAX)
  } else {
    throw bad(`${path}.4`, 'expected a 32-byte string or an unsigned integer')
  }

  return {
    networkTag: tstr(m.get(0), `${path}.0`, 1, 64),
    txId: bstr(m.get(1), `${path}.1`, 1, 128),
    vout: m.has(2) ? u32ish(m.get(2), `${path}.2`, 0, 4294967295) : undefined,
    destination: bstr(m.get(3), `${path}.3`, 1, 128),
    value,
    token: m.has(5) ? bstr(m.get(5), `${path}.5`, 1, 128) : undefined,
    stealthMetadata: m.has(6)
      ? stealthMetadata(m.get(6), `${path}.6`)
      : undefined,
    commitment: m.has(7) ? bstr(m.get(7), `${path}.7`, 32, 32) : undefined,
  }
}

function signatureEntry(
  v: FrankValue | undefined,
  path: string,
): SignatureEntry {
  const m = fields(v, path, [0, 1, 2], [], false, false)
  return {
    algorithm: u32ish(m.get(0), `${path}.0`, 0, 65535),
    signer: account(m.get(1), `${path}.1`),
    signature: bstr(m.get(2), `${path}.2`, 1, 512),
  }
}

function participantBalance(
  v: FrankValue | undefined,
  path: string,
): ParticipantBalance {
  const m = fields(v, path, [0, 1], [], false, false)
  const rawVal = m.get(1)
  let balance: Uint8Array | bigint
  if (rawVal instanceof Uint8Array) {
    balance = bstr(rawVal, `${path}.1`, 32, 32)
  } else if (typeof rawVal === 'bigint') {
    balance = uintRange(rawVal, `${path}.1`, 0n, U64_MAX)
  } else {
    throw bad(`${path}.1`, 'expected a 32-byte string or an unsigned integer')
  }
  return {
    participant: account(m.get(0), `${path}.0`),
    balance,
  }
}

function chainAllocation(
  v: FrankValue | undefined,
  path: string,
): ChainAllocation {
  const m = fields(v, path, [0, 1, 2], [], false, false)
  return {
    networkTag: networkTag(m.get(0), `${path}.0`),
    token: bstr(m.get(1), `${path}.1`, 0, 128),
    balances: asList(m.get(2), `${path}.2`, 2, 16).map((b, i) =>
      participantBalance(b, `${path}.2[${i}]`),
    ),
  }
}

function relayBinding(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
  preview = false,
): RelayBinding {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    relayId: bstr(m.get(0), `${path}.0`, 16, 64),
    endpoint: endpoint(m.get(1), `${path}.1`),
    identity: directoryAccount(m.get(2), `${path}.2`, preview),
    expiry: timestamp(m.get(3), `${path}.3`),
    unknownFields: m.unknown,
  }
}

function keyTransition(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): KeyTransition<Uint8Array> {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    statementFrame: framed(m.get(0), `${path}.0`),
    algorithm: u32ish(m.get(1), `${path}.1`, 0, 65535),
    signer: account(m.get(2), `${path}.2`),
    signature: bstr(m.get(3), `${path}.3`, 1, 512),
    unknownFields: m.unknown,
  }
}

function journalFact(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): JournalFact {
  const m = fields(v, path, [0, 1, 2, 3], [], true, allow)
  return {
    timestamp: timestamp(m.get(0), `${path}.0`),
    factId: bstr(m.get(1), `${path}.1`, 16, 16),
    kind: u32ish(m.get(2), `${path}.2`, 0, 65535),
    payload: bstr(m.get(3), `${path}.3`, 0, 8_388_608),
    unknownFields: m.unknown,
  }
}

function opaqueSection(v: FrankValue | undefined, path: string): OpaqueSection {
  const m = fields(v, path, [0, 1, 2], [], false, false)
  return {
    sectionType: u32ish(m.get(0), `${path}.0`, 0, U32_MAX),
    sectionSchemaVersion: u32ish(m.get(1), `${path}.1`, 1, U32_MAX),
    value: bstr(m.get(2), `${path}.2`, 0, 8_388_608),
  }
}

function profileHeader(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): ProfileHeader {
  const m = fields(v, path, [0, 1], [], true, allow)
  return {
    name: tstr(m.get(0), `${path}.0`, 0, MAX_TEXT_STRING_BYTES),
    value: tstr(m.get(1), `${path}.1`, 0, MAX_TEXT_STRING_BYTES),
    unknownFields: m.unknown,
  }
}

function profileEntry(
  v: FrankValue | undefined,
  path: string,
  allow: boolean,
): ProfileEntry {
  const m = fields(v, path, [0, 1, 2], [], true, allow)
  const headers = asList(m.get(1), `${path}.1`, 0, 64)
  return {
    kind: tstr(m.get(0), `${path}.0`, 0, MAX_TEXT_STRING_BYTES),
    headers: headers.map((e, i) => profileHeader(e, `${path}.1[${i}]`, allow)),
    body: bstr(m.get(2), `${path}.2`, 0, 8_388_608),
    unknownFields: m.unknown,
  }
}

/**
 * Stage 8.2: converts a generic payload to the typed draft of `typeId`, applying the CDDL
 * structure and range rules. Framed fields stay raw bytes until stage 8.4 opens them.
 */
export function parseForumContent(
  value: FrankValue,
  allow: boolean,
  path: string,
): ForumContent {
  if (value instanceof Map && tooMany(value.get(1n), MAX_FORUM_ENTRIES))
    throw fail('resource', '8.1', path, 'Forum content exceeds 64 entries')
  const m = fields(value, path, [0, 1], [], true, allow)
  return {
    authored: timestamp(m.get(0), `${path}.0`),
    unknownFields: m.unknown,
    entries: asList(m.get(1), `${path}.1`, 1, MAX_FORUM_ENTRIES).map(
      (entry, i) => {
        const p = `${path}.1[${i}]`
        if (!(entry instanceof Map)) throw bad(p, 'expected entry map')
        const kind = uintRange(entry.get(0n), `${p}.0`, 0n, U64_MAX)
        if (kind !== 1n) {
          if (!allow) throw bad(p, 'unallocated Forum entry kind')
          return {
            kind: 'unsupported' as const,
            kindId: kind,
            placeholder: 'Unsupported content' as const,
            fields: entry,
          }
        }
        const e = fields(entry, p, [0], [1, 2, 3], true, allow)
        return {
          kind: 'post' as const,
          ...(e.has(1)
            ? { title: tstr(e.get(1), `${p}.1`, 0, MAX_TEXT_STRING_BYTES) }
            : {}),
          ...(e.has(2)
            ? { url: tstr(e.get(2), `${p}.2`, 0, MAX_TEXT_STRING_BYTES) }
            : {}),
          ...(e.has(3)
            ? { message: tstr(e.get(3), `${p}.3`, 0, MAX_TEXT_STRING_BYTES) }
            : {}),
          unknownFields: e.unknown,
        }
      },
    ),
  }
}

function forumAggregate(
  value: FrankValue | undefined,
  path: string,
): ForumAggregate {
  const m = fields(value, path, [0, 1], [], false, false)
  const negative = m.get(0),
    magnitude = bstr(m.get(1), `${path}.1`, 32, 32)
  if (typeof negative !== 'boolean')
    throw bad(`${path}.0`, 'expected boolean sign')
  if (negative && magnitude.every(b => b === 0))
    throw bad(path, 'negative zero')
  return { negative, magnitude }
}

/** The cursor item has already passed canonical decoding with its enclosing counters. */
export function parseForumCursor(
  value: FrankValue,
  bytes: Uint8Array,
  path: string,
): ForumCursor {
  if (!(value instanceof Map)) throw bad(path, 'expected cursor map')
  const family = u32ish(value.get(1n), `${path}.1`, 13, 14)
  const m = fields(
    value,
    path,
    family === 13 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 7],
    [],
    false,
    false,
  )
  const common = {
    bytes,
    network: networkTag(m.get(0), `${path}.0`),
    revision: uintRange(m.get(2), `${path}.2`, 0n, U64_MAX),
    epoch: bstr(m.get(3), `${path}.3`, 16, 16),
    incarnation: uintRange(m.get(7), `${path}.7`, 0n, U64_MAX),
  }
  if (family === 14)
    return { ...common, family, last: tstr(m.get(4), `${path}.4`, 1, 512) }
  const last = fields(m.get(4), `${path}.4`, [0, 1], [], false, false)
  return {
    ...common,
    family: 13,
    topic: tstr(m.get(5), `${path}.5`, 1, 512),
    since: timestamp(m.get(6), `${path}.6`),
    last: {
      timestamp: timestamp(last.get(0), `${path}.4.0`),
      hash: bstr(last.get(1), `${path}.4.1`, 32, 32),
    },
  }
}

export function parseDraft(
  typeId: number,
  payload: FrankValue,
  allow: boolean,
  schema: { envelope: number; effective: number; minReader?: number } = {
    envelope: 1,
    effective: 1,
  },
): DraftPayload {
  const P = 'root/payload'
  switch (typeId) {
    case TYPE_DIRECT_MESSAGE_DELIVERY: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [5, 6], true, allow)
      const res: DirectMessageDelivery<Uint8Array> = {
        type: 1,
        network: networkTag(m.get(0), `${P}.0`),
        destination: account(m.get(1), `${P}.1`),
        payloadFrame: framed(m.get(2), `${P}.2`),
        payloadDigest: bstr(m.get(3), `${P}.3`, 32, 32),
        payments: asList(m.get(4), `${P}.4`, 1, MAX_PAYMENT_MEMBERS).map(
          (e, i) => paymentMember(e, `${P}.4[${i}]`),
        ),
        unknownFields: m.unknown,
      }
      if (m.has(5)) {
        const recipient = account(m.get(5), `${P}.5`)
        if (recipient.keyType !== 1) {
          throw bad(`${P}.5`, 'recipient key type must be 1')
        }
        res.recipient = recipient
      }
      if (m.has(6)) {
        res.dleqProof = proof(m.get(6), `${P}.6`)
      }
      return res
    }
    case TYPE_DIRECTORY_ATTESTATION: {
      const m = fields(payload, P, [0, 1], [], true, allow)
      return {
        type: 2,
        statementFrame: framed(m.get(0), `${P}.0`),
        signatures: asList(m.get(1), `${P}.1`, 1, MAX_SIGNATURES).map((e, i) =>
          signatureEntry(e, `${P}.1[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MAILBOX_CHECKPOINT: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [5], true, allow)
      const cp: DraftPayload = {
        type: 3,
        network: networkTag(m.get(0), `${P}.0`),
        owner: account(m.get(1), `${P}.1`),
        checkpointId: bstr(m.get(2), `${P}.2`, 16, 16),
        timestamp: timestamp(m.get(3), `${P}.3`),
        facts: asList(m.get(4), `${P}.4`, 0, MAX_JOURNAL_FACTS).map((e, i) =>
          journalFact(e, `${P}.4[${i}]`, allow),
        ),
        unknownFields: m.unknown,
      }
      if (m.has(5)) {
        cp.sections = asList(m.get(5), `${P}.5`, 0, MAX_OPAQUE_SECTIONS).map(
          (e, i) => opaqueSection(e, `${P}.5[${i}]`),
        )
      }
      return cp
    }
    case TYPE_DIRECTORY_STATEMENT: {
      // Fields 5-7 are optional at every schema; field 8 (the stamp key) is required from
      // schema 2 and undefined in schema 1, where C12 makes it a schema error (S10a.1); field
      // 9 (the profile entries, M4) is optional from schema 3, where a schema-2 reader reads
      // the statement through V6.3 and retains it. `effective` is the exact version, or the
      // reader's highest supported schema when a newer frame is read through V6.3.
      const preview = schema.effective >= 4
      const optional = preview
        ? [14]
        : schema.effective >= 3
        ? [5, 6, 7, 9, 14]
        : [5, 6, 7, 14]
      const m = fields(
        payload,
        P,
        preview
          ? [0, 1, 2, 3, 4, 6, 8, 10, 11, 12, 13]
          : schema.effective >= 2
          ? [0, 1, 2, 3, 4, 8]
          : [0, 1, 2, 3, 4],
        optional,
        true,
        allow,
      )
      // These allocated old meanings remain unsupported even in a future V6 projection.
      if (preview && [5, 7, 9].some(k => m.has(k)))
        throw bad(
          P,
          'transitions, recovery and profiles are unsupported in directory preview',
        )
      const st: DraftPayload = {
        type: 4,
        network: networkTag(m.get(0), `${P}.0`),
        subject: directoryAccount(m.get(1), `${P}.1`, preview),
        revision: uintRange(m.get(2), `${P}.2`, 0n, U64_MAX),
        timestamp: timestamp(m.get(3), `${P}.3`),
        relays: asList(
          m.get(4),
          `${P}.4`,
          1,
          preview ? 1 : MAX_RELAY_BINDINGS,
        ).map((e, i) => relayBinding(e, `${P}.4[${i}]`, allow, preview)),
        schemaVersion: schema.envelope,
        unknownFields: m.unknown,
      }
      if (m.has(8)) st.stampKey = directoryAccount(m.get(8), `${P}.8`, preview)
      if (preview) {
        st.preview = {
          messageDhKey: directoryAccount(m.get(10), `${P}.10`, true),
          mailboxKeyGeneration: uintRange(m.get(11), `${P}.11`, 0n, U64_MAX),
          stampKeyGeneration: uintRange(m.get(12), `${P}.12`, 0n, U64_MAX),
          predecessor:
            m.get(13) === null ? null : bstr(m.get(13), `${P}.13`, 32, 32),
        }
      }
      // Field 9 is interpreted only by a reader whose highest type-4 schema is 3; a schema-2
      // reader projects the statement through V6.3 and retains it as an unknown field.
      if (m.has(9) && schema.effective >= 3) {
        st.profileEntries = asList(m.get(9), `${P}.9`, 1, 64).map((e, i) =>
          profileEntry(e, `${P}.9[${i}]`, allow),
        )
      }
      if (m.has(14)) {
        st.spendKeys = asList(m.get(14), `${P}.14`, 1, 8).map((e, i) =>
          account(e, `${P}.14[${i}]`),
        )
      }
      if (m.has(5)) {
        st.keyTransitions = asList(m.get(5), `${P}.5`, 1, 16).map((e, i) =>
          keyTransition(e, `${P}.5[${i}]`, allow),
        )
      }
      if (m.has(6)) st.expiry = timestamp(m.get(6), `${P}.6`)
      if (m.has(7)) {
        st.recoveryAuthorities = asList(m.get(7), `${P}.7`, 1, 8).map((e, i) =>
          account(e, `${P}.7[${i}]`),
        )
      }
      return st
    }
    case TYPE_RECIPIENT_ENCRYPTED_PAYLOAD: {
      if (schema.effective >= 2) {
        const m = fields(payload, P, [0, 1, 2, 3, 4, 5, 6, 7], [], true, allow)
        return {
          type: 5,
          schemaVersion: 2,
          network: networkTag(m.get(0), `${P}.0`),
          sender: account(m.get(1), `${P}.1`),
          recipient: account(m.get(2), `${P}.2`),
          suite: u32ish(m.get(3), `${P}.3`, 0, 65535),
          cryptoBoxEnvelope: bstr(
            m.get(4),
            `${P}.4`,
            1,
            MAX_DM_CRYPTO_BOX_ENVELOPE_BYTES,
          ),
          ephemeralPoint: point(m.get(5), `${P}.5`),
          sharedPoint: point(m.get(6), `${P}.6`),
          dleqProof: proof(m.get(7), `${P}.7`),
          unknownFields: m.unknown,
        }
      }
      const m = fields(payload, P, [0, 1, 2, 3, 4, 5, 6, 7, 8], [], true, allow)
      return {
        type: 5,
        schemaVersion: 1,
        network: networkTag(m.get(0), `${P}.0`),
        sender: account(m.get(1), `${P}.1`),
        recipient: account(m.get(2), `${P}.2`),
        suite: u32ish(m.get(3), `${P}.3`, 0, 65535),
        nonce: bstr(m.get(4), `${P}.4`, 1, 64),
        ciphertext: bstr(m.get(5), `${P}.5`, 1, MAX_CIPHERTEXT_BYTES),
        ephemeralPoint: point(m.get(6), `${P}.6`),
        sharedPoint: point(m.get(7), `${P}.7`),
        dleqProof: proof(m.get(8), `${P}.8`),
        unknownFields: m.unknown,
      }
    }
    case TYPE_ENCRYPTED_MESSAGE_CONTENT: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [5], true, allow)
      const convName = m.has(5)
        ? conversationName(m.get(5), `${P}.5`)
        : undefined
      return {
        type: 6,
        network: networkTag(m.get(0), `${P}.0`),
        messageId: bstr(m.get(1), `${P}.1`, 16, 16),
        revisionFrame: framed(m.get(2), `${P}.2`),
        contentDigest: bstr(m.get(3), `${P}.3`, 32, 32),
        conversationId: bstr(m.get(4), `${P}.4`, 16, 16),
        conversationName: convName,
        unknownFields: m.unknown,
      }
    }
    case TYPE_KEY_TRANSITION_STATEMENT: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [], true, allow)
      return {
        type: 7,
        network: networkTag(m.get(0), `${P}.0`),
        subject: account(m.get(1), `${P}.1`),
        priorAuthority: account(m.get(2), `${P}.2`),
        revision: uintRange(m.get(3), `${P}.3`, 1n, U64_MAX),
        newKey: account(m.get(4), `${P}.4`),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_POST: {
      const m = fields(payload, P, [0, 1, 3], [2], true, allow)
      const body = bstr(m.get(3), `${P}.3`, 1, MAX_TOPIC_BODY_BYTES)
      const post: TopicPost<Uint8Array> = {
        type: 9,
        network: networkTag(m.get(0), `${P}.0`),
        topic: tstr(m.get(1), `${P}.1`, 1, 512),
        body,
        ...(schema.effective >= 2
          ? { schemaVersion: 2 as const, content: body }
          : { schemaVersion: 1 as const }),
        unknownFields: m.unknown,
      }
      if (m.has(2)) post.parentHash = bstr(m.get(2), `${P}.2`, 32, 32)
      return post
    }
    case TYPE_FORUM_VIEW: {
      const m = fields(
        payload,
        P,
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [],
        true,
        allow,
      )
      return {
        type: 12,
        network: networkTag(m.get(0), `${P}.0`),
        postFrame: framed(m.get(1), `${P}.1`),
        author: bstr(m.get(2), `${P}.2`, 20, 20),
        authorBurnTx: bstr(m.get(3), `${P}.3`, 1, 16384),
        transactionHash: bstr(m.get(4), `${P}.4`, 32, 32),
        firstVisible: timestamp(m.get(5), `${P}.5`),
        block: uintRange(m.get(6), `${P}.6`, 0n, U64_MAX),
        transactionIndex: uintRange(m.get(7), `${P}.7`, 0n, U64_MAX),
        aggregate: forumAggregate(m.get(8), `${P}.8`),
        revision: uintRange(m.get(9), `${P}.9`, 0n, U64_MAX),
        epoch: bstr(m.get(10), `${P}.10`, 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_TOPIC_PAGE: {
      const m = fields(payload, P, [0, 1, 2, 3, 4, 6], [5, 7], true, allow)
      return {
        type: 13,
        network: networkTag(m.get(0), `${P}.0`),
        topic: tstr(m.get(1), `${P}.1`, 1, 512),
        since: timestamp(m.get(2), `${P}.2`),
        revision: uintRange(m.get(3), `${P}.3`, 0n, U64_MAX),
        rows: asList(m.get(4), `${P}.4`, 0, MAX_FORUM_ROWS).map((row, i) =>
          framed(row, `${P}.4[${i}]`),
        ),
        nextCursor: m.has(5)
          ? bstr(m.get(5), `${P}.5`, 1, MAX_FORUM_CURSOR_BYTES)
          : undefined,
        requestCursor: m.has(7)
          ? bstr(m.get(7), `${P}.7`, 1, MAX_FORUM_CURSOR_BYTES)
          : undefined,
        epoch: bstr(m.get(6), `${P}.6`, 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_DISCOVERY_PAGE: {
      const m = fields(payload, P, [0, 1, 2, 4], [3, 5], true, allow)
      return {
        type: 14,
        network: networkTag(m.get(0), `${P}.0`),
        revision: uintRange(m.get(1), `${P}.1`, 0n, U64_MAX),
        entries: asList(m.get(2), `${P}.2`, 0, MAX_FORUM_ROWS).map((row, i) => {
          const path = `${P}.2[${i}]`,
            r = fields(row, path, [0, 1, 2], [], true, allow)
          return {
            topic: tstr(r.get(0), `${path}.0`, 1, 512),
            count: uintRange(r.get(1), `${path}.1`, 0n, U64_MAX),
            lastActivity: timestamp(r.get(2), `${path}.2`),
            unknownFields: r.unknown,
          }
        }),
        nextCursor: m.has(3)
          ? bstr(m.get(3), `${P}.3`, 1, MAX_FORUM_CURSOR_BYTES)
          : undefined,
        requestCursor: m.has(5)
          ? bstr(m.get(5), `${P}.5`, 1, MAX_FORUM_CURSOR_BYTES)
          : undefined,
        epoch: bstr(m.get(4), `${P}.4`, 16, 16),
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORUM_OPERATION_STATUS: {
      const m = fields(
        payload,
        P,
        [0, 1, 2, 3, 4, 5, 6, 7, 10, 11],
        [8, 9],
        true,
        allow,
      )
      const common = {
        type: 15 as const,
        network: networkTag(m.get(0), `${P}.0`),
        submittedFrame: framed(m.get(1), `${P}.1`),
        targetHash: bstr(m.get(2), `${P}.2`, 32, 32),
        transactionHash: bstr(m.get(3), `${P}.3`, 32, 32),
        sender: bstr(m.get(4), `${P}.4`, 20, 20),
        direction: u32ish(m.get(5), `${P}.5`, 0, 1) as 0 | 1,
        value: uintRange(m.get(6), `${P}.6`, 0n, U64_MAX),
        revision: uintRange(m.get(10), `${P}.10`, 0n, U64_MAX),
        epoch: bstr(m.get(11), `${P}.11`, 16, 16),
        unknownFields: m.unknown,
      }
      const state = u32ish(m.get(7), `${P}.7`, 0, 3)
      if (m.has(8) !== (state === 2) || m.has(9) !== (state === 2))
        throw bad(P, 'confirmation position iff confirmed')
      if (
        (state === 1 || state === 2) &&
        (common.value === 0n || common.value > I64_MAX)
      )
        throw bad(`${P}.6`, 'observed burn outside 1..i64::MAX')
      if (state === 2)
        return {
          ...common,
          state,
          evidence: 'relay-observed',
          block: uintRange(m.get(8), `${P}.8`, 0n, U64_MAX),
          transactionIndex: uintRange(m.get(9), `${P}.9`, 0n, U64_MAX),
        }
      if (state === 1) return { ...common, state, evidence: 'relay-observed' }
      return {
        ...common,
        state: state as 0 | 3,
        evidence: 'unverified-request',
      }
    }
    case TYPE_TOPIC_POST_SUBMISSION: {
      const m = fields(payload, P, [0, 1, 2], [], true, allow)
      return {
        type: 10,
        network: networkTag(m.get(0), `${P}.0`),
        postFrame: framed(m.get(1), `${P}.1`),
        burnTx: bstr(m.get(2), `${P}.2`, 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TOPIC_VOTE_SUBMISSION: {
      const m = fields(payload, P, [0, 1, 2], [], true, allow)
      return {
        type: 11,
        network: networkTag(m.get(0), `${P}.0`),
        targetHash: bstr(m.get(1), `${P}.1`, 32, 32),
        burnTx: bstr(m.get(2), `${P}.2`, 1, 16384),
        unknownFields: m.unknown,
      }
    }
    case TYPE_MESSAGE_CONTENT_REVISION: {
      const m = fields(payload, P, [0, 1], [], true, allow)
      if (m.get(0) !== 'frank')
        throw bad(`${P}.0`, 'the type-8 domain must be the text "frank"')
      return {
        type: 8,
        items: asList(m.get(1), `${P}.1`, 1, MAX_MESSAGE_ITEMS_PER_ARRAY).map(
          (e, i) => framed(e, `${P}.1[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_CONTAINER_MESSAGE_ITEM: {
      const m = fields(payload, P, [0], [], true, allow)
      return {
        type: 16,
        items: asList(m.get(0), `${P}.0`, 1, MAX_MESSAGE_ITEMS_PER_ARRAY).map(
          (e, i) => framed(e, `${P}.0[${i}]`),
        ),
        unknownFields: m.unknown,
      }
    }
    case TYPE_TEXT_MESSAGE_ITEM: {
      const m = fields(payload, P, [0], [], true, allow)
      return {
        type: 17,
        text: tstr(m.get(0), `${P}.0`, 0, 262144),
        unknownFields: m.unknown,
      }
    }
    case TYPE_BLACKJACK_MESSAGE_ITEM: {
      // Schema 2 adds the ten hand shapes to the schema-1 shapes. Their action codes (16..25)
      // are disjoint from schema 1's (0..6), so the code alone says which closed map applies.
      // A hand shape is read only from a frame that requires reader 2; anywhere else its action
      // code is simply out of range for the schema-1 shapes.
      const code = isMap(payload) ? payload.get(1n) : undefined
      // Schema 3 adds the hand shapes with entropy from both sides, codes 32..41, read only by
      // a reader that supports schema 3.
      if (
        typeof code === 'bigint' &&
        code >= 32n &&
        schema.effective >= 3 &&
        (schema.minReader ?? 1) >= 2
      )
        return blackjackHandV3Payload(payload)
      return typeof code === 'bigint' &&
        code >= 16n &&
        schema.effective >= 2 &&
        (schema.minReader ?? 1) >= 2
        ? blackjackHandPayload(payload)
        : blackjackPayload(payload)
    }
    case TYPE_STEALTH_MESSAGE_ITEM: {
      const m = fields(payload, P, [0, 1, 2, 3], [4], true, allow)
      return {
        type: 19,
        networkTag: tstr(m.get(0), `${P}.0`, 1, 64),
        ephemeralPubKey: account(m.get(1), `${P}.1`),
        transactions: asList(m.get(2), `${P}.2`, 1, 16).map((e, i) =>
          bstr(e, `${P}.2[${i}]`, 1, 16384),
        ),
        amount: uintRange(m.get(3), `${P}.3`, 0n, U64_MAX),
        memo: m.has(4) ? tstr(m.get(4), `${P}.4`, 0, 1024) : undefined,
        unknownFields: m.unknown,
      }
    }
    case TYPE_CHANNEL_UPDATE: {
      const m = fields(payload, P, [0, 1, 2, 3, 4, 5], [6], true, allow)
      return {
        type: 24,
        channelId: bstr(m.get(0), `${P}.0`, 32, 32),
        appId: tstr(m.get(1), `${P}.1`, 1, 64),
        sequenceNumber: u32ish(m.get(2), `${P}.2`, 0, 4294967295),
        allocations: asList(m.get(3), `${P}.3`, 1, 8).map((a, i) =>
          chainAllocation(a, `${P}.3[${i}]`),
        ),
        appState: bstr(m.get(4), `${P}.4`, 0, 65536),
        signatures: asList(m.get(5), `${P}.5`, 1, 4).map((s, i) =>
          signatureEntry(s, `${P}.5[${i}]`),
        ),
        settlementRef: m.has(6) ? bstr(m.get(6), `${P}.6`, 1, 128) : undefined,
        unknownFields: m.unknown,
      }
    }
    case TYPE_FORWARDING_DELIVERY_ENVELOPE: {
      const m = fields(payload, P, [0, 1, 2, 3, 4], [5, 6], true, allow)
      const res: ForwardingDeliveryEnvelope<Uint8Array> = {
        type: 25,
        network: networkTag(m.get(0), `${P}.0`),
        destination: account(m.get(1), `${P}.1`),
        payloadFrame: framed(m.get(2), `${P}.2`),
        payloadDigest: bstr(m.get(3), `${P}.3`, 32, 32),
        payments: asList(m.get(4), `${P}.4`, 1, MAX_PAYMENT_MEMBERS).map(
          (e, i) => paymentMember(e, `${P}.4[${i}]`),
        ),
        unknownFields: m.unknown,
      }
      if (m.has(5)) {
        res.endpoint = tstr(m.get(5), `${P}.5`, 1, 256)
      }
      if (m.has(6)) {
        res.expiresAt = u32ish(m.get(6), `${P}.6`, 0, 4294967295)
      }
      return res
    }
    default:
      throw new Error(`parseDraft: type ${typeId} has no schema`)
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 8.3
// ---------------------------------------------------------------------------------------------

const unsupported = (path: string, message: string) =>
  fail('unsupported', '8.3', path, message)

const ALLOCATED_KEY_TYPES = new Set([1, 2, 3])

function checkKeyType(a: AccountRef, path: string): void {
  if (!ALLOCATED_KEY_TYPES.has(a.keyType)) {
    throw unsupported(path, `unallocated key type ${a.keyType} (S2)`)
  }
}

/** S2b: algorithm / key type / signature-length pairing. */
function checkSignatureShape(
  algorithm: number,
  signer: AccountRef,
  signature: Uint8Array,
  path: string,
): void {
  let keyType: number
  let ok: boolean
  switch (algorithm) {
    case 1:
      keyType = 1
      ok = signature.length >= 8 && signature.length <= 72
      break
    case 2:
      keyType = 3
      ok = signature.length === 64
      break
    case 3:
      keyType = 1
      ok = signature.length === 64
      break
    case 16:
      keyType = 2
      ok = signature.length === 64
      break
    default:
      throw unsupported(
        path,
        `unallocated signature algorithm ${algorithm} (S2a)`,
      )
  }
  if (signer.keyType !== keyType || !ok) {
    throw unsupported(
      path,
      'algorithm/key-type/length combination is not allocated (S2b)',
    )
  }
}

/** Stage 8.3: allocated-identifier checks that need only the draft. */
export function checkAllocated(d: DraftPayload): void {
  const P = 'root/payload'
  switch (d.type) {
    case 1:
      checkKeyType(d.destination, `${P}.1`)
      if (d.recipient) checkKeyType(d.recipient, `${P}.5`)
      break
    case 2:
      d.signatures.forEach((s, i) => {
        checkKeyType(s.signer, `${P}.1[${i}].1`)
        checkSignatureShape(s.algorithm, s.signer, s.signature, `${P}.1[${i}]`)
      })
      break
    case 3:
      checkKeyType(d.owner, `${P}.1`)
      break
    case 4:
      checkKeyType(d.subject, `${P}.1`)
      d.relays.forEach((r, i) => checkKeyType(r.identity, `${P}.4[${i}].2`))
      if (d.stampKey) checkKeyType(d.stampKey, `${P}.8`)
      if (d.preview) checkKeyType(d.preview.messageDhKey, `${P}.10`)
      d.keyTransitions?.forEach((t, i) => {
        checkKeyType(t.signer, `${P}.5[${i}].2`)
        checkSignatureShape(t.algorithm, t.signer, t.signature, `${P}.5[${i}]`)
      })
      d.recoveryAuthorities?.forEach((a, i) => checkKeyType(a, `${P}.7[${i}]`))
      break
    case 5:
      checkKeyType(d.sender, `${P}.1`)
      checkKeyType(d.recipient, `${P}.2`)
      if (
        (d.schemaVersion === 1 && d.suite !== ENCRYPTION_SUITE_PROOF) ||
        (d.schemaVersion === 2 && d.suite !== ENCRYPTION_SUITE_DM_AUTH_XCHACHA)
      ) {
        throw unsupported(
          `${P}.3`,
          `encryption suite ${d.suite} is unallocated (S2c)`,
        )
      }
      break
    case 7:
      checkKeyType(d.subject, `${P}.1`)
      checkKeyType(d.priorAuthority, `${P}.2`)
      checkKeyType(d.newKey, `${P}.4`)
      break
    case 19:
      checkKeyType(d.ephemeralPubKey, `${P}.1`)
      break
    case 24:
      d.allocations.forEach((a, i) => {
        a.balances.forEach((b, j) => {
          checkKeyType(b.participant, `${P}.3[${i}].2[${j}].0`)
        })
      })
      d.signatures.forEach((s, i) => {
        checkKeyType(s.signer, `${P}.5[${i}].1`)
        checkSignatureShape(s.algorithm, s.signer, s.signature, `${P}.5[${i}]`)
      })
      break
    case 25:
      checkKeyType(d.destination, `${P}.1`)
      break
    default:
  }
}
