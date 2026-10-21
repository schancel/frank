/**
 * P2P OTC Swap & Escrow Handshake (`swap-handshake-v1`) Message-Item Plugin (Issue #1705).
 *
 * Provides:
 * 1. Canonical CBOR serialization, validation, and application-item wrapping for
 *    in-chat multi-chain atomic swaps and milestone escrows.
 * 2. Deterministic per-swap cryptographic secret derivation (`deriveSwapSecrets`)
 *    from `(masterSeed, swapId, role)` via HKDF-SHA256 so any synced device sharing
 *    the wallet's root seed can deterministically reconstruct the HTLC preimage,
 *    SHA-256 hashlock, adaptor secret scalar, and ephemeral signing seed without
 *    vulnerable device-local storage.
 * 3. Multi-device execution lease tracking and transcript folding (`foldSwapHandshakeState`)
 *    so only the active leader device (`executorDeviceId`) can auto-advance or broadcast
 *    transactions while its lease is valid (`nowMs < leaseExpiresAtMs`), while allowing
 *    seamless failover takeover on a secondary device once the lease expires.
 */
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import {
  encodeCanonical,
  standaloneItemBudget,
  type Encodable,
  type FrankValue,
} from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import { formatBaseUnit } from '../../chain/base-unit'
import { validateApplicationValue } from '@frank/cashweb/message-items/application-item'
import {
  requirePluginCapabilities,
  type ApplicationItemPlugin,
  type MessageItemDecodeContext,
  type MessageItemPlugin,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'

export const SWAP_HANDSHAKE_PLUGIN_ID = 'swap-handshake-v1' as const
export const SWAP_HANDSHAKE_ITEM_TYPE = SWAP_HANDSHAKE_PLUGIN_ID
export const SWAP_HANDSHAKE_SCHEMA_VERSION = 1 as const
export const DEFAULT_SWAP_LEASE_DURATION_MS = 60_000 as const
export const SWAP_HANDSHAKE_MAX_MEMO_BYTES = 512 as const

const SWAP_HANDSHAKE_HKDF_SALT = 'frank-swap-handshake-salt-v1'

export type SwapHandshakeMode = 'atomic_swap' | 'milestone_escrow'

export type SwapHandshakeAction =
  | 'propose'
  | 'accept_and_lock'
  | 'counter_lock'
  | 'settle_claim'
  | 'refund'
  | 'cancel'
  | 'lease_heartbeat'

export type SwapHandshakePhase =
  | 'proposed'
  | 'maker_locked'
  | 'both_locked'
  | 'settled'
  | 'refunded'
  | 'cancelled'
  | 'expired'

export type SwapHandshakeRole = 'maker' | 'taker'

export interface SwapLegSpec {
  chainKey: string
  assetSymbol: string
  amountAtomic: string
  decimals: number
  recipientAddress: string
}

export interface SwapHandshakePayload {
  schemaVersion: 1
  swapId: string
  mode: SwapHandshakeMode
  action: SwapHandshakeAction
  sequence: number
  executorDeviceId: string
  leaseExpiresAtMs: number
  makerAddress?: string
  takerAddress?: string
  giveLeg?: SwapLegSpec
  wantLeg?: SwapLegSpec
  hashlockSha256Hex?: string
  timelockExpiresAtMs?: number
  lockTxHash?: string
  counterLockTxHash?: string
  settleTxHash?: string
  revealedPreimageHex?: string
  refundTxHash?: string
  memo?: string
}

export interface DeriveSwapSecretsParams {
  masterSeed: Uint8Array
  swapId: string
  role: SwapHandshakeRole
}

export interface DerivedSwapSecrets {
  preimage: Uint8Array
  preimageHex: string
  hashlockSha256: Uint8Array
  hashlockSha256Hex: string
  adaptorSecretScalar: Uint8Array
  adaptorSecretScalarHex: string
  ephemeralSigningSeed: Uint8Array
  ephemeralSigningSeedHex: string
}

export interface SwapDeviceLeaseState {
  executorDeviceId: string
  leaseExpiresAtMs: number
  isLocalDeviceLeader: boolean
  isLeaseExpired: boolean
  canLocalDeviceExecute: boolean
  requiresFailoverTakeover: boolean
}

export interface FoldedSwapHandshakeState {
  swapId: string
  mode: SwapHandshakeMode
  phase: SwapHandshakePhase
  makerAddress: string
  takerAddress: string
  giveLeg: SwapLegSpec
  wantLeg: SwapLegSpec
  hashlockSha256Hex: string
  timelockExpiresAtMs: number
  makerLockTxHash: string | null
  takerLockTxHash: string | null
  settleTxHash: string | null
  refundTxHash: string | null
  revealedPreimageHex: string | null
  makerLease: SwapDeviceLeaseState | null
  takerLease: SwapDeviceLeaseState | null
  availableActions: SwapHandshakeAction[]
  memo?: string
  lastSequence?: number
}

export interface FoldSwapHandshakeOptions {
  localDeviceId?: string
  localAddress?: string
  localRole?: SwapHandshakeRole
  nowMs?: number
}

const VALID_MODES = new Set<SwapHandshakeMode>([
  'atomic_swap',
  'milestone_escrow',
])

const VALID_ACTIONS = new Set<SwapHandshakeAction>([
  'propose',
  'accept_and_lock',
  'counter_lock',
  'settle_claim',
  'refund',
  'cancel',
  'lease_heartbeat',
])

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'schemaVersion',
  'swapId',
  'mode',
  'action',
  'sequence',
  'executorDeviceId',
  'leaseExpiresAtMs',
  'makerAddress',
  'takerAddress',
  'giveLeg',
  'wantLeg',
  'hashlockSha256Hex',
  'timelockExpiresAtMs',
  'lockTxHash',
  'counterLockTxHash',
  'settleTxHash',
  'revealedPreimageHex',
  'refundTxHash',
  'memo',
])

