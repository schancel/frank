// Typed secp256k1: ECDSA (RFC 6979, low-S), BIP340 Schnorr, ECDH, tweaks,
// message signatures, and BIP-374 DLEQ. Sign, verify, ECDH, and point
// addition go through src/backend. The installed backend is @noble/curves
// 1.9.1. Recoverable message signatures still read the recovery bit from
// that library. This file does not hash an ECDH point unless the caller
// passes the hash. It does not multiply a secret by an arbitrary scalar.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'

import { cryptoBackend, CryptoBackendError } from './backend.js'
import { concatBytes, copyBytes, isPlainBytes } from './bytes.js'
import type { ChainDescriptor } from './chain/types.js'
import {
  ecdsaSignatureFromBytes,
  privateKeyFromBytes,
  schnorrSignatureFromBytes,
  type EcdsaSignature,
  type PrivateKey,
  type SchnorrSignature,
} from './constructors.js'
import { bigintToBytes, bytesToBigint, mod } from './integer.js'
import { SECP256K1_N, isValidScalar } from './secp256k1.js'
import { encodeVarint } from './varint.js'

const Point = secp256k1.ProjectivePoint
type Projective = typeof Point.BASE

export interface BadLength {
  readonly code: 'bad-length'
  readonly actual: number
}

export interface ScalarOutOfRange {
  readonly code: 'scalar-out-of-range'
}

export interface PointInvalid {
  readonly code: 'point-invalid'
}

export interface PointAtInfinity {
  readonly code: 'point-at-infinity'
}

export interface HighS {
  readonly code: 'high-s'
}

export interface SignatureInvalid {
  readonly code: 'signature-invalid'
}

export interface MessageMagicUnpinned {
  readonly code: 'message-magic-unpinned'
}

export interface MessageBytes {
  readonly code: 'message-bytes'
}

export interface HashRequired {
  readonly code: 'hash-required'
}

export interface CompressionRequired {
  readonly code: 'compression-required'
}

export type CurveError =
  | BadLength
  | ScalarOutOfRange
  | PointInvalid
  | PointAtInfinity
  | HighS
  | SignatureInvalid
  | MessageMagicUnpinned
  | MessageBytes
  | HashRequired
  | CompressionRequired

export type CurveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CurveError }

const CURVE_CODES: ReadonlySet<string> = new Set([
  'bad-length',
  'scalar-out-of-range',
  'point-invalid',
  'point-at-infinity',
  'high-s',
  'signature-invalid',
  'message-magic-unpinned',
  'message-bytes',
  'hash-required',
  'compression-required',
])

export function isCurveError(value: unknown): value is CurveError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && CURVE_CODES.has(code)
}

export interface SharedPoint {
  /** Compressed SEC1 point. Not a hash. */
  readonly point: Uint8Array
}

export interface DleqProof {
  readonly proof: Uint8Array
  /** A = a·G, compressed. */
  readonly key: Uint8Array
  /** C = a·B, compressed. */
  readonly shared: Uint8Array
}

export interface DleqInput {
  readonly secret: Uint8Array
  readonly pointB: Uint8Array
  readonly aux: Uint8Array
  /** Defaults to the secp256k1 generator. BIP-374 vectors also pass other G. */
  readonly generator?: Uint8Array
  /** Optional 32-byte message. Omitted means the empty message. */
  readonly message?: Uint8Array
}

export interface DleqVerifyInput {
  readonly key: Uint8Array
  readonly pointB: Uint8Array
  readonly shared: Uint8Array
  readonly proof: Uint8Array
  readonly generator?: Uint8Array
  readonly message?: Uint8Array
}

function fail<T>(error: CurveError): CurveResult<T> {
  return { ok: false, error }
}

function backendFailure(error: unknown): CurveError {
  if (error instanceof CryptoBackendError) {
    if (error.code === 'bad-length') {
      return { code: 'bad-length', actual: error.actual ?? 0 }
    }
    if (
      error.code === 'scalar-out-of-range' ||
      error.code === 'point-invalid' ||
      error.code === 'point-at-infinity' ||
      error.code === 'high-s' ||
      error.code === 'signature-invalid'
    ) {
      return { code: error.code }
    }
  }
  return { code: 'signature-invalid' }
}

function lengthError(actual: number): BadLength {
  return { code: 'bad-length', actual }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}

function scalar32(bytes: Uint8Array): CurveResult<bigint> {
  if (!isPlainBytes(bytes)) return fail(lengthError(0))
  if (bytes.length !== 32) return fail(lengthError(bytes.length))
  const value = bytesToBigint(bytes)
  if (!isValidScalar(value)) return fail({ code: 'scalar-out-of-range' })
  return { ok: true, value }
}

