/**
 * Heads-Up Mental Poker State Machine & Protocol Types (Issue #62).
 *
 * Implements 1:1 Heads-Up Texas Hold'em over Stamp messages without a trusted dealer.
 *
 * Deck index layout in Z_{0..51}:
 * - Indices 0, 1: Challenger (Alice) hole cards
 * - Indices 2, 3: Accepter (Bob) hole cards
 * - Indices 4, 5, 6: Flop cards
 * - Index 7: Turn card
 * - Index 8: River card
 */
import type { ApplicationMessageItem, Message, MessageItem } from '@frank/cashweb/types/messages'
import { formatCard } from '../poker/deck'
import {
  assertValidEncryptedDeck,
  compareHandRanks,
  DECK_SIZE,
  decryptLockedCard,
  evaluateBest7CardHand,
  isValidCompressedPointHex,
  isValidScalarHex,
  type HandEvaluation,
  type MentalPokerRole,
  type MentalPokerSecrets,
} from './crypto'

export const MENTAL_POKER_PLUGIN_ID = 'mental-poker-v1' as const
export const MENTAL_POKER_ITEM_TYPE = MENTAL_POKER_PLUGIN_ID
export const MENTAL_POKER_SCHEMA_VERSION = 1 as const

export const CHALLENGER_HOLE_INDICES = Object.freeze([0, 1] as const)
export const ACCEPTER_HOLE_INDICES = Object.freeze([2, 3] as const)
export const FLOP_CARD_INDICES = Object.freeze([4, 5, 6] as const)
export const TURN_CARD_INDICES = Object.freeze([7] as const)
export const RIVER_CARD_INDICES = Object.freeze([8] as const)
export const ALL_BOARD_INDICES = Object.freeze([4, 5, 6, 7, 8] as const)
export const ALL_SHOWDOWN_INDICES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8] as const)

export type MentalPokerAction =
  | 'challenge'
  | 'shuffle_and_lock'
  | 'lock_and_deal'
  | 'unlock_hole_cards'
  | 'bet_action'
  | 'settle'

export type MentalPokerBetSubAction = 'check' | 'call' | 'raise' | 'fold'

export type MentalPokerStreet =
  | 'locking'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'complete'

export interface MentalPokerPayload {
  schemaVersion?: 1
  handId: string
  action: MentalPokerAction
  /** Optional explicit role of the sender ('challenger' | 'accepter'). */
  actor?: MentalPokerRole
  /** Initial stake per player in wei (decimal string). */
  stakeWei?: string
  /** Step 1: Challenger's 52 shuffled single-locked compressed curve points X_{0..51}. */
  deckX?: string[]
  /** Step 2: Accepter's 52 re-shuffled double-locked compressed curve points Y_{0..51}. */
  deckY?: string[]
  /** Step 3: Challenger's 52 stripped & per-card locked compressed curve points Z_{0..51}. */
  deckZ?: string[]
  /** Challenger's revealed per-card lock scalars k_{A,i} keyed by deck index. */
  revealedKeysA?: Record<number, string>
  /** Accepter's revealed per-card lock scalars k_{B,i} keyed by deck index. */
  revealedKeysB?: Record<number, string>
  /** Per-card lock scalars revealed during bet_action / street progression / showdown. */
  revealedKeys?: Record<number, string>
  /** Betting sub-action when action === 'bet_action'. */
  subAction?: MentalPokerBetSubAction
  /** Additional bet/call/settle amount in wei (decimal string). */
  amountWei?: string
  /** Winner role on settle ('challenger' | 'accepter' | 'split'). */
  winnerRole?: MentalPokerRole | 'split'
}

export interface MentalPokerMessageInput {
  payload?: MentalPokerPayload
  item?: ApplicationMessageItem | MessageItem | MentalPokerPayload
  items?: readonly (ApplicationMessageItem | MessageItem)[]
  senderRole?: MentalPokerRole
  outbound?: boolean
  senderAddress?: string
  stampValueWei?: bigint | string
}

