/**
 * Mental Poker (`mental-poker-v1`) Message-Item Plugin (Issue #62).
 *
 * Provides canonical CBOR serialization, application-item wrapping, preview
 * summary formatting, and registry installation for 1:1 Heads-Up Texas Hold'em
 * without a trusted dealer.
 */
import {
  encodeCanonical,
  standaloneItemBudget,
  type Encodable,
  type FrankValue,
} from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  requirePluginCapabilities,
  type ApplicationItemPlugin,
  type MessageItemDecodeContext,
  type MessageItemPlugin,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'

import {
  extractMentalPokerPayload,
  MENTAL_POKER_ITEM_TYPE,
  MENTAL_POKER_PLUGIN_ID,
  readMentalPokerPayload,
  type MentalPokerPayload,
} from './game'

export * from './crypto'
export * from './game'

const CBOR_KEY_SCHEMA_VERSION = 0
const CBOR_KEY_HAND_ID = 1
const CBOR_KEY_ACTION = 2
const CBOR_KEY_ACTOR = 3
const CBOR_KEY_STAKE_WEI = 4
const CBOR_KEY_DECK_X = 5
const CBOR_KEY_DECK_Y = 6
const CBOR_KEY_DECK_Z = 7
const CBOR_KEY_REVEALED_KEYS_A = 8
const CBOR_KEY_REVEALED_KEYS_B = 9
const CBOR_KEY_REVEALED_KEYS = 10
const CBOR_KEY_SUB_ACTION = 11
const CBOR_KEY_AMOUNT_WEI = 12
const CBOR_KEY_WINNER_ROLE = 13

function encodeKeyRecord(record: Record<number, string>): Map<number, string> {
  const map = new Map<number, string>()
  for (const [k, v] of Object.entries(record)) {
    map.set(Number(k), v)
  }
  return map
}

function decodeKeyRecord(raw: FrankValue, field: string): Record<number, string> {
  if (!(raw instanceof Map)) {
    throw new TypeError(`Expected CBOR map for ${field}`)
  }
  const out: Record<number, string> = {}
  for (const [k, v] of raw.entries()) {
    const idx = typeof k === 'bigint' ? Number(k) : Number(k)
    if (typeof v !== 'string') {
      throw new TypeError(`Expected string scalar in ${field}`)
    }
    out[idx] = v
  }
  return out
}

function encodeMentalPokerMap(payload: MentalPokerPayload): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_SCHEMA_VERSION, payload.schemaVersion ?? 1],
    [CBOR_KEY_HAND_ID, payload.handId],
    [CBOR_KEY_ACTION, payload.action],
  ])
  if (payload.actor !== undefined) {
    map.set(CBOR_KEY_ACTOR, payload.actor)
  }
  if (payload.stakeWei !== undefined) {
    map.set(CBOR_KEY_STAKE_WEI, payload.stakeWei)
  }
  if (payload.deckX !== undefined) {
    map.set(CBOR_KEY_DECK_X, payload.deckX)
  }
  if (payload.deckY !== undefined) {
    map.set(CBOR_KEY_DECK_Y, payload.deckY)
  }
  if (payload.deckZ !== undefined) {
    map.set(CBOR_KEY_DECK_Z, payload.deckZ)
  }
  if (payload.revealedKeysA !== undefined) {
    map.set(CBOR_KEY_REVEALED_KEYS_A, encodeKeyRecord(payload.revealedKeysA))
  }
  if (payload.revealedKeysB !== undefined) {
    map.set(CBOR_KEY_REVEALED_KEYS_B, encodeKeyRecord(payload.revealedKeysB))
  }
  if (payload.revealedKeys !== undefined) {
    map.set(CBOR_KEY_REVEALED_KEYS, encodeKeyRecord(payload.revealedKeys))
  }
  if (payload.subAction !== undefined) {
    map.set(CBOR_KEY_SUB_ACTION, payload.subAction)
  }
  if (payload.amountWei !== undefined) {
    map.set(CBOR_KEY_AMOUNT_WEI, payload.amountWei)
  }
  if (payload.winnerRole !== undefined) {
    map.set(CBOR_KEY_WINNER_ROLE, payload.winnerRole)
  }
  return map
}

