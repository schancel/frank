/**
 * Pure typed-item writing, projection, verification, and modular application schemas
 * for Universal State Channel Update Items (Type 24).
 * (docs/protocol/cbor/direct-message.cddl, Issues #949 and #950).
 */
import { sha256 } from '@noble/hashes/sha256'

import { cborMap, decodeCanonical, encodeCanonical, FrankValue } from './cbor'
import {
  ACCOUNT_REF,
  CHAIN_ALLOCATION,
  CHANNEL_UPDATE_ITEM,
  DICE_GAME_PAYLOAD,
  DICE_GAME_PAYLOAD_SHAPE,
  KEY_TYPE,
  MAX_CHANNEL_ALLOCATIONS,
  MAX_CHANNEL_APP_STATE_BYTES,
  MAX_CHANNEL_PARTICIPANTS,
  MAX_CHANNEL_SIGNATURES,
  PARTICIPANT_BALANCE,
  POKER_GAME_PAYLOAD,
  POKER_GAME_PAYLOAD_SHAPE,
  RAFFLE_PAYLOAD,
  RAFFLE_PAYLOAD_SHAPE,
  SIGNATURE_ALGORITHM,
  SIGNATURE_ENTRY,
  SWAP_OFFER_PAYLOAD,
  SWAP_OFFER_PAYLOAD_SHAPE,
  TYPE_CHANNEL_UPDATE,
  U32_MAX,
  U64_MAX,
} from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { commonTranscript, fromHex, toHex } from './hash'
import type {
  AccountRef,
  ChainAllocation,
  ChannelUpdateItem,
  DiceAction,
  DiceGamePayload,
  ParsedFrame,
  ParticipantBalance,
  PokerGamePayload,
  RafflePayload,
  SignatureEntry,
  SwapOfferPayload,
} from './types'
import { at } from './schema-primitives'
import { parseFrame } from './validate'
import { verifyAlgorithm1 } from './verify'

export interface CanonicalParticipantBalance {
  participant: {
    keyType: number
    pubKey: string
  }
  balance: string | number | bigint
}

export interface CanonicalChainAllocation {
  networkTag: string
  token?: string
  balances: CanonicalParticipantBalance[]
}

export interface CanonicalSignatureEntry {
  algorithm: number
  signer: {
    keyType: number
    pubKey: string
  }
  signature: string
}

export interface CanonicalChannelUpdateItem {
  type: 'channel-update'
  channelId: string
  appId: string
  sequenceNumber: number
  allocations: CanonicalChainAllocation[]
  appState: Uint8Array | string
  signatures: CanonicalSignatureEntry[]
  settlementRef?: string
}

const bad = (message: string, path = 'channel-update/writer') =>
  new FrankCodecError('schema', '8.2', message, path)

const semantic = (message: string, path = 'channel-update/semantic') =>
  new FrankCodecError('semantic', '9', message, path)

function parseHex(
  h: string,
  expectedLen?: number,
  fieldName = 'hex',
): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2).toLowerCase() : h.toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw bad(`${fieldName} must be a valid hex string`)
  }
  const bytes = fromHex(clean)
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw bad(
      `${fieldName} must be exactly ${expectedLen} bytes, got ${bytes.length}`,
    )
  }
  return bytes
}

function parseBytes(
  val: Uint8Array | string | undefined,
  expectedLen?: number,
  fieldName = 'bytes',
): Uint8Array {
  if (val === undefined) {
    throw bad(`${fieldName} is required`)
  }
  if (typeof val === 'string') {
    return parseHex(val, expectedLen, fieldName)
  }
  if (val instanceof Uint8Array) {
    if (expectedLen !== undefined && val.length !== expectedLen) {
      throw bad(
        `${fieldName} must be exactly ${expectedLen} bytes, got ${val.length}`,
      )
    }
    return val
  }
  throw bad(`${fieldName} must be Uint8Array or hex string`)
}

function parseBalance(
  val: string | number | bigint | Uint8Array,
  path = 'balance',
): Uint8Array | bigint {
  if (val instanceof Uint8Array) {
    if (val.length !== 32) {
      throw bad(`${path} byte quantity must be exactly 32 bytes`)
    }
    return val
  }
  if (typeof val === 'number') {
    if (!Number.isSafeInteger(val) || val < 0) {
      throw bad(`${path} number must be a non-negative safe integer`)
    }
    return BigInt(val)
  }
  if (typeof val === 'bigint') {
    if (val < 0n || val > U64_MAX) {
      throw bad(`${path} bigint must be in range 0..${U64_MAX}`)
    }
    return val
  }
  if (typeof val === 'string') {
    const clean = val.startsWith('0x')
      ? val.slice(2).toLowerCase()
      : val.toLowerCase()
    if (
      val.startsWith('0x') &&
      clean.length === 64 &&
      /^[0-9a-f]{64}$/.test(clean)
    ) {
      return fromHex(clean)
    }
    if (/^[0-9]+$/.test(val)) {
      const b = BigInt(val)
      if (b > U64_MAX) {
        // Encode as 32-byte big-endian EVM quantity
        const bytes = new Uint8Array(32)
        let temp = b
        for (let i = 31; i >= 0; i--, temp >>= 8n) {
          bytes[i] = Number(temp & 255n)
        }
        return bytes
      }
      return b
    }
    throw bad(
      `${path} string must be decimal digits or 0x-prefixed 32-byte hex`,
    )
  }
  throw bad(
    `${path} must be a number, bigint, decimal string, or 32-byte Uint8Array`,
  )
}

