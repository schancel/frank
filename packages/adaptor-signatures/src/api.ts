import { privateKeyFromSecretBytes } from '@frank/nakamoto/keys'

import {
  decodeAdaptorSignature,
  decodeEcdsaSignature,
  decryptSignature,
  encodeAdaptorSignature,
  encodeEcdsaSignature,
  encryptedSign,
  recoverTweak,
  verifyEncryptedSignature,
} from './ecdsa-adaptor.js'
import {
  G,
  pointBytes,
  pointFromBytes,
  scalarBytes,
  scalarFromBytesCanonical,
} from './curve.js'
import { pokProve, pokVerify } from './tweak-pok.js'

type Brand<Name extends string> = Uint8Array & {
  readonly __adaptorSignature: Name
}

export type AdaptorSecret = Brand<'secret'>
export type AdaptorPoint = Brand<'point'>
export type AdaptorSecretProof = Brand<'secret-proof'>
export type AdaptorSignatureBytes = Brand<'adaptor-signature'>
export type CompactEcdsaSignature = Brand<'compact-ecdsa-signature'>

export type AdaptorErrorCode =
  | 'bad-length'
  | 'invalid-scalar'
  | 'invalid-point'
  | 'invalid-proof'
  | 'invalid-signature'
  | 'secret-point-mismatch'
  | 'rng-failed'
  | 'mismatched-signature'

export interface AdaptorError {
  readonly code: AdaptorErrorCode
}

export type AdaptorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AdaptorError }

export interface AdaptorSecretMaterial {
  readonly secret: AdaptorSecret
  readonly point: AdaptorPoint
  readonly proof: AdaptorSecretProof
}

export interface AdaptorSignInput {
  /** A compressed Nakamoto/secp256k1 signing private key. */
  readonly privateKey: Uint8Array
  /** Public adaptor point `T = tG`. */
  readonly adaptorPoint: AdaptorPoint
  /** Proof of knowledge bound to this exact adaptor point. */
  readonly adaptorProof: AdaptorSecretProof
  /** Explicit 32-byte transaction sighash or other digest. */
  readonly digest: Uint8Array
}

export interface AdaptorVerifyInput {
  readonly publicKey: Uint8Array
  readonly adaptorPoint: AdaptorPoint
  /** Proof of knowledge bound to this exact adaptor point. */
  readonly adaptorProof: AdaptorSecretProof
  readonly digest: Uint8Array
  readonly signature: AdaptorSignatureBytes
}

export interface AdaptorCompleteInput {
  readonly publicKey: Uint8Array
  readonly adaptorPoint: AdaptorPoint
  readonly adaptorProof: AdaptorSecretProof
  readonly digest: Uint8Array
  readonly signature: AdaptorSignatureBytes
  readonly secret: AdaptorSecret
}

export interface AdaptorExtractInput {
  readonly adaptorPoint: AdaptorPoint
  readonly signature: AdaptorSignatureBytes
  readonly completedSignature: CompactEcdsaSignature
}

export type RandomBytes = (length: number) => Uint8Array

function success<T>(value: T): AdaptorResult<T> {
  return { ok: true, value }
}

function failure<T>(code: AdaptorErrorCode): AdaptorResult<T> {
  return { ok: false, error: { code } }
}

function copyBrand<Name extends string>(bytes: Uint8Array): Brand<Name> {
  return new Uint8Array(bytes) as Brand<Name>
}

function copyLength(bytes: Uint8Array, length: number): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) return null
  return new Uint8Array(bytes)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return different === 0
}

export function adaptorSecretFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorSecret> {
  let canonical: Uint8Array | null = null
  try {
    canonical = copyLength(bytes, 32)
    if (canonical === null) return failure('bad-length')
    scalarFromBytesCanonical(canonical, false)
    return success(canonical as AdaptorSecret)
  } catch {
    canonical?.fill(0)
    return failure('invalid-scalar')
  }
}

export function adaptorPointFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorPoint> {
  try {
    const canonical = copyLength(bytes, 33)
    if (canonical === null) return failure('bad-length')
    const point = pointFromBytes(canonical)
    return success(copyBrand<'point'>(pointBytes(point)))
  } catch {
    return failure('invalid-point')
  }
}

export function adaptorSecretProofFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorSecretProof> {
  try {
    const canonical = copyLength(bytes, 65)
    if (canonical === null) return failure('bad-length')
    pointFromBytes(canonical.subarray(0, 33))
    scalarFromBytesCanonical(canonical.subarray(33), false)
    return success(copyBrand<'secret-proof'>(canonical))
  } catch {
    return failure('invalid-proof')
  }
}

export function adaptorSignatureFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorSignatureBytes> {
  try {
    const canonical = copyLength(bytes, 162)
    if (canonical === null) return failure('bad-length')
    const parsed = decodeAdaptorSignature(canonical)
    return success(
      copyBrand<'adaptor-signature'>(encodeAdaptorSignature(parsed)),
    )
  } catch {
    return failure('invalid-signature')
  }
}