function decodeMentalPokerMap(decoded: FrankValue): MentalPokerPayload {
  if (!(decoded instanceof Map)) {
    throw new TypeError('Expected canonical CBOR map for mental-poker-v1 payload')
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 13n) {
      throw new TypeError(`Unexpected CBOR key in mental-poker-v1: ${String(key)}`)
    }
  }

  const rawSchemaVersion = decoded.get(BigInt(CBOR_KEY_SCHEMA_VERSION))
  if (rawSchemaVersion !== undefined && rawSchemaVersion !== 1n) {
    throw new TypeError(`Unsupported mental-poker-v1 schemaVersion: ${String(rawSchemaVersion)}`)
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    handId: decoded.get(BigInt(CBOR_KEY_HAND_ID)),
    action: decoded.get(BigInt(CBOR_KEY_ACTION)),
  }

  if (decoded.has(BigInt(CBOR_KEY_ACTOR))) {
    candidate.actor = decoded.get(BigInt(CBOR_KEY_ACTOR))
  }
  if (decoded.has(BigInt(CBOR_KEY_STAKE_WEI))) {
    candidate.stakeWei = decoded.get(BigInt(CBOR_KEY_STAKE_WEI))
  }
  if (decoded.has(BigInt(CBOR_KEY_DECK_X))) {
    candidate.deckX = decoded.get(BigInt(CBOR_KEY_DECK_X))
  }
  if (decoded.has(BigInt(CBOR_KEY_DECK_Y))) {
    candidate.deckY = decoded.get(BigInt(CBOR_KEY_DECK_Y))
  }
  if (decoded.has(BigInt(CBOR_KEY_DECK_Z))) {
    candidate.deckZ = decoded.get(BigInt(CBOR_KEY_DECK_Z))
  }
  if (decoded.has(BigInt(CBOR_KEY_REVEALED_KEYS_A))) {
    candidate.revealedKeysA = decodeKeyRecord(
      decoded.get(BigInt(CBOR_KEY_REVEALED_KEYS_A))!,
      'revealedKeysA',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_REVEALED_KEYS_B))) {
    candidate.revealedKeysB = decodeKeyRecord(
      decoded.get(BigInt(CBOR_KEY_REVEALED_KEYS_B))!,
      'revealedKeysB',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_REVEALED_KEYS))) {
    candidate.revealedKeys = decodeKeyRecord(
      decoded.get(BigInt(CBOR_KEY_REVEALED_KEYS))!,
      'revealedKeys',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_SUB_ACTION))) {
    candidate.subAction = decoded.get(BigInt(CBOR_KEY_SUB_ACTION))
  }
  if (decoded.has(BigInt(CBOR_KEY_AMOUNT_WEI))) {
    candidate.amountWei = decoded.get(BigInt(CBOR_KEY_AMOUNT_WEI))
  }
  if (decoded.has(BigInt(CBOR_KEY_WINNER_ROLE))) {
    candidate.winnerRole = decoded.get(BigInt(CBOR_KEY_WINNER_ROLE))
  }

  return readMentalPokerPayload(candidate)
}

export function encodeMentalPokerPayload(payload: MentalPokerPayload): Uint8Array {
  const validated = readMentalPokerPayload(payload)
  return encodeCanonical(encodeMentalPokerMap(validated))
}

export function decodeMentalPokerPayload(
  bytes: Uint8Array,
  context?: MessageItemDecodeContext,
): MentalPokerPayload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('Expected non-empty Uint8Array for mental-poker-v1 payload')
  }
  const budget = context?.budget ?? standaloneItemBudget()
  const decoded = budget.decodeCbor(bytes, MENTAL_POKER_PLUGIN_ID)
  return decodeMentalPokerMap(decoded)
}

