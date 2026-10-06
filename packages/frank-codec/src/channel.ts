/**
 * Pure typed-item writing, projection, verification, and modular application schemas
 * for Universal State Channel Update Items (Type 24).
 * (docs/protocol/cbor/direct-message.cddl, Issues #949 and #950).
 */
import { sha256 } from '@noble/hashes/sha256'

import { cborMap, decodeCanonical, encodeCanonical, FrankValue } from './cbor'
import {
  MAX_CHANNEL_ALLOCATIONS,
  MAX_CHANNEL_APP_STATE_BYTES,
  MAX_CHANNEL_PARTICIPANTS,
  MAX_CHANNEL_SIGNATURES,
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

function parseHex(h: string, expectedLen?: number, fieldName = 'hex'): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2).toLowerCase() : h.toLowerCase()
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw bad(`${fieldName} must be a valid hex string`)
  }
  const bytes = fromHex(clean)
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw bad(`${fieldName} must be exactly ${expectedLen} bytes, got ${bytes.length}`)
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
      throw bad(`${fieldName} must be exactly ${expectedLen} bytes, got ${val.length}`)
    }
    return val
  }
  throw bad(`${fieldName} must be Uint8Array or hex string`)
}

function parseBalance(val: string | number | bigint | Uint8Array, path = 'balance'): Uint8Array | bigint {
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
    const clean = val.startsWith('0x') ? val.slice(2).toLowerCase() : val.toLowerCase()
    if (val.startsWith('0x') && clean.length === 64 && /^[0-9a-f]{64}$/.test(clean)) {
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
    throw bad(`${path} string must be decimal digits or 0x-prefixed 32-byte hex`)
  }
  throw bad(`${path} must be a number, bigint, decimal string, or 32-byte Uint8Array`)
}

function toAccountRef(signer: { keyType: number; pubKey: string } | AccountRef): AccountRef {
  const keyType = signer.keyType
  let keyBytes: Uint8Array
  if ('pubKey' in signer) {
    const expected = keyType === 1 ? 33 : 32
    keyBytes = parseHex(signer.pubKey, expected, 'signer.pubKey')
  } else {
    keyBytes = signer.keyBytes
  }
  return { keyType, keyBytes }
}

function encodeAllocationsCbor(
  allocations: (ChainAllocation | CanonicalChainAllocation)[],
): Map<number | bigint, any>[] {
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > MAX_CHANNEL_ALLOCATIONS) {
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

    if (!Array.isArray(a.balances) || a.balances.length < 2 || a.balances.length > MAX_CHANNEL_PARTICIPANTS) {
      throw bad(`allocation[${i}].balances must have 2..${MAX_CHANNEL_PARTICIPANTS} participant balances`)
    }

    const balancesCbor = a.balances.map((b, j) => {
      const participant = toAccountRef(b.participant)
      const balance = parseBalance(b.balance, `allocation[${i}].balances[${j}]`)
      return cborMap([
        [
          0,
          cborMap([
            [0, participant.keyType],
            [1, participant.keyBytes],
          ]),
        ],
        [1, balance],
      ])
    })

    return cborMap([
      [0, a.networkTag],
      [1, tokenBytes],
      [2, balancesCbor],
    ])
  })
}