export interface FoldedMentalPokerState {
  handId: string
  viewerRole: MentalPokerRole
  street: MentalPokerStreet
  /** Whose turn it is to act next, or null if hand is complete or awaiting automatic key reveal. */
  turnRole: MentalPokerRole | null
  /** Initial stake per player in wei. */
  stakeWei: bigint
  /** Total committed pot in wei across both players. */
  potWei: bigint
  /** Total wei committed by challenger. */
  challengerCommittedWei: bigint
  /** Total wei committed by accepter. */
  accepterCommittedWei: bigint
  /** Amount in wei the active turn player must pay to call (0n if check is allowed). */
  pendingCallWei: bigint
  /** Challenger's initial encrypted deck X (52 compressed points). */
  deckX: string[] | null
  /** Accepter's shuffled & locked deck Y (52 compressed points). */
  deckY: string[] | null
  /** Final double-locked deck Z (52 compressed points). */
  deckZ: string[] | null
  /** All verified challenger lock scalars k_{A,i} revealed publicly so far. */
  revealedKeysA: Record<number, string>
  /** All verified accepter lock scalars k_{B,i} revealed publicly so far. */
  revealedKeysB: Record<number, string>
  /** Decrypted card index (0..51) at each unlocked position in Z. */
  decryptedByIndex: Record<number, number>
  /** Viewer's own 2 decrypted hole cards (available as soon as peer unlocks them). */
  viewerHoleCards: number[]
  /** Opponent's 2 decrypted hole cards (empty until showdown keys are revealed). */
  opponentHoleCards: number[]
  /** Challenger's 2 hole cards (populated for challenger or at showdown). */
  challengerHoleCards: number[]
  /** Accepter's 2 hole cards (populated for accepter or at showdown). */
  accepterHoleCards: number[]
  /** Decrypted community cards (0, 3, 4, or 5 cards for preflop/flop/turn/river). */
  communityCards: number[]
  /** Card indices that the viewer needs to reveal next to advance the street/showdown. */
  pendingViewerKeyRevealIndices: number[]
  /** True if all 52 points in Z and all revealed keys so far are cryptographically valid. */
  deckVerified: boolean
  /** True if any invalid curve point, forged key scalar, or duplicate decrypted card was detected. */
  cheatingDetected: boolean
  /** Human-readable explanation when cheatingDetected is true. */
  cheatingReason?: string
  /** Role of the player who folded, if any. */
  foldedBy?: MentalPokerRole
  /** Winner at fold or showdown ('challenger' | 'accepter' | 'split' | null). */
  winner: MentalPokerRole | 'split' | null
  /** Whether a settle message has been recorded. */
  settled: boolean
  /** Amount paid in the settle message, if settled. */
  settledAmountWei: bigint
  /** Hand evaluation for challenger at showdown. */
  challengerEvaluation?: HandEvaluation
  /** Hand evaluation for accepter at showdown. */
  accepterEvaluation?: HandEvaluation
  /** Action log for UI display. */
  actionHistory: Array<{
    actor: MentalPokerRole
    action: MentalPokerAction
    subAction?: MentalPokerBetSubAction
    amountWei?: string
  }>
}

function isDecimalWeiString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)
}

export function normalizeRevealedKeyMap(
  raw: unknown,
  field = 'revealedKeys',
): Record<number, string> {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null)
  ) {
    throw new TypeError(`${field} must be a plain object mapping card indices to hex scalars`)
  }
  const out: Record<number, string> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > DECK_SIZE) {
    throw new RangeError(`${field} cannot contain more than ${DECK_SIZE} entries`)
  }
  for (const [k, v] of entries) {
    if (!/^(0|[1-9][0-9]*)$/.test(k)) {
      throw new TypeError(`${field} key "${k}" must be a card index in 0..51`)
    }
    const idx = Number(k)
    if (!Number.isInteger(idx) || idx < 0 || idx >= DECK_SIZE) {
      throw new RangeError(`${field} index ${idx} out of range 0..51`)
    }
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(v.replace(/^0x/i, ''))) {
      throw new TypeError(`${field}[${idx}] must be a hex scalar string`)
    }
    out[idx] = v.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
  }
  return out
}

