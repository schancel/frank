import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  isChainAddress,
  safeToChainDisplayAddress,
  toChainDisplayAddress,
} from './chain-address'
import { sameCanonicalAddress } from './own-address'

export const CONTACT_KEY_ROTATION_DOMAIN = 'frank.contact-key-rotation.v1'

export interface ContactKeyRotationStatement {
  version: 1
  masterPublicKeyHex: string
  oldAddress: string
  newAddress: string
  sequence: number
  issuedAt: number
  masterSignatureHex: string
  oldKeySignatureHex?: string
}

export type ContactKeyRotationRejectionReason =
  | 'invalid-version'
  | 'invalid-address'
  | 'same-address'
  | 'invalid-sequence'
  | 'invalid-issued-at'
  | 'invalid-master-public-key'
  | 'invalid-signature'
  | 'invalid-old-key-signature'
  | 'master-key-mismatch'
  | 'old-address-mismatch'
  | 'replayed-or-stale-sequence'
  | 'contact-not-found'
  | 'new-address-conflict'

export type ContactKeyRotationVerificationResult =
  | {
      valid: true
      normalizedMasterPublicKeyHex: string
      oldAddress: string
      newAddress: string
      sequence: number
      issuedAt: number
    }
  | {
      valid: false
      reason: ContactKeyRotationRejectionReason
      message: string
    }

export interface CreateContactKeyRotationStatementParams {
  masterPrivateKey: string | Uint8Array
  oldAddress: string
  newAddress: string
  sequence: number
  issuedAt?: number
  oldPrivateKey?: string | Uint8Array
}

export interface VerifyContactKeyRotationOptions {
  expectedMasterPublicKeyHex?: string | null
  expectedOldAddress?: string | null
  lastRotationSequence?: number
  requireOldAddressBinding?: boolean
}

function stripHexPrefix(hex: string): string {
  const trimmed = hex.trim()
  return trimmed.startsWith('0x') || trimmed.startsWith('0X')
    ? trimmed.slice(2)
    : trimmed
}

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== 'string') return null
  const clean = stripHexPrefix(hex)
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    return null
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'))
}

function privateKeyToBytes(key: string | Uint8Array): Uint8Array {
  const bytes =
    typeof key === 'string'
      ? hexToBytes(key)
      : key instanceof Uint8Array
      ? Uint8Array.from(key)
      : null
  if (!bytes || bytes.length !== 32) {
    throw new Error('Private key must be 32 bytes')
  }
  return bytes
}

/**
 * Normalizes a secp256k1 public key hex string to its 33-byte compressed lowercase hex form.
 * Returns null if the input is not a valid secp256k1 point.
 */
export function normalizeMasterPublicKeyHex(pubKeyHex: string): string | null {
  const bytes = hexToBytes(pubKeyHex)
  if (!bytes || (bytes.length !== 33 && bytes.length !== 65)) {
    return null
  }
  try {
    const point = secp256k1.ProjectivePoint.fromHex(bytes)
    point.assertValidity()
    const compressed = point.toRawBytes(true)
    return Buffer.from(compressed).toString('hex').toLowerCase()
  } catch {
    return null
  }
}

/**
 * Derives the canonical chain display address (`0x...`) corresponding to a secp256k1 public key.
 * Returns null if the public key is invalid.
 */
export function deriveAddressFromPublicKeyHex(
  pubKeyHex: string,
): string | null {
  const bytes = hexToBytes(pubKeyHex)
  if (!bytes || (bytes.length !== 33 && bytes.length !== 65)) {
    return null
  }
  try {
    const point = secp256k1.ProjectivePoint.fromHex(bytes)
    point.assertValidity()
    const uncompressed = point.toRawBytes(false)
    const digest = keccak_256(Uint8Array.from(uncompressed.subarray(1)))
    const rawAddr = `0x${Buffer.from(digest.subarray(12)).toString('hex')}`
    return safeToChainDisplayAddress(rawAddr)
  } catch {
    return null
  }
}

/**
 * Canonical domain-separated payload bytes:
 * `"frank.contact-key-rotation.v1\0<version>\0<masterPubKeyHex>\0<oldAddressLower>\0<newAddressLower>\0<sequence>\0<issuedAt>"`
 */
export function encodeContactKeyRotationPayload(params: {
  version: 1
  masterPublicKeyHex: string
  oldAddress: string
  newAddress: string
  sequence: number
  issuedAt: number
}): Uint8Array {
  const normalizedPubKey =
    normalizeMasterPublicKeyHex(params.masterPublicKeyHex) ??
    stripHexPrefix(params.masterPublicKeyHex).toLowerCase()
  const canonicalOld = toChainDisplayAddress(params.oldAddress).toLowerCase()
  const canonicalNew = toChainDisplayAddress(params.newAddress).toLowerCase()
  const canonicalString = [
    CONTACT_KEY_ROTATION_DOMAIN,
    String(params.version),
    normalizedPubKey,
    canonicalOld,
    canonicalNew,
    String(params.sequence),
    String(params.issuedAt),
  ].join('\0')
  return Uint8Array.from(new TextEncoder().encode(canonicalString))
}