const ALLOWED_LEG_KEYS = new Set<string>([
  'chainKey',
  'assetSymbol',
  'amountAtomic',
  'decimals',
  'recipientAddress',
])

const CBOR_KEY_SCHEMA_VERSION = 0
const CBOR_KEY_SWAP_ID = 1
const CBOR_KEY_MODE = 2
const CBOR_KEY_ACTION = 3
const CBOR_KEY_SEQUENCE = 4
const CBOR_KEY_EXECUTOR_DEVICE_ID = 5
const CBOR_KEY_LEASE_EXPIRES_AT_MS = 6
const CBOR_KEY_MAKER_ADDRESS = 7
const CBOR_KEY_TAKER_ADDRESS = 8
const CBOR_KEY_GIVE_LEG = 9
const CBOR_KEY_WANT_LEG = 10
const CBOR_KEY_HASHLOCK_SHA256_HEX = 11
const CBOR_KEY_TIMELOCK_EXPIRES_AT_MS = 12
const CBOR_KEY_LOCK_TX_HASH = 13
const CBOR_KEY_COUNTER_LOCK_TX_HASH = 14
const CBOR_KEY_SETTLE_TX_HASH = 15
const CBOR_KEY_REVEALED_PREIMAGE_HEX = 16
const CBOR_KEY_REFUND_TX_HASH = 17
const CBOR_KEY_MEMO = 18

const CBOR_LEG_KEY_CHAIN_KEY = 0
const CBOR_LEG_KEY_ASSET_SYMBOL = 1
const CBOR_LEG_KEY_AMOUNT_ATOMIC = 2
const CBOR_LEG_KEY_DECIMALS = 3
const CBOR_LEG_KEY_RECIPIENT_ADDRESS = 4

const utf8Encoder = new TextEncoder()

export function generateSwapId(): string {
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: {
        randomUUID?: () => string
        getRandomValues?: <T extends Uint8Array>(arr: T) => T
      }
    }
  ).crypto
  if (runtimeCrypto?.randomUUID) {
    return `swap_${runtimeCrypto.randomUUID().replace(/-/g, '')}`
  }
  const bytes = new Uint8Array(16)
  if (runtimeCrypto?.getRandomValues) {
    runtimeCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return `swap_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
}

export function formatSwapLegAmount(
  amountAtomic: string,
  decimals: number,
): string {
  if (
    typeof amountAtomic !== 'string' ||
    !/^[1-9]\d{0,77}$/.test(amountAtomic) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    return '0'
  }
  return formatBaseUnit(BigInt(amountAtomic), decimals)
}

function assertPlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`Expected plain ${label} object`)
  }
  return value as Record<string, unknown>
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`swap-handshake ${field} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    throw new TypeError(
      `swap-handshake ${field} must be 1..${maxChars} non-blank characters`,
    )
  }
  return trimmed
}

function normalizeHex32(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`swap-handshake ${field} must be a 32-byte hex string`)
  }
  const stripped = value.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new TypeError(
      `swap-handshake ${field} must be exactly 64 hexadecimal characters (32 bytes)`,
    )
  }
  return stripped.toLowerCase()
}

export function validateSwapLegSpec(raw: unknown, field = 'leg'): SwapLegSpec {
  const obj = assertPlainObject(raw, field)
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !ALLOWED_LEG_KEYS.has(key)) {
      throw new TypeError(`Unexpected ${field} property: ${String(key)}`)
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `${field} property ${key} must be an enumerable data property`,
      )
    }
  }

  const chainKey = assertNonEmptyString(obj.chainKey, `${field}.chainKey`, 64)
  const assetSymbol = assertNonEmptyString(
    obj.assetSymbol,
    `${field}.assetSymbol`,
    32,
  )
  const amountAtomic = assertNonEmptyString(
    obj.amountAtomic,
    `${field}.amountAtomic`,
    78,
  )
  if (!/^[1-9]\d{0,77}$/.test(amountAtomic)) {
    throw new TypeError(
      `swap-handshake ${field}.amountAtomic must be a positive base-10 integer string`,
    )
  }
  if (
    typeof obj.decimals !== 'number' ||
    !Number.isInteger(obj.decimals) ||
    obj.decimals < 0 ||
    obj.decimals > 36 ||
    Object.is(obj.decimals, -0)
  ) {
    throw new TypeError(
      `swap-handshake ${field}.decimals must be an integer between 0 and 36`,
    )
  }
  const recipientAddress = assertNonEmptyString(
    obj.recipientAddress,
    `${field}.recipientAddress`,
    256,
  )

  return {
    chainKey,
    assetSymbol,
    amountAtomic,
    decimals: obj.decimals,
    recipientAddress,
  }
}