function validatePointArraySyntax(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length !== DECK_SIZE) {
    throw new TypeError(`${field} must be an array of ${DECK_SIZE} compressed secp256k1 points`)
  }
  return raw.map((pt, idx) => {
    if (!isValidCompressedPointHex(pt)) {
      throw new TypeError(`${field}[${idx}] must be a valid 33-byte compressed secp256k1 point`)
    }
    return pt.toLowerCase()
  })
}

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'schemaVersion',
  'handId',
  'action',
  'actor',
  'stakeWei',
  'deckX',
  'deckY',
  'deckZ',
  'revealedKeysA',
  'revealedKeysB',
  'revealedKeys',
  'subAction',
  'amountWei',
  'winnerRole',
])

export function readMentalPokerPayload(value: unknown): MentalPokerPayload {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('Expected mental-poker-v1 payload object')
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !ALLOWED_PAYLOAD_KEYS.has(key)) {
      throw new TypeError(`Unexpected mental-poker-v1 property: ${String(key)}`)
    }
  }

  const raw = value as Record<string, unknown>

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new TypeError(`Unsupported mental-poker-v1 schemaVersion: ${String(raw.schemaVersion)}`)
  }

  if (typeof raw.handId !== 'string' || raw.handId.trim().length === 0 || raw.handId.length > 128) {
    throw new TypeError('mental-poker-v1 handId must be a non-empty string (<= 128 chars)')
  }

  const action = raw.action
  if (
    action !== 'challenge' &&
    action !== 'shuffle_and_lock' &&
    action !== 'lock_and_deal' &&
    action !== 'unlock_hole_cards' &&
    action !== 'bet_action' &&
    action !== 'settle'
  ) {
    throw new TypeError(`Invalid mental-poker-v1 action: ${String(action)}`)
  }

  const result: MentalPokerPayload = {
    schemaVersion: 1,
    handId: raw.handId.trim(),
    action,
  }

  if (raw.actor !== undefined) {
    if (raw.actor !== 'challenger' && raw.actor !== 'accepter') {
      throw new TypeError(`Invalid mental-poker-v1 actor: ${String(raw.actor)}`)
    }
    result.actor = raw.actor
  }

  if (raw.stakeWei !== undefined) {
    if (!isDecimalWeiString(raw.stakeWei)) {
      throw new TypeError('mental-poker-v1 stakeWei must be a non-negative decimal wei string')
    }
    result.stakeWei = raw.stakeWei
  }

  if (raw.amountWei !== undefined) {
    if (!isDecimalWeiString(raw.amountWei)) {
      throw new TypeError('mental-poker-v1 amountWei must be a non-negative decimal wei string')
    }
    result.amountWei = raw.amountWei
  }

  if (raw.deckX !== undefined) {
    result.deckX = validatePointArraySyntax(raw.deckX, 'deckX')
  }
  if (raw.deckY !== undefined) {
    result.deckY = validatePointArraySyntax(raw.deckY, 'deckY')
  }
  if (raw.deckZ !== undefined) {
    result.deckZ = validatePointArraySyntax(raw.deckZ, 'deckZ')
  }

  if (raw.revealedKeysA !== undefined) {
    result.revealedKeysA = normalizeRevealedKeyMap(raw.revealedKeysA, 'revealedKeysA')
  }
  if (raw.revealedKeysB !== undefined) {
    result.revealedKeysB = normalizeRevealedKeyMap(raw.revealedKeysB, 'revealedKeysB')
  }
  if (raw.revealedKeys !== undefined) {
    result.revealedKeys = normalizeRevealedKeyMap(raw.revealedKeys, 'revealedKeys')
  }

  if (raw.subAction !== undefined) {
    if (
      raw.subAction !== 'check' &&
      raw.subAction !== 'call' &&
      raw.subAction !== 'raise' &&
      raw.subAction !== 'fold'
    ) {
      throw new TypeError(`Invalid mental-poker-v1 subAction: ${String(raw.subAction)}`)
    }
    result.subAction = raw.subAction
  }

  if (raw.winnerRole !== undefined) {
    if (
      raw.winnerRole !== 'challenger' &&
      raw.winnerRole !== 'accepter' &&
      raw.winnerRole !== 'split'
    ) {
      throw new TypeError(`Invalid mental-poker-v1 winnerRole: ${String(raw.winnerRole)}`)
    }
    result.winnerRole = raw.winnerRole
  }

  // Action-specific required fields
  if (action === 'challenge') {
    if (!result.deckX) {
      throw new TypeError('mental-poker-v1 challenge requires deckX')
    }
    if (!result.stakeWei) {
      result.stakeWei = '0'
    }
  } else if (action === 'shuffle_and_lock') {
    if (!result.deckY) {
      throw new TypeError('mental-poker-v1 shuffle_and_lock requires deckY')
    }
  } else if (action === 'lock_and_deal') {
    if (!result.deckZ) {
      throw new TypeError('mental-poker-v1 lock_and_deal requires deckZ')
    }
    if (!result.revealedKeysA) {
      throw new TypeError('mental-poker-v1 lock_and_deal requires revealedKeysA')
    }
  } else if (action === 'unlock_hole_cards') {
    if (!result.revealedKeysB) {
      throw new TypeError('mental-poker-v1 unlock_hole_cards requires revealedKeysB')
    }
  } else if (action === 'bet_action') {
    if (!result.subAction && !result.revealedKeys) {
      throw new TypeError('mental-poker-v1 bet_action requires subAction or revealedKeys')
    }
  }

  return result
}