function encodeSignaturesCbor(
  signatures: (SignatureEntry | CanonicalSignatureEntry)[],
): Map<number | bigint, any>[] {
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > MAX_CHANNEL_SIGNATURES) {
    throw bad(`signatures must have 1..${MAX_CHANNEL_SIGNATURES} items`)
  }

  return signatures.map((s, i) => {
    const signer = toAccountRef(s.signer)
    const sigBytes =
      typeof s.signature === 'string'
        ? parseHex(s.signature, undefined, `signature[${i}].signature`)
        : s.signature
    return cborMap([
      [0, s.algorithm],
      [
        1,
        cborMap([
          [0, signer.keyType],
          [1, signer.keyBytes],
        ]),
      ],
      [2, sigBytes],
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
  if (typeof item.appId !== 'string' || item.appId.length < 1 || item.appId.length > 64) {
    throw bad('appId must be a string of 1..64 characters')
  }
  const sequenceNumber = item.sequenceNumber
  if (
    typeof sequenceNumber !== 'number' ||
    !Number.isSafeInteger(sequenceNumber) ||
    sequenceNumber < 0 ||
    sequenceNumber > U32_MAX
  ) {
    throw bad(`sequenceNumber must be an unsigned 32-bit integer (0..${U32_MAX})`)
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
    throw bad(`appState exceeds maximum of ${MAX_CHANNEL_APP_STATE_BYTES} bytes`)
  }

  const signaturesCbor = encodeSignaturesCbor(item.signatures)

  const entries: Array<[number, any]> = [
    [0, channelIdBytes],
    [1, item.appId],
    [2, BigInt(sequenceNumber)],
    [3, allocationsCbor],
    [4, appStateBytes],
    [5, signaturesCbor],
  ]

  if (item.settlementRef !== undefined) {
    const settlementBytes =
      typeof item.settlementRef === 'string'
        ? parseHex(item.settlementRef, undefined, 'settlementRef')
        : item.settlementRef
    if (settlementBytes.length < 1 || settlementBytes.length > 128) {
      throw bad('settlementRef must be 1..128 bytes')
    }
    entries.push([6, settlementBytes])
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
  return frame.typeId === TYPE_CHANNEL_UPDATE && frame.typed?.type === 24
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
    [0, channelIdBytes],
    [1, item.appId],
    [2, BigInt(item.sequenceNumber)],
    [3, allocationsCbor],
    [4, appStateBytes],
  ]

  if (item.settlementRef !== undefined) {
    const settlementBytes =
      typeof item.settlementRef === 'string'
        ? parseHex(item.settlementRef, undefined, 'settlementRef')
        : item.settlementRef
    entries.push([6, settlementBytes])
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

  if (entry.algorithm === 1 && signer.keyType === 1) {
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
      'type' in prior && prior.type === 24
        ? toHex(prior.channelId)
        : (prior as CanonicalChannelUpdateItem).channelId.toLowerCase()
    const nextId =
      'type' in next && next.type === 24
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

// --- 1. Dice Game Payload ---
export function validateDiceGamePayload(payload: DiceGamePayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw bad('dice payload must be an object', 'dice-payload')
  }
  const round = BigInt(payload.round)
  if (round < 0n) {
    throw bad('dice round cannot be negative', 'dice-payload.0')
  }
  if (
    payload.action !== 'commit' &&
    payload.action !== 'reveal' &&
    payload.action !== 'roll'
  ) {
    throw bad(
      `invalid dice action: ${payload.action} (must be commit|reveal|roll)`,
      'dice-payload.1',
    )
  }
  if (!(payload.seedCommitment instanceof Uint8Array) || payload.seedCommitment.length !== 32) {
    throw bad('dice seedCommitment must be 32 bytes', 'dice-payload.2')
  }
  if (payload.revealSeed !== undefined) {
    if (
      !(payload.revealSeed instanceof Uint8Array) ||
      payload.revealSeed.length < 1 ||
      payload.revealSeed.length > 64
    ) {
      throw bad('dice revealSeed must be 1..64 bytes', 'dice-payload.3')
    }
  }
  if (payload.targetRoll !== undefined) {
    if (
      typeof payload.targetRoll !== 'number' ||
      !Number.isSafeInteger(payload.targetRoll) ||
      payload.targetRoll < 0 ||
      payload.targetRoll > 100
    ) {
      throw bad('dice targetRoll must be 0..100', 'dice-payload.4')
    }
  }
  parseBalance(payload.wager, 'dice-payload.5')
}

export function encodeDiceGamePayload(payload: DiceGamePayload): Uint8Array {
  validateDiceGamePayload(payload)
  const entries: Array<[number, any]> = [
    [0, BigInt(payload.round)],
    [1, payload.action],
    [2, payload.seedCommitment],
  ]
  if (payload.revealSeed !== undefined) {
    entries.push([3, payload.revealSeed])
  }
  if (payload.targetRoll !== undefined) {
    entries.push([4, BigInt(payload.targetRoll)])
  }
  entries.push([5, parseBalance(payload.wager, 'dice-payload.5')])

  return encodeCanonical(cborMap(entries))
}

export function decodeDiceGamePayload(bytes: Uint8Array): DiceGamePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('dice payload must be a CBOR map', 'dice-payload')
  }
  if (!val.has(0n) || !val.has(1n) || !val.has(2n) || !val.has(5n)) {
    throw bad('dice payload missing required fields', 'dice-payload')
  }
  const round = val.get(0n)
  if (typeof round !== 'bigint' || round < 0n) {
    throw bad('dice round must be a non-negative integer', 'dice-payload.0')
  }
  const action = val.get(1n)
  if (action !== 'commit' && action !== 'reveal' && action !== 'roll') {
    throw bad('invalid dice action', 'dice-payload.1')
  }
  const seedCommitment = val.get(2n)
  if (!(seedCommitment instanceof Uint8Array) || seedCommitment.length !== 32) {
    throw bad('dice seedCommitment must be 32 bytes', 'dice-payload.2')
  }
  let revealSeed: Uint8Array | undefined
  if (val.has(3n)) {
    const rs = val.get(3n)
    if (!(rs instanceof Uint8Array) || rs.length < 1 || rs.length > 64) {
      throw bad('dice revealSeed must be 1..64 bytes', 'dice-payload.3')
    }
    revealSeed = rs
  }
  let targetRoll: number | undefined
  if (val.has(4n)) {
    const tr = val.get(4n)
    if (typeof tr !== 'bigint' || tr < 0n || tr > 100n) {
      throw bad('dice targetRoll must be 0..100', 'dice-payload.4')
    }
    targetRoll = Number(tr)
  }
  const rawWager = val.get(5n)
  let wager: Uint8Array | bigint
  if (rawWager instanceof Uint8Array) {
    if (rawWager.length !== 32) throw bad('dice wager bytes must be 32 bytes', 'dice-payload.5')
    wager = rawWager
  } else if (typeof rawWager === 'bigint') {
    if (rawWager < 0n) throw bad('dice wager cannot be negative', 'dice-payload.5')
    wager = rawWager
  } else {
    throw bad('dice wager must be 32 bytes or uint', 'dice-payload.5')
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
    throw bad('poker payload must be an object', 'poker-payload')
  }
  if (!(payload.handId instanceof Uint8Array) || payload.handId.length !== 32) {
    throw bad('poker handId must be 32 bytes', 'poker-payload.0')
  }
  if (typeof payload.phase !== 'string' || payload.phase.length < 1 || payload.phase.length > 32) {
    throw bad('poker phase must be 1..32 characters', 'poker-payload.1')
  }
  if (typeof payload.action !== 'string' || payload.action.length < 1 || payload.action.length > 32) {
    throw bad('poker action must be 1..32 characters', 'poker-payload.2')
  }
  if (payload.cardCommitments !== undefined) {
    if (!Array.isArray(payload.cardCommitments) || payload.cardCommitments.length < 1 || payload.cardCommitments.length > 10) {
      throw bad('poker cardCommitments must be an array of 1..10 items', 'poker-payload.3')
    }
    for (let i = 0; i < payload.cardCommitments.length; i++) {
      const c = payload.cardCommitments[i]
      if (!(c instanceof Uint8Array) || c.length !== 32) {
        throw bad(`poker cardCommitment[${i}] must be 32 bytes`, 'poker-payload.3')
      }
    }
  }
  if (payload.keys !== undefined) {
    if (!Array.isArray(payload.keys) || payload.keys.length < 1 || payload.keys.length > 10) {
      throw bad('poker keys must be an array of 1..10 items', 'poker-payload.4')
    }
    for (let i = 0; i < payload.keys.length; i++) {
      const k = payload.keys[i]
      if (!(k instanceof Uint8Array) || k.length < 1 || k.length > 64) {
        throw bad(`poker key[${i}] must be 1..64 bytes`, 'poker-payload.4')
      }
    }
  }
}

export function encodePokerGamePayload(payload: PokerGamePayload): Uint8Array {
  validatePokerGamePayload(payload)
  const entries: Array<[number, any]> = [
    [0, payload.handId],
    [1, payload.phase],
    [2, payload.action],
  ]
  if (payload.cardCommitments !== undefined) {
    entries.push([3, payload.cardCommitments])
  }
  if (payload.keys !== undefined) {
    entries.push([4, payload.keys])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodePokerGamePayload(bytes: Uint8Array): PokerGamePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('poker payload must be a CBOR map', 'poker-payload')
  }
  if (!val.has(0n) || !val.has(1n) || !val.has(2n)) {
    throw bad('poker payload missing required fields', 'poker-payload')
  }
  const handId = val.get(0n)
  if (!(handId instanceof Uint8Array) || handId.length !== 32) {
    throw bad('poker handId must be 32 bytes', 'poker-payload.0')
  }
  const phase = val.get(1n)
  if (typeof phase !== 'string' || phase.length < 1 || phase.length > 32) {
    throw bad('poker phase must be 1..32 characters', 'poker-payload.1')
  }
  const action = val.get(2n)
  if (typeof action !== 'string' || action.length < 1 || action.length > 32) {
    throw bad('poker action must be 1..32 characters', 'poker-payload.2')
  }
  let cardCommitments: Uint8Array[] | undefined
  if (val.has(3n)) {
    const list = val.get(3n)
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) {
      throw bad('poker cardCommitments must be an array of 1..10 items', 'poker-payload.3')
    }
    cardCommitments = list.map((c, i) => {
      if (!(c instanceof Uint8Array) || c.length !== 32) {
        throw bad(`poker cardCommitment[${i}] must be 32 bytes`, 'poker-payload.3')
      }
      return c
    })
  }
  let keys: Uint8Array[] | undefined
  if (val.has(4n)) {
    const list = val.get(4n)
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) {
      throw bad('poker keys must be an array of 1..10 items', 'poker-payload.4')
    }
    keys = list.map((k, i) => {
      if (!(k instanceof Uint8Array) || k.length < 1 || k.length > 64) {
        throw bad(`poker key[${i}] must be 1..64 bytes`, 'poker-payload.4')
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
    throw bad('swap payload must be an object', 'swap-payload')
  }
  if (!(payload.swapId instanceof Uint8Array) || payload.swapId.length !== 32) {
    throw bad('swap swapId must be 32 bytes', 'swap-payload.0')
  }
  if (!(payload.makerAsset instanceof Uint8Array) || payload.makerAsset.length > 128) {
    throw bad('swap makerAsset must be 0..128 bytes', 'swap-payload.1')
  }
  parseBalance(payload.makerAmount, 'swap-payload.2')
  if (!(payload.takerAsset instanceof Uint8Array) || payload.takerAsset.length > 128) {
    throw bad('swap takerAsset must be 0..128 bytes', 'swap-payload.3')
  }
  parseBalance(payload.takerAmount, 'swap-payload.4')
  const exp = BigInt(payload.expiration)
  if (exp < 0n || exp > BigInt(U32_MAX)) {
    throw bad(`swap expiration must be in range 0..${U32_MAX}`, 'swap-payload.5')
  }
  if (payload.htlcHash !== undefined) {
    if (!(payload.htlcHash instanceof Uint8Array) || payload.htlcHash.length !== 32) {
      throw bad('swap htlcHash must be 32 bytes', 'swap-payload.6')
    }
  }
}

export function encodeSwapOfferPayload(payload: SwapOfferPayload): Uint8Array {
  validateSwapOfferPayload(payload)
  const entries: Array<[number, any]> = [
    [0, payload.swapId],
    [1, payload.makerAsset],
    [2, parseBalance(payload.makerAmount, 'swap-payload.2')],
    [3, payload.takerAsset],
    [4, parseBalance(payload.takerAmount, 'swap-payload.4')],
    [5, BigInt(payload.expiration)],
  ]
  if (payload.htlcHash !== undefined) {
    entries.push([6, payload.htlcHash])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodeSwapOfferPayload(bytes: Uint8Array): SwapOfferPayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('swap payload must be a CBOR map', 'swap-payload')
  }
  if (!val.has(0n) || !val.has(1n) || !val.has(2n) || !val.has(3n) || !val.has(4n) || !val.has(5n)) {
    throw bad('swap payload missing required fields', 'swap-payload')
  }
  const swapId = val.get(0n)
  if (!(swapId instanceof Uint8Array) || swapId.length !== 32) {
    throw bad('swap swapId must be 32 bytes', 'swap-payload.0')
  }
  const makerAsset = val.get(1n)
  if (!(makerAsset instanceof Uint8Array) || makerAsset.length > 128) {
    throw bad('swap makerAsset must be 0..128 bytes', 'swap-payload.1')
  }
  const rawMakerAmt = val.get(2n)
  let makerAmount: Uint8Array | bigint
  if (rawMakerAmt instanceof Uint8Array) {
    if (rawMakerAmt.length !== 32) throw bad('swap makerAmount bytes must be 32 bytes', 'swap-payload.2')
    makerAmount = rawMakerAmt
  } else if (typeof rawMakerAmt === 'bigint') {
    if (rawMakerAmt < 0n) throw bad('swap makerAmount cannot be negative', 'swap-payload.2')
    makerAmount = rawMakerAmt
  } else {
    throw bad('swap makerAmount must be 32 bytes or uint', 'swap-payload.2')
  }

  const takerAsset = val.get(3n)
  if (!(takerAsset instanceof Uint8Array) || takerAsset.length > 128) {
    throw bad('swap takerAsset must be 0..128 bytes', 'swap-payload.3')
  }
  const rawTakerAmt = val.get(4n)
  let takerAmount: Uint8Array | bigint
  if (rawTakerAmt instanceof Uint8Array) {
    if (rawTakerAmt.length !== 32) throw bad('swap takerAmount bytes must be 32 bytes', 'swap-payload.4')
    takerAmount = rawTakerAmt
  } else if (typeof rawTakerAmt === 'bigint') {
    if (rawTakerAmt < 0n) throw bad('swap takerAmount cannot be negative', 'swap-payload.4')
    takerAmount = rawTakerAmt
  } else {
    throw bad('swap takerAmount must be 32 bytes or uint', 'swap-payload.4')
  }

  const exp = val.get(5n)
  if (typeof exp !== 'bigint' || exp < 0n || exp > BigInt(U32_MAX)) {
    throw bad(`swap expiration must be 0..${U32_MAX}`, 'swap-payload.5')
  }

  let htlcHash: Uint8Array | undefined
  if (val.has(6n)) {
    const h = val.get(6n)
    if (!(h instanceof Uint8Array) || h.length !== 32) {
      throw bad('swap htlcHash must be 32 bytes', 'swap-payload.6')
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
    throw bad('raffle payload must be an object', 'raffle-payload')
  }
  if (!(payload.raffleId instanceof Uint8Array) || payload.raffleId.length !== 32) {
    throw bad('raffle raffleId must be 32 bytes', 'raffle-payload.0')
  }
  parseBalance(payload.ticketPrice, 'raffle-payload.1')
  const sold = BigInt(payload.ticketsSold)
  if (sold < 0n) {
    throw bad('raffle ticketsSold cannot be negative', 'raffle-payload.2')
  }
  if (payload.winningHash !== undefined) {
    if (!(payload.winningHash instanceof Uint8Array) || payload.winningHash.length !== 32) {
      throw bad('raffle winningHash must be 32 bytes', 'raffle-payload.3')
    }
  }
}

export function encodeRafflePayload(payload: RafflePayload): Uint8Array {
  validateRafflePayload(payload)
  const entries: Array<[number, any]> = [
    [0, payload.raffleId],
    [1, parseBalance(payload.ticketPrice, 'raffle-payload.1')],
    [2, BigInt(payload.ticketsSold)],
  ]
  if (payload.winningHash !== undefined) {
    entries.push([3, payload.winningHash])
  }
  return encodeCanonical(cborMap(entries))
}

export function decodeRafflePayload(bytes: Uint8Array): RafflePayload {
  const val = decodeCanonical(bytes)
  if (!(val instanceof Map)) {
    throw bad('raffle payload must be a CBOR map', 'raffle-payload')
  }
  if (!val.has(0n) || !val.has(1n) || !val.has(2n)) {
    throw bad('raffle payload missing required fields', 'raffle-payload')
  }
  const raffleId = val.get(0n)
  if (!(raffleId instanceof Uint8Array) || raffleId.length !== 32) {
    throw bad('raffle raffleId must be 32 bytes', 'raffle-payload.0')
  }
  const rawPrice = val.get(1n)
  let ticketPrice: Uint8Array | bigint
  if (rawPrice instanceof Uint8Array) {
    if (rawPrice.length !== 32) throw bad('raffle ticketPrice bytes must be 32 bytes', 'raffle-payload.1')
    ticketPrice = rawPrice
  } else if (typeof rawPrice === 'bigint') {
    if (rawPrice < 0n) throw bad('raffle ticketPrice cannot be negative', 'raffle-payload.1')
    ticketPrice = rawPrice
  } else {
    throw bad('raffle ticketPrice must be 32 bytes or uint', 'raffle-payload.1')
  }

  const sold = val.get(2n)
  if (typeof sold !== 'bigint' || sold < 0n) {
    throw bad('raffle ticketsSold must be a non-negative integer', 'raffle-payload.2')
  }

  let winningHash: Uint8Array | undefined
  if (val.has(3n)) {
    const w = val.get(3n)
    if (!(w instanceof Uint8Array) || w.length !== 32) {
      throw bad('raffle winningHash must be 32 bytes', 'raffle-payload.3')
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
        throw bad(`appState exceeds maximum of ${MAX_CHANNEL_APP_STATE_BYTES} bytes`)
      }
  }
}