export function hashContactKeyRotationPayload(params: {
  version: 1
  masterPublicKeyHex: string
  oldAddress: string
  newAddress: string
  sequence: number
  issuedAt: number
}): Uint8Array {
  return Uint8Array.from(sha256(encodeContactKeyRotationPayload(params)))
}

export function createContactKeyRotationStatement(
  params: CreateContactKeyRotationStatementParams,
): ContactKeyRotationStatement {
  const privBytes = privateKeyToBytes(params.masterPrivateKey)
  const pubBytes = secp256k1.getPublicKey(privBytes, true)
  const masterPublicKeyHex = Buffer.from(pubBytes).toString('hex').toLowerCase()

  const oldAddress = toChainDisplayAddress(params.oldAddress)
  const newAddress = toChainDisplayAddress(params.newAddress)
  if (sameCanonicalAddress(oldAddress, newAddress)) {
    throw new Error('Contact key rotation newAddress must differ from oldAddress')
  }
  if (!Number.isSafeInteger(params.sequence) || params.sequence < 1) {
    throw new Error('Contact key rotation sequence must be a positive integer')
  }
  const issuedAt = params.issuedAt ?? Date.now()
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new Error('Contact key rotation issuedAt must be a positive integer')
  }

  const digest = hashContactKeyRotationPayload({
    version: 1,
    masterPublicKeyHex,
    oldAddress,
    newAddress,
    sequence: params.sequence,
    issuedAt,
  })

  const masterSig = secp256k1.sign(digest, privBytes, { lowS: true })
  const masterSignatureHex = masterSig.toCompactHex().toLowerCase()

  let oldKeySignatureHex: string | undefined
  if (params.oldPrivateKey !== undefined) {
    const oldPrivBytes = privateKeyToBytes(params.oldPrivateKey)
    const oldSig = secp256k1.sign(digest, oldPrivBytes, { lowS: true })
    const recoveryHex = (oldSig.recovery ?? 0).toString(16).padStart(2, '0')
    oldKeySignatureHex = `${oldSig.toCompactHex().toLowerCase()}${recoveryHex}`
  }

  return {
    version: 1,
    masterPublicKeyHex,
    oldAddress,
    newAddress,
    sequence: params.sequence,
    issuedAt,
    masterSignatureHex,
    ...(oldKeySignatureHex ? { oldKeySignatureHex } : {}),
  }
}

