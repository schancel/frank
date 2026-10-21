/** Pure typed-item writing/projection. No game engine, authentication, or payment authority. */
import {
  blackjackFeatureCodec,
  checkBlackjackSemantics,
  parseBlackjackDraft,
  type BlackjackWireItem,
} from './blackjack-schema'
import type { Encodable } from './cbor'
import {
  BLACKJACK_ACTION,
  BLACKJACK_HAND_ACTION,
  BLACKJACK_HAND_ITEM,
  BLACKJACK_HAND_V3_ACTION,
  BLACKJACK_HAND_V3_ITEM,
  BLACKJACK_ITEM,
  BLACKJACK_OUTCOME,
  BLACKJACK_ROLE,
  TYPE_BLACKJACK_MESSAGE_ITEM,
} from './constants'
import { FrankCodecError, FrankContextError } from './errors'
import { encodeFrame } from './frame'
import { fromHex, toHex } from './hash'
import type {
  BlackjackFields,
  BlackjackHandFields,
  BlackjackHandV3Fields,
  ParsedFrame,
} from './types'
import { defaultContext, validateFrame } from './validate'

export {
  blackjackFeatureCodec,
  checkBlackjackSemantics,
  parseBlackjackDraft,
  type BlackjackWireItem,
}

/** Nine closed application-facing shapes; quantities remain exact decimal strings. */
export type BlackjackSplitMoveFields =
  | {
      action: 'split'
      splitWagerTxHash?: string
      playerCards?: number[]
      splitHands?: [number[], number[]]
    }
  | {
      action: 'hit'
      playerCards?: number[]
      splitHands?: [number[], number[]]
    }
  | {
      action: 'reveal'
      dealerCards: number[]
      serverSeed: string
      outcome: 'player_win' | 'dealer_win' | 'push' | 'player_blackjack'
      splitHands?: [number[], number[]]
      splitOutcomes?: [
        'player_win' | 'dealer_win' | 'push' | 'player_blackjack',
        'player_win' | 'dealer_win' | 'push' | 'player_blackjack',
      ]
    }

export type BlackjackItem = { type: 'blackjack-move' } & (
  | BlackjackFields<string, string>
  | ({ gameId: string } & BlackjackSplitMoveFields)
)

const bad = (message: string) =>
  new FrankCodecError('schema', '8.2', message, 'blackjack/writer')
const own = (input: object, key: string) =>
  Object.prototype.hasOwnProperty.call(input, key)

function hash(value: unknown, prefixed: boolean): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length !== (prefixed ? 66 : 64) ||
    !(prefixed ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-f]{64}$/).test(value)
  )
    throw bad(
      prefixed
        ? 'expected lowercase 0x prefix and exactly 64 hex digits'
        : 'expected exactly 64 bare lowercase hex digits',
    )
  return fromHex(prefixed ? value.slice(2).toLowerCase() : value)
}

function quantity(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 40 ||
    /[^0-9]/.test(value)
  )
    throw bad(
      'quantity requires 1..40 complete ASCII decimal digits before conversion',
    )
  let n = BigInt(value)
  const bytes = new Uint8Array(32)
  for (let i = 31; i >= 0; i--, n >>= 8n) bytes[i] = Number(n & 255n)
  return bytes
}

/** Deterministic writer. Rejects unsupported/extra host fields before conversion, then uses
 * the ordinary typed validator for the same wire shapes, resource and semantic rules. */
