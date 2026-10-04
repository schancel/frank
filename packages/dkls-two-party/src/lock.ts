/**
 * Adaptor locks: the points a pre-signature can be locked to. The formats and
 * every proof are byte-compatible with `@frank/threshold-ecdsa`'s `lock.ts`
 * (same domain tags, same encodings, same second generator H), so a lock made
 * by one backend is accepted by the other's `resolveLock`. See that file for
 * the full rationale; in short:
 *
 * 1. POINT LOCK. T = t*G with the 65-byte proof of knowledge of
 *    `@frank/adaptor-signatures` and an owner proof bound to the key id and
 *    the holder's identity.
 * 2. COMMITMENT LOCK. C = s*G + v*H with an Okamoto proof of knowledge of an
 *    opening, bound to the key id and the holder. Lock point for candidate
 *    value i: T_i = C - i*H. Only T_v = s*G can be completed.
 *
 * A bare caller-chosen point is never accepted.
 *
 * WHO HOLDS A LOCK. In this package the holder is the RESPONDER of the
 * pre-signing session (the initiator learns the pre-signature first and is
 * the extractor). Either party of a key can be the responder of a session, so
 * either party can hold locks.
 *
 * PROVENANCE. The two parties check a lock differently and both checks are
 * needed. The INITIATOR verifies the proofs: someone knows the secret. The
 * RESPONDER must show `startSign` the secret itself (a `LockOpening`): a
 * proof only shows that someone knows it, and the identity hashed into it is
 * just bytes, so the initiator could build a lock from its own secret and
 * label it as the responder's. Requiring the opening means the responder
 * only ever pre-signs under a lock it can open.
 */
import {
  generateAdaptorSecret,
  verifyAdaptorSecret,
  type AdaptorPoint,
  type AdaptorSecret,
  type AdaptorSecretProof,
} from '@frank/adaptor-signatures'
import {
  decodeAdaptorSignature,
  decodeEcdsaSignature,
  decryptSignature,
  encodeEcdsaSignature,
  recoverTweak,
  verifyEncryptedSignature,
  verifyStandardEcdsaSignature,
} from '@frank/adaptor-signatures/src/ecdsa-adaptor.js'
import { hashToScalar } from '@frank/adaptor-signatures/src/curve.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  asciiBytes,
  bytesToInt,
  concat,
  equalBytes,
  intToBytes,
  Reader,
  snapshot,
} from './bytes.js'
import {
  DLOG_PROOF_BYTES,
  G,
  hedgedScalarWith,
  modAdd,
  modMul,
  multiply,
  parsePoint,
  parseScalar,
  POINT_BYTES,
  pointBytes,
  proveDlog,
  requireDlogProof,
  SCALAR_BYTES,
  scalarBytes,
  transcriptWith,
  type Point,
} from './group.js'
import { usableShare, type KeyShare } from './key-share.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type DklsResult,
} from './result.js'
import { draw, type RandomBytes } from './rng.js'

/** The domain prefix of `@frank/threshold-ecdsa`, whose lock formats these are. */
const LOCK_PREFIX = 'FRANK-TECDSA-V1/'

const ADAPTOR_PROOF_BYTES = 65
export const ADAPTOR_SIGNATURE_BYTES = 162
const COMPACT_SIGNATURE_BYTES = 64
const INDEX_BYTES = 4
const MAX_INDEX = 0xffffffff
export const OPENING_PROOF_BYTES = POINT_BYTES + 2 * SCALAR_BYTES

const KIND_POINT = 1
const KIND_COMMITMENT = 2

/**
 * The second Pedersen generator: the first valid point with even y whose x is
 * `SHA256("FRANK-TECDSA-V1/pedersen-H" || counter)`, counter 4 bytes
 * big-endian from 0. Nobody knows its discrete logarithm.
 */
function deriveSecondGenerator(): Point {
  const tag = asciiBytes(`${LOCK_PREFIX}pedersen-H`)
  for (let counter = 0; counter < 1000; counter += 1) {
    const x = sha256(concat(tag, intToBytes(counter, 4)))
    try {
      return parsePoint(concat(Uint8Array.of(0x02), x))
    } catch {
      // Not an x coordinate of the curve; try the next counter.
    }
  }
  return fail('internal-error')
}

export const PEDERSEN_H: Point = deriveSecondGenerator()