function toAccountRef(
  signer: { keyType: number; pubKey: string } | AccountRef,
): AccountRef {
  const keyType = signer.keyType
  let keyBytes: Uint8Array
  if ('pubKey' in signer) {
    const expected = keyType === KEY_TYPE.secp256k1 ? 33 : 32
    keyBytes = parseHex(signer.pubKey, expected, 'signer.pubKey')
  } else {
    keyBytes = signer.keyBytes
  }
  return { keyType, keyBytes }
}

function encodeAllocationsCbor(
  allocations: (ChainAllocation | CanonicalChainAllocation)[],
): Map<number | bigint, any>[] {
  if (
    !Array.isArray(allocations) ||
    allocations.length < 1 ||
    allocations.length > MAX_CHANNEL_ALLOCATIONS
  ) {
    throw bad(`allocations must have 1..${MAX_CHANNEL_ALLOCATIONS} items`)
  }

  return allocations.map((a, i) => {
    if (!a.networkTag || typeof a.networkTag !== 'string') {
      throw bad(`allocation[${i}].networkTag must be a non-empty string`)
    }
    let tokenBytes: Uint8Array
    if (a.token === undefined || a.token === '') {
      tokenBytes = new Uint8Array(0)
    } else if (typeof a.token === 'string') {
      tokenBytes = parseHex(a.token, undefined, `allocation[${i}].token`)
    } else if (a.token instanceof Uint8Array) {
      tokenBytes = a.token
    } else {
      throw bad(`allocation[${i}].token must be a hex string or Uint8Array`)
    }

    if (
      !Array.isArray(a.balances) ||
      a.balances.length < 2 ||
      a.balances.length > MAX_CHANNEL_PARTICIPANTS
    ) {
      throw bad(
        `allocation[${i}].balances must have 2..${MAX_CHANNEL_PARTICIPANTS} participant balances`,
      )
    }

    const balancesCbor = a.balances.map((b, j) => {
      const participant = toAccountRef(b.participant)
      const balance = parseBalance(b.balance, `allocation[${i}].balances[${j}]`)
      return cborMap([
        [
          PARTICIPANT_BALANCE.participant,
          cborMap([
            [ACCOUNT_REF.keyType, participant.keyType],
            [ACCOUNT_REF.keyBytes, participant.keyBytes],
          ]),
        ],
        [PARTICIPANT_BALANCE.balance, balance],
      ])
    })

    return cborMap([
      [CHAIN_ALLOCATION.networkTag, a.networkTag],
      [CHAIN_ALLOCATION.token, tokenBytes],
      [CHAIN_ALLOCATION.balances, balancesCbor],
    ])
  })
}

function encodeSignaturesCbor(
  signatures: (SignatureEntry | CanonicalSignatureEntry)[],
): Map<number | bigint, any>[] {
  if (
    !Array.isArray(signatures) ||
    signatures.length < 1 ||
    signatures.length > MAX_CHANNEL_SIGNATURES
  ) {
    throw bad(`signatures must have 1..${MAX_CHANNEL_SIGNATURES} items`)
  }

  return signatures.map((s, i) => {
    const signer = toAccountRef(s.signer)
    const sigBytes =
      typeof s.signature === 'string'
        ? parseHex(s.signature, undefined, `signature[${i}].signature`)
        : s.signature
    return cborMap([
      [SIGNATURE_ENTRY.algorithm, s.algorithm],
      [
        SIGNATURE_ENTRY.signer,
        cborMap([
          [ACCOUNT_REF.keyType, signer.keyType],
          [ACCOUNT_REF.keyBytes, signer.keyBytes],
        ]),
      ],
      [SIGNATURE_ENTRY.signature, sigBytes],
    ])
  })
}

// ---------------------------------------------------------------------------------------------
// Universal Channel Update Item encoding & projection
// ---------------------------------------------------------------------------------------------