export function toMentalPokerApplicationItem(
  payload: MentalPokerPayload,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: MENTAL_POKER_PLUGIN_ID,
    value: readMentalPokerPayload(payload),
  }
}

export function parseMentalPokerApplicationItem(
  item: unknown,
): MentalPokerPayload | null {
  return extractMentalPokerPayload(item)
}

export function buildMentalPokerSummary(payload: MentalPokerPayload): string {
  const validated = readMentalPokerPayload(payload)
  switch (validated.action) {
    case 'challenge':
      return `🃏 Mental Poker: Heads-Up Challenge (${validated.handId.slice(0, 8)})`
    case 'shuffle_and_lock':
      return `🃏 Mental Poker: Shuffled & Double-Locked Deck`
    case 'lock_and_deal':
      return `🃏 Mental Poker: Dealt 52 Double-Locked Cards`
    case 'unlock_hole_cards':
      return `🃏 Mental Poker: Hole Cards Unlocked`
    case 'bet_action':
      if (validated.subAction) {
        return `🃏 Mental Poker: ${validated.subAction.toUpperCase()}${
          validated.amountWei ? ` (${validated.amountWei} wei)` : ''
        }`
      }
      return `🃏 Mental Poker: Card Keys Revealed`
    case 'settle':
      return `🃏 Mental Poker: Pot Settled!`
  }
}

function unwrapPayload(
  input: MentalPokerPayload | ApplicationMessageItem,
): MentalPokerPayload {
  if (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'application'
  ) {
    if (input.itemType !== MENTAL_POKER_PLUGIN_ID) {
      throw new TypeError(`Expected ${MENTAL_POKER_PLUGIN_ID} application item`)
    }
    return readMentalPokerPayload(input.value)
  }
  return readMentalPokerPayload(input)
}

export interface MentalPokerItemPluginContract
  extends ApplicationItemPlugin<MentalPokerPayload>,
    Omit<
      MessageItemPlugin<ApplicationMessageItem, MentalPokerPayload>,
      'encode' | 'decode' | 'previewText' | 'hydrate'
    > {
  readonly pluginId: typeof MENTAL_POKER_PLUGIN_ID
  readonly type: typeof MENTAL_POKER_PLUGIN_ID
  readonly itemType: typeof MENTAL_POKER_ITEM_TYPE
  read(value: unknown): MentalPokerPayload
  buildSummary(payload: MentalPokerPayload | ApplicationMessageItem): string
  previewText(payload: MentalPokerPayload | ApplicationMessageItem): string
  encode(payload: MentalPokerPayload | ApplicationMessageItem): Uint8Array
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): MentalPokerPayload
  hydrate(
    raw: ApplicationMessageItem | MentalPokerPayload,
  ): MentalPokerPayload
}

export const mentalPokerPlugin: MentalPokerItemPluginContract = {
  pluginId: MENTAL_POKER_PLUGIN_ID,
  type: MENTAL_POKER_PLUGIN_ID,
  itemType: MENTAL_POKER_ITEM_TYPE,
  read: readMentalPokerPayload,
  hydrate(raw: ApplicationMessageItem | MentalPokerPayload): MentalPokerPayload {
    return unwrapPayload(raw)
  },
  buildSummary(input: MentalPokerPayload | ApplicationMessageItem): string {
    return buildMentalPokerSummary(unwrapPayload(input))
  },
  previewText(input: MentalPokerPayload | ApplicationMessageItem): string {
    return buildMentalPokerSummary(unwrapPayload(input))
  },
  encode(input: MentalPokerPayload | ApplicationMessageItem): Uint8Array {
    return encodeMentalPokerPayload(unwrapPayload(input))
  },
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): MentalPokerPayload {
    return decodeMentalPokerPayload(bytes, context)
  },
}

export function createMentalPokerPlugin(): ApplicationItemPlugin<MentalPokerPayload> {
  return mentalPokerPlugin
}

export function initMentalPokerPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities(MENTAL_POKER_PLUGIN_ID, capabilities)
  registry.registerApplication(mentalPokerPlugin)
}
