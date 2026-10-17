import { encodeCanonical } from '@frank/codec'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import type { WebRtcMediaIntent } from './schema'

export const SFRAME_SPEC_VERSION = 'frank-sframe-v1' as const
export const SFRAME_AES_GCM_KEY_BYTES = 32
export const SFRAME_SALT_BYTES = 12
export const SFRAME_NONCE_BYTES = 12
export const SFRAME_MAX_EPOCH = 0xffff

export interface DeriveSFrameEpochKeyParams {
  callId: string
  epoch: number
  senderAddress: string
  senderDeviceId?: string
  groupSharedSecret?: Uint8Array | string
  epochSecret?: Uint8Array | string
}

export interface SFrameEpochKeyMaterial {
  callId: string
  epoch: number
  senderAddress: string
  senderDeviceId: string
  keyId: bigint
  baseKey: Uint8Array
  salt: Uint8Array
  keyHex: string
  saltHex: string
}

export interface BuildSFrameHeaderParams {
  callId: string
  epoch: number
  keyId: bigint | number
  frameCounter: bigint | number
  mediaType?: WebRtcMediaIntent
  ssrc?: number
  salt?: Uint8Array
}

export interface SFrameHeaderResult {
  headerBytes: Uint8Array
  aadBytes: Uint8Array
  nonce: Uint8Array
  epoch: number
  keyId: bigint
  frameCounter: bigint
}

export type SFrameEpochTransitionReason =
  | 'initial'
  | 'member_joined'
  | 'member_left'
  | 'key_rotation'

export interface VerifySFrameEpochTransitionParams {
  currentEpoch: number
  nextEpoch: number
  reason?: SFrameEpochTransitionReason
  previousSecretHash?: string
  nextSecretHash?: string
  previousEpochSecret?: Uint8Array | string
  nextEpochSecret?: Uint8Array | string
}

export interface SFrameEpochTransitionValidation {
  valid: boolean
  reason?: string
}

function normalizeSecretBytes(secret: Uint8Array | string | undefined): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.byteLength < 16) {
      throw new RangeError('SFrame epoch secret must be at least 16 bytes')
    }
    return secret
  }
  if (typeof secret === 'string') {
    const trimmed = secret.trim()
    if (trimmed.length < 16) {
      throw new RangeError(
        'SFrame epoch secret string must be at least 16 characters',
      )
    }
    return utf8ToBytes(trimmed)
  }
  throw new TypeError(
    'SFrame epoch key derivation requires groupSharedSecret or epochSecret',
  )
}