export function encodeChannelUpdateItem(
  item: CanonicalChannelUpdateItem | ChannelUpdateItem,
): Uint8Array {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw bad('expected an item object')
  }

  const channelIdBytes = parseBytes(item.channelId, 32, 'channelId')
  if (
    typeof item.appId !== 'string' ||
    item.appId.length < 1 ||
    item.appId.length > 64
  ) {
    throw bad('appId must be a string of 1..64 characters')
  }
  const sequenceNumber = item.sequenceNumber
  if (
    typeof sequenceNumber !== 'number' ||
    !Number.isSafeInteger(sequenceNumber) ||
    sequenceNumber < 0 ||
    sequenceNumber > U32_MAX
  ) {
    throw bad(
      `sequenceNumber must be an unsigned 32-bit integer (0..${U32_MAX})`,
    )
  }

  const allocationsCbor = encodeAllocationsCbor(item.allocations)

  let appStateBytes: Uint8Array
  if (typeof item.appState === 'string') {
    appStateBytes = parseHex(item.appState, undefined, 'appState')
  } else if (item.appState instanceof Uint8Array) {
    appStateBytes = item.appState
  } else {
    throw bad('appState must be Uint8Array or hex string')
  }
  if (appStateBytes.length > MAX_CHANNEL_APP_STATE_BYTES) {
    throw bad(
      `appState exceeds maximum of ${MAX_CHANNEL_APP_STATE_BYTES} bytes`,
    )
  }

  const signaturesCbor = encodeSignaturesCbor(item.signatures)

  const entries: Array<[number, any]> = [
    [CHANNEL_UPDATE_ITEM.channelId, channelIdBytes],
    [CHANNEL_UPDATE_ITEM.appId, item.appId],
    [CHANNEL_UPDATE_ITEM.sequenceNumber, BigInt(sequenceNumber)],
    [CHANNEL_UPDATE_ITEM.allocations, allocationsCbor],
    [CHANNEL_UPDATE_ITEM.appState, appStateBytes],
    [CHANNEL_UPDATE_ITEM.signatures, signaturesCbor],
  ]

  if (item.settlementRef !== undefined) {
    const settlementBytes =
      typeof item.settlementRef === 'string'
        ? parseHex(item.settlementRef, undefined, 'settlementRef')
        : item.settlementRef
    if (settlementBytes.length < 1 || settlementBytes.length > 128) {
      throw bad('settlementRef must be 1..128 bytes')
    }
    entries.push([CHANNEL_UPDATE_ITEM.settlementRef, settlementBytes])
  }

  const frameBytes = encodeFrame(
    {
      typeId: TYPE_CHANNEL_UPDATE,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    cborMap(entries),
  )

  parseFrame(frameBytes)
  return frameBytes
}

export function isChannelUpdateItemFrame(
  frame: ParsedFrame,
): frame is ParsedFrame & { typed: ChannelUpdateItem } {
  return (
    frame.typeId === TYPE_CHANNEL_UPDATE &&
    frame.typed?.type === TYPE_CHANNEL_UPDATE
  )
}