/** The public side of a lock. Both parties pass the same one to `startSign`. */
export type AdaptorLock =
  | {
      readonly kind: 'point'
      /** T = t*G. */
      readonly point: AdaptorPoint
      /** Proof of knowledge of t from `@frank/adaptor-signatures`. */
      readonly proof: AdaptorSecretProof
      /** Proof of knowledge of t bound to this key and its holder. */
      readonly ownerProof: Uint8Array
    }
  | {
      readonly kind: 'commitment'
      /** C = s*G + v*H, 33 bytes. */
      readonly commitment: Uint8Array
      /** Proof of knowledge of an opening of C, bound to key and holder. */
      readonly proof: Uint8Array
      /** The candidate value i this pre-signature is for: lock point C - i*H. */
      readonly index: number
    }

/**
 * The secret side of a lock, held by its holder only and required by the
 * holder's `startSign`.
 */
export type LockOpening =
  | { readonly kind: 'point'; readonly secret: Uint8Array }
  | {
      readonly kind: 'commitment'
      readonly secret: Uint8Array
      /** The committed value v (not the candidate index being signed). */
      readonly value: number
    }

/** A validated lock: its point and the canonical bytes bound into the session. */
export interface ResolvedLock {
  readonly point: Uint8Array
  readonly encoded: Uint8Array
}

function lockContext(keyId: Uint8Array, holderId: Uint8Array): Uint8Array {
  return transcriptWith(LOCK_PREFIX, 'lock/context', keyId, holderId)
}

function indexScalar(index: number): bigint {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    fail('invalid-input')
  }
  return BigInt(index)
}

/** `C - index * H`. Fails if that is the identity. */
function lockPointOf(commitment: Point, index: bigint): Point {
  if (index === 0n) return commitment
  const point = commitment.subtract(multiply(PEDERSEN_H, index))
  try {
    point.assertValidity()
  } catch {
    return fail('invalid-point')
  }
  return point
}

function openingChallenge(
  context: Uint8Array,
  holderId: Uint8Array,
  commitment: Point,
  announcement: Point,
): bigint {
  return hashToScalar(
    transcriptWith(
      LOCK_PREFIX,
      'proof/opening',
      context,
      holderId,
      pointBytes(commitment),
      pointBytes(PEDERSEN_H),
      pointBytes(announcement),
    ),
  )
}

/** `left * G + right * H`, allowing either scalar (not both) to be zero. */
function pedersen(left: bigint, right: bigint): Point {
  if (left === 0n && right === 0n) fail('invalid-proof')
  if (left === 0n) return multiply(PEDERSEN_H, right)
  if (right === 0n) return multiply(G, left)
  const sum = multiply(G, left).add(multiply(PEDERSEN_H, right))
  try {
    sum.assertValidity()
  } catch {
    return fail('invalid-proof')
  }
  return sum
}

/**
 * Okamoto proof of knowledge of (s, v) with C = s*G + v*H:
 *   A = a*G + b*H,  e = H(context, holder, C, H, A),
 *   z1 = a + e*s,   z2 = b + e*v.      Wire: A (33) || z1 (32) || z2 (32).
 */
function proveOpening(
  rng: RandomBytes,
  context: Uint8Array,
  holderId: Uint8Array,
  secret: bigint,
  value: bigint,
  commitment: Point,
): Uint8Array {
  const witness = scalarBytes(secret)
  const a = hedgedScalarWith(
    LOCK_PREFIX,
    rng,
    'proof/opening/a',
    context,
    holderId,
    witness,
  )
  const b = hedgedScalarWith(
    LOCK_PREFIX,
    rng,
    'proof/opening/b',
    context,
    holderId,
    witness,
  )
  witness.fill(0)
  const announcement = pedersen(a, b)
  const challenge = openingChallenge(context, holderId, commitment, announcement)
  return concat(
    pointBytes(announcement),
    scalarBytes(modAdd(a, modMul(challenge, secret))),
    scalarBytes(modAdd(b, modMul(challenge, value))),
  )
}

/** Verifier: z1*G + z2*H = A + e*C. */
function requireOpeningProof(
  context: Uint8Array,
  holderId: Uint8Array,
  commitment: Point,
  proof: Uint8Array,
): void {
  if (proof.length !== OPENING_PROOF_BYTES) fail('malformed-message')
  const reader = new Reader(proof)
  const announcement = parsePoint(reader.take(POINT_BYTES))
  const z1 = parseScalar(reader.take(SCALAR_BYTES), true)
  const z2 = parseScalar(reader.take(SCALAR_BYTES), true)
  reader.finish()
  const challenge = openingChallenge(context, holderId, commitment, announcement)
  if (challenge === 0n) fail('invalid-proof')
  const left = pedersen(z1, z2)
  const right = announcement.add(multiply(commitment, challenge))
  if (!left.equals(right)) fail('invalid-proof')
}