function privateScalar(key: PrivateKey): CurveResult<bigint> {
  if (typeof key.compressed !== 'boolean') {
    return fail({ code: 'compression-required' })
  }
  return scalar32(key.bytes)
}

function parsePoint(bytes: Uint8Array): CurveResult<Projective> {
  if (!isPlainBytes(bytes)) return fail(lengthError(0))
  if (bytes.length !== 32 && bytes.length !== 33 && bytes.length !== 65) {
    return fail(lengthError(bytes.length))
  }
  if (bytes.length === 33 && bytes[0] !== 0x02 && bytes[0] !== 0x03) {
    return fail({ code: 'point-invalid' })
  }
  if (bytes.length === 65 && bytes[0] !== 0x04) {
    return fail({ code: 'point-invalid' })
  }
  try {
    if (bytes.length === 32) {
      const lifted = schnorr.utils.lift_x(bytesToBigint(bytes))
      lifted.assertValidity()
      return { ok: true, value: lifted }
    }
    return { ok: true, value: Point.fromHex(bytes) }
  } catch {
    return fail({ code: 'point-invalid' })
  }
}

function compressed(point: Projective): CurveResult<Uint8Array> {
  if (point.equals(Point.ZERO)) return fail({ code: 'point-at-infinity' })
  try {
    const bytes = point.toRawBytes(true)
    if (bytes.length !== 33) return fail({ code: 'point-invalid' })
    return { ok: true, value: bytes }
  } catch {
    return fail({ code: 'point-invalid' })
  }
}

function scale(point: Projective, scalar: bigint): Projective {
  const reduced = mod(scalar, SECP256K1_N)
  if (!reduced.ok || reduced.value === 0n) return Point.ZERO
  return point.multiply(reduced.value)
}

function generatorPoint(
  bytes: Uint8Array | undefined,
): CurveResult<Projective> {
  if (bytes === undefined) return { ok: true, value: Point.BASE }
  return parsePoint(bytes)
}

function optionalMessage(
  message: Uint8Array | undefined,
): CurveResult<Uint8Array> {
  if (message === undefined) return { ok: true, value: new Uint8Array(0) }
  if (!isPlainBytes(message)) return fail({ code: 'message-bytes' })
  if (message.length !== 32) return fail(lengthError(message.length))
  return { ok: true, value: message }
}

function ascii(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code > 0x7f) return null
    out[index] = code
  }
  return out
}

/** DER, low-S. `digest` is the 32-byte value ECDSA signs, not the preimage. */
export function signEcdsa(
  key: PrivateKey,
  digest: Uint8Array,
): CurveResult<EcdsaSignature> {
  const scalar = privateScalar(key)
  if (!scalar.ok) return scalar
  if (!isPlainBytes(digest)) return fail(lengthError(0))
  if (digest.length !== 32) return fail(lengthError(digest.length))
  const secret = copyBytes(key.bytes)
  try {
    const der = ecdsaSignatureFromBytes(cryptoBackend.signEcdsa(secret, digest))
    if (!der.ok) return fail({ code: 'signature-invalid' })
    return { ok: true, value: der.value }
  } catch (error) {
    return fail(backendFailure(error))
  } finally {
    secret.fill(0)
  }
}

/** False when the signature is well formed and belongs to another key. */
export function verifyEcdsa(
  signature: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
): CurveResult<boolean> {
  if (!isPlainBytes(signature)) return fail(lengthError(0))
  if (!isPlainBytes(digest) || digest.length !== 32) {
    return fail(lengthError(isPlainBytes(digest) ? digest.length : 0))
  }
  try {
    return {
      ok: true,
      value: cryptoBackend.verifyEcdsa(signature, digest, publicKey),
    }
  } catch (error) {
    return fail(backendFailure(error))
  }
}

/** BIP340. `aux` is the 32-byte auxiliary randomness. It is not optional. */
export function signSchnorr(
  key: PrivateKey,
  message: Uint8Array,
  aux: Uint8Array,
): CurveResult<SchnorrSignature> {
  const scalar = privateScalar(key)
  if (!scalar.ok) return scalar
  if (!isPlainBytes(message)) return fail({ code: 'message-bytes' })
  if (!isPlainBytes(aux) || aux.length !== 32) {
    return fail(lengthError(isPlainBytes(aux) ? aux.length : 0))
  }
  const secret = copyBytes(key.bytes)
  try {
    const signature = cryptoBackend.signSchnorr(secret, message, aux)
    const branded = schnorrSignatureFromBytes(signature)
    if (!branded.ok) return fail({ code: 'signature-invalid' })
    return { ok: true, value: branded.value }
  } catch {
    return fail({ code: 'signature-invalid' })
  } finally {
    secret.fill(0)
  }
}