export function validateSwapHandshakePayload(
  raw: unknown,
): SwapHandshakePayload {
  validateApplicationValue(raw)
  const obj = assertPlainObject(raw, 'swap-handshake payload')

  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !ALLOWED_PAYLOAD_KEYS.has(key)) {
      throw new TypeError(
        `Unexpected swap-handshake payload property: ${String(key)}`,
      )
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `swap-handshake property ${key} must be an enumerable data property`,
      )
    }
  }

  if (obj.schemaVersion !== SWAP_HANDSHAKE_SCHEMA_VERSION) {
    throw new TypeError(
      `swap-handshake schemaVersion must be ${SWAP_HANDSHAKE_SCHEMA_VERSION}`,
    )
  }

  const swapId = assertNonEmptyString(obj.swapId, 'swapId', 128)
  if (!/^[a-zA-Z0-9_:-]{1,128}$/.test(swapId)) {
    throw new TypeError(
      'swap-handshake swapId must contain only alphanumeric, underscore, colon, or hyphen characters',
    )
  }

  if (
    typeof obj.mode !== 'string' ||
    !VALID_MODES.has(obj.mode as SwapHandshakeMode)
  ) {
    throw new TypeError(
      `swap-handshake mode must be 'atomic_swap' or 'milestone_escrow', got ${String(obj.mode)}`,
    )
  }
  const mode = obj.mode as SwapHandshakeMode

  if (
    typeof obj.action !== 'string' ||
    !VALID_ACTIONS.has(obj.action as SwapHandshakeAction)
  ) {
    throw new TypeError(
      `Unsupported swap-handshake action: ${String(obj.action)}`,
    )
  }
  const action = obj.action as SwapHandshakeAction

  if (
    typeof obj.sequence !== 'number' ||
    !Number.isSafeInteger(obj.sequence) ||
    obj.sequence < 0 ||
    Object.is(obj.sequence, -0)
  ) {
    throw new TypeError(
      'swap-handshake sequence must be a non-negative safe integer',
    )
  }

  const executorDeviceId = assertNonEmptyString(
    obj.executorDeviceId,
    'executorDeviceId',
    128,
  )

  if (
    typeof obj.leaseExpiresAtMs !== 'number' ||
    !Number.isSafeInteger(obj.leaseExpiresAtMs) ||
    obj.leaseExpiresAtMs <= 0
  ) {
    throw new TypeError(
      'swap-handshake leaseExpiresAtMs must be a positive safe integer timestamp',
    )
  }

  const validated: SwapHandshakePayload = {
    schemaVersion: SWAP_HANDSHAKE_SCHEMA_VERSION,
    swapId,
    mode,
    action,
    sequence: obj.sequence,
    executorDeviceId,
    leaseExpiresAtMs: obj.leaseExpiresAtMs,
  }

  if (obj.makerAddress !== undefined) {
    validated.makerAddress = assertNonEmptyString(
      obj.makerAddress,
      'makerAddress',
      256,
    )
  }
  if (obj.takerAddress !== undefined) {
    validated.takerAddress = assertNonEmptyString(
      obj.takerAddress,
      'takerAddress',
      256,
    )
  }
  if (obj.giveLeg !== undefined) {
    validated.giveLeg = validateSwapLegSpec(obj.giveLeg, 'giveLeg')
  }
  if (obj.wantLeg !== undefined) {
    validated.wantLeg = validateSwapLegSpec(obj.wantLeg, 'wantLeg')
  }
  if (obj.hashlockSha256Hex !== undefined) {
    validated.hashlockSha256Hex = normalizeHex32(
      obj.hashlockSha256Hex,
      'hashlockSha256Hex',
    )
  }
  if (obj.timelockExpiresAtMs !== undefined) {
    if (
      typeof obj.timelockExpiresAtMs !== 'number' ||
      !Number.isSafeInteger(obj.timelockExpiresAtMs) ||
      obj.timelockExpiresAtMs <= 0
    ) {
      throw new TypeError(
        'swap-handshake timelockExpiresAtMs must be a positive safe integer timestamp',
      )
    }
    validated.timelockExpiresAtMs = obj.timelockExpiresAtMs
  }
  if (obj.lockTxHash !== undefined) {
    validated.lockTxHash = assertNonEmptyString(
      obj.lockTxHash,
      'lockTxHash',
      256,
    )
  }
  if (obj.counterLockTxHash !== undefined) {
    validated.counterLockTxHash = assertNonEmptyString(
      obj.counterLockTxHash,
      'counterLockTxHash',
      256,
    )
  }
  if (obj.settleTxHash !== undefined) {
    validated.settleTxHash = assertNonEmptyString(
      obj.settleTxHash,
      'settleTxHash',
      256,
    )
  }
  if (obj.revealedPreimageHex !== undefined) {
    validated.revealedPreimageHex = normalizeHex32(
      obj.revealedPreimageHex,
      'revealedPreimageHex',
    )
  }
  if (obj.refundTxHash !== undefined) {
    validated.refundTxHash = assertNonEmptyString(
      obj.refundTxHash,
      'refundTxHash',
      256,
    )
  }
  if (obj.memo !== undefined) {
    if (typeof obj.memo !== 'string') {
      throw new TypeError('swap-handshake memo must be a string')
    }
    const byteLength = utf8Encoder.encode(obj.memo).byteLength
    if (byteLength > SWAP_HANDSHAKE_MAX_MEMO_BYTES) {
      throw new TypeError(
        `swap-handshake memo exceeds ${SWAP_HANDSHAKE_MAX_MEMO_BYTES} UTF-8 bytes`,
      )
    }
    validated.memo = obj.memo
  }

  return validated
}

export const readSwapHandshakePayload = validateSwapHandshakePayload

/**
 * Deterministically derives per-swap HTLC preimage, SHA-256 hashlock, adaptor secret scalar,
 * and ephemeral signing seed from `(masterSeed, swapId, role)` using HKDF-SHA256.
 *
 * Because all secrets are derived purely from the wallet's root `masterSeed` and the
 * public `swapId` in the chat transcript, a user whose primary device (e.g. phone) goes
 * offline mid-swap can seamlessly resume and settle or refund the swap from any secondary
 * synced device (e.g. desktop) without transferring fragile device-local state.
 */