export function projectChannelUpdateItem(
  frame: ParsedFrame,
): CanonicalChannelUpdateItem {
  if (!isChannelUpdateItemFrame(frame)) {
    throw bad('frame is not a valid channel update item')
  }
  const typed = frame.typed
  return {
    type: 'channel-update',
    channelId: toHex(typed.channelId),
    appId: typed.appId,
    sequenceNumber: typed.sequenceNumber,
    allocations: typed.allocations.map(a => ({
      networkTag: a.networkTag,
      token: toHex(a.token),
      balances: a.balances.map(b => ({
        participant: {
          keyType: b.participant.keyType,
          pubKey: toHex(b.participant.keyBytes),
        },
        balance:
          typeof b.balance === 'bigint'
            ? b.balance.toString()
            : toHex(b.balance),
      })),
    })),
    appState: typed.appState,
    signatures: typed.signatures.map(s => ({
      algorithm: s.algorithm,
      signer: {
        keyType: s.signer.keyType,
        pubKey: toHex(s.signer.keyBytes),
      },
      signature: toHex(s.signature),
    })),
    ...(typed.settlementRef !== undefined
      ? { settlementRef: toHex(typed.settlementRef) }
      : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// State Digest and Verification
// ---------------------------------------------------------------------------------------------

export function channelStateDigest(item: {
  channelId: Uint8Array | string
  appId: string
  sequenceNumber: number
  allocations: (ChainAllocation | CanonicalChainAllocation)[]
  appState: Uint8Array | string
  settlementRef?: Uint8Array | string
}): Uint8Array {
  const channelIdBytes = parseBytes(item.channelId, 32, 'channelId')
  const allocationsCbor = encodeAllocationsCbor(item.allocations)
  const appStateBytes =
    typeof item.appState === 'string'
      ? parseHex(item.appState, undefined, 'appState')
      : item.appState

  const entries: Array<[number, any]> = [
    [CHANNEL_UPDATE_ITEM.channelId, channelIdBytes],
    [CHANNEL_UPDATE_ITEM.appId, item.appId],
    [CHANNEL_UPDATE_ITEM.sequenceNumber, BigInt(item.sequenceNumber)],
    [CHANNEL_UPDATE_ITEM.allocations, allocationsCbor],
    [CHANNEL_UPDATE_ITEM.appState, appStateBytes],
  ]

  if (item.settlementRef !== undefined) {
    const settlementBytes =
      typeof item.settlementRef === 'string'
        ? parseHex(item.settlementRef, undefined, 'settlementRef')
        : item.settlementRef
    entries.push([CHANNEL_UPDATE_ITEM.settlementRef, settlementBytes])
  }

  const unsignedCbor = encodeCanonical(cborMap(entries))
  return sha256(
    commonTranscript('frank/channel-state/v1', item.appId, unsignedCbor),
  )
}

export function verifyChannelSignature(
  entry: SignatureEntry | CanonicalSignatureEntry,
  stateDigest: Uint8Array,
): boolean {
  const signer = toAccountRef(entry.signer)
  const sigBytes =
    typeof entry.signature === 'string'
      ? parseHex(entry.signature, undefined, 'signature')
      : entry.signature

  if (
    entry.algorithm === SIGNATURE_ALGORITHM.secp256k1EcdsaDer &&
    signer.keyType === KEY_TYPE.secp256k1
  ) {
    return verifyAlgorithm1(stateDigest, sigBytes, signer.keyBytes)
  }
  // For algorithms 2, 3, 16 basic format validation
  if (sigBytes.length === 64) {
    return true
  }
  return false
}

export function verifyChannelSignatures(
  item: ChannelUpdateItem | CanonicalChannelUpdateItem,
  digest?: Uint8Array,
): boolean {
  const d = digest ?? channelStateDigest(item)
  if (!item.signatures || item.signatures.length === 0) return false
  for (const s of item.signatures) {
    if (!verifyChannelSignature(s, d)) {
      return false
    }
  }
  return true
}

export function validateChannelSequence(
  prior: number | ChannelUpdateItem | CanonicalChannelUpdateItem,
  next: number | ChannelUpdateItem | CanonicalChannelUpdateItem,
): void {
  const priorSeq = typeof prior === 'number' ? prior : prior.sequenceNumber
  const nextSeq = typeof next === 'number' ? next : next.sequenceNumber

  if (nextSeq <= priorSeq) {
    throw semantic(
      `sequence number must be strictly monotonic: next (${nextSeq}) <= prior (${priorSeq})`,
      'channel-update/sequenceNumber',
    )
  }

  if (typeof prior === 'object' && typeof next === 'object') {
    const priorId =
      'type' in prior && prior.type === TYPE_CHANNEL_UPDATE
        ? toHex(prior.channelId)
        : (prior as CanonicalChannelUpdateItem).channelId.toLowerCase()
    const nextId =
      'type' in next && next.type === TYPE_CHANNEL_UPDATE
        ? toHex(next.channelId)
        : (next as CanonicalChannelUpdateItem).channelId.toLowerCase()
    if (priorId !== nextId) {
      throw semantic(
        `channelId mismatch: prior (${priorId}) !== next (${nextId})`,
        'channel-update/channelId',
      )
    }
  }
}

export function validateChannelTransition(
  prior: ChannelUpdateItem | CanonicalChannelUpdateItem,
  next: ChannelUpdateItem | CanonicalChannelUpdateItem,
): void {
  validateChannelSequence(prior, next)
  if (prior.appId !== next.appId) {
    throw semantic(
      `appId mismatch in transition: ${prior.appId} !== ${next.appId}`,
      'channel-update/appId',
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Modular Application Schemas (Issue #950)
// ---------------------------------------------------------------------------------------------

const DICE_PATH = 'dice-payload'
const POKER_PATH = 'poker-payload'
const SWAP_PATH = 'swap-payload'
const RAFFLE_PATH = 'raffle-payload'

// --- 1. Dice Game Payload ---
export function validateDiceGamePayload(payload: DiceGamePayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw bad('dice payload must be an object', DICE_PATH)
  }
  const round = BigInt(payload.round)
  if (round < 0n) {
    throw bad(
      'dice round cannot be negative',
      at(DICE_PATH, DICE_GAME_PAYLOAD.round),
    )
  }
  if (
    payload.action !== 'commit' &&
    payload.action !== 'reveal' &&
    payload.action !== 'roll'
  ) {
    throw bad(
      `invalid dice action: ${payload.action} (must be commit|reveal|roll)`,
      at(DICE_PATH, DICE_GAME_PAYLOAD.action),
    )
  }
  if (
    !(payload.seedCommitment instanceof Uint8Array) ||
    payload.seedCommitment.length !== 32
  ) {
    throw bad(
      'dice seedCommitment must be 32 bytes',
      at(DICE_PATH, DICE_GAME_PAYLOAD.seedCommitment),
    )
  }
  if (payload.revealSeed !== undefined) {
    if (
      !(payload.revealSeed instanceof Uint8Array) ||
      payload.revealSeed.length < 1 ||
      payload.revealSeed.length > 64
    ) {
      throw bad(
        'dice revealSeed must be 1..64 bytes',
        at(DICE_PATH, DICE_GAME_PAYLOAD.revealSeed),
      )
    }
  }
  if (payload.targetRoll !== undefined) {
    if (
      typeof payload.targetRoll !== 'number' ||
      !Number.isSafeInteger(payload.targetRoll) ||
      payload.targetRoll < 0 ||
      payload.targetRoll > 100
    ) {
      throw bad(
        'dice targetRoll must be 0..100',
        at(DICE_PATH, DICE_GAME_PAYLOAD.targetRoll),
      )
    }
  }
  parseBalance(payload.wager, at(DICE_PATH, DICE_GAME_PAYLOAD.wager))
}

export function encodeDiceGamePayload(payload: DiceGamePayload): Uint8Array {
  validateDiceGamePayload(payload)
  const entries: Array<[number, any]> = [
    [DICE_GAME_PAYLOAD.round, BigInt(payload.round)],
    [DICE_GAME_PAYLOAD.action, payload.action],
    [DICE_GAME_PAYLOAD.seedCommitment, payload.seedCommitment],
  ]
  if (payload.revealSeed !== undefined) {
    entries.push([DICE_GAME_PAYLOAD.revealSeed, payload.revealSeed])
  }
  if (payload.targetRoll !== undefined) {
    entries.push([DICE_GAME_PAYLOAD.targetRoll, BigInt(payload.targetRoll)])
  }
  entries.push([
    DICE_GAME_PAYLOAD.wager,
    parseBalance(payload.wager, at(DICE_PATH, DICE_GAME_PAYLOAD.wager)),
  ])

  return encodeCanonical(cborMap(entries))
}

export function decodeDiceGamePayload(bytes: Uint8Array): DiceGamePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('dice payload must be a CBOR map', DICE_PATH)
  }
  if (!DICE_GAME_PAYLOAD_SHAPE.required.every(k => val.has(BigInt(k)))) {
    throw bad('dice payload missing required fields', DICE_PATH)
  }
  const round = val.get(BigInt(DICE_GAME_PAYLOAD.round))
  if (typeof round !== 'bigint' || round < 0n) {
    throw bad(
      'dice round must be a non-negative integer',
      at(DICE_PATH, DICE_GAME_PAYLOAD.round),
    )
  }
  const action = val.get(BigInt(DICE_GAME_PAYLOAD.action))
  if (action !== 'commit' && action !== 'reveal' && action !== 'roll') {
    throw bad('invalid dice action', at(DICE_PATH, DICE_GAME_PAYLOAD.action))
  }
  const seedCommitment = val.get(BigInt(DICE_GAME_PAYLOAD.seedCommitment))
  if (!(seedCommitment instanceof Uint8Array) || seedCommitment.length !== 32) {
    throw bad(
      'dice seedCommitment must be 32 bytes',
      at(DICE_PATH, DICE_GAME_PAYLOAD.seedCommitment),
    )
  }
  let revealSeed: Uint8Array | undefined
  if (val.has(BigInt(DICE_GAME_PAYLOAD.revealSeed))) {
    const rs = val.get(BigInt(DICE_GAME_PAYLOAD.revealSeed))
    if (!(rs instanceof Uint8Array) || rs.length < 1 || rs.length > 64) {
      throw bad(
        'dice revealSeed must be 1..64 bytes',
        at(DICE_PATH, DICE_GAME_PAYLOAD.revealSeed),
      )
    }
    revealSeed = rs
  }
  let targetRoll: number | undefined
  if (val.has(BigInt(DICE_GAME_PAYLOAD.targetRoll))) {
    const tr = val.get(BigInt(DICE_GAME_PAYLOAD.targetRoll))
    if (typeof tr !== 'bigint' || tr < 0n || tr > 100n) {
      throw bad(
        'dice targetRoll must be 0..100',
        at(DICE_PATH, DICE_GAME_PAYLOAD.targetRoll),
      )
    }
    targetRoll = Number(tr)
  }
  const rawWager = val.get(BigInt(DICE_GAME_PAYLOAD.wager))
  let wager: Uint8Array | bigint
  if (rawWager instanceof Uint8Array) {
    if (rawWager.length !== 32)
      throw bad(
        'dice wager bytes must be 32 bytes',
        at(DICE_PATH, DICE_GAME_PAYLOAD.wager),
      )
    wager = rawWager
  } else if (typeof rawWager === 'bigint') {
    if (rawWager < 0n)
      throw bad(
        'dice wager cannot be negative',
        at(DICE_PATH, DICE_GAME_PAYLOAD.wager),
      )
    wager = rawWager
  } else {
    throw bad(
      'dice wager must be 32 bytes or uint',
      at(DICE_PATH, DICE_GAME_PAYLOAD.wager),
    )
  }

  return {
    round,
    action: action as DiceAction,
    seedCommitment,
    revealSeed,
    targetRoll,
    wager,
  }
}

// --- 2. Poker Game Payload ---
export function validatePokerGamePayload(payload: PokerGamePayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw bad('poker payload must be an object', POKER_PATH)
  }
  if (!(payload.handId instanceof Uint8Array) || payload.handId.length !== 32) {
    throw bad(
      'poker handId must be 32 bytes',
      at(POKER_PATH, POKER_GAME_PAYLOAD.handId),
    )
  }
  if (
    typeof payload.phase !== 'string' ||
    payload.phase.length < 1 ||
    payload.phase.length > 32
  ) {
    throw bad(
      'poker phase must be 1..32 characters',
      at(POKER_PATH, POKER_GAME_PAYLOAD.phase),
    )
  }
  if (
    typeof payload.action !== 'string' ||
    payload.action.length < 1 ||
    payload.action.length > 32
  ) {
    throw bad(
      'poker action must be 1..32 characters',
      at(POKER_PATH, POKER_GAME_PAYLOAD.action),
    )
  }
  if (payload.cardCommitments !== undefined) {
    if (
      !Array.isArray(payload.cardCommitments) ||
      payload.cardCommitments.length < 1 ||
      payload.cardCommitments.length > 10
    ) {
      throw bad(
        'poker cardCommitments must be an array of 1..10 items',
        at(POKER_PATH, POKER_GAME_PAYLOAD.cardCommitments),
      )
    }
    for (let i = 0; i < payload.cardCommitments.length; i++) {
      const c = payload.cardCommitments[i]
      if (!(c instanceof Uint8Array) || c.length !== 32) {
        throw bad(
          `poker cardCommitment[${i}] must be 32 bytes`,
          at(POKER_PATH, POKER_GAME_PAYLOAD.cardCommitments),
        )
      }
    }
  }
  if (payload.keys !== undefined) {
    if (
      !Array.isArray(payload.keys) ||
      payload.keys.length < 1 ||
      payload.keys.length > 10
    ) {
      throw bad(
        'poker keys must be an array of 1..10 items',
        at(POKER_PATH, POKER_GAME_PAYLOAD.keys),
      )
    }
    for (let i = 0; i < payload.keys.length; i++) {
      const k = payload.keys[i]
      if (!(k instanceof Uint8Array) || k.length < 1 || k.length > 64) {
        throw bad(
          `poker key[${i}] must be 1..64 bytes`,
          at(POKER_PATH, POKER_GAME_PAYLOAD.keys),
        )
      }
    }
  }
}

export function encodePokerGamePayload(payload: PokerGamePayload): Uint8Array {
  validatePokerGamePayload(payload)
  const entries: Array<[number, any]> = [
    [POKER_GAME_PAYLOAD.handId, payload.handId],
    [POKER_GAME_PAYLOAD.phase, payload.phase],
    [POKER_GAME_PAYLOAD.action, payload.action],
  ]
  if (payload.cardCommitments !== undefined) {
    entries.push([POKER_GAME_PAYLOAD.cardCommitments, payload.cardCommitments])
  }
  if (payload.keys !== undefined) {
    entries.push([POKER_GAME_PAYLOAD.keys, payload.keys])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodePokerGamePayload(bytes: Uint8Array): PokerGamePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('poker payload must be a CBOR map', POKER_PATH)
  }
  if (!POKER_GAME_PAYLOAD_SHAPE.required.every(k => val.has(BigInt(k)))) {
    throw bad('poker payload missing required fields', POKER_PATH)
  }
  const handId = val.get(BigInt(POKER_GAME_PAYLOAD.handId))
  if (!(handId instanceof Uint8Array) || handId.length !== 32) {
    throw bad(
      'poker handId must be 32 bytes',
      at(POKER_PATH, POKER_GAME_PAYLOAD.handId),
    )
  }
  const phase = val.get(BigInt(POKER_GAME_PAYLOAD.phase))
  if (typeof phase !== 'string' || phase.length < 1 || phase.length > 32) {
    throw bad(
      'poker phase must be 1..32 characters',
      at(POKER_PATH, POKER_GAME_PAYLOAD.phase),
    )
  }
  const action = val.get(BigInt(POKER_GAME_PAYLOAD.action))
  if (typeof action !== 'string' || action.length < 1 || action.length > 32) {
    throw bad(
      'poker action must be 1..32 characters',
      at(POKER_PATH, POKER_GAME_PAYLOAD.action),
    )
  }
  let cardCommitments: Uint8Array[] | undefined
  if (val.has(BigInt(POKER_GAME_PAYLOAD.cardCommitments))) {
    const list = val.get(BigInt(POKER_GAME_PAYLOAD.cardCommitments))
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) {
      throw bad(
        'poker cardCommitments must be an array of 1..10 items',
        at(POKER_PATH, POKER_GAME_PAYLOAD.cardCommitments),
      )
    }
    cardCommitments = list.map((c, i) => {
      if (!(c instanceof Uint8Array) || c.length !== 32) {
        throw bad(
          `poker cardCommitment[${i}] must be 32 bytes`,
          at(POKER_PATH, POKER_GAME_PAYLOAD.cardCommitments),
        )
      }
      return c
    })
  }
  let keys: Uint8Array[] | undefined
  if (val.has(BigInt(POKER_GAME_PAYLOAD.keys))) {
    const list = val.get(BigInt(POKER_GAME_PAYLOAD.keys))
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) {
      throw bad(
        'poker keys must be an array of 1..10 items',
        at(POKER_PATH, POKER_GAME_PAYLOAD.keys),
      )
    }
    keys = list.map((k, i) => {
      if (!(k instanceof Uint8Array) || k.length < 1 || k.length > 64) {
        throw bad(
          `poker key[${i}] must be 1..64 bytes`,
          at(POKER_PATH, POKER_GAME_PAYLOAD.keys),
        )
      }
      return k
    })
  }

  return {
    handId,
    phase,
    action,
    cardCommitments,
    keys,
  }
}

// --- 3. Swap Offer Payload ---
export function validateSwapOfferPayload(payload: SwapOfferPayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw bad('swap payload must be an object', SWAP_PATH)
  }
  if (!(payload.swapId instanceof Uint8Array) || payload.swapId.length !== 32) {
    throw bad(
      'swap swapId must be 32 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.swapId),
    )
  }
  if (
    !(payload.makerAsset instanceof Uint8Array) ||
    payload.makerAsset.length > 128
  ) {
    throw bad(
      'swap makerAsset must be 0..128 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAsset),
    )
  }
  parseBalance(
    payload.makerAmount,
    at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAmount),
  )
  if (
    !(payload.takerAsset instanceof Uint8Array) ||
    payload.takerAsset.length > 128
  ) {
    throw bad(
      'swap takerAsset must be 0..128 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAsset),
    )
  }
  parseBalance(
    payload.takerAmount,
    at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAmount),
  )
  const exp = BigInt(payload.expiration)
  if (exp < 0n || exp > BigInt(U32_MAX)) {
    throw bad(
      `swap expiration must be in range 0..${U32_MAX}`,
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.expiration),
    )
  }
  if (payload.htlcHash !== undefined) {
    if (
      !(payload.htlcHash instanceof Uint8Array) ||
      payload.htlcHash.length !== 32
    ) {
      throw bad(
        'swap htlcHash must be 32 bytes',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.htlcHash),
      )
    }
  }
}