export function encodeBlackjackItem(item: BlackjackItem): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    throw bad('expected an item object')
  const input = item as unknown as Record<string, unknown>
  const K = BLACKJACK_ITEM
  const A = BLACKJACK_ACTION
  const fields: [number, string][] = [[K.gameId, 'gameId']]
  let action: number
  switch (input.action) {
    case 'bet':
      action = A.bet
      fields.push([K.wagerTxHash, 'wagerTxHash'])
      break
    case 'deal':
      action = A.deal
      fields.push(
        [K.serverSeedHash, 'serverSeedHash'],
        [K.playerCards, 'playerCards'],
        [K.dealerUpCard, 'dealerUpCard'],
      )
      break
    case 'hit':
      action = A.hit
      if (own(input, 'playerCards')) fields.push([K.playerCards, 'playerCards'])
      break
    case 'stand':
      action = A.stand
      break
    case 'double':
      action = A.double
      if (own(input, 'doubleWagerTxHash') === own(input, 'playerCards'))
        throw bad('double requires exactly one request/response form')
      fields.push(
        own(input, 'doubleWagerTxHash')
          ? [K.doubleWagerTxHash, 'doubleWagerTxHash']
          : [K.playerCards, 'playerCards'],
      )
      break
    case 'reveal':
      action = A.reveal
      fields.push(
        [K.dealerCards, 'dealerCards'],
        [K.serverSeed, 'serverSeed'],
        [K.outcome, 'outcome'],
      )
      break
    case 'welcome':
      action = A.welcome
      fields.push(
        [K.minWagerWei, 'minWagerWei'],
        [K.maxWagerWei, 'maxWagerWei'],
      )
      if (own(input, 'feeHintWei')) fields.push([K.feeHintWei, 'feeHintWei'])
      if (own(input, 'rules')) fields.push([K.rules, 'rules'])
      break
    default:
      throw bad('unknown blackjack action')
  }
  const names = ['type', 'action', ...fields.map(([, name]) => name)]
  if (
    input.type !== 'blackjack-move' ||
    names.some(name => !own(input, name)) ||
    Reflect.ownKeys(input).some(
      key => typeof key !== 'string' || !names.includes(key),
    )
  )
    throw bad('closed blackjack item fields required')
  const payload = new Map<number, Encodable>([[K.action, action]])
  for (const [key, name] of fields) {
    const value = input[name]
    if (
      key === K.wagerTxHash ||
      key === K.doubleWagerTxHash ||
      key === K.serverSeedHash
    )
      // Wager hashes are 0x-prefixed transaction hashes; the seed hash is bare hex.
      payload.set(key, hash(value, key !== K.serverSeedHash))
    else if (
      key === K.minWagerWei ||
      key === K.maxWagerWei ||
      key === K.feeHintWei
    )
      payload.set(key, quantity(value))
    else if (key === K.outcome) payload.set(key, outcomeCode(value))
    else {
      // The canonical encoder rejects invalid host kinds and ill-formed Unicode; the
      // typed validator below enforces every action-specific wire bound and semantic rule.
      payload.set(key, value as Encodable)
    }
  }
  const frame = encodeFrame(
    {
      typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    payload,
  )
  validateFrame(frame, defaultContext())
  return frame
}

/** Project an already typed child without restarting its validation or budgets. Both the
 * original frame and array values are copied. Forward `frame` unchanged, not by re-encoding. */
export function projectBlackjackItem(parsed: ParsedFrame): {
  frame: Uint8Array
  item: BlackjackItem
} {
  const wire = parsed.typed
  if (wire?.type !== TYPE_BLACKJACK_MESSAGE_ITEM || wire.schema !== undefined)
    throw new FrankContextError('expected a typed schema-1 blackjack frame')
  const base = { type: 'blackjack-move' as const, gameId: wire.gameId }
  let item: BlackjackItem
  switch (wire.action) {
    case 'bet':
      item = {
        ...base,
        action: 'bet',
        wagerTxHash: `0x${toHex(wire.wagerTxHash)}`,
      }
      break
    case 'deal':
      item = {
        ...base,
        action: 'deal',
        serverSeedHash: toHex(wire.serverSeedHash),
        playerCards: [...wire.playerCards],
        dealerUpCard: wire.dealerUpCard,
      }
      break
    case 'hit':
      item =
        wire.playerCards !== undefined
          ? { ...base, action: 'hit', playerCards: [...wire.playerCards] }
          : { ...base, action: 'hit' }
      break
    case 'stand':
      item = { ...base, action: 'stand' }
      break
    case 'double':
      item =
        wire.doubleWagerTxHash !== undefined
          ? {
              ...base,
              action: 'double',
              doubleWagerTxHash: `0x${toHex(wire.doubleWagerTxHash)}`,
            }
          : { ...base, action: 'double', playerCards: [...wire.playerCards] }
      break
    case 'reveal':
      item = {
        ...base,
        action: 'reveal',
        dealerCards: [...wire.dealerCards],
        serverSeed: wire.serverSeed,
        outcome: wire.outcome,
      }
      break
    case 'welcome': {
      const decimal = (b: Uint8Array) =>
        b.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n).toString(10)
      item = {
        ...base,
        action: 'welcome',
        minWagerWei: decimal(wire.minWagerWei),
        maxWagerWei: decimal(wire.maxWagerWei),
      }
      if (wire.feeHintWei !== undefined)
        item.feeHintWei = decimal(wire.feeHintWei)
      if (wire.rules !== undefined) item.rules = wire.rules
      break
    }
  }
  return { frame: new Uint8Array(parsed.frame), item }
}