export function deriveSwapSecrets(
  params: DeriveSwapSecretsParams,
): DerivedSwapSecrets {
  if (
    !params ||
    !(params.masterSeed instanceof Uint8Array) ||
    params.masterSeed.byteLength < 16
  ) {
    throw new TypeError(
      'deriveSwapSecrets requires a masterSeed Uint8Array of at least 16 bytes',
    )
  }
  const swapId = assertNonEmptyString(params.swapId, 'swapId', 128)
  if (params.role !== 'maker' && params.role !== 'taker') {
    throw new TypeError("deriveSwapSecrets role must be 'maker' or 'taker'")
  }

  const salt = utf8ToBytes(SWAP_HANDSHAKE_HKDF_SALT)
  const info = utf8ToBytes(`frank-swap-v1:${swapId}:${params.role}`)
  const okm = hkdf(sha256, params.masterSeed, salt, info, 96)

  const preimage = okm.slice(0, 32)
  const adaptorSecretScalar = okm.slice(32, 64)
  const ephemeralSigningSeed = okm.slice(64, 96)
  const hashlockSha256 = sha256(preimage)

  return {
    preimage,
    preimageHex: bytesToHex(preimage),
    hashlockSha256,
    hashlockSha256Hex: bytesToHex(hashlockSha256),
    adaptorSecretScalar,
    adaptorSecretScalarHex: bytesToHex(adaptorSecretScalar),
    ephemeralSigningSeed,
    ephemeralSigningSeedHex: bytesToHex(ephemeralSigningSeed),
  }
}

/**
 * Constant-time verification that `sha256(preimageHex) === expectedHashlockSha256Hex`.
 */
export function verifyPreimageAgainstHashlock(
  revealedPreimageHex: string,
  expectedHashlockSha256Hex: string,
): boolean {
  try {
    const preimageNorm = normalizeHex32(
      revealedPreimageHex,
      'revealedPreimageHex',
    )
    const hashlockNorm = normalizeHex32(
      expectedHashlockSha256Hex,
      'expectedHashlockSha256Hex',
    )
    const computedHashHex = bytesToHex(sha256(hexToBytes(preimageNorm)))
    if (computedHashHex.length !== hashlockNorm.length) {
      return false
    }
    let diff = 0
    for (let i = 0; i < computedHashHex.length; i += 1) {
      diff |= computedHashHex.charCodeAt(i) ^ hashlockNorm.charCodeAt(i)
    }
    return diff === 0
  } catch {
    return false
  }
}

export function computeSwapDeviceLeaseState(params: {
  executorDeviceId: string
  leaseExpiresAtMs: number
  localDeviceId?: string
  nowMs?: number
}): SwapDeviceLeaseState {
  const nowMs = params.nowMs ?? Date.now()
  const isLocalDeviceLeader = Boolean(
    params.localDeviceId && params.executorDeviceId === params.localDeviceId,
  )
  const isLeaseExpired = nowMs >= params.leaseExpiresAtMs
  const canLocalDeviceExecute = isLocalDeviceLeader || isLeaseExpired
  const requiresFailoverTakeover =
    Boolean(
      params.localDeviceId
        ? params.executorDeviceId !== params.localDeviceId
        : true,
    ) && isLeaseExpired

  return {
    executorDeviceId: params.executorDeviceId,
    leaseExpiresAtMs: params.leaseExpiresAtMs,
    isLocalDeviceLeader,
    isLeaseExpired,
    canLocalDeviceExecute,
    requiresFailoverTakeover,
  }
}

/**
 * Folds an ordered or unordered sequence of `SwapHandshakePayload` items (or
 * `ApplicationMessageItem` wrappers) for a swap into a deterministic
 * `FoldedSwapHandshakeState` with multi-device execution lease enforcement.
 */