export function extractMentalPokerPayload(
  input: unknown,
): MentalPokerPayload | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Record<string, unknown>
  if (candidate.type === 'application') {
    if (candidate.itemType !== MENTAL_POKER_PLUGIN_ID) return null
    try {
      return readMentalPokerPayload(candidate.value)
    } catch {
      return null
    }
  }
  if ('action' in candidate && 'handId' in candidate) {
    try {
      return readMentalPokerPayload(candidate)
    } catch {
      return null
    }
  }
  return null
}

function oppositeRole(role: MentalPokerRole): MentalPokerRole {
  return role === 'challenger' ? 'accepter' : 'challenger'
}

function normalizeMessageList(
  messages: readonly (MentalPokerPayload | MentalPokerMessageInput | Message)[],
  viewerRole: MentalPokerRole,
): Array<{ payload: MentalPokerPayload; actorHint?: MentalPokerRole; stampValueWei?: bigint }> {
  const normalized: Array<{
    payload: MentalPokerPayload
    actorHint?: MentalPokerRole
    stampValueWei?: bigint
  }> = []

  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue

    // Direct MentalPokerPayload
    const direct = extractMentalPokerPayload(entry)
    if (direct) {
      normalized.push({ payload: direct, actorHint: direct.actor })
      continue
    }

    const wrapper = entry as MentalPokerMessageInput
    const roleFromOutbound =
      typeof wrapper.outbound === 'boolean'
        ? wrapper.outbound
          ? viewerRole
          : oppositeRole(viewerRole)
        : undefined
    const actorHint = wrapper.senderRole ?? roleFromOutbound
    const stampValueWei =
      typeof wrapper.stampValueWei === 'bigint'
        ? wrapper.stampValueWei
        : typeof wrapper.stampValueWei === 'string' && isDecimalWeiString(wrapper.stampValueWei)
          ? BigInt(wrapper.stampValueWei)
          : undefined

    if (wrapper.payload) {
      const parsed = extractMentalPokerPayload(wrapper.payload)
      if (parsed) {
        normalized.push({
          payload: parsed,
          actorHint: parsed.actor ?? actorHint,
          stampValueWei,
        })
      }
      continue
    }

    if (wrapper.item) {
      const parsed = extractMentalPokerPayload(wrapper.item)
      if (parsed) {
        normalized.push({
          payload: parsed,
          actorHint: parsed.actor ?? actorHint,
          stampValueWei,
        })
      }
      continue
    }

    if (Array.isArray(wrapper.items)) {
      for (const item of wrapper.items) {
        const parsed = extractMentalPokerPayload(item)
        if (parsed) {
          normalized.push({
            payload: parsed,
            actorHint: parsed.actor ?? actorHint,
            stampValueWei,
          })
        }
      }
    }
  }

  return normalized
}