export function verifySchnorr(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): CurveResult<boolean> {
  if (!isPlainBytes(signature) || signature.length !== 64) {
    return fail(lengthError(isPlainBytes(signature) ? signature.length : 0))
  }
  if (!isPlainBytes(message)) return fail({ code: 'message-bytes' })
  if (!isPlainBytes(publicKey) || publicKey.length !== 32) {
    return fail(lengthError(isPlainBytes(publicKey) ? publicKey.length : 0))
  }
  try {
    return {
      ok: true,
      value: cryptoBackend.verifySchnorr(signature, message, publicKey),
    }
  } catch {
    return fail({ code: 'signature-invalid' })
  }
}

/** Raw shared point. No hash is applied. */
export function ecdh(
  key: PrivateKey,
  publicKey: Uint8Array,
): CurveResult<SharedPoint> {
  const scalar = privateScalar(key)
  if (!scalar.ok) return scalar
  const secret = copyBytes(key.bytes)
  try {
    return { ok: true, value: { point: cryptoBackend.ecdh(secret, publicKey) } }
  } catch (error) {
    return fail(backendFailure(error))
  } finally {
    secret.fill(0)
  }
}

/** Hashes the compressed shared point with the function the caller passes. */
export function ecdhWithHash(
  key: PrivateKey,
  publicKey: Uint8Array,
  hash: (point: Uint8Array) => Uint8Array,
): CurveResult<Uint8Array> {
  if (typeof hash !== 'function') return fail({ code: 'hash-required' })
  const shared = ecdh(key, publicKey)
  if (!shared.ok) return shared
  const hashed = hash(shared.value.point)
  if (!isPlainBytes(hashed)) return fail({ code: 'hash-required' })
  return { ok: true, value: copyBytes(hashed) }
}

/**
 * (secret + tweak) mod n. Tweaks in (n/2, n) are accepted: a BIP341 tweak
 * is not an ECDSA S value (decision 345). The sum 0 is rejected.
 */
export function tweakAddPrivateKey(
  key: PrivateKey,
  tweak: Uint8Array,
): CurveResult<PrivateKey> {
  const scalar = privateScalar(key)
  if (!scalar.ok) return scalar
  const added = scalar32(tweak)
  if (!added.ok) return added
  const sum = mod(scalar.value + added.value, SECP256K1_N)
  if (!sum.ok || sum.value === 0n) return fail({ code: 'scalar-out-of-range' })
  const bytes = bigintToBytes(sum.value, 32)
  if (!bytes.ok) return fail({ code: 'scalar-out-of-range' })
  const branded = privateKeyFromBytes(bytes.value, key.compressed)
  if (!branded.ok) return fail({ code: 'scalar-out-of-range' })
  return { ok: true, value: branded.value }
}

/** P + tweak·G. A 32-byte key is lifted with even Y (BIP340). */
export function tweakAddPublicKey(
  publicKey: Uint8Array,
  tweak: Uint8Array,
): CurveResult<Uint8Array> {
  const point = parsePoint(publicKey)
  if (!point.ok) return point
  const added = scalar32(tweak)
  if (!added.ok) return added
  return compressed(point.value.add(Point.BASE.multiply(added.value)))
}

/** Compressed sum. Infinity is an error, not an encoding. */
export function pointAdd(
  left: Uint8Array,
  right: Uint8Array,
): CurveResult<Uint8Array> {
  try {
    return { ok: true, value: cryptoBackend.pointAdd(left, right) }
  } catch (error) {
    return fail(backendFailure(error))
  }
}

/** Public point times a scalar in [1, n). Not a secret-times-scalar helper. */
export function pointMultiply(
  publicPoint: Uint8Array,
  scalar: Uint8Array,
): CurveResult<Uint8Array> {
  try {
    return {
      ok: true,
      value: cryptoBackend.pointMultiply(publicPoint, scalar),
    }
  } catch (error) {
    return fail(backendFailure(error))
  }
}

function dleqChallenge(
  key: Uint8Array,
  pointB: Uint8Array,
  shared: Uint8Array,
  generator: Uint8Array,
  first: Uint8Array,
  second: Uint8Array,
  message: Uint8Array,
): bigint {
  const digest = schnorr.utils.taggedHash(
    'BIP0374/challenge',
    key,
    pointB,
    shared,
    generator,
    first,
    second,
    message,
  )
  const reduced = mod(bytesToBigint(digest), SECP256K1_N)
  return reduced.ok ? reduced.value : 0n
}