export function verifyContactKeyRotationStatement(
  statement: ContactKeyRotationStatement,
  options: VerifyContactKeyRotationOptions = {},
): ContactKeyRotationVerificationResult {
  if (!statement || statement.version !== 1) {
    return {
      valid: false,
      reason: 'invalid-version',
      message: 'Unsupported or missing contact key rotation statement version',
    }
  }

  if (
    !isChainAddress(statement.oldAddress) ||
    !isChainAddress(statement.newAddress)
  ) {
    return {
      valid: false,
      reason: 'invalid-address',
      message: 'Rotation statement contains an invalid oldAddress or newAddress',
    }
  }

  const oldAddress = toChainDisplayAddress(statement.oldAddress)
  const newAddress = toChainDisplayAddress(statement.newAddress)
  if (sameCanonicalAddress(oldAddress, newAddress)) {
    return {
      valid: false,
      reason: 'same-address',
      message: 'Rotation statement oldAddress and newAddress must differ',
    }
  }

  if (!Number.isSafeInteger(statement.sequence) || statement.sequence < 1) {
    return {
      valid: false,
      reason: 'invalid-sequence',
      message: 'Rotation statement sequence must be a positive integer',
    }
  }

  if (!Number.isSafeInteger(statement.issuedAt) || statement.issuedAt <= 0) {
    return {
      valid: false,
      reason: 'invalid-issued-at',
      message: 'Rotation statement issuedAt must be a positive timestamp',
    }
  }

  const normalizedMasterPublicKeyHex = normalizeMasterPublicKeyHex(
    statement.masterPublicKeyHex,
  )
  if (!normalizedMasterPublicKeyHex) {
    return {
      valid: false,
      reason: 'invalid-master-public-key',
      message: 'Rotation statement masterPublicKeyHex is not a valid secp256k1 key',
    }
  }

  if (options.expectedOldAddress) {
    if (!sameCanonicalAddress(oldAddress, options.expectedOldAddress)) {
      return {
        valid: false,
        reason: 'old-address-mismatch',
        message: `Rotation statement oldAddress ${oldAddress} does not match pinned address ${options.expectedOldAddress}`,
      }
    }
  }

  if (options.expectedMasterPublicKeyHex) {
    const expectedNormalized = normalizeMasterPublicKeyHex(
      options.expectedMasterPublicKeyHex,
    )
    if (
      !expectedNormalized ||
      expectedNormalized !== normalizedMasterPublicKeyHex
    ) {
      return {
        valid: false,
        reason: 'master-key-mismatch',
        message:
          'Rotation statement masterPublicKeyHex does not match the contact pinned master key',
      }
    }
  }

  if (
    options.lastRotationSequence !== undefined &&
    statement.sequence <= options.lastRotationSequence
  ) {
    return {
      valid: false,
      reason: 'replayed-or-stale-sequence',
      message: `Rotation statement sequence ${statement.sequence} is not greater than current sequence ${options.lastRotationSequence}`,
    }
  }

  const sigBytes = hexToBytes(statement.masterSignatureHex)
  if (!sigBytes) {
    return {
      valid: false,
      reason: 'invalid-signature',
      message: 'Rotation statement masterSignatureHex is malformed',
    }
  }

  const digest = hashContactKeyRotationPayload({
    version: 1,
    masterPublicKeyHex: normalizedMasterPublicKeyHex,
    oldAddress,
    newAddress,
    sequence: statement.sequence,
    issuedAt: statement.issuedAt,
  })

  const masterPubBytes = hexToBytes(normalizedMasterPublicKeyHex)
  if (!masterPubBytes) {
    return {
      valid: false,
      reason: 'invalid-master-public-key',
      message: 'Rotation statement masterPublicKeyHex is invalid',
    }
  }

  try {
    const parsedSig =
      sigBytes.length === 64
        ? secp256k1.Signature.fromCompact(sigBytes)
        : secp256k1.Signature.fromDER(sigBytes)
    parsedSig.assertValidity()
    if (parsedSig.hasHighS()) {
      return {
        valid: false,
        reason: 'invalid-signature',
        message: 'Rotation statement signature has high-S value',
      }
    }
    const verified = secp256k1.verify(parsedSig, digest, masterPubBytes, {
      lowS: true,
    })
    if (!verified) {
      return {
        valid: false,
        reason: 'invalid-signature',
        message: 'Rotation statement signature verification failed',
      }
    }
  } catch {
    return {
      valid: false,
      reason: 'invalid-signature',
      message: 'Rotation statement signature verification failed',
    }
  }

  let oldKeyBound = false
  const derivedMasterAddr = deriveAddressFromPublicKeyHex(
    normalizedMasterPublicKeyHex,
  )
  if (derivedMasterAddr && sameCanonicalAddress(derivedMasterAddr, oldAddress)) {
    oldKeyBound = true
  }

  if (statement.oldKeySignatureHex !== undefined) {
    const oldSigBytes = hexToBytes(statement.oldKeySignatureHex)
    if (!oldSigBytes || oldSigBytes.length !== 65) {
      return {
        valid: false,
        reason: 'invalid-old-key-signature',
        message: 'Rotation statement oldKeySignatureHex must be 65 bytes',
      }
    }
    const recovery = oldSigBytes[64]
    if (recovery !== 0 && recovery !== 1) {
      return {
        valid: false,
        reason: 'invalid-old-key-signature',
        message: 'Rotation statement oldKeySignatureHex has invalid recovery bit',
      }
    }
    try {
      const parsedOldSig = secp256k1.Signature.fromCompact(
        oldSigBytes.subarray(0, 64),
      )
      parsedOldSig.assertValidity()
      if (parsedOldSig.hasHighS()) {
        return {
          valid: false,
          reason: 'invalid-old-key-signature',
          message: 'Rotation statement oldKeySignatureHex has high-S value',
        }
      }
      const recoveredPoint = parsedOldSig
        .addRecoveryBit(recovery)
        .recoverPublicKey(digest)
      const recoveredPubHex = Buffer.from(recoveredPoint.toRawBytes(true)).toString(
        'hex',
      )
      const recoveredAddress = deriveAddressFromPublicKeyHex(recoveredPubHex)
      if (!recoveredAddress || !sameCanonicalAddress(recoveredAddress, oldAddress)) {
        return {
          valid: false,
          reason: 'invalid-old-key-signature',
          message:
            'Rotation statement oldKeySignatureHex does not match oldAddress',
        }
      }
      oldKeyBound = true
    } catch {
      return {
        valid: false,
        reason: 'invalid-old-key-signature',
        message: 'Rotation statement oldKeySignatureHex failed verification',
      }
    }
  }

  if (options.requireOldAddressBinding && !oldKeyBound) {
    return {
      valid: false,
      reason: 'master-key-mismatch',
      message:
        'Rotation statement masterPublicKeyHex is not pinned or bound to oldAddress',
    }
  }

  return {
    valid: true,
    normalizedMasterPublicKeyHex,
    oldAddress,
    newAddress,
    sequence: statement.sequence,
    issuedAt: statement.issuedAt,
  }
}