export function compactEcdsaSignatureFromBytes(
  bytes: Uint8Array,
): AdaptorResult<CompactEcdsaSignature> {
  try {
    const canonical = copyLength(bytes, 64)
    if (canonical === null) return failure('bad-length')
    const parsed = decodeEcdsaSignature(canonical)
    return success(
      copyBrand<'compact-ecdsa-signature'>(encodeEcdsaSignature(parsed)),
    )
  } catch {
    return failure('invalid-signature')
  }
}

/**
 * Draws a uniformly distributed non-zero scalar using the caller's CSPRNG.
 * The callback is mandatory so applications can bind generation to their
 * platform's reviewed randomness source.
 */
export function generateAdaptorSecret(
  randomBytes: RandomBytes,
): AdaptorResult<AdaptorSecretMaterial> {
  if (typeof randomBytes !== 'function') return failure('rng-failed')
  for (let attempt = 0; attempt < 128; attempt += 1) {
    let random: Uint8Array
    try {
      random = randomBytes(32)
    } catch {
      return failure('rng-failed')
    }
    let candidate: Uint8Array
    try {
      const copied = copyLength(random, 32)
      if (copied === null) return failure('rng-failed')
      candidate = copied
    } catch {
      return failure('rng-failed')
    }
    const parsed = adaptorSecretFromBytes(candidate)
    candidate.fill(0)
    if (!parsed.ok) continue
    const scalar = scalarFromBytesCanonical(parsed.value, false)
    const point = G.multiply(scalar)
    const proof = pokProve(scalar, point)
    return success({
      secret: parsed.value,
      point: copyBrand<'point'>(pointBytes(point)),
      proof: copyBrand<'secret-proof'>(
        new Uint8Array([...pointBytes(proof.R), ...scalarBytes(proof.z)]),
      ),
    })
  }
  return failure('rng-failed')
}

export function verifyAdaptorSecret(
  point: AdaptorPoint,
  proof: AdaptorSecretProof,
): AdaptorResult<boolean> {
  try {
    const pointBytes = copyLength(point, 33)
    const proofBytes = copyLength(proof, 65)
    if (pointBytes === null || proofBytes === null) return failure('bad-length')
    const parsedPoint = pointFromBytes(pointBytes)
    const proofPoint = pointFromBytes(proofBytes.subarray(0, 33))
    const response = scalarFromBytesCanonical(proofBytes.subarray(33), false)
    return success(pokVerify(parsedPoint, { R: proofPoint, z: response }))
  } catch {
    return failure('invalid-proof')
  }
}

export function adaptorSign(
  input: AdaptorSignInput,
): AdaptorResult<AdaptorSignatureBytes> {
  let privateKey: Uint8Array | null = null
  let adaptorPoint: Uint8Array | null = null
  let adaptorProof: Uint8Array | null = null
  let digest: Uint8Array | null = null
  try {
    privateKey = copyLength(input.privateKey, 32)
    adaptorPoint = copyLength(input.adaptorPoint, 33)
    adaptorProof = copyLength(input.adaptorProof, 65)
    digest = copyLength(input.digest, 32)
  } catch {
    privateKey?.fill(0)
    return failure('invalid-signature')
  }
  if (
    privateKey === null ||
    adaptorPoint === null ||
    adaptorProof === null ||
    digest === null
  ) {
    privateKey?.fill(0)
    return failure('bad-length')
  }
  let key: ReturnType<typeof privateKeyFromSecretBytes>
  try {
    key = privateKeyFromSecretBytes(privateKey, true)
  } catch {
    return failure('invalid-signature')
  } finally {
    privateKey.fill(0)
  }
  if (!key.ok) return failure('invalid-scalar')
  try {
    const proof = verifyAdaptorSecret(
      adaptorPoint as AdaptorPoint,
      adaptorProof as AdaptorSecretProof,
    )
    if (!proof.ok || !proof.value) return failure('invalid-proof')
    const scalar = scalarFromBytesCanonical(key.value.bytes, false)
    const point = pointFromBytes(adaptorPoint)
    return success(
      copyBrand<'adaptor-signature'>(
        encodeAdaptorSignature(encryptedSign(scalar, point, digest)),
      ),
    )
  } catch {
    return failure('invalid-signature')
  } finally {
    key.value.bytes.fill(0)
  }
}

interface AdaptorVerifySnapshot {
  readonly publicKey: Uint8Array
  readonly adaptorPoint: AdaptorPoint
  readonly adaptorProof: AdaptorSecretProof
  readonly digest: Uint8Array
  readonly signature: AdaptorSignatureBytes
}