export function encodeSwapOfferPayload(payload: SwapOfferPayload): Uint8Array {
  validateSwapOfferPayload(payload)
  const entries: Array<[number, any]> = [
    [SWAP_OFFER_PAYLOAD.swapId, payload.swapId],
    [SWAP_OFFER_PAYLOAD.makerAsset, payload.makerAsset],
    [
      SWAP_OFFER_PAYLOAD.makerAmount,
      parseBalance(
        payload.makerAmount,
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAmount),
      ),
    ],
    [SWAP_OFFER_PAYLOAD.takerAsset, payload.takerAsset],
    [
      SWAP_OFFER_PAYLOAD.takerAmount,
      parseBalance(
        payload.takerAmount,
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAmount),
      ),
    ],
    [SWAP_OFFER_PAYLOAD.expiration, BigInt(payload.expiration)],
  ]
  if (payload.htlcHash !== undefined) {
    entries.push([SWAP_OFFER_PAYLOAD.htlcHash, payload.htlcHash])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodeSwapOfferPayload(bytes: Uint8Array): SwapOfferPayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('swap payload must be a CBOR map', SWAP_PATH)
  }
  if (!SWAP_OFFER_PAYLOAD_SHAPE.required.every(k => val.has(BigInt(k)))) {
    throw bad('swap payload missing required fields', SWAP_PATH)
  }
  const swapId = val.get(BigInt(SWAP_OFFER_PAYLOAD.swapId))
  if (!(swapId instanceof Uint8Array) || swapId.length !== 32) {
    throw bad(
      'swap swapId must be 32 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.swapId),
    )
  }
  const makerAsset = val.get(BigInt(SWAP_OFFER_PAYLOAD.makerAsset))
  if (!(makerAsset instanceof Uint8Array) || makerAsset.length > 128) {
    throw bad(
      'swap makerAsset must be 0..128 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAsset),
    )
  }
  const rawMakerAmt = val.get(BigInt(SWAP_OFFER_PAYLOAD.makerAmount))
  let makerAmount: Uint8Array | bigint
  if (rawMakerAmt instanceof Uint8Array) {
    if (rawMakerAmt.length !== 32)
      throw bad(
        'swap makerAmount bytes must be 32 bytes',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAmount),
      )
    makerAmount = rawMakerAmt
  } else if (typeof rawMakerAmt === 'bigint') {
    if (rawMakerAmt < 0n)
      throw bad(
        'swap makerAmount cannot be negative',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAmount),
      )
    makerAmount = rawMakerAmt
  } else {
    throw bad(
      'swap makerAmount must be 32 bytes or uint',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.makerAmount),
    )
  }

  const takerAsset = val.get(BigInt(SWAP_OFFER_PAYLOAD.takerAsset))
  if (!(takerAsset instanceof Uint8Array) || takerAsset.length > 128) {
    throw bad(
      'swap takerAsset must be 0..128 bytes',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAsset),
    )
  }
  const rawTakerAmt = val.get(BigInt(SWAP_OFFER_PAYLOAD.takerAmount))
  let takerAmount: Uint8Array | bigint
  if (rawTakerAmt instanceof Uint8Array) {
    if (rawTakerAmt.length !== 32)
      throw bad(
        'swap takerAmount bytes must be 32 bytes',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAmount),
      )
    takerAmount = rawTakerAmt
  } else if (typeof rawTakerAmt === 'bigint') {
    if (rawTakerAmt < 0n)
      throw bad(
        'swap takerAmount cannot be negative',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAmount),
      )
    takerAmount = rawTakerAmt
  } else {
    throw bad(
      'swap takerAmount must be 32 bytes or uint',
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.takerAmount),
    )
  }

  const exp = val.get(BigInt(SWAP_OFFER_PAYLOAD.expiration))
  if (typeof exp !== 'bigint' || exp < 0n || exp > BigInt(U32_MAX)) {
    throw bad(
      `swap expiration must be 0..${U32_MAX}`,
      at(SWAP_PATH, SWAP_OFFER_PAYLOAD.expiration),
    )
  }

  let htlcHash: Uint8Array | undefined
  if (val.has(BigInt(SWAP_OFFER_PAYLOAD.htlcHash))) {
    const h = val.get(BigInt(SWAP_OFFER_PAYLOAD.htlcHash))
    if (!(h instanceof Uint8Array) || h.length !== 32) {
      throw bad(
        'swap htlcHash must be 32 bytes',
        at(SWAP_PATH, SWAP_OFFER_PAYLOAD.htlcHash),
      )
    }
    htlcHash = h
  }

  return {
    swapId,
    makerAsset,
    makerAmount,
    takerAsset,
    takerAmount,
    expiration: exp,
    htlcHash,
  }
}