export function foldSwapHandshakeState(
  items: ReadonlyArray<SwapHandshakePayload | ApplicationMessageItem | unknown>,
  options: FoldSwapHandshakeOptions = {},
): FoldedSwapHandshakeState | null {
  if (!Array.isArray(items) || items.length === 0) {
    return null
  }

  const validPayloads: SwapHandshakePayload[] = []
  for (const item of items) {
    const extracted = extractSwapHandshakePayload(item)
    if (extracted) {
      validPayloads.push(extracted)
    }
  }

  if (validPayloads.length === 0) {
    return null
  }

  const proposal = validPayloads.find(p => p.action === 'propose')
  if (!proposal || !proposal.giveLeg || !proposal.wantLeg) {
    return null
  }

  const swapId = proposal.swapId
  const matchingPayloads = validPayloads
    .filter(p => p.swapId === swapId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence)

  const nowMs = options.nowMs ?? Date.now()
  const localDeviceId = options.localDeviceId

  let phase: SwapHandshakePhase = 'proposed'
  let makerAddress =
    proposal.makerAddress ?? proposal.giveLeg.recipientAddress ?? ''
  let takerAddress =
    proposal.takerAddress ?? proposal.wantLeg.recipientAddress ?? ''
  const giveLeg = proposal.giveLeg
  const wantLeg = proposal.wantLeg
  const hashlockSha256Hex = proposal.hashlockSha256Hex ?? '0'.repeat(64)
  const timelockExpiresAtMs = proposal.timelockExpiresAtMs ?? 0
  let makerLockTxHash: string | null = proposal.lockTxHash ?? null
  let takerLockTxHash: string | null = null
  let settleTxHash: string | null = null
  let refundTxHash: string | null = null
  let revealedPreimageHex: string | null = null
  let memo: string | undefined = proposal.memo

  let rawMakerLease: {
    executorDeviceId: string
    leaseExpiresAtMs: number
  } | null = {
    executorDeviceId: proposal.executorDeviceId,
    leaseExpiresAtMs: proposal.leaseExpiresAtMs,
  }
  let rawTakerLease: {
    executorDeviceId: string
    leaseExpiresAtMs: number
  } | null = null

  let lastSequence = -1
  let latestActiveLeaseSide: SwapHandshakeRole = 'maker'

  for (const step of matchingPayloads) {
    if (step.sequence <= lastSequence && step.action !== 'propose') {
      continue
    }
    lastSequence = Math.max(lastSequence, step.sequence)

    if (step.makerAddress) {
      makerAddress = step.makerAddress
    }
    if (step.takerAddress) {
      takerAddress = step.takerAddress
    }
    if (step.memo !== undefined) {
      memo = step.memo
    }

    const isTerminal =
      phase === 'settled' || phase === 'refunded' || phase === 'cancelled'

    switch (step.action) {
      case 'propose': {
        rawMakerLease = {
          executorDeviceId: step.executorDeviceId,
          leaseExpiresAtMs: step.leaseExpiresAtMs,
        }
        latestActiveLeaseSide = 'maker'
        if (step.lockTxHash) {
          makerLockTxHash = step.lockTxHash
        }
        break
      }

      case 'accept_and_lock': {
        if (!isTerminal && phase === 'proposed') {
          phase = 'maker_locked'
          makerLockTxHash =
            step.lockTxHash ?? step.counterLockTxHash ?? makerLockTxHash
          if (step.takerAddress && !step.makerAddress) {
            rawTakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'taker'
          } else {
            rawMakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'maker'
          }
        }
        break
      }

      case 'counter_lock': {
        if (
          !isTerminal &&
          (phase === 'maker_locked' || phase === 'proposed')
        ) {
          phase = 'both_locked'
          takerLockTxHash =
            step.counterLockTxHash ?? step.lockTxHash ?? takerLockTxHash
          rawTakerLease = {
            executorDeviceId: step.executorDeviceId,
            leaseExpiresAtMs: step.leaseExpiresAtMs,
          }
          latestActiveLeaseSide = 'taker'
        }
        break
      }

      case 'settle_claim': {
        if (
          !isTerminal &&
          (phase === 'both_locked' || phase === 'maker_locked') &&
          step.revealedPreimageHex &&
          verifyPreimageAgainstHashlock(
            step.revealedPreimageHex,
            hashlockSha256Hex,
          )
        ) {
          phase = 'settled'
          settleTxHash = step.settleTxHash ?? settleTxHash
          revealedPreimageHex = step.revealedPreimageHex.toLowerCase()
          if (
            (step.takerAddress && !step.makerAddress) ||
            (rawTakerLease &&
              step.executorDeviceId === rawTakerLease.executorDeviceId)
          ) {
            rawTakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'taker'
          } else {
            rawMakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'maker'
          }
        }
        break
      }

      case 'refund': {
        if (
          !isTerminal &&
          (phase === 'maker_locked' || phase === 'both_locked')
        ) {
          phase = 'refunded'
          refundTxHash = step.refundTxHash ?? refundTxHash
          if (
            (step.takerAddress && !step.makerAddress) ||
            (rawTakerLease &&
              step.executorDeviceId === rawTakerLease.executorDeviceId)
          ) {
            rawTakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'taker'
          } else {
            rawMakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
            latestActiveLeaseSide = 'maker'
          }
        }
        break
      }

      case 'cancel': {
        if (!isTerminal && phase === 'proposed') {
          phase = 'cancelled'
          rawMakerLease = {
            executorDeviceId: step.executorDeviceId,
            leaseExpiresAtMs: step.leaseExpiresAtMs,
          }
          latestActiveLeaseSide = 'maker'
        }
        break
      }

      case 'lease_heartbeat': {
        const isTakerHeartbeat =
          (step.takerAddress && !step.makerAddress) ||
          (rawTakerLease &&
            step.executorDeviceId === rawTakerLease.executorDeviceId) ||
          options.localRole === 'taker' ||
          (options.localAddress &&
            takerAddress &&
            options.localAddress.toLowerCase() === takerAddress.toLowerCase())

        if (isTakerHeartbeat) {
          rawTakerLease = {
            executorDeviceId: step.executorDeviceId,
            leaseExpiresAtMs: step.leaseExpiresAtMs,
          }
          latestActiveLeaseSide = 'taker'
        } else {
          rawMakerLease = {
            executorDeviceId: step.executorDeviceId,
            leaseExpiresAtMs: step.leaseExpiresAtMs,
          }
          latestActiveLeaseSide = 'maker'
          if (rawTakerLease && nowMs >= rawTakerLease.leaseExpiresAtMs) {
            rawTakerLease = {
              executorDeviceId: step.executorDeviceId,
              leaseExpiresAtMs: step.leaseExpiresAtMs,
            }
          }
        }
        break
      }
    }
  }

  // Evaluate timelock expiry on non-terminal phases when timelockExpiresAtMs > 0
  const isTimelockExpired =
    timelockExpiresAtMs > 0 && nowMs >= timelockExpiresAtMs
  if (phase === 'proposed' && isTimelockExpired) {
    phase = 'expired'
  }

  const makerLease = rawMakerLease
    ? computeSwapDeviceLeaseState({
        executorDeviceId: rawMakerLease.executorDeviceId,
        leaseExpiresAtMs: rawMakerLease.leaseExpiresAtMs,
        localDeviceId,
        nowMs,
      })
    : null

  const takerLease = rawTakerLease
    ? computeSwapDeviceLeaseState({
        executorDeviceId: rawTakerLease.executorDeviceId,
        leaseExpiresAtMs: rawTakerLease.leaseExpiresAtMs,
        localDeviceId,
        nowMs,
      })
    : null

  // Determine the governing lease for local execution gating
  let resolvedRole: SwapHandshakeRole | 'both' | 'observer' = 'both'
  if (options.localRole) {
    resolvedRole = options.localRole
  } else if (options.localAddress) {
    const normLocal = options.localAddress.toLowerCase()
    if (makerAddress && normLocal === makerAddress.toLowerCase()) {
      resolvedRole = 'maker'
    } else if (takerAddress && normLocal === takerAddress.toLowerCase()) {
      resolvedRole = 'taker'
    } else {
      resolvedRole = 'observer'
    }
  }

  let governingLease: SwapDeviceLeaseState | null = null
  if (resolvedRole === 'maker') {
    governingLease = makerLease
  } else if (resolvedRole === 'taker') {
    governingLease = takerLease
  } else if (resolvedRole === 'both') {
    governingLease =
      latestActiveLeaseSide === 'taker'
        ? takerLease ?? makerLease
        : makerLease ?? takerLease
  }

  const canLocalDeviceExecute =
    resolvedRole !== 'observer' &&
    (governingLease ? governingLease.canLocalDeviceExecute : true)

  const availableActions: SwapHandshakeAction[] = []
  if (canLocalDeviceExecute) {
    switch (phase) {
      case 'proposed':
        availableActions.push('accept_and_lock', 'cancel')
        break
      case 'maker_locked':
        if (!isTimelockExpired) {
          availableActions.push('counter_lock')
        }
        availableActions.push('refund')
        break
      case 'both_locked':
        availableActions.push('settle_claim', 'refund')
        break
      case 'expired':
        if (makerLockTxHash || takerLockTxHash) {
          availableActions.push('refund')
        }
        break
      case 'settled':
      case 'refunded':
      case 'cancelled':
        break
    }
  }

  const state: FoldedSwapHandshakeState = {
    swapId,
    mode: proposal.mode,
    phase,
    makerAddress,
    takerAddress,
    giveLeg,
    wantLeg,
    hashlockSha256Hex,
    timelockExpiresAtMs,
    makerLockTxHash,
    takerLockTxHash,
    settleTxHash,
    refundTxHash,
    revealedPreimageHex,
    makerLease,
    takerLease,
    availableActions,
  }

  if (memo !== undefined) {
    state.memo = memo
  }
  if (lastSequence >= 0) {
    state.lastSequence = lastSequence
  }

  return state
}