/** The ten closed peer-to-peer hand shapes (type 18, schema 2). Hashes are 64 bare lowercase hex
 * characters, quantities exact decimal strings. No shape carries an amount of money: a wager,
 * payout or refund is the stamp of the message that carries the item. */
export type BlackjackHandItem = {
  type: 'blackjack-hand'
} & BlackjackHandFields<string, string>

/** Application outcome name to its wire code (key 9). */
const OUTCOME_CODES: Readonly<Record<string, number>> = {
  player_win: BLACKJACK_OUTCOME.playerWin,
  dealer_win: BLACKJACK_OUTCOME.dealerWin,
  push: BLACKJACK_OUTCOME.push,
  player_blackjack: BLACKJACK_OUTCOME.playerBlackjack,
}

function outcomeCode(value: unknown): number {
  if (typeof value !== 'string' || !own(OUTCOME_CODES, value))
    throw bad('unknown blackjack outcome')
  return OUTCOME_CODES[value]
}

/** Application action name to its schema-2 or schema-3 wire code (key 1). */
function actionCode(
  codes: Readonly<Record<string, number>>,
  action: unknown,
): number | undefined {
  return typeof action === 'string' && own(codes, action)
    ? codes[action]
    : undefined
}

/** Deterministic writer for one hand item; the typed validator then enforces every wire rule. */
export function encodeBlackjackHandItem(item: BlackjackHandItem): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    throw bad('expected an item object')
  const input = item as unknown as Record<string, unknown>
  const K = BLACKJACK_HAND_ITEM
  const action = actionCode(BLACKJACK_HAND_ACTION, input.action)
  if (action === undefined) throw bad('unknown blackjack action')
  const fields: [number, string][] = [[K.gameId, 'gameId']]
  switch (input.action) {
    case 'challenge':
      if (input.role !== 'dealer' && input.role !== 'player')
        throw bad('unknown blackjack role')
      fields.push([K.role, 'role'], [K.maxBetWei, 'maxBetWei'])
      if (input.role === 'dealer') fields.push([K.commitment, 'commitment'])
      break
    case 'accept':
      fields.push([K.maxBetWei, 'maxBetWei'], [K.commitment, 'commitment'])
      break
    case 'deal':
      fields.push(
        [K.playerCards, 'playerCards'],
        [K.dealerUpCard, 'dealerUpCard'],
      )
      break
    case 'card':
      fields.push([K.playerCards, 'playerCards'])
      break
    case 'reveal':
      fields.push(
        [K.dealerCards, 'dealerCards'],
        [K.seed, 'seed'],
        [K.outcome, 'outcome'],
      )
      break
    case 'refund':
      fields.push([K.ref, 'ref'])
      break
  }
  const names = ['type', 'action', ...fields.map(([, name]) => name)]
  if (
    input.type !== 'blackjack-hand' ||
    names.some(name => !own(input, name)) ||
    Reflect.ownKeys(input).some(
      key => typeof key !== 'string' || !names.includes(key),
    )
  )
    throw bad('closed blackjack item fields required')
  const payload = new Map<number, Encodable>([[K.action, action]])
  for (const [key, name] of fields) {
    const value = input[name]
    if (key === K.role)
      payload.set(
        key,
        value === 'dealer' ? BLACKJACK_ROLE.dealer : BLACKJACK_ROLE.player,
      )
    else if (key === K.maxBetWei) payload.set(key, quantity(value))
    else if (key === K.commitment || key === K.ref)
      payload.set(key, hash(value, false))
    else if (key === K.outcome) payload.set(key, outcomeCode(value))
    else payload.set(key, value as Encodable)
  }
  const frame = encodeFrame(
    {
      typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
      schemaVersion: 2,
      minReaderVersion: 2,
    },
    payload,
  )
  validateFrame(frame, defaultContext())
  return frame
}

