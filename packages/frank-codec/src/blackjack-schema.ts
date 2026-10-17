// Composable Stage 8.1/8.2 and Stage 9 schema descriptor for Type 18 Blackjack message items.
import type { FrankValue } from './cbor'
import {
  MAX_BLACKJACK_FRAME_BYTES,
  TYPE_BLACKJACK_MESSAGE_ITEM,
} from './constants'
import { FrankCodecError } from './errors'
import {
  asList,
  bad,
  bstr,
  fields,
  isMap,
  tstr,
  u32ish,
  type FeatureCodecDescriptor,
  type MapView,
  type SchemaVersionContext,
} from './schema-primitives'
import type {
  BlackjackHandMessageItem,
  BlackjackHandV3MessageItem,
  BlackjackMessageItem,
} from './types'

export type BlackjackWireItem =
  | BlackjackMessageItem
  | BlackjackHandMessageItem
  | BlackjackHandV3MessageItem

const semantic = (message: string, location = 'root'): FrankCodecError =>
  new FrankCodecError('semantic', '9', message, location)

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

/** Stage 8.2 draft parser for Type 18 Blackjack message items (schemas 1..3). */
export function parseBlackjackDraft(
  payload: FrankValue,
  _allowUnknown: boolean,
  schema: SchemaVersionContext,
): BlackjackWireItem {
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

/** Stage 9 semantic checks for Type 18 Blackjack message items (schemas 1..3). */
export function checkBlackjackSemantics(typed: BlackjackWireItem): void {
  if (typed.schema === 3) {
    if (typed.action === 'challenge' || typed.action === 'accept') {
      const max = typed.maxBetWei.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
      if (max < 1n || max > 10n ** 40n - 1n)
        throw semantic('blackjack max bet range')
    }
    return
  }
  if (typed.schema === 2) {
    const hand =
      'playerCards' in typed
        ? typed.playerCards
        : 'dealerCards' in typed
        ? typed.dealerCards
        : undefined
    if (hand && new Set(hand).size !== hand.length)
      throw semantic('blackjack hand contains duplicate cards')
    if (
      typed.action === 'deal' &&
      typed.playerCards.includes(typed.dealerUpCard)
    )
      throw semantic('deal up-card duplicates a player card')
    if (typed.action === 'challenge' || typed.action === 'accept') {
      const max = typed.maxBetWei.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
      if (max < 1n || max > 10n ** 40n - 1n)
        throw semantic('blackjack max bet range')
    }
    return
  }
  if ((typed.gameId === 'welcome') !== (typed.action === 'welcome'))
    throw semantic('welcome gameId is reserved iff action is welcome')
  const cards =
    'playerCards' in typed
      ? typed.playerCards
      : 'dealerCards' in typed
      ? typed.dealerCards
      : undefined
  if (cards && new Set(cards).size !== cards.length)
    throw semantic('blackjack hand contains duplicate cards')
  if (
    typed.action === 'deal' &&
    typed.playerCards.includes(typed.dealerUpCard)
  )
    throw semantic('deal up-card duplicates a player card')
  if (typed.action === 'welcome') {
    const quantity = (bytes: Uint8Array) =>
      bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
    const min = quantity(typed.minWagerWei),
      max = quantity(typed.maxWagerWei)
    const limit = 10n ** 40n - 1n
    if (
      min < 1n ||
      max < 1n ||
      min > max ||
      max > limit ||
      (typed.feeHintWei !== undefined && quantity(typed.feeHintWei) > limit)
    )
      throw semantic('blackjack welcome quantity range/order')
  }
}

export const blackjackFeatureCodec: FeatureCodecDescriptor<
  BlackjackWireItem,
  BlackjackWireItem
> = {
  typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
  maxSchemaVersion: 3,
  maxFrameBytes: MAX_BLACKJACK_FRAME_BYTES,
  enforceFrameLimitWhenNested: true,
  parseDraft: parseBlackjackDraft,
  checkSemantics: checkBlackjackSemantics,
}

export const DEFAULT_FEATURE_CODECS: readonly FeatureCodecDescriptor[] = [
  blackjackFeatureCodec,
]

export const DEFAULT_FEATURE_CODEC_MAP: ReadonlyMap<
  number,
  FeatureCodecDescriptor
> = new Map(DEFAULT_FEATURE_CODECS.map(codec => [codec.typeId, codec]))