/**
 * Validates the public side of a lock against a key and its holder, and
 * returns the lock point and canonical encoding. Every proof is verified
 * here, before any session exists.
 */
export function resolveLock(
  lock: AdaptorLock,
  keyId: Uint8Array,
  holderId: Uint8Array,
): ResolvedLock {
  if (lock === null || typeof lock !== 'object') fail('invalid-input')
  const context = lockContext(keyId, holderId)
  if (lock.kind === 'point') {
    const point = snapshot(lock.point, POINT_BYTES)
    const proof = snapshot(lock.proof, ADAPTOR_PROOF_BYTES)
    const ownerProof = snapshot(lock.ownerProof, DLOG_PROOF_BYTES)
    if (point === null || proof === null || ownerProof === null) {
      return fail('invalid-input')
    }
    const parsed = parsePoint(point)
    const known = verifyAdaptorSecret(
      point as AdaptorPoint,
      proof as AdaptorSecretProof,
    )
    if (!known.ok || !known.value) fail('invalid-proof')
    requireDlogProof(context, holderId, parsed, ownerProof, LOCK_PREFIX)
    return {
      point,
      encoded: concat(Uint8Array.of(KIND_POINT), point, proof, ownerProof),
    }
  }
  if (lock.kind === 'commitment') {
    const commitment = snapshot(lock.commitment, POINT_BYTES)
    const proof = snapshot(lock.proof, OPENING_PROOF_BYTES)
    if (commitment === null || proof === null) return fail('invalid-input')
    const index = indexScalar(lock.index)
    const parsed = parsePoint(commitment)
    requireOpeningProof(context, holderId, parsed, proof)
    return {
      point: pointBytes(lockPointOf(parsed, index)),
      // H is fixed, but binding it makes the transcript self-describing.
      encoded: concat(
        Uint8Array.of(KIND_COMMITMENT),
        commitment,
        pointBytes(PEDERSEN_H),
        proof,
        intToBytes(index, INDEX_BYTES),
      ),
    }
  }
  return fail('invalid-input')
}

/**
 * Holder-side check: the opening really opens this lock, i.e.
 * `secret * G = T` for a point lock and `secret * G + value * H = C` for a
 * commitment lock (whatever candidate index the session is for). Fails with
 * `lock-not-owned` otherwise.
 */
export function requireLockOpening(
  lock: AdaptorLock,
  opening: LockOpening | undefined,
): void {
  if (opening === undefined) fail('lock-not-owned')
  if (typeof opening !== 'object' || opening === null) fail('invalid-input')
  const secretBytes = snapshot(opening.secret, SCALAR_BYTES)
  if (secretBytes === null) return fail('invalid-input')
  try {
    let secret: bigint
    try {
      secret = parseScalar(secretBytes)
    } catch {
      return fail('lock-not-owned')
    }
    if (lock.kind === 'point' && opening.kind === 'point') {
      const point = snapshot(lock.point, POINT_BYTES)
      if (point === null) return fail('invalid-input')
      if (!multiply(G, secret).equals(parsePoint(point))) fail('lock-not-owned')
      return
    }
    if (lock.kind === 'commitment' && opening.kind === 'commitment') {
      const commitment = snapshot(lock.commitment, POINT_BYTES)
      if (commitment === null) return fail('invalid-input')
      const expected = pedersen(secret, indexScalar(opening.value))
      if (!expected.equals(parsePoint(commitment))) fail('lock-not-owned')
      return
    }
    fail('lock-not-owned')
  } finally {
    secretBytes.fill(0)
  }
}

/** Inverse of the encoding produced by `resolveLock`. */
export function decodeLock(encoded: Uint8Array): AdaptorLock {
  const reader = new Reader(encoded)
  const kind = reader.byte()
  if (kind === KIND_POINT) {
    const lock: AdaptorLock = {
      kind: 'point',
      point: reader.take(POINT_BYTES) as AdaptorPoint,
      proof: reader.take(ADAPTOR_PROOF_BYTES) as AdaptorSecretProof,
      ownerProof: reader.take(DLOG_PROOF_BYTES),
    }
    reader.finish()
    return lock
  }
  if (kind === KIND_COMMITMENT) {
    const commitment = reader.take(POINT_BYTES)
    if (!equalBytes(reader.take(POINT_BYTES), pointBytes(PEDERSEN_H))) {
      fail('invalid-input')
    }
    const proof = reader.take(OPENING_PROOF_BYTES)
    const index = Number(bytesToInt(reader.take(INDEX_BYTES)))
    reader.finish()
    return { kind: 'commitment', commitment, proof, index }
  }
  return fail('invalid-input')
}