function indicesForNextStreet(currentStreet: MentalPokerStreet): readonly number[] {
  if (currentStreet === 'preflop') return FLOP_CARD_INDICES
  if (currentStreet === 'flop') return TURN_CARD_INDICES
  if (currentStreet === 'turn') return RIVER_CARD_INDICES
  if (currentStreet === 'river') return [0, 1, 2, 3]
  return []
}

function haveBothKeysForIndices(
  indices: readonly number[],
  keysA: Record<number, string>,
  keysB: Record<number, string>,
): boolean {
  return indices.every(idx => Boolean(keysA[idx]) && Boolean(keysB[idx]))
}

/**
 * Deterministically folds a sequence of mental-poker-v1 messages for a single hand,
 * verifying curve points and revealed card keys, decrypting the viewer's private
 * hole cards and public community cards, and evaluating showdown hands.
 */
export function foldMentalPokerState(
  messages: readonly (MentalPokerPayload | MentalPokerMessageInput | Message)[],
  viewerRole: MentalPokerRole,
  viewerSecrets?: MentalPokerSecrets,
): FoldedMentalPokerState {
  const list = normalizeMessageList(messages, viewerRole)
  const handId = list[0]?.payload.handId ?? viewerSecrets?.handId ?? 'unknown-hand'

  const state: FoldedMentalPokerState = {
    handId,
    viewerRole,
    street: 'locking',
    turnRole: 'challenger',
    stakeWei: 0n,
    potWei: 0n,
    challengerCommittedWei: 0n,
    accepterCommittedWei: 0n,
    pendingCallWei: 0n,
    deckX: null,
    deckY: null,
    deckZ: null,
    revealedKeysA: {},
    revealedKeysB: {},
    decryptedByIndex: {},
    viewerHoleCards: [],
    opponentHoleCards: [],
    challengerHoleCards: [],
    accepterHoleCards: [],
    communityCards: [],
    pendingViewerKeyRevealIndices: [],
    deckVerified: false,
    cheatingDetected: false,
    winner: null,
    settled: false,
    settledAmountWei: 0n,
    actionHistory: [],
  }

  let streetCheckCount = 0
  let awaitingKeyIndices: readonly number[] = []

  const flagCheating = (reason: string): void => {
    if (!state.cheatingDetected) {
      state.cheatingDetected = true
      state.cheatingReason = reason
    }
  }

  const recordKey = (role: MentalPokerRole, idx: number, scalarHex: string): void => {
    if (!isValidScalarHex(scalarHex)) {
      flagCheating(`Invalid scalar hex revealed by ${role} for card index ${idx}`)
      return
    }
    const target = role === 'challenger' ? state.revealedKeysA : state.revealedKeysB
    if (target[idx] && target[idx] !== scalarHex) {
      flagCheating(`Conflicting scalar revealed by ${role} for card index ${idx}`)
      return
    }
    target[idx] = scalarHex
  }

  const recomputeDecryptions = (): void => {
    if (!state.deckZ) return

    // Build effective key maps including viewer's own private lockScalars for viewer's hole cards
    const effectiveA: Record<number, string> = { ...state.revealedKeysA }
    const effectiveB: Record<number, string> = { ...state.revealedKeysB }

    if (viewerSecrets && Array.isArray(viewerSecrets.lockScalars)) {
      if (viewerRole === 'challenger') {
        for (const idx of CHALLENGER_HOLE_INDICES) {
          if (viewerSecrets.lockScalars[idx]) {
            effectiveA[idx] = viewerSecrets.lockScalars[idx]
          }
        }
      } else {
        for (const idx of ACCEPTER_HOLE_INDICES) {
          if (viewerSecrets.lockScalars[idx]) {
            effectiveB[idx] = viewerSecrets.lockScalars[idx]
          }
        }
      }
    }

    const seenCardValues = new Map<number, number>()
    for (const idx of ALL_SHOWDOWN_INDICES) {
      const kA = effectiveA[idx]
      const kB = effectiveB[idx]
      if (!kA || !kB) continue

      const card = decryptLockedCard(state.deckZ[idx], kA, kB)
      if (card === null) {
        flagCheating(`Key verification failed at deck index ${idx}: unlocked point is not a canonical card`)
        continue
      }
      const prevIdx = seenCardValues.get(card)
      if (prevIdx !== undefined && prevIdx !== idx) {
        flagCheating(`Duplicate decrypted card ${formatCard(card)} at indices ${prevIdx} and ${idx}`)
        continue
      }
      seenCardValues.set(card, idx)
      state.decryptedByIndex[idx] = card
    }

    // Challenger hole cards (0, 1)
    if (
      state.decryptedByIndex[0] !== undefined &&
      state.decryptedByIndex[1] !== undefined
    ) {
      state.challengerHoleCards = [
        state.decryptedByIndex[0],
        state.decryptedByIndex[1],
      ]
    }

    // Accepter hole cards (2, 3)
    if (
      state.decryptedByIndex[2] !== undefined &&
      state.decryptedByIndex[3] !== undefined
    ) {
      state.accepterHoleCards = [
        state.decryptedByIndex[2],
        state.decryptedByIndex[3],
      ]
    }

    if (viewerRole === 'challenger') {
      state.viewerHoleCards = [...state.challengerHoleCards]
      // Opponent's hole cards are only known when both public keys for 2,3 are revealed
      if (
        state.revealedKeysA[2] &&
        state.revealedKeysB[2] &&
        state.revealedKeysA[3] &&
        state.revealedKeysB[3] &&
        state.decryptedByIndex[2] !== undefined &&
        state.decryptedByIndex[3] !== undefined
      ) {
        state.opponentHoleCards = [...state.accepterHoleCards]
      }
    } else {
      state.viewerHoleCards = [...state.accepterHoleCards]
      if (
        state.revealedKeysA[0] &&
        state.revealedKeysB[0] &&
        state.revealedKeysA[1] &&
        state.revealedKeysB[1] &&
        state.decryptedByIndex[0] !== undefined &&
        state.decryptedByIndex[1] !== undefined
      ) {
        state.opponentHoleCards = [...state.challengerHoleCards]
      }
    }

    // Community cards (4, 5, 6, 7, 8) in order as unlocked by BOTH players
    const board: number[] = []
    if (
      haveBothKeysForIndices(FLOP_CARD_INDICES, state.revealedKeysA, state.revealedKeysB) &&
      FLOP_CARD_INDICES.every(i => state.decryptedByIndex[i] !== undefined)
    ) {
      board.push(
        state.decryptedByIndex[4],
        state.decryptedByIndex[5],
        state.decryptedByIndex[6],
      )
      if (
        haveBothKeysForIndices(TURN_CARD_INDICES, state.revealedKeysA, state.revealedKeysB) &&
        state.decryptedByIndex[7] !== undefined
      ) {
        board.push(state.decryptedByIndex[7])
        if (
          haveBothKeysForIndices(RIVER_CARD_INDICES, state.revealedKeysA, state.revealedKeysB) &&
          state.decryptedByIndex[8] !== undefined
        ) {
          board.push(state.decryptedByIndex[8])
        }
      }
    }
    state.communityCards = board
  }

  const tryAdvanceStreetFromKeys = (): void => {
    recomputeDecryptions()
    if (state.cheatingDetected) {
      state.turnRole = null
      return
    }

    // Check if we were waiting on keys for the next street and now have both players' keys
    while (
      awaitingKeyIndices.length > 0 &&
      haveBothKeysForIndices(awaitingKeyIndices, state.revealedKeysA, state.revealedKeysB)
    ) {
      if (state.street === 'preflop') {
        state.street = 'flop'
        state.turnRole = 'challenger'
        streetCheckCount = 0
        awaitingKeyIndices = []
      } else if (state.street === 'flop') {
        state.street = 'turn'
        state.turnRole = 'challenger'
        streetCheckCount = 0
        awaitingKeyIndices = []
      } else if (state.street === 'turn') {
        state.street = 'river'
        state.turnRole = 'challenger'
        streetCheckCount = 0
        awaitingKeyIndices = []
      } else if (state.street === 'river') {
        state.street = 'showdown'
        state.turnRole = null
        awaitingKeyIndices = []
      } else {
        break
      }
    }

    // Also allow direct street advancement if keys for flop/turn/river/showdown were attached
    if (
      state.street === 'showdown' ||
      haveBothKeysForIndices(ALL_SHOWDOWN_INDICES, state.revealedKeysA, state.revealedKeysB)
    ) {
      if (
        state.challengerHoleCards.length === 2 &&
        state.accepterHoleCards.length === 2 &&
        state.communityCards.length === 5 &&
        !state.cheatingDetected
      ) {
        state.street = 'showdown'
        state.challengerEvaluation = evaluateBest7CardHand([
          ...state.challengerHoleCards,
          ...state.communityCards,
        ])
        state.accepterEvaluation = evaluateBest7CardHand([
          ...state.accepterHoleCards,
          ...state.communityCards,
        ])
        const cmp = compareHandRanks(
          state.challengerEvaluation,
          state.accepterEvaluation,
        )
        state.winner = cmp > 0 ? 'challenger' : cmp < 0 ? 'accepter' : 'split'
        state.turnRole = null
      }
    }
  }

  for (const { payload, actorHint } of list) {
    if (payload.handId !== state.handId) continue

    if (payload.action === 'challenge') {
      const stake = BigInt(payload.stakeWei ?? '0')
      state.stakeWei = stake
      state.challengerCommittedWei = stake
      state.potWei = stake
      try {
        assertValidEncryptedDeck(payload.deckX ?? [], 'deckX')
        state.deckX = payload.deckX ?? null
      } catch (err) {
        flagCheating((err as Error).message)
      }
      state.street = 'locking'
      state.turnRole = 'accepter'
      state.actionHistory.push({
        actor: 'challenger',
        action: 'challenge',
        amountWei: state.stakeWei.toString(),
      })
      continue
    }

    if (payload.action === 'shuffle_and_lock') {
      try {
        assertValidEncryptedDeck(payload.deckY ?? [], 'deckY')
        state.deckY = payload.deckY ?? null
      } catch (err) {
        flagCheating((err as Error).message)
      }
      state.accepterCommittedWei += state.stakeWei
      state.potWei = state.challengerCommittedWei + state.accepterCommittedWei
      state.turnRole = 'challenger'
      state.actionHistory.push({
        actor: 'accepter',
        action: 'shuffle_and_lock',
        amountWei: state.stakeWei.toString(),
      })
      continue
    }

    if (payload.action === 'lock_and_deal') {
      try {
        assertValidEncryptedDeck(payload.deckZ ?? [], 'deckZ')
        state.deckZ = payload.deckZ ?? null
        state.deckVerified = true
      } catch (err) {
        flagCheating((err as Error).message)
      }
      if (payload.revealedKeysA) {
        for (const [k, v] of Object.entries(payload.revealedKeysA)) {
          recordKey('challenger', Number(k), v)
        }
      }
      recomputeDecryptions()
      state.turnRole = 'accepter'
      state.actionHistory.push({
        actor: 'challenger',
        action: 'lock_and_deal',
      })
      continue
    }

    if (payload.action === 'unlock_hole_cards') {
      if (payload.revealedKeysB) {
        for (const [k, v] of Object.entries(payload.revealedKeysB)) {
          recordKey('accepter', Number(k), v)
        }
      }
      recomputeDecryptions()
      if (!state.cheatingDetected) {
        state.street = 'preflop'
        state.turnRole = 'challenger'
        streetCheckCount = 0
      }
      state.actionHistory.push({
        actor: 'accepter',
        action: 'unlock_hole_cards',
      })
      continue
    }

    if (payload.action === 'bet_action') {
      const actor: MentalPokerRole =
        payload.actor ??
        actorHint ??
        state.turnRole ??
        'challenger'

      if (payload.revealedKeysA) {
        for (const [k, v] of Object.entries(payload.revealedKeysA)) {
          recordKey('challenger', Number(k), v)
        }
      }
      if (payload.revealedKeysB) {
        for (const [k, v] of Object.entries(payload.revealedKeysB)) {
          recordKey('accepter', Number(k), v)
        }
      }
      if (payload.revealedKeys) {
        for (const [k, v] of Object.entries(payload.revealedKeys)) {
          recordKey(actor, Number(k), v)
        }
      }

      if (payload.subAction) {
        state.actionHistory.push({
          actor,
          action: 'bet_action',
          subAction: payload.subAction,
          amountWei: payload.amountWei,
        })

        if (payload.subAction === 'fold') {
          state.foldedBy = actor
          state.winner = oppositeRole(actor)
          state.street = 'complete'
          state.turnRole = null
          continue
        }

        if (payload.subAction === 'raise') {
          const raiseAmount = BigInt(payload.amountWei ?? '0')
          const totalContribution = state.pendingCallWei + raiseAmount
          if (actor === 'challenger') {
            state.challengerCommittedWei += totalContribution
          } else {
            state.accepterCommittedWei += totalContribution
          }
          state.potWei = state.challengerCommittedWei + state.accepterCommittedWei
          state.pendingCallWei = raiseAmount
          state.turnRole = oppositeRole(actor)
          streetCheckCount = 0
        } else if (payload.subAction === 'call') {
          const callAmount =
            payload.amountWei !== undefined
              ? BigInt(payload.amountWei)
              : state.pendingCallWei
          if (actor === 'challenger') {
            state.challengerCommittedWei += callAmount
          } else {
            state.accepterCommittedWei += callAmount
          }
          state.potWei = state.challengerCommittedWei + state.accepterCommittedWei
          state.pendingCallWei = 0n
          awaitingKeyIndices = indicesForNextStreet(state.street)
          streetCheckCount = 0
        } else if (payload.subAction === 'check') {
          streetCheckCount += 1
          if (streetCheckCount >= 2) {
            awaitingKeyIndices = indicesForNextStreet(state.street)
            streetCheckCount = 0
          } else {
            state.turnRole = oppositeRole(actor)
          }
        }
      }

      tryAdvanceStreetFromKeys()

      // If betting closed on this street and we still need keys from one or both players
      if (awaitingKeyIndices.length > 0 && !state.cheatingDetected) {
        const missingA = awaitingKeyIndices.some(i => !state.revealedKeysA[i])
        const missingB = awaitingKeyIndices.some(i => !state.revealedKeysB[i])
        if (missingA) {
          state.turnRole = 'challenger'
        } else if (missingB) {
          state.turnRole = 'accepter'
        }
      }
      continue
    }

    if (payload.action === 'settle') {
      const actor: MentalPokerRole = payload.actor ?? actorHint ?? 'challenger'
      if (payload.revealedKeys) {
        for (const [k, v] of Object.entries(payload.revealedKeys)) {
          recordKey(actor, Number(k), v)
        }
      }
      tryAdvanceStreetFromKeys()
      state.settled = true
      state.settledAmountWei = BigInt(payload.amountWei ?? '0')
      if (payload.winnerRole && !state.winner) {
        state.winner = payload.winnerRole
      }
      state.street = 'complete'
      state.turnRole = null
      state.actionHistory.push({
        actor,
        action: 'settle',
        amountWei: payload.amountWei,
      })
    }
  }

  // Compute pendingViewerKeyRevealIndices if betting closed on a street and viewer hasn't revealed keys yet
  if (awaitingKeyIndices.length > 0 && !state.cheatingDetected) {
    const ownRevealed =
      viewerRole === 'challenger' ? state.revealedKeysA : state.revealedKeysB
    state.pendingViewerKeyRevealIndices = awaitingKeyIndices.filter(
      idx => {
        // Viewer never needs to re-reveal the opponent's hole cards at showdown since they were already revealed in lock_and_deal / unlock_hole_cards
        if (viewerRole === 'challenger' && (idx === 2 || idx === 3) && ownRevealed[idx]) {
          return false
        }
        if (viewerRole === 'accepter' && (idx === 0 || idx === 1) && ownRevealed[idx]) {
          return false
        }
        return !ownRevealed[idx]
      },
    )
  }

  return state
}