function encodeSwapLegMap(leg: SwapLegSpec): Map<number, Encodable> {
  return new Map<number, Encodable>([
    [CBOR_LEG_KEY_CHAIN_KEY, leg.chainKey],
    [CBOR_LEG_KEY_ASSET_SYMBOL, leg.assetSymbol],
    [CBOR_LEG_KEY_AMOUNT_ATOMIC, leg.amountAtomic],
    [CBOR_LEG_KEY_DECIMALS, leg.decimals],
    [CBOR_LEG_KEY_RECIPIENT_ADDRESS, leg.recipientAddress],
  ])
}

function decodeSwapLegMap(raw: FrankValue, field: string): SwapLegSpec {
  if (!(raw instanceof Map)) {
    throw new TypeError(`Expected canonical CBOR map for ${field}`)
  }
  for (const key of raw.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 4n) {
      throw new TypeError(`Unexpected CBOR key in ${field}: ${String(key)}`)
    }
  }
  const rawDecimals = raw.get(BigInt(CBOR_LEG_KEY_DECIMALS))
  if (typeof rawDecimals !== 'bigint' || rawDecimals < 0n || rawDecimals > 36n) {
    throw new TypeError(`${field}.decimals must be 0..36`)
  }
  return validateSwapLegSpec(
    {
      chainKey: raw.get(BigInt(CBOR_LEG_KEY_CHAIN_KEY)),
      assetSymbol: raw.get(BigInt(CBOR_LEG_KEY_ASSET_SYMBOL)),
      amountAtomic: raw.get(BigInt(CBOR_LEG_KEY_AMOUNT_ATOMIC)),
      decimals: Number(rawDecimals),
      recipientAddress: raw.get(BigInt(CBOR_LEG_KEY_RECIPIENT_ADDRESS)),
    },
    field,
  )
}

function encodeSwapHandshakeMap(
  payload: SwapHandshakePayload,
): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_SCHEMA_VERSION, payload.schemaVersion],
    [CBOR_KEY_SWAP_ID, payload.swapId],
    [CBOR_KEY_MODE, payload.mode],
    [CBOR_KEY_ACTION, payload.action],
    [CBOR_KEY_SEQUENCE, payload.sequence],
    [CBOR_KEY_EXECUTOR_DEVICE_ID, payload.executorDeviceId],
    [CBOR_KEY_LEASE_EXPIRES_AT_MS, payload.leaseExpiresAtMs],
  ])

  if (payload.makerAddress !== undefined) {
    map.set(CBOR_KEY_MAKER_ADDRESS, payload.makerAddress)
  }
  if (payload.takerAddress !== undefined) {
    map.set(CBOR_KEY_TAKER_ADDRESS, payload.takerAddress)
  }
  if (payload.giveLeg !== undefined) {
    map.set(CBOR_KEY_GIVE_LEG, encodeSwapLegMap(payload.giveLeg))
  }
  if (payload.wantLeg !== undefined) {
    map.set(CBOR_KEY_WANT_LEG, encodeSwapLegMap(payload.wantLeg))
  }
  if (payload.hashlockSha256Hex !== undefined) {
    map.set(CBOR_KEY_HASHLOCK_SHA256_HEX, payload.hashlockSha256Hex)
  }
  if (payload.timelockExpiresAtMs !== undefined) {
    map.set(CBOR_KEY_TIMELOCK_EXPIRES_AT_MS, payload.timelockExpiresAtMs)
  }
  if (payload.lockTxHash !== undefined) {
    map.set(CBOR_KEY_LOCK_TX_HASH, payload.lockTxHash)
  }
  if (payload.counterLockTxHash !== undefined) {
    map.set(CBOR_KEY_COUNTER_LOCK_TX_HASH, payload.counterLockTxHash)
  }
  if (payload.settleTxHash !== undefined) {
    map.set(CBOR_KEY_SETTLE_TX_HASH, payload.settleTxHash)
  }
  if (payload.revealedPreimageHex !== undefined) {
    map.set(CBOR_KEY_REVEALED_PREIMAGE_HEX, payload.revealedPreimageHex)
  }
  if (payload.refundTxHash !== undefined) {
    map.set(CBOR_KEY_REFUND_TX_HASH, payload.refundTxHash)
  }
  if (payload.memo !== undefined) {
    map.set(CBOR_KEY_MEMO, payload.memo)
  }

  return map
}