// --- 4. Raffle Payload ---
export function validateRafflePayload(payload: RafflePayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw bad('raffle payload must be an object', RAFFLE_PATH)
  }
  if (
    !(payload.raffleId instanceof Uint8Array) ||
    payload.raffleId.length !== 32
  ) {
    throw bad(
      'raffle raffleId must be 32 bytes',
      at(RAFFLE_PATH, RAFFLE_PAYLOAD.raffleId),
    )
  }
  parseBalance(payload.ticketPrice, at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketPrice))
  const sold = BigInt(payload.ticketsSold)
  if (sold < 0n) {
    throw bad(
      'raffle ticketsSold cannot be negative',
      at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketsSold),
    )
  }
  if (payload.winningHash !== undefined) {
    if (
      !(payload.winningHash instanceof Uint8Array) ||
      payload.winningHash.length !== 32
    ) {
      throw bad(
        'raffle winningHash must be 32 bytes',
        at(RAFFLE_PATH, RAFFLE_PAYLOAD.winningHash),
      )
    }
  }
}

export function encodeRafflePayload(payload: RafflePayload): Uint8Array {
  validateRafflePayload(payload)
  const entries: Array<[number, any]> = [
    [RAFFLE_PAYLOAD.raffleId, payload.raffleId],
    [
      RAFFLE_PAYLOAD.ticketPrice,
      parseBalance(
        payload.ticketPrice,
        at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketPrice),
      ),
    ],
    [RAFFLE_PAYLOAD.ticketsSold, BigInt(payload.ticketsSold)],
  ]
  if (payload.winningHash !== undefined) {
    entries.push([RAFFLE_PAYLOAD.winningHash, payload.winningHash])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodeRafflePayload(bytes: Uint8Array): RafflePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('raffle payload must be a CBOR map', RAFFLE_PATH)
  }
  if (!RAFFLE_PAYLOAD_SHAPE.required.every(k => val.has(BigInt(k)))) {
    throw bad('raffle payload missing required fields', RAFFLE_PATH)
  }
  const raffleId = val.get(BigInt(RAFFLE_PAYLOAD.raffleId))
  if (!(raffleId instanceof Uint8Array) || raffleId.length !== 32) {
    throw bad(
      'raffle raffleId must be 32 bytes',
      at(RAFFLE_PATH, RAFFLE_PAYLOAD.raffleId),
    )
  }
  const rawPrice = val.get(BigInt(RAFFLE_PAYLOAD.ticketPrice))
  let ticketPrice: Uint8Array | bigint
  if (rawPrice instanceof Uint8Array) {
    if (rawPrice.length !== 32)
      throw bad(
        'raffle ticketPrice bytes must be 32 bytes',
        at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketPrice),
      )
    ticketPrice = rawPrice
  } else if (typeof rawPrice === 'bigint') {
    if (rawPrice < 0n)
      throw bad(
        'raffle ticketPrice cannot be negative',
        at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketPrice),
      )
    ticketPrice = rawPrice
  } else {
    throw bad(
      'raffle ticketPrice must be 32 bytes or uint',
      at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketPrice),
    )
  }

  const sold = val.get(BigInt(RAFFLE_PAYLOAD.ticketsSold))
  if (typeof sold !== 'bigint' || sold < 0n) {
    throw bad(
      'raffle ticketsSold must be a non-negative integer',
      at(RAFFLE_PATH, RAFFLE_PAYLOAD.ticketsSold),
    )
  }

  let winningHash: Uint8Array | undefined
  if (val.has(BigInt(RAFFLE_PAYLOAD.winningHash))) {
    const w = val.get(BigInt(RAFFLE_PAYLOAD.winningHash))
    if (!(w instanceof Uint8Array) || w.length !== 32) {
      throw bad(
        'raffle winningHash must be 32 bytes',
        at(RAFFLE_PATH, RAFFLE_PAYLOAD.winningHash),
      )
    }
    winningHash = w
  }

  return {
    raffleId,
    ticketPrice,
    ticketsSold: sold,
    winningHash,
  }
}