/** True for a parsed type-18 child that is a schema-2 hand item. */
export function isBlackjackHandFrame(parsed: ParsedFrame): boolean {
  return (
    parsed.typed?.type === TYPE_BLACKJACK_MESSAGE_ITEM &&
    parsed.typed.schema === 2
  )
}

/** Project an already typed schema-2 child. Arrays and the frame are copied. */
export function projectBlackjackHandItem(parsed: ParsedFrame): {
  frame: Uint8Array
  item: BlackjackHandItem
} {
  const wire = parsed.typed
  if (wire?.type !== TYPE_BLACKJACK_MESSAGE_ITEM || wire.schema !== 2)
    throw new FrankContextError('expected a typed schema-2 blackjack frame')
  const base = { type: 'blackjack-hand' as const, gameId: wire.gameId }
  const decimal = (b: Uint8Array) =>
    b.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n).toString(10)
  let item: BlackjackHandItem
  switch (wire.action) {
    case 'challenge':
      item =
        wire.role === 'dealer'
          ? {
              ...base,
              action: 'challenge',
              role: 'dealer',
              maxBetWei: decimal(wire.maxBetWei),
              commitment: toHex(wire.commitment),
            }
          : {
              ...base,
              action: 'challenge',
              role: 'player',
              maxBetWei: decimal(wire.maxBetWei),
            }
      break
    case 'accept':
      item = {
        ...base,
        action: 'accept',
        maxBetWei: decimal(wire.maxBetWei),
        commitment: toHex(wire.commitment),
      }
      break
    case 'deal':
      item = {
        ...base,
        action: 'deal',
        playerCards: [...wire.playerCards],
        dealerUpCard: wire.dealerUpCard,
      }
      break
    case 'card':
      item = { ...base, action: 'card', playerCards: [...wire.playerCards] }
      break
    case 'reveal':
      item = {
        ...base,
        action: 'reveal',
        dealerCards: [...wire.dealerCards],
        seed: wire.seed,
        outcome: wire.outcome,
      }
      break
    case 'refund':
      item = { ...base, action: 'refund', ref: toHex(wire.ref) }
      break
    default:
      item = { ...base, action: wire.action }
  }
  return { frame: new Uint8Array(parsed.frame), item }
}

/** The closed hand shapes with entropy from both sides (type 18, schema 3). Hashes are 64 bare
 * lowercase hex characters, quantities exact decimal strings. No shape states a card, an outcome
 * or an amount of money. */
export type BlackjackHandV3Item = {
  type: 'blackjack-hand'
} & (
  | BlackjackHandV3Fields<string, string>
  | {
      gameId: string
      seq: number
      action: 'split'
      link: string
      prev: string
    }
)