/** BIP-374 GenerateProof. G defaults to the secp256k1 generator. */
export function generateDleqProof(input: DleqInput): CurveResult<DleqProof> {
  const secret = scalar32(input.secret)
  if (!secret.ok) return secret
  const pointB = parsePoint(input.pointB)
  if (!pointB.ok) return pointB
  if (!isPlainBytes(input.aux) || input.aux.length !== 32) {
    return fail(lengthError(isPlainBytes(input.aux) ? input.aux.length : 0))
  }
  const generator = generatorPoint(input.generator)
  if (!generator.ok) return generator
  const message = optionalMessage(input.message)
  if (!message.ok) return message
  const keyPoint = scale(generator.value, secret.value)
  const sharedPoint = scale(pointB.value, secret.value)
  const key = compressed(keyPoint)
  const shared = compressed(sharedPoint)
  const generatorBytes = compressed(generator.value)
  const pointBBytes = compressed(pointB.value)
  if (!key.ok || !shared.ok || !generatorBytes.ok || !pointBBytes.ok) {
    return fail({ code: 'point-at-infinity' })
  }
  const secretBytes = bigintToBytes(secret.value, 32)
  if (!secretBytes.ok) return fail({ code: 'scalar-out-of-range' })
  const mask = schnorr.utils.taggedHash('BIP0374/aux', input.aux)
  const hidden = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    hidden[index] = (secretBytes.value[index] ?? 0) ^ (mask[index] ?? 0)
  }
  const nonce = schnorr.utils.taggedHash(
    'BIP0374/nonce',
    hidden,
    key.value,
    shared.value,
    message.value,
  )
  hidden.fill(0)
  const nonceScalar = mod(bytesToBigint(nonce), SECP256K1_N)
  if (!nonceScalar.ok || nonceScalar.value === 0n) {
    return fail({ code: 'scalar-out-of-range' })
  }
  const firstPoint = scale(generator.value, nonceScalar.value)
  const secondPoint = scale(pointB.value, nonceScalar.value)
  const first = compressed(firstPoint)
  const second = compressed(secondPoint)
  if (!first.ok || !second.ok) return fail({ code: 'point-at-infinity' })
  const challenge = dleqChallenge(
    key.value,
    pointBBytes.value,
    shared.value,
    generatorBytes.value,
    first.value,
    second.value,
    message.value,
  )
  const response = mod(
    nonceScalar.value + challenge * secret.value,
    SECP256K1_N,
  )
  if (!response.ok) return fail({ code: 'scalar-out-of-range' })
  const challengeBytes = bigintToBytes(challenge, 32)
  const responseBytes = bigintToBytes(response.value, 32)
  if (!challengeBytes.ok || !responseBytes.ok) {
    return fail({ code: 'scalar-out-of-range' })
  }
  const proof = concatBytes([challengeBytes.value, responseBytes.value])
  const verified = verifyDleqProof({
    key: key.value,
    pointB: pointBBytes.value,
    shared: shared.value,
    proof,
    generator: input.generator,
    message: input.message,
  })
  if (!verified.ok || !verified.value)
    return fail({ code: 'signature-invalid' })
  return {
    ok: true,
    value: { proof, key: key.value, shared: shared.value },
  }
}

/** BIP-374 VerifyProof. A failed relation is `false`, not an exception. */
export function verifyDleqProof(input: DleqVerifyInput): CurveResult<boolean> {
  const key = parsePoint(input.key)
  if (!key.ok) return key
  const pointB = parsePoint(input.pointB)
  if (!pointB.ok) return pointB
  const shared = parsePoint(input.shared)
  if (!shared.ok) return shared
  const generator = generatorPoint(input.generator)
  if (!generator.ok) return generator
  const message = optionalMessage(input.message)
  if (!message.ok) return message
  if (!isPlainBytes(input.proof) || input.proof.length !== 64) {
    return fail(lengthError(isPlainBytes(input.proof) ? input.proof.length : 0))
  }
  const challenge = bytesToBigint(input.proof.subarray(0, 32))
  const response = bytesToBigint(input.proof.subarray(32))
  if (challenge >= SECP256K1_N || response >= SECP256K1_N) {
    return { ok: true, value: false }
  }
  const keyBytes = compressed(key.value)
  const pointBBytes = compressed(pointB.value)
  const sharedBytes = compressed(shared.value)
  const generatorBytes = compressed(generator.value)
  if (
    !keyBytes.ok ||
    !pointBBytes.ok ||
    !sharedBytes.ok ||
    !generatorBytes.ok
  ) {
    return { ok: true, value: false }
  }
  const first = compressed(
    scale(generator.value, response).add(scale(key.value, -challenge)),
  )
  const second = compressed(
    scale(pointB.value, response).add(scale(shared.value, -challenge)),
  )
  if (!first.ok || !second.ok) return { ok: true, value: false }
  const again = dleqChallenge(
    keyBytes.value,
    pointBBytes.value,
    sharedBytes.value,
    generatorBytes.value,
    first.value,
    second.value,
    message.value,
  )
  return { ok: true, value: again === challenge }
}