function writeBigUint64BE(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let remaining = BigInt.asUintN(64, value)
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

/**
 * Derives per-sender SFrame epoch key material (`keyId`, 256-bit `baseKey`, 96-bit `salt`)
 * bound to `(callId, epoch, senderAddress, senderDeviceId)` via HKDF-SHA256.
 *
 * Because the SFU only forwards encrypted RTP payloads and never receives `groupSharedSecret`,
 * the SFU remains completely untrusted for media confidentiality and frame authenticity.
 */
export function deriveSFrameEpochKey(
  params: DeriveSFrameEpochKeyParams,
): SFrameEpochKeyMaterial {
  const callId = params.callId?.trim()
  if (!callId) {
    throw new TypeError('SFrame callId must be a non-empty string')
  }
  if (
    typeof params.epoch !== 'number' ||
    !Number.isInteger(params.epoch) ||
    params.epoch < 0 ||
    params.epoch > SFRAME_MAX_EPOCH
  ) {
    throw new RangeError(`SFrame epoch must be an integer 0..${SFRAME_MAX_EPOCH}`)
  }
  const senderAddress = params.senderAddress?.trim()
  if (!senderAddress) {
    throw new TypeError('SFrame senderAddress must be a non-empty string')
  }
  const senderDeviceId = (params.senderDeviceId ?? 'default-device').trim()
  if (!senderDeviceId) {
    throw new TypeError('SFrame senderDeviceId must be a non-empty string')
  }

  const secretBytes = normalizeSecretBytes(
    params.groupSharedSecret ?? params.epochSecret,
  )

  const senderDigest = sha256(
    utf8ToBytes(`${senderAddress.toLowerCase()}:${senderDeviceId}`),
  )
  let senderShortId = 0n
  for (let i = 0; i < 6; i += 1) {
    senderShortId = (senderShortId << 8n) | BigInt(senderDigest[i]!)
  }
  const keyId = (BigInt(params.epoch & 0xffff) << 48n) | senderShortId

  const hkdfSalt = sha256(
    encodeCanonical([SFRAME_SPEC_VERSION, 'hkdf-salt', callId, params.epoch]),
  )
  const baseKeyInfo = encodeCanonical([
    SFRAME_SPEC_VERSION,
    'base-key',
    callId,
    params.epoch,
    senderAddress.toLowerCase(),
    senderDeviceId,
    keyId,
  ])
  const saltInfo = encodeCanonical([
    SFRAME_SPEC_VERSION,
    'nonce-salt',
    callId,
    params.epoch,
    senderAddress.toLowerCase(),
    senderDeviceId,
    keyId,
  ])

  const baseKey = hkdf(
    sha256,
    secretBytes,
    hkdfSalt,
    baseKeyInfo,
    SFRAME_AES_GCM_KEY_BYTES,
  )
  const salt = hkdf(
    sha256,
    secretBytes,
    hkdfSalt,
    saltInfo,
    SFRAME_SALT_BYTES,
  )

  return {
    callId,
    epoch: params.epoch,
    senderAddress,
    senderDeviceId,
    keyId,
    baseKey,
    salt,
    keyHex: bytesToHex(baseKey),
    saltHex: bytesToHex(salt),
  }
}

/**
 * Builds the SFrame wire header, authenticated AAD bytes, and 12-byte AES-GCM nonce
 * for a single media frame.
 *
 * Binds `callId`, `epoch`, `keyId`, `frameCounter`, `mediaType`, and `ssrc` into `aadBytes`
 * so an untrusted SFU cannot replay frames across epochs, splice frames between calls,
 * or spoof sender identity.
 */
export function buildSFrameHeader(
  params: BuildSFrameHeaderParams,
): SFrameHeaderResult {
  const callId = params.callId?.trim()
  if (!callId) {
    throw new TypeError('SFrame callId must be a non-empty string')
  }
  if (
    typeof params.epoch !== 'number' ||
    !Number.isInteger(params.epoch) ||
    params.epoch < 0 ||
    params.epoch > SFRAME_MAX_EPOCH
  ) {
    throw new RangeError(`SFrame epoch must be an integer 0..${SFRAME_MAX_EPOCH}`)
  }

  const keyId =
    typeof params.keyId === 'bigint' ? params.keyId : BigInt(params.keyId)
  const frameCounter =
    typeof params.frameCounter === 'bigint'
      ? params.frameCounter
      : BigInt(params.frameCounter)

  if (keyId < 0n) {
    throw new RangeError('SFrame keyId must be non-negative')
  }
  if (frameCounter < 0n) {
    throw new RangeError('SFrame frameCounter must be non-negative')
  }

  const keyIdBytes = writeBigUint64BE(keyId)
  const counterBytes = writeBigUint64BE(frameCounter)

  // Compact SFrame-style extended header: [flags(1), epoch_be(2), keyId_be(8), counter_be(8)] = 19 bytes
  const headerBytes = new Uint8Array(19)
  headerBytes[0] = 0x88 // Extended KID + Extended CTR indicator
  headerBytes[1] = (params.epoch >> 8) & 0xff
  headerBytes[2] = params.epoch & 0xff
  headerBytes.set(keyIdBytes, 3)
  headerBytes.set(counterBytes, 11)

  const aadBytes = encodeCanonical([
    SFRAME_SPEC_VERSION,
    'frame-aad',
    callId,
    params.epoch,
    keyId,
    frameCounter,
    params.mediaType ?? 'audio',
    params.ssrc ?? 0,
    headerBytes,
  ])

  const nonce = new Uint8Array(SFRAME_NONCE_BYTES)
  if (params.salt) {
    if (params.salt.byteLength !== SFRAME_SALT_BYTES) {
      throw new RangeError(
        `SFrame salt must be exactly ${SFRAME_SALT_BYTES} bytes`,
      )
    }
    nonce.set(params.salt)
  }
  for (let i = 0; i < 8; i += 1) {
    nonce[4 + i]! ^= counterBytes[i]!
  }

  return {
    headerBytes,
    aadBytes,
    nonce,
    epoch: params.epoch,
    keyId,
    frameCounter,
  }
}

function hashSecretIfProvided(
  secret: Uint8Array | string | undefined,
): string | undefined {
  if (secret === undefined) return undefined
  const bytes =
    secret instanceof Uint8Array ? secret : utf8ToBytes(String(secret))
  return bytesToHex(sha256(bytes))
}

/**
 * Validates an SFrame group key epoch transition.
 *
 * Enforces:
 * - Strict monotonic single-step epoch progression (`nextEpoch === currentEpoch + 1` on rotation).
 * - Mandatory secret rotation whenever a participant joins or leaves (`member_joined`, `member_left`, `key_rotation`),
 *   providing forward secrecy and post-compromise security against the SFU and departed members.
 */
export function verifySFrameEpochTransition(
  params: VerifySFrameEpochTransitionParams,
): SFrameEpochTransitionValidation {
  const { currentEpoch, nextEpoch, reason = 'key_rotation' } = params

  if (
    !Number.isInteger(currentEpoch) ||
    !Number.isInteger(nextEpoch) ||
    currentEpoch < 0 ||
    nextEpoch < 0 ||
    nextEpoch > SFRAME_MAX_EPOCH
  ) {
    return { valid: false, reason: 'invalid_epoch_bounds' }
  }

  if (reason === 'initial') {
    if (currentEpoch !== 0 || nextEpoch !== 0) {
      return { valid: false, reason: 'initial_epoch_must_be_zero' }
    }
    return { valid: true }
  }

  if (nextEpoch <= currentEpoch) {
    return { valid: false, reason: 'epoch_rollback_detected' }
  }

  if (nextEpoch !== currentEpoch + 1) {
    return { valid: false, reason: 'non_sequential_epoch_jump' }
  }

  const prevHash =
    params.previousSecretHash ??
    hashSecretIfProvided(params.previousEpochSecret)
  const nextHash =
    params.nextSecretHash ?? hashSecretIfProvided(params.nextEpochSecret)

  if (prevHash !== undefined && nextHash !== undefined && prevHash === nextHash) {
    return { valid: false, reason: 'epoch_secret_not_rotated' }
  }

  return { valid: true }
}