/** Deterministic writer for one schema-3 hand item; the typed validator enforces the wire rules. */
export function encodeBlackjackHandV3Item(
  item: BlackjackHandV3Item,
): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    throw bad('expected an item object')
  const input = item as unknown as Record<string, unknown>
  const K = BLACKJACK_HAND_V3_ITEM
  const action = actionCode(BLACKJACK_HAND_V3_ACTION, input.action)
  if (action === undefined) throw bad('unknown blackjack action')
  const fields: [number, string][] = [
    [K.gameId, 'gameId'],
    [K.seq, 'seq'],
  ]
  switch (input.action) {
    case 'challenge':
      if (input.role !== 'dealer' && input.role !== 'player')
        throw bad('unknown blackjack role')
      fields.push([K.role, 'role'], [K.maxBetWei, 'maxBetWei'])
      if (input.role === 'dealer') fields.push([K.commitment, 'commitment'])
      break
    case 'accept':
      fields.push(
        [K.maxBetWei, 'maxBetWei'],
        [K.commitment, 'commitment'],
        [K.prev, 'prev'],
      )
      break
    case 'bet':
      fields.push([K.commitment, 'commitment'], [K.prev, 'prev'])
      break
    case 'refund':
      fields.push([K.ref, 'ref'], [K.prev, 'prev'])
      break
    default:
      fields.push([K.prev, 'prev'], [K.link, 'link'])
  }
  const names = ['type', 'action', ...fields.map(([, name]) => name)]
  if (
    input.type !== 'blackjack-hand' ||
    names.some(name => !own(input, name)) ||
    Reflect.ownKeys(input).some(
      key => typeof key !== 'string' || !names.includes(key),
    )
  )
    throw bad('closed blackjack item fields required')
  const payload = new Map<number, Encodable>([[K.action, action]])
  for (const [key, name] of fields) {
    const value = input[name]
    if (key === K.role)
      payload.set(
        key,
        value === 'dealer' ? BLACKJACK_ROLE.dealer : BLACKJACK_ROLE.player,
      )
    else if (key === K.maxBetWei) payload.set(key, quantity(value))
    else if (key === K.seq) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        throw bad('seq must be a non-negative integer')
      payload.set(key, value)
    } else if (key === K.gameId) payload.set(key, value as Encodable)
    else payload.set(key, hash(value, false))
  }
  const frame = encodeFrame(
    {
      typeId: TYPE_BLACKJACK_MESSAGE_ITEM,
      schemaVersion: 3,
      minReaderVersion: 2,
    },
    payload,
  )
  validateFrame(frame, defaultContext())
  return frame
}

/** True for a parsed type-18 child that is a schema-3 hand item. */
export function isBlackjackHandV3Frame(parsed: ParsedFrame): boolean {
  return (
    parsed.typed?.type === TYPE_BLACKJACK_MESSAGE_ITEM &&
    parsed.typed.schema === 3
  )
}

/** Project an already typed schema-3 child. The frame is copied. */
export function projectBlackjackHandV3Item(parsed: ParsedFrame): {
  frame: Uint8Array
  item: BlackjackHandV3Item
} {
  const wire = parsed.typed
  if (wire?.type !== TYPE_BLACKJACK_MESSAGE_ITEM || wire.schema !== 3)
    throw new FrankContextError('expected a typed schema-3 blackjack frame')
  const base = {
    type: 'blackjack-hand' as const,
    gameId: wire.gameId,
    seq: wire.seq,
  }
  const decimal = (b: Uint8Array) =>
    b.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n).toString(10)
  let item: BlackjackHandV3Item
  switch (wire.action) {
    case 'challenge':
      item =
        wire.role === 'dealer'
          ? {
              ...base,
              action: 'challenge',
              role: 'dealer',
              maxBetWei: decimal(wire.maxBetWei),
              commitment: toHex(wire.commitment),
            }
          : {
              ...base,
              action: 'challenge',
              role: 'player',
              maxBetWei: decimal(wire.maxBetWei),
            }
      break
    case 'accept':
      item = {
        ...base,
        action: 'accept',
        maxBetWei: decimal(wire.maxBetWei),
        commitment: toHex(wire.commitment),
        prev: toHex(wire.prev),
      }
      break
    case 'bet':
      item = {
        ...base,
        action: 'bet',
        commitment: toHex(wire.commitment),
        prev: toHex(wire.prev),
      }
      break
    case 'refund':
      item = {
        ...base,
        action: 'refund',
        ref: toHex(wire.ref),
        prev: toHex(wire.prev),
      }
      break
    default:
      item = {
        ...base,
        action: wire.action,
        link: toHex(wire.link),
        prev: toHex(wire.prev),
      }
  }
  return { frame: new Uint8Array(parsed.frame), item }
}