function verifyAdaptorSignatureSnapshot(
  snapshot: AdaptorVerifySnapshot,
): AdaptorResult<boolean> {
  const { publicKey, adaptorPoint, adaptorProof, digest, signature } = snapshot
  const proof = verifyAdaptorSecret(adaptorPoint, adaptorProof)
  if (!proof.ok || !proof.value) return failure('invalid-proof')
  try {
    return success(
      verifyEncryptedSignature(
        pointFromBytes(publicKey),
        pointFromBytes(adaptorPoint),
        digest,
        decodeAdaptorSignature(signature),
      ),
    )
  } catch {
    return failure('invalid-signature')
  }
}

export function verifyAdaptorSignature(
  input: AdaptorVerifyInput,
): AdaptorResult<boolean> {
  let publicKey: Uint8Array | null
  let adaptorPoint: Uint8Array | null
  let adaptorProof: Uint8Array | null
  let digest: Uint8Array | null
  let signature: Uint8Array | null
  try {
    publicKey = copyLength(input.publicKey, 33)
    adaptorPoint = copyLength(input.adaptorPoint, 33)
    adaptorProof = copyLength(input.adaptorProof, 65)
    digest = copyLength(input.digest, 32)
    signature = copyLength(input.signature, 162)
  } catch {
    return failure('invalid-signature')
  }
  if (
    publicKey === null ||
    adaptorPoint === null ||
    adaptorProof === null ||
    digest === null ||
    signature === null
  ) {
    return failure('bad-length')
  }
  return verifyAdaptorSignatureSnapshot({
    publicKey,
    adaptorPoint: adaptorPoint as AdaptorPoint,
    adaptorProof: adaptorProof as AdaptorSecretProof,
    digest,
    signature: signature as AdaptorSignatureBytes,
  })
}

/**
 * Validate the complete adaptor transcript and bind `secret·G` to its adaptor
 * point before producing a compact signature.
 */
export function completeAdaptorSignature(
  input: AdaptorCompleteInput,
): AdaptorResult<CompactEcdsaSignature> {
  let secret: Uint8Array | null = null
  let publicKey: Uint8Array | null
  let adaptorPoint: Uint8Array | null
  let adaptorProof: Uint8Array | null
  let digest: Uint8Array | null
  let signature: Uint8Array | null
  try {
    secret = copyLength(input.secret, 32)
    publicKey = copyLength(input.publicKey, 33)
    adaptorPoint = copyLength(input.adaptorPoint, 33)
    adaptorProof = copyLength(input.adaptorProof, 65)
    digest = copyLength(input.digest, 32)
    signature = copyLength(input.signature, 162)
  } catch {
    secret?.fill(0)
    return failure('invalid-signature')
  }
  if (
    secret === null ||
    publicKey === null ||
    adaptorPoint === null ||
    adaptorProof === null ||
    digest === null ||
    signature === null
  ) {
    secret?.fill(0)
    return failure('bad-length')
  }
  try {
    const verified = verifyAdaptorSignatureSnapshot({
      publicKey,
      adaptorPoint: adaptorPoint as AdaptorPoint,
      adaptorProof: adaptorProof as AdaptorSecretProof,
      digest,
      signature: signature as AdaptorSignatureBytes,
    })
    if (!verified.ok) return verified
    if (!verified.value) return failure('invalid-signature')
    let scalar: bigint
    try {
      scalar = scalarFromBytesCanonical(secret, false)
    } catch {
      return failure('invalid-scalar')
    }
    const expectedPoint = pointBytes(G.multiply(scalar))
    if (!equalBytes(expectedPoint, adaptorPoint)) {
      return failure('secret-point-mismatch')
    }
    const completed = decryptSignature(
      decodeAdaptorSignature(signature),
      scalar,
    )
    return success(
      copyBrand<'compact-ecdsa-signature'>(encodeEcdsaSignature(completed)),
    )
  } catch {
    return failure('invalid-signature')
  } finally {
    secret.fill(0)
  }
}

export function extractAdaptorSecret(
  input: AdaptorExtractInput,
): AdaptorResult<AdaptorSecret> {
  let adaptorPoint: Uint8Array | null
  let signature: Uint8Array | null
  let completedSignature: Uint8Array | null
  try {
    adaptorPoint = copyLength(input.adaptorPoint, 33)
    signature = copyLength(input.signature, 162)
    completedSignature = copyLength(input.completedSignature, 64)
  } catch {
    return failure('mismatched-signature')
  }
  if (
    adaptorPoint === null ||
    signature === null ||
    completedSignature === null
  ) {
    return failure('bad-length')
  }
  try {
    const recovered = recoverTweak(
      pointFromBytes(adaptorPoint),
      decodeAdaptorSignature(signature),
      decodeEcdsaSignature(completedSignature),
    )
    return success(copyBrand<'secret'>(scalarBytes(recovered)))
  } catch {
    return failure('mismatched-signature')
  }
}
