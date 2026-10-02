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
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    return failure('bad-length')
  }
  try {
    const canonical = new Uint8Array(bytes)
    scalarFromBytesCanonical(canonical, false)
    return success(copyBrand<'secret'>(canonical))
  } catch {
    return failure('invalid-scalar')
  }
}

export function adaptorPointFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorPoint> {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 33) {
    return failure('bad-length')
  }
  try {
    const point = pointFromBytes(new Uint8Array(bytes))
    return success(copyBrand<'point'>(pointBytes(point)))
  } catch {
    return failure('invalid-point')
  }
}

export function adaptorSecretProofFromBytes(
  bytes: Uint8Array,
): AdaptorResult<AdaptorSecretProof> {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 65) {
    return failure('bad-length')
  }
  try {
    const canonical = new Uint8Array(bytes)
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
  if (!(bytes instanceof Uint8Array) || bytes.length !== 162) {
    return failure('bad-length')
  }
  try {
    const parsed = decodeAdaptorSignature(new Uint8Array(bytes))
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
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) {
    return failure('bad-length')
  }
  try {
    const parsed = decodeEcdsaSignature(new Uint8Array(bytes))
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
    if (!(random instanceof Uint8Array) || random.length !== 32) {
      return failure('rng-failed')
    }
    const candidate = new Uint8Array(random)
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
  const pointBytes = copyLength(point, 33)
  const proofBytes = copyLength(proof, 65)
  if (pointBytes === null || proofBytes === null) return failure('bad-length')
  try {
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
  const digest = copyLength(input.digest, 32)
  const privateKey = copyLength(input.privateKey, 32)
  if (digest === null || privateKey === null) return failure('bad-length')
  const proof = verifyAdaptorSecret(input.adaptorPoint, input.adaptorProof)
  if (!proof.ok || !proof.value) return failure('invalid-proof')
  try {
    const key = privateKeyFromSecretBytes(privateKey, true)
    privateKey.fill(0)
    if (!key.ok) return failure('invalid-scalar')
    const scalar = scalarFromBytesCanonical(key.value.bytes, false)
    try {
      const point = pointFromBytes(new Uint8Array(input.adaptorPoint))
      return success(
        copyBrand<'adaptor-signature'>(
          encodeAdaptorSignature(encryptedSign(scalar, point, digest)),
        ),
      )
    } finally {
      key.value.bytes.fill(0)
    }
  } catch {
    privateKey.fill(0)
    return failure('invalid-signature')
  }
}

export function verifyAdaptorSignature(
  input: AdaptorVerifyInput,
): AdaptorResult<boolean> {
  const digest = copyLength(input.digest, 32)
  const publicKey = copyLength(input.publicKey, 33)
  const signature = copyLength(input.signature, 162)
  if (digest === null || publicKey === null || signature === null) {
    return failure('bad-length')
  }
  const proof = verifyAdaptorSecret(input.adaptorPoint, input.adaptorProof)
  if (!proof.ok || !proof.value) return failure('invalid-proof')
  try {
    return success(
      verifyEncryptedSignature(
        pointFromBytes(publicKey),
        pointFromBytes(new Uint8Array(input.adaptorPoint)),
        digest,
        decodeAdaptorSignature(signature),
      ),
    )
  } catch {
    return failure('invalid-signature')
  }
}

/**
 * Validate the complete adaptor transcript and bind `secret·G` to its adaptor
 * point before producing a compact signature.
 */
export function completeAdaptorSignature(
  input: AdaptorCompleteInput,
): AdaptorResult<CompactEcdsaSignature> {
  const verified = verifyAdaptorSignature({
    publicKey: input.publicKey,
    adaptorPoint: input.adaptorPoint,
    adaptorProof: input.adaptorProof,
    digest: input.digest,
    signature: input.signature,
  })
  if (!verified.ok) return verified
  if (!verified.value) return failure('invalid-signature')
  const parsedSecret = adaptorSecretFromBytes(input.secret)
  if (!parsedSecret.ok) return parsedSecret
  try {
    const scalar = scalarFromBytesCanonical(parsedSecret.value, false)
    const expectedPoint = pointBytes(G.multiply(scalar))
    if (!equalBytes(expectedPoint, new Uint8Array(input.adaptorPoint))) {
      return failure('secret-point-mismatch')
    }
    const completed = decryptSignature(
      decodeAdaptorSignature(new Uint8Array(input.signature)),
      scalar,
    )
    return success(
      copyBrand<'compact-ecdsa-signature'>(encodeEcdsaSignature(completed)),
    )
  } catch {
    return failure('invalid-signature')
  } finally {
    parsedSecret.value.fill(0)
  }
}

export function extractAdaptorSecret(
  input: AdaptorExtractInput,
): AdaptorResult<AdaptorSecret> {
  try {
    const recovered = recoverTweak(
      pointFromBytes(input.adaptorPoint),
      decodeAdaptorSignature(input.signature),
      decodeEcdsaSignature(input.completedSignature),
    )
    return success(copyBrand<'secret'>(scalarBytes(recovered)))
  } catch {
    return failure('mismatched-signature')
  }
}