function decodeSafeBigIntToNumber(raw: unknown, field: string): number {
  if (typeof raw !== 'bigint') {
    throw new TypeError(`swap-handshake-v1 ${field} must be an integer`)
  }
  const num = Number(raw)
  if (!Number.isSafeInteger(num)) {
    throw new TypeError(`swap-handshake-v1 ${field} exceeds safe integer range`)
  }
  return num
}

function decodeSwapHandshakeMap(decoded: FrankValue): SwapHandshakePayload {
  if (!(decoded instanceof Map)) {
    throw new TypeError(
      'Expected canonical CBOR map for swap-handshake-v1 payload',
    )
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 18n) {
      throw new TypeError(
        `Unexpected CBOR key in swap-handshake-v1: ${String(key)}`,
      )
    }
  }

  const rawSchemaVersion = decoded.get(BigInt(CBOR_KEY_SCHEMA_VERSION))
  if (rawSchemaVersion !== 1n) {
    throw new TypeError(
      `Unsupported swap-handshake-v1 schemaVersion: ${String(rawSchemaVersion)}`,
    )
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    swapId: decoded.get(BigInt(CBOR_KEY_SWAP_ID)),
    mode: decoded.get(BigInt(CBOR_KEY_MODE)),
    action: decoded.get(BigInt(CBOR_KEY_ACTION)),
    sequence: decodeSafeBigIntToNumber(
      decoded.get(BigInt(CBOR_KEY_SEQUENCE)),
      'sequence',
    ),
    executorDeviceId: decoded.get(BigInt(CBOR_KEY_EXECUTOR_DEVICE_ID)),
    leaseExpiresAtMs: decodeSafeBigIntToNumber(
      decoded.get(BigInt(CBOR_KEY_LEASE_EXPIRES_AT_MS)),
      'leaseExpiresAtMs',
    ),
  }

  if (decoded.has(BigInt(CBOR_KEY_MAKER_ADDRESS))) {
    candidate.makerAddress = decoded.get(BigInt(CBOR_KEY_MAKER_ADDRESS))
  }
  if (decoded.has(BigInt(CBOR_KEY_TAKER_ADDRESS))) {
    candidate.takerAddress = decoded.get(BigInt(CBOR_KEY_TAKER_ADDRESS))
  }
  if (decoded.has(BigInt(CBOR_KEY_GIVE_LEG))) {
    candidate.giveLeg = decodeSwapLegMap(
      decoded.get(BigInt(CBOR_KEY_GIVE_LEG))!,
      'giveLeg',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_WANT_LEG))) {
    candidate.wantLeg = decodeSwapLegMap(
      decoded.get(BigInt(CBOR_KEY_WANT_LEG))!,
      'wantLeg',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_HASHLOCK_SHA256_HEX))) {
    candidate.hashlockSha256Hex = decoded.get(
      BigInt(CBOR_KEY_HASHLOCK_SHA256_HEX),
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_TIMELOCK_EXPIRES_AT_MS))) {
    candidate.timelockExpiresAtMs = decodeSafeBigIntToNumber(
      decoded.get(BigInt(CBOR_KEY_TIMELOCK_EXPIRES_AT_MS)),
      'timelockExpiresAtMs',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_LOCK_TX_HASH))) {
    candidate.lockTxHash = decoded.get(BigInt(CBOR_KEY_LOCK_TX_HASH))
  }
  if (decoded.has(BigInt(CBOR_KEY_COUNTER_LOCK_TX_HASH))) {
    candidate.counterLockTxHash = decoded.get(
      BigInt(CBOR_KEY_COUNTER_LOCK_TX_HASH),
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_SETTLE_TX_HASH))) {
    candidate.settleTxHash = decoded.get(BigInt(CBOR_KEY_SETTLE_TX_HASH))
  }
  if (decoded.has(BigInt(CBOR_KEY_REVEALED_PREIMAGE_HEX))) {
    candidate.revealedPreimageHex = decoded.get(
      BigInt(CBOR_KEY_REVEALED_PREIMAGE_HEX),
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_REFUND_TX_HASH))) {
    candidate.refundTxHash = decoded.get(BigInt(CBOR_KEY_REFUND_TX_HASH))
  }
  if (decoded.has(BigInt(CBOR_KEY_MEMO))) {
    candidate.memo = decoded.get(BigInt(CBOR_KEY_MEMO))
  }

  return validateSwapHandshakePayload(candidate)
}