export interface PointLockMaterial {
  /** The secret t. Reveal it only by completing a pre-signature. */
  readonly secret: AdaptorSecret
  /** Give this to the other party; both pass it to `startSign` as `lock`. */
  readonly lock: AdaptorLock & { readonly kind: 'point' }
  /** Keep private; the holder passes it to `startSign` as `lockOpening`. */
  readonly opening: LockOpening
}

/** Creates a fresh point lock held by this share's party. */
export function createPointLock(input: {
  readonly keyShare: KeyShare
  readonly randomBytes: RandomBytes
}): DklsResult<PointLockMaterial> {
  try {
    const share = usableShare(input?.keyShare)
    const rng = input.randomBytes
    if (typeof rng !== 'function') return failure('rng-failed')
    const material = generateAdaptorSecret(rng)
    if (!material.ok) return failure('rng-failed')
    const context = lockContext(share.keyId, share.localId)
    const ownerProof = proveDlog(
      rng,
      context,
      share.localId,
      bytesToInt(material.value.secret),
      parsePoint(material.value.point),
      LOCK_PREFIX,
    )
    return success({
      secret: material.value.secret,
      opening: { kind: 'point', secret: material.value.secret.slice() },
      lock: {
        kind: 'point',
        point: material.value.point,
        proof: material.value.proof,
        ownerProof,
      },
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}

export interface CommitmentLockMaterial {
  /** The blinding secret s. Completing the pre-signature for `value` reveals it. */
  readonly secret: Uint8Array
  /** C = s*G + value*H, 33 bytes. */
  readonly commitment: Uint8Array
  /** Proof of knowledge of the opening, bound to the key and this party. */
  readonly proof: Uint8Array
  /** Keep private; the holder passes it to `startSign` as `lockOpening`. */
  readonly opening: LockOpening
}

/**
 * Commits to `value` (0 to 2^32 - 1) with a fresh secret. Use
 * `{ kind: 'commitment', commitment, proof, index }` as the `lock` of one
 * pre-signing session per candidate value `index`; the holder passes the
 * returned `opening` in each of them.
 */
export function createCommitmentLock(input: {
  readonly keyShare: KeyShare
  readonly value: number
  readonly randomBytes: RandomBytes
}): DklsResult<CommitmentLockMaterial> {
  try {
    const share = usableShare(input?.keyShare)
    const rng = input.randomBytes
    if (typeof rng !== 'function') return failure('rng-failed')
    const value = indexScalar(input.value)
    const context = lockContext(share.keyId, share.localId)
    const fresh = draw(rng, 32)
    const secret = hedgedScalarWith(
      LOCK_PREFIX,
      rng,
      'lock/commitment-secret',
      context,
      fresh,
    )
    fresh.fill(0)
    const commitment = pedersen(secret, value)
    return success({
      secret: scalarBytes(secret),
      opening: {
        kind: 'commitment',
        secret: scalarBytes(secret),
        value: input.value,
      },
      commitment: pointBytes(commitment),
      proof: proveOpening(
        rng,
        context,
        share.localId,
        secret,
        value,
        commitment,
      ),
    })
  } catch (error) {
    return failure(failureCode(error))
  }
}

/** The lock point `C - index*H` of a commitment, 33 bytes. No proof is checked. */
export function commitmentLockPoint(
  commitment: Uint8Array,
  index: number,
): DklsResult<Uint8Array> {
  try {
    const copied = snapshot(commitment, POINT_BYTES)
    if (copied === null) return failure('invalid-input')
    return success(
      pointBytes(lockPointOf(parsePoint(copied), indexScalar(index))),
    )
  } catch (error) {
    return failure(failureCode(error))
  }
}

/**
 * True if `signature` is a valid adaptor pre-signature for the key, digest
 * and lock point, by the verifier of `@frank/adaptor-signatures`.
 */
export function isLockedSignature(
  publicKey: Point,
  lockPoint: Point,
  digest: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return verifyEncryptedSignature(
      publicKey,
      lockPoint,
      digest,
      decodeAdaptorSignature(signature),
    )
  } catch {
    return false
  }
}

/** The recovery bit (EIP-1559 yParity) of a signature, or null if none fits. */
export function recoveryBit(
  publicKey: Uint8Array,
  digest: Uint8Array,
  signature: Uint8Array,
): 0 | 1 | null {
  if (
    snapshot(publicKey, POINT_BYTES) === null ||
    snapshot(digest, 32) === null ||
    snapshot(signature, COMPACT_SIGNATURE_BYTES) === null
  ) {
    return null
  }
  for (const candidate of [0, 1] as const) {
    try {
      const recovered = secp256k1.Signature.fromCompact(signature)
        .addRecoveryBit(candidate)
        .recoverPublicKey(digest)
        .toRawBytes(true)
      if (equalBytes(recovered, publicKey)) return candidate
    } catch {
      // Try the other bit.
    }
  }
  return null
}

interface LockedInputs {
  readonly publicKey: Point
  readonly publicKeyBytes: Uint8Array
  readonly lockPoint: Point
  readonly digest: Uint8Array
  readonly signature: Uint8Array
}

function lockedInputs(input: {
  readonly publicKey: Uint8Array
  readonly commitment: Uint8Array
  readonly index: number
  readonly digest: Uint8Array
  readonly adaptorSignature: Uint8Array
}): LockedInputs {
  const publicKey = snapshot(input.publicKey, POINT_BYTES)
  const commitment = snapshot(input.commitment, POINT_BYTES)
  const digest = snapshot(input.digest, 32)
  const signature = snapshot(input.adaptorSignature, ADAPTOR_SIGNATURE_BYTES)
  if (
    publicKey === null ||
    commitment === null ||
    digest === null ||
    signature === null
  ) {
    return fail('invalid-input')
  }
  return {
    publicKey: parsePoint(publicKey),
    publicKeyBytes: publicKey,
    lockPoint: lockPointOf(parsePoint(commitment), indexScalar(input.index)),
    digest,
    signature,
  }
}

export interface CompletedSignature {
  /** `r (32) || s (32)`, low-s. */
  readonly signature: Uint8Array
  /** EIP-1559 yParity. */
  readonly recovery: 0 | 1
}

/**
 * Completes a pre-signature locked to `C - index*H` with the commitment's
 * secret. Succeeds only if `index` is the committed value (`secret * G` must
 * equal the lock point). Publishing the result reveals `secret`.
 */
export function completeCommitmentLock(input: {
  readonly publicKey: Uint8Array
  readonly commitment: Uint8Array
  readonly index: number
  readonly digest: Uint8Array
  readonly adaptorSignature: Uint8Array
  readonly secret: Uint8Array
}): DklsResult<CompletedSignature> {
  let secret: Uint8Array | null = null
  try {
    secret = snapshot(input?.secret, SCALAR_BYTES)
    if (secret === null) return failure('invalid-input')
    const inputs = lockedInputs(input)
    const scalar = parseScalar(secret)
    if (!multiply(G, scalar).equals(inputs.lockPoint)) {
      return failure('lock-not-owned')
    }
    if (
      !isLockedSignature(
        inputs.publicKey,
        inputs.lockPoint,
        inputs.digest,
        inputs.signature,
      )
    ) {
      return failure('invalid-signature')
    }
    const signature = encodeEcdsaSignature(
      decryptSignature(decodeAdaptorSignature(inputs.signature), scalar),
    )
    const recovery = recoveryBit(inputs.publicKeyBytes, inputs.digest, signature)
    if (recovery === null) return failure('invalid-signature')
    return success({ signature, recovery })
  } catch (error) {
    return failure(failureCode(error))
  } finally {
    secret?.fill(0)
  }
}

/**
 * Extracts the commitment's secret from a completed signature and the
 * pre-signature it came from. Both are verified first.
 */
export function extractCommitmentLockSecret(input: {
  readonly publicKey: Uint8Array
  readonly commitment: Uint8Array
  readonly index: number
  readonly digest: Uint8Array
  readonly adaptorSignature: Uint8Array
  readonly completedSignature: Uint8Array
}): DklsResult<Uint8Array> {
  try {
    const completed = snapshot(input?.completedSignature, COMPACT_SIGNATURE_BYTES)
    if (completed === null) return failure('invalid-input')
    const inputs = lockedInputs(input)
    if (
      !isLockedSignature(
        inputs.publicKey,
        inputs.lockPoint,
        inputs.digest,
        inputs.signature,
      )
    ) {
      return failure('invalid-signature')
    }
    const parsed = decodeEcdsaSignature(completed)
    if (!verifyStandardEcdsaSignature(inputs.publicKey, inputs.digest, parsed)) {
      return failure('invalid-signature')
    }
    return success(
      scalarBytes(
        recoverTweak(
          inputs.lockPoint,
          decodeAdaptorSignature(inputs.signature),
          parsed,
        ),
      ),
    )
  } catch (error) {
    const code = failureCode(error)
    return failure(code === 'internal-error' ? 'invalid-signature' : code)
  }
}
