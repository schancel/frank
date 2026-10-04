/** Pure typed-item writing/projection. No game engine, authentication, or payment authority. */
import type { Encodable } from './cbor'
import { TYPE_BLACKJACK_MESSAGE_ITEM } from './constants'
import { FrankCodecError, FrankContextError } from './errors'
import { encodeFrame } from './frame'
import { fromHex, toHex } from './hash'
import type {
  BlackjackFields,
  BlackjackHandFields,
  ParsedFrame,
} from './types'
import { defaultContext, validateFrame } from './validate'

/** Nine closed application-facing shapes; quantities remain exact decimal strings. */
export type BlackjackItem = { type: 'blackjack-move' } & BlackjackFields<
  string,
  string
>

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
  const fields: [number, string][] = [[0, 'gameId']]
  let action: number
  switch (input.action) {
    case 'bet':
      action = 0
      fields.push([2, 'wagerTxHash'])
      break
    case 'deal':
      action = 1
      fields.push(
        [4, 'serverSeedHash'],
        [5, 'playerCards'],
        [6, 'dealerUpCard'],
      )
      break
    case 'hit':
      action = 2
      if (own(input, 'playerCards')) fields.push([5, 'playerCards'])
      break
    case 'stand':
      action = 3
      break
    case 'double':
      action = 4
      if (own(input, 'doubleWagerTxHash') === own(input, 'playerCards'))
        throw bad('double requires exactly one request/response form')
      fields.push(
        own(input, 'doubleWagerTxHash')
          ? [3, 'doubleWagerTxHash']
          : [5, 'playerCards'],
      )
      break
    case 'reveal':
      action = 5
      fields.push([7, 'dealerCards'], [8, 'serverSeed'], [9, 'outcome'])
      break
    case 'welcome':
      action = 6
      fields.push([10, 'minWagerWei'], [11, 'maxWagerWei'])
      if (own(input, 'feeHintWei')) fields.push([12, 'feeHintWei'])
      if (own(input, 'rules')) fields.push([13, 'rules'])
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
  const payload = new Map<number, Encodable>([[1, action]])
  for (const [key, name] of fields) {
    const value = input[name]
    if (key === 2 || key === 3 || key === 4)
      payload.set(key, hash(value, key !== 4))
    else if (key >= 10 && key <= 12) payload.set(key, quantity(value))
    else if (key === 9) {
      const outcomes = ['player_win', 'dealer_win', 'push', 'player_blackjack']
      if (typeof value !== 'string' || !outcomes.includes(value))
        throw bad('unknown blackjack outcome')
      payload.set(key, outcomes.indexOf(value))
    } else {
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
  if (wire?.type !== TYPE_BLACKJACK_MESSAGE_ITEM || wire.schema === 2)
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
export type BlackjackHandItem = { type: 'blackjack-hand' } & BlackjackHandFields<
  string,
  string
>

const HAND_ACTIONS = [
  'challenge',
  'accept',
  'bet',
  'deal',
  'hit',
  'stand',
  'double',
  'card',
  'reveal',
  'refund',
] as const
const OUTCOMES = ['player_win', 'dealer_win', 'push', 'player_blackjack']

/** Deterministic writer for one hand item; the typed validator then enforces every wire rule. */
export function encodeBlackjackHandItem(item: BlackjackHandItem): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    throw bad('expected an item object')
  const input = item as unknown as Record<string, unknown>
  const action = HAND_ACTIONS.indexOf(input.action as typeof HAND_ACTIONS[number])
  if (action < 0) throw bad('unknown blackjack action')
  const fields: [number, string][] = [[0, 'gameId']]
  switch (input.action) {
    case 'challenge':
      if (input.role !== 'dealer' && input.role !== 'player')
        throw bad('unknown blackjack role')
      fields.push([2, 'role'], [3, 'maxBetWei'])
      if (input.role === 'dealer') fields.push([4, 'commitment'])
      break
    case 'accept':
      fields.push([3, 'maxBetWei'], [4, 'commitment'])
      break
    case 'deal':
      fields.push([5, 'playerCards'], [6, 'dealerUpCard'])
      break
    case 'card':
      fields.push([5, 'playerCards'])
      break
    case 'reveal':
      fields.push([7, 'dealerCards'], [8, 'seed'], [9, 'outcome'])
      break
    case 'refund':
      fields.push([10, 'ref'])
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
  const payload = new Map<number, Encodable>([[1, action + 16]])
  for (const [key, name] of fields) {
    const value = input[name]
    if (key === 2) payload.set(key, value === 'dealer' ? 0 : 1)
    else if (key === 3) payload.set(key, quantity(value))
    else if (key === 4 || key === 10) payload.set(key, hash(value, false))
    else if (key === 9) {
      if (typeof value !== 'string' || !OUTCOMES.includes(value))
        throw bad('unknown blackjack outcome')
      payload.set(key, OUTCOMES.indexOf(value))
    } else payload.set(key, value as Encodable)
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