export function encodeSwapHandshakePayload(
  payload: SwapHandshakePayload,
): Uint8Array {
  const validated = validateSwapHandshakePayload(payload)
  return encodeCanonical(encodeSwapHandshakeMap(validated))
}

export function decodeSwapHandshakePayload(
  bytes: Uint8Array,
  context?: MessageItemDecodeContext,
): SwapHandshakePayload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError(
      'Expected non-empty Uint8Array for swap-handshake-v1 payload',
    )
  }
  const budget = context?.budget ?? standaloneItemBudget()
  const decoded = budget.decodeCbor(bytes, SWAP_HANDSHAKE_PLUGIN_ID)
  return decodeSwapHandshakeMap(decoded)
}

export function toSwapHandshakeApplicationItem(
  payload: SwapHandshakePayload,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: SWAP_HANDSHAKE_PLUGIN_ID,
    value: validateSwapHandshakePayload(payload),
  }
}

export function extractSwapHandshakePayload(
  item: unknown,
): SwapHandshakePayload | null {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as Record<string, unknown>
  try {
    if (record.type === 'application') {
      if (record.itemType !== SWAP_HANDSHAKE_PLUGIN_ID) {
        return null
      }
      return validateSwapHandshakePayload(record.value)
    }
    return validateSwapHandshakePayload(item)
  } catch {
    return null
  }
}

export function parseSwapHandshakeApplicationItem(
  itemOrPayload: unknown,
): SwapHandshakePayload | null {
  return extractSwapHandshakePayload(itemOrPayload)
}

export function buildSwapHandshakeSummary(
  payload: SwapHandshakePayload,
): string {
  const validated = validateSwapHandshakePayload(payload)
  if (validated.giveLeg && validated.wantLeg) {
    const giveAmt = formatSwapLegAmount(
      validated.giveLeg.amountAtomic,
      validated.giveLeg.decimals,
    )
    const wantAmt = formatSwapLegAmount(
      validated.wantLeg.amountAtomic,
      validated.wantLeg.decimals,
    )
    return `🔄 Swap (${validated.action}): ${giveAmt} ${validated.giveLeg.assetSymbol} ↔ ${wantAmt} ${validated.wantLeg.assetSymbol}`
  }
  return `🔄 Swap (${validated.action}): ${validated.swapId.slice(0, 12)}`
}

export const formatSwapHandshakePreviewText = buildSwapHandshakeSummary

function unwrapSwapHandshakePayload(
  input: SwapHandshakePayload | ApplicationMessageItem,
): SwapHandshakePayload {
  if (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'application'
  ) {
    if (input.itemType !== SWAP_HANDSHAKE_PLUGIN_ID) {
      throw new TypeError(
        `Expected ${SWAP_HANDSHAKE_PLUGIN_ID} application item`,
      )
    }
    return validateSwapHandshakePayload(input.value)
  }
  return validateSwapHandshakePayload(input)
}

export interface SwapHandshakeItemPluginContract
  extends ApplicationItemPlugin<SwapHandshakePayload>,
    Omit<
      MessageItemPlugin<ApplicationMessageItem, SwapHandshakePayload>,
      'encode' | 'decode' | 'previewText' | 'hydrate'
    > {
  readonly pluginId: typeof SWAP_HANDSHAKE_PLUGIN_ID
  readonly type: typeof SWAP_HANDSHAKE_PLUGIN_ID
  readonly itemType: typeof SWAP_HANDSHAKE_ITEM_TYPE
  read(value: unknown): SwapHandshakePayload
  buildSummary(
    payload: SwapHandshakePayload | ApplicationMessageItem,
  ): string
  previewText(
    payload: SwapHandshakePayload | ApplicationMessageItem,
  ): string
  encode(payload: SwapHandshakePayload | ApplicationMessageItem): Uint8Array
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): SwapHandshakePayload
  hydrate(
    raw: ApplicationMessageItem | SwapHandshakePayload,
  ): SwapHandshakePayload
}

export const swapHandshakePlugin: SwapHandshakeItemPluginContract = {
  pluginId: SWAP_HANDSHAKE_PLUGIN_ID,
  type: SWAP_HANDSHAKE_PLUGIN_ID,
  itemType: SWAP_HANDSHAKE_ITEM_TYPE,
  read: validateSwapHandshakePayload,
  hydrate(
    raw: ApplicationMessageItem | SwapHandshakePayload,
  ): SwapHandshakePayload {
    return unwrapSwapHandshakePayload(raw)
  },
  buildSummary(
    input: SwapHandshakePayload | ApplicationMessageItem,
  ): string {
    return buildSwapHandshakeSummary(unwrapSwapHandshakePayload(input))
  },
  previewText(
    input: SwapHandshakePayload | ApplicationMessageItem,
  ): string {
    return buildSwapHandshakeSummary(unwrapSwapHandshakePayload(input))
  },
  encode(input: SwapHandshakePayload | ApplicationMessageItem): Uint8Array {
    return encodeSwapHandshakePayload(unwrapSwapHandshakePayload(input))
  },
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): SwapHandshakePayload {
    return decodeSwapHandshakePayload(bytes, context)
  },
}

export function createSwapHandshakePlugin(): SwapHandshakeItemPluginContract {
  return swapHandshakePlugin
}

export function initSwapHandshakePlugin(
  registry: MessageItemRegistry,
  capabilities?: MessageItemPluginCapabilities,
): void {
  if (capabilities) {
    requirePluginCapabilities(SWAP_HANDSHAKE_PLUGIN_ID, capabilities)
  }
  registry.registerApplication(swapHandshakePlugin)
}