/** SHA-256d of the Bitcoin Core compact-size framing. Unpinned chains refuse. */
export function messageDigest(
  chain: ChainDescriptor,
  message: Uint8Array,
): CurveResult<Uint8Array> {
  if (
    typeof chain !== 'object' ||
    chain === null ||
    chain.messageMagic.status !== 'pinned'
  ) {
    return fail({ code: 'message-magic-unpinned' })
  }
  if (!isPlainBytes(message)) return fail({ code: 'message-bytes' })
  const magic = ascii(chain.messageMagic.text)
  if (magic === null) return fail({ code: 'message-magic-unpinned' })
  const magicLength = encodeVarint(BigInt(magic.length))
  const messageLength = encodeVarint(BigInt(message.length))
  if (!magicLength.ok || !messageLength.ok) {
    return fail({ code: 'message-bytes' })
  }
  const framed = concatBytes([
    magicLength.value,
    magic,
    messageLength.value,
    message,
  ])
  return { ok: true, value: new Uint8Array(cryptoBackend.sha256d(framed)) }
}

function recoveryFromHeader(
  header: number,
): { readonly recovery: number; readonly compressed: boolean } | null {
  if (!Number.isInteger(header) || header < 27 || header > 34) return null
  const shifted = header - 27
  return { recovery: shifted & 3, compressed: (shifted & 4) !== 0 }
}

/** 65-byte recoverable signature. The header carries recovery and compression. */
export function signMessage(
  chain: ChainDescriptor,
  key: PrivateKey,
  message: Uint8Array,
): CurveResult<Uint8Array> {
  const scalar = privateScalar(key)
  if (!scalar.ok) return scalar
  const digest = messageDigest(chain, message)
  if (!digest.ok) return digest
  const secret = copyBytes(key.bytes)
  try {
    const signature = secp256k1.sign(digest.value, secret, { lowS: true })
    if (signature.hasHighS()) return fail({ code: 'high-s' })
    if (signature.recovery !== 0 && signature.recovery !== 1) {
      return fail({ code: 'signature-invalid' })
    }
    const header = 27 + signature.recovery + (key.compressed ? 4 : 0)
    const compact = signature.toCompactRawBytes()
    const out = new Uint8Array(65)
    out[0] = header
    out.set(compact, 1)
    return { ok: true, value: out }
  } catch {
    return fail({ code: 'signature-invalid' })
  } finally {
    secret.fill(0)
  }
}

/**
 * Recovers the public key and compares it to `publicKey`. A different key
 * is `false`. The compression flag in the header must match that key.
 */
export function verifyMessage(
  chain: ChainDescriptor,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): CurveResult<boolean> {
  if (!isPlainBytes(publicKey)) return fail(lengthError(0))
  if (!isPlainBytes(signature) || signature.length !== 65) {
    return fail(lengthError(isPlainBytes(signature) ? signature.length : 0))
  }
  const digest = messageDigest(chain, message)
  if (!digest.ok) return digest
  const header = signature[0] ?? 0
  const recoveredHeader = recoveryFromHeader(header)
  if (recoveredHeader === null) return fail({ code: 'signature-invalid' })
  const expectedLength = recoveredHeader.compressed ? 33 : 65
  if (publicKey.length !== expectedLength) return { ok: true, value: false }
  try {
    const parsed = secp256k1.Signature.fromCompact(signature.subarray(1))
    parsed.assertValidity()
    if (parsed.hasHighS()) return fail({ code: 'high-s' })
    const point = parsed
      .addRecoveryBit(recoveredHeader.recovery)
      .recoverPublicKey(digest.value)
    const encoded = point.toRawBytes(recoveredHeader.compressed)
    return { ok: true, value: equalBytes(encoded, publicKey) }
  } catch {
    return fail({ code: 'signature-invalid' })
  }
}