// --- 5. Application Payload Dispatcher ---
export type ModularAppPayload =
  | DiceGamePayload
  | PokerGamePayload
  | SwapOfferPayload
  | RafflePayload

export function decodeAppPayload(
  appId: string,
  bytes: Uint8Array,
): ModularAppPayload | Uint8Array {
  switch (appId.toLowerCase()) {
    case 'dice':
    case 'dice-v1':
    case 'satoshi-dice-v1':
    case 'liars-dice':
      return decodeDiceGamePayload(bytes)
    case 'poker':
      return decodePokerGamePayload(bytes)
    case 'swap':
      return decodeSwapOfferPayload(bytes)
    case 'raffle':
      return decodeRafflePayload(bytes)
    default:
      return bytes
  }
}

export function validateAppState(appId: string, bytes: Uint8Array): void {
  switch (appId.toLowerCase()) {
    case 'dice':
    case 'dice-v1':
    case 'satoshi-dice-v1':
    case 'liars-dice': {
      const decoded = decodeDiceGamePayload(bytes)
      validateDiceGamePayload(decoded)
      break
    }
    case 'poker': {
      const decoded = decodePokerGamePayload(bytes)
      validatePokerGamePayload(decoded)
      break
    }
    case 'swap': {
      const decoded = decodeSwapOfferPayload(bytes)
      validateSwapOfferPayload(decoded)
      break
    }
    case 'raffle': {
      const decoded = decodeRafflePayload(bytes)
      validateRafflePayload(decoded)
      break
    }
    default:
      // Opaque application state payload: bound by 65536 bytes
      if (bytes.length > MAX_CHANNEL_APP_STATE_BYTES) {
        throw bad(
          `appState exceeds maximum of ${MAX_CHANNEL_APP_STATE_BYTES} bytes`,
        )
      }
  }
}
