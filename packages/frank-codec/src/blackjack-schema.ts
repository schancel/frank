// Composable Stage 8.1/8.2 and Stage 9 schema descriptor for Type 18 Blackjack message items.
import type { FrankValue } from './cbor'
import {
  BLACKJACK_ACTION,
  BLACKJACK_HAND_ACTION,
  BLACKJACK_HAND_ITEM,
  BLACKJACK_HAND_ITEM_ACCEPT_SHAPE,
  BLACKJACK_HAND_ITEM_ACTION_ONLY_SHAPE,
  BLACKJACK_HAND_ITEM_CARD_SHAPE,
  BLACKJACK_HAND_ITEM_CHALLENGE_DEALER_SHAPE,
  BLACKJACK_HAND_ITEM_CHALLENGE_PLAYER_SHAPE,
  BLACKJACK_HAND_ITEM_DEAL_SHAPE,
  BLACKJACK_HAND_ITEM_REFUND_SHAPE,
  BLACKJACK_HAND_ITEM_REVEAL_SHAPE,
  BLACKJACK_HAND_V3_ACTION,
  BLACKJACK_HAND_V3_ITEM,
  BLACKJACK_HAND_V3_ITEM_ACCEPT_SHAPE,
  BLACKJACK_HAND_V3_ITEM_BET_SHAPE,
  BLACKJACK_HAND_V3_ITEM_CHALLENGE_DEALER_SHAPE,
  BLACKJACK_HAND_V3_ITEM_CHALLENGE_PLAYER_SHAPE,
  BLACKJACK_HAND_V3_ITEM_MOVE_SHAPE,
  BLACKJACK_HAND_V3_ITEM_REFUND_SHAPE,
  BLACKJACK_ITEM,
  BLACKJACK_ITEM_BET_SHAPE,
  BLACKJACK_ITEM_DEAL_SHAPE,
  BLACKJACK_ITEM_DOUBLE_REQUEST_SHAPE,
  BLACKJACK_ITEM_DOUBLE_RESPONSE_SHAPE,
  BLACKJACK_ITEM_HIT_SHAPE,
  BLACKJACK_ITEM_REVEAL_SHAPE,
  BLACKJACK_ITEM_STAND_SHAPE,
  BLACKJACK_ITEM_WELCOME_SHAPE,
  BLACKJACK_OUTCOME,
  BLACKJACK_ROLE,
  MAX_BLACKJACK_FRAME_BYTES,
  TYPE_BLACKJACK_MESSAGE_ITEM,
  type MapShape,
} from './constants'
import { FrankCodecError } from './errors'
import {
  asList,
  at,
  bad,
  bstr,
  isMap,
  shaped,
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

/** Wire outcome code (key 9) to its application name. */
const OUTCOME_NAMES = {
  [BLACKJACK_OUTCOME.playerWin]: 'player_win',
  [BLACKJACK_OUTCOME.dealerWin]: 'dealer_win',
  [BLACKJACK_OUTCOME.push]: 'push',
  [BLACKJACK_OUTCOME.playerBlackjack]: 'player_blackjack',
} as const
const outcomeName = (code: number) =>
  OUTCOME_NAMES[code as keyof typeof OUTCOME_NAMES]

/** Closed schema-1 shapes, also closed when projected from a compatible future envelope. */
function blackjackPayload(payload: FrankValue): BlackjackMessageItem {
  const P = 'root/payload'
  const K = BLACKJACK_ITEM
  const A = BLACKJACK_ACTION
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  const action = u32ish(
    payload.get(BigInt(K.action)),
    at(P, K.action),
    A.bet,
    A.welcome,
  )
  const card = (v: FrankValue | undefined, path: string) =>
    u32ish(v, path, 0, 51)
  const hand = (
    v: FrankValue | undefined,
    key: number,
    min: number,
    max: number,
  ) =>
    asList(v, at(P, key), min, max).map((c, i) =>
      card(c, `${at(P, key)}[${i}]`),
    )
  const read = (shape: MapShape) => {
    const m = shaped(payload, P, shape, false)
    return {
      m,
      base: {
        type: TYPE_BLACKJACK_MESSAGE_ITEM,
        gameId: tstr(m.get(K.gameId), at(P, K.gameId), 1, 128),
      },
    }
  }
  switch (action) {
    case A.bet: {
      const { m, base } = read(BLACKJACK_ITEM_BET_SHAPE)
      return {
        ...base,
        action: 'bet',
        wagerTxHash: bstr(m.get(K.wagerTxHash), at(P, K.wagerTxHash), 32, 32),
      }
    }
    case A.deal: {
      const { m, base } = read(BLACKJACK_ITEM_DEAL_SHAPE)
      return {
        ...base,
        action: 'deal',
        serverSeedHash: bstr(
          m.get(K.serverSeedHash),
          at(P, K.serverSeedHash),
          32,
          32,
        ),
        playerCards: hand(m.get(K.playerCards), K.playerCards, 2, 2),
        dealerUpCard: card(m.get(K.dealerUpCard), at(P, K.dealerUpCard)),
      }
    }
    case A.hit: {
      const { m, base } = read(BLACKJACK_ITEM_HIT_SHAPE)
      return m.has(K.playerCards)
        ? {
            ...base,
            action: 'hit',
            playerCards: hand(m.get(K.playerCards), K.playerCards, 3, 52),
          }
        : { ...base, action: 'hit' }
    }
    case A.stand:
      return { ...read(BLACKJACK_ITEM_STAND_SHAPE).base, action: 'stand' }
    case A.double: {
      const request = payload.has(BigInt(K.doubleWagerTxHash))
      if (request === payload.has(BigInt(K.playerCards)))
        throw bad(P, 'double requires exactly one request/response form')
      const { m, base } = read(
        request
          ? BLACKJACK_ITEM_DOUBLE_REQUEST_SHAPE
          : BLACKJACK_ITEM_DOUBLE_RESPONSE_SHAPE,
      )
      return m.has(K.doubleWagerTxHash)
        ? {
            ...base,
            action: 'double',
            doubleWagerTxHash: bstr(
              m.get(K.doubleWagerTxHash),
              at(P, K.doubleWagerTxHash),
              32,
              32,
            ),
          }
        : {
            ...base,
            action: 'double',
            playerCards: hand(m.get(K.playerCards), K.playerCards, 3, 3),
          }
    }
    case A.reveal: {
      const { m, base } = read(BLACKJACK_ITEM_REVEAL_SHAPE)
      const seed = tstr(m.get(K.serverSeed), at(P, K.serverSeed), 64, 64)
      if (seed.length !== 64 || !/^[0-9a-f]+$/.test(seed))
        throw bad(
          at(P, K.serverSeed),
          'seed must be 64 lowercase ASCII hex characters',
        )
      return {
        ...base,
        action: 'reveal',
        dealerCards: hand(m.get(K.dealerCards), K.dealerCards, 2, 52),
        serverSeed: seed,
        outcome: outcomeName(
          u32ish(
            m.get(K.outcome),
            at(P, K.outcome),
            BLACKJACK_OUTCOME.playerWin,
            BLACKJACK_OUTCOME.playerBlackjack,
          ),
        ),
      }
    }
    default: {
      const { m, base } = read(BLACKJACK_ITEM_WELCOME_SHAPE)
      const result: BlackjackMessageItem = {
        ...base,
        action: 'welcome',
        minWagerWei: bstr(m.get(K.minWagerWei), at(P, K.minWagerWei), 32, 32),
        maxWagerWei: bstr(m.get(K.maxWagerWei), at(P, K.maxWagerWei), 32, 32),
      }
      if (m.has(K.feeHintWei))
        result.feeHintWei = bstr(
          m.get(K.feeHintWei),
          at(P, K.feeHintWei),
          32,
          32,
        )
      if (m.has(K.rules)) {
        result.rules = tstr(m.get(K.rules), at(P, K.rules), 0, 1200)
        if (result.rules.length > 400)
          throw bad(at(P, K.rules), 'rules exceed 400 UTF-16 units')
      }
      return result
    }
  }
}

/** Closed schema-2 shapes: one peer-to-peer hand. No shape carries an amount of money. */
function blackjackHandPayload(payload: FrankValue): BlackjackHandMessageItem {
  const P = 'root/payload'
  const K = BLACKJACK_HAND_ITEM
  const A = BLACKJACK_HAND_ACTION
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  // Codes 16..25: disjoint from schema 1's 0..6, so no reader can take one for the other.
  const action = u32ish(
    payload.get(BigInt(K.action)),
    at(P, K.action),
    A.challenge,
    A.refund,
  )
  const hand = (
    v: FrankValue | undefined,
    key: number,
    min: number,
    max: number,
  ) =>
    asList(v, at(P, key), min, max).map((c, i) =>
      u32ish(c, `${at(P, key)}[${i}]`, 0, 51),
    )
  const read = (shape: MapShape) => {
    const m = shaped(payload, P, shape, false)
    // Fixed form, so a game id is always safe to use as a key: 32 lowercase hex characters.
    const gameId = tstr(m.get(K.gameId), at(P, K.gameId), 32, 32)
    if (!/^[0-9a-f]{32}$/.test(gameId))
      throw bad(
        at(P, K.gameId),
        'game id must be 32 lowercase ASCII hex characters',
      )
    return {
      m,
      base: { type: TYPE_BLACKJACK_MESSAGE_ITEM, schema: 2 as const, gameId },
    }
  }
  const hash = (m: MapView, key: number) => bstr(m.get(key), at(P, key), 32, 32)
  switch (action) {
    case A.challenge: {
      const dealer =
        u32ish(
          payload.get(BigInt(K.role)),
          at(P, K.role),
          BLACKJACK_ROLE.dealer,
          BLACKJACK_ROLE.player,
        ) === BLACKJACK_ROLE.dealer
      const { m, base } = read(
        dealer
          ? BLACKJACK_HAND_ITEM_CHALLENGE_DEALER_SHAPE
          : BLACKJACK_HAND_ITEM_CHALLENGE_PLAYER_SHAPE,
      )
      return dealer
        ? {
            ...base,
            action: 'challenge',
            role: 'dealer',
            maxBetWei: hash(m, K.maxBetWei),
            commitment: hash(m, K.commitment),
          }
        : {
            ...base,
            action: 'challenge',
            role: 'player',
            maxBetWei: hash(m, K.maxBetWei),
          }
    }
    case A.accept: {
      const { m, base } = read(BLACKJACK_HAND_ITEM_ACCEPT_SHAPE)
      return {
        ...base,
        action: 'accept',
        maxBetWei: hash(m, K.maxBetWei),
        commitment: hash(m, K.commitment),
      }
    }
    case A.bet:
      return {
        ...read(BLACKJACK_HAND_ITEM_ACTION_ONLY_SHAPE).base,
        action: 'bet',
      }
    case A.deal: {
      const { m, base } = read(BLACKJACK_HAND_ITEM_DEAL_SHAPE)
      return {
        ...base,
        action: 'deal',
        playerCards: hand(m.get(K.playerCards), K.playerCards, 2, 2),
        dealerUpCard: u32ish(
          m.get(K.dealerUpCard),
          at(P, K.dealerUpCard),
          0,
          51,
        ),
      }
    }
    case A.hit:
      return {
        ...read(BLACKJACK_HAND_ITEM_ACTION_ONLY_SHAPE).base,
        action: 'hit',
      }
    case A.stand:
      return {
        ...read(BLACKJACK_HAND_ITEM_ACTION_ONLY_SHAPE).base,
        action: 'stand',
      }
    case A.double:
      return {
        ...read(BLACKJACK_HAND_ITEM_ACTION_ONLY_SHAPE).base,
        action: 'double',
      }
    case A.card: {
      const { m, base } = read(BLACKJACK_HAND_ITEM_CARD_SHAPE)
      return {
        ...base,
        action: 'card',
        playerCards: hand(m.get(K.playerCards), K.playerCards, 3, 52),
      }
    }
    case A.reveal: {
      const { m, base } = read(BLACKJACK_HAND_ITEM_REVEAL_SHAPE)
      const seed = tstr(m.get(K.seed), at(P, K.seed), 64, 64)
      if (seed.length !== 64 || !/^[0-9a-f]+$/.test(seed))
        throw bad(
          at(P, K.seed),
          'seed must be 64 lowercase ASCII hex characters',
        )
      return {
        ...base,
        action: 'reveal',
        dealerCards: hand(m.get(K.dealerCards), K.dealerCards, 2, 52),
        seed,
        outcome: outcomeName(
          u32ish(
            m.get(K.outcome),
            at(P, K.outcome),
            BLACKJACK_OUTCOME.playerWin,
            BLACKJACK_OUTCOME.playerBlackjack,
          ),
        ),
      }
    }
    default: {
      const { m, base } = read(BLACKJACK_HAND_ITEM_REFUND_SHAPE)
      return { ...base, action: 'refund', ref: hash(m, K.ref) }
    }
  }
}

/** Schema-3 move codes that carry only `link` and `prev`, by application name. */
const V3_MOVES = {
  [BLACKJACK_HAND_V3_ACTION.deal]: 'deal',
  [BLACKJACK_HAND_V3_ACTION.hit]: 'hit',
  [BLACKJACK_HAND_V3_ACTION.stand]: 'stand',
  [BLACKJACK_HAND_V3_ACTION.double]: 'double',
  [BLACKJACK_HAND_V3_ACTION.card]: 'card',
  [BLACKJACK_HAND_V3_ACTION.reveal]: 'reveal',
} as const

/** Closed schema-3 shapes: a hand whose cards come from both sides' entropy. No shape states a
 * card, an outcome or an amount of money. */
function blackjackHandV3Payload(
  payload: FrankValue,
): BlackjackHandV3MessageItem {
  const P = 'root/payload'
  const K = BLACKJACK_HAND_V3_ITEM
  const A = BLACKJACK_HAND_V3_ACTION
  if (!isMap(payload)) throw bad(P, 'blackjack payload must be a map')
  // Codes 32..41: disjoint from schema 1's 0..6 and schema 2's 16..25.
  const action = u32ish(
    payload.get(BigInt(K.action)),
    at(P, K.action),
    A.challenge,
    A.refund,
  )
  const read = (shape: MapShape) => {
    const m = shaped(payload, P, shape, false)
    const gameId = tstr(m.get(K.gameId), at(P, K.gameId), 32, 32)
    if (!/^[0-9a-f]{32}$/.test(gameId))
      throw bad(
        at(P, K.gameId),
        'game id must be 32 lowercase ASCII hex characters',
      )
    // A challenge is message 0 of its hand; every other message follows one.
    const seq =
      action === A.challenge
        ? u32ish(m.get(K.seq), at(P, K.seq), 0, 0)
        : u32ish(m.get(K.seq), at(P, K.seq), 1, 255)
    return {
      m,
      base: {
        type: TYPE_BLACKJACK_MESSAGE_ITEM,
        schema: 3 as const,
        gameId,
        seq,
      },
    }
  }
  const hash = (m: MapView, key: number) => bstr(m.get(key), at(P, key), 32, 32)
  switch (action) {
    case A.challenge: {
      const dealer =
        u32ish(
          payload.get(BigInt(K.role)),
          at(P, K.role),
          BLACKJACK_ROLE.dealer,
          BLACKJACK_ROLE.player,
        ) === BLACKJACK_ROLE.dealer
      const { m, base } = read(
        dealer
          ? BLACKJACK_HAND_V3_ITEM_CHALLENGE_DEALER_SHAPE
          : BLACKJACK_HAND_V3_ITEM_CHALLENGE_PLAYER_SHAPE,
      )
      return dealer
        ? {
            ...base,
            action: 'challenge',
            role: 'dealer',
            maxBetWei: hash(m, K.maxBetWei),
            commitment: hash(m, K.commitment),
          }
        : {
            ...base,
            action: 'challenge',
            role: 'player',
            maxBetWei: hash(m, K.maxBetWei),
          }
    }
    case A.accept: {
      const { m, base } = read(BLACKJACK_HAND_V3_ITEM_ACCEPT_SHAPE)
      return {
        ...base,
        action: 'accept',
        maxBetWei: hash(m, K.maxBetWei),
        commitment: hash(m, K.commitment),
        prev: hash(m, K.prev),
      }
    }
    case A.bet: {
      const { m, base } = read(BLACKJACK_HAND_V3_ITEM_BET_SHAPE)
      return {
        ...base,
        action: 'bet',
        commitment: hash(m, K.commitment),
        prev: hash(m, K.prev),
      }
    }
    case A.refund: {
      const { m, base } = read(BLACKJACK_HAND_V3_ITEM_REFUND_SHAPE)
      return {
        ...base,
        action: 'refund',
        ref: hash(m, K.ref),
        prev: hash(m, K.prev),
      }
    }
    default: {
      const { m, base } = read(BLACKJACK_HAND_V3_ITEM_MOVE_SHAPE)
      return {
        ...base,
        action: V3_MOVES[action as keyof typeof V3_MOVES],
        link: hash(m, K.link),
        prev: hash(m, K.prev),
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
  const code = isMap(payload)
    ? payload.get(BigInt(BLACKJACK_ITEM.action))
    : undefined
  // Schema 3 adds the hand shapes with entropy from both sides, codes 32..41, read only by
  // a reader that supports schema 3.
  if (
    typeof code === 'bigint' &&
    code >= BigInt(BLACKJACK_HAND_V3_ACTION.challenge) &&
    schema.effective >= 3 &&
    (schema.minReader ?? 1) >= 2
  )
    return blackjackHandV3Payload(payload)
  return typeof code === 'bigint' &&
    code >= BigInt(BLACKJACK_HAND_ACTION.challenge) &&
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
  if (typed.action === 'deal' && typed.playerCards.includes(typed.dealerUpCard))
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
