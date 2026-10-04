/**
 * Adaptor locks: the points an adaptor pre-signature can be locked to.
 *
 * An ECDSA adaptor signature under a point T is only safe when someone
 * provably knows the discrete log of T (Aumayr et al., "Generalized
 * Bitcoin-Compatible Channels", ePrint 2020/476; see
 * `@frank/adaptor-signatures`). This package never accepts a bare,
 * caller-chosen T. A lock is one of two things, both created by the party
 * that knows the secret, which is always the RESPONDER of the key (the
 * initiator is the party that later extracts the secret).
 *
 * The two parties check a lock differently, and both checks are needed:
 *
 *  - The INITIATOR verifies the proofs below: someone knows the secret, so
 *    the adaptor construction is safe to use.
 *  - The RESPONDER must show `startSign` the secret itself (a `LockOpening`).
 *    A proof only shows that SOMEONE knows the secret, and the identity
 *    hashed into it is just bytes: the initiator could build a lock from its
 *    own secret, label it with the responder's identity and present it as
 *    "the responder's". The responder would then pre-sign under a lock the
 *    initiator can open, and the initiator would complete the signature
 *    alone. Requiring the opening means the responder only ever pre-signs
 *    under a lock it can open itself.
 *
 * The two kinds of lock:
 *
 * 1. POINT LOCK. T = t*G with two proofs of knowledge of t:
 *    - the 65-byte proof of `@frank/adaptor-signatures`, which that package's
 *      verify/complete/extract functions require. Its challenge is H(T, R)
 *      only, so by itself it can be replayed by anyone who has seen it;
 *    - an owner proof: a Schnorr proof of knowledge of t bound to this key
 *      (key id) and to the responder's identity. A copied (T, proof) pair
 *      cannot be given a valid owner proof without knowing t.
 *
 * 2. COMMITMENT LOCK. A Pedersen commitment C = s*G + v*H to a value v
 *    (for example a card), with a proof of knowledge of an opening (s, v).
 *    It yields a family of lock points, one per candidate value:
 *
 *        T_i = C - i*H = s*G + (v - i)*H
 *
 *    T_v = s*G, so a pre-signature locked to T_v is completed with s, and
 *    completing it reveals s. For any i != v, completing under T_i needs the
 *    discrete log of s*G + (v - i)*H; knowing it together with (s, v) gives
 *    log_G(H), which nobody knows. So the holder can complete exactly the
 *    pre-signature for the value it committed to, without having said in
 *    advance which one that is.
 *
 *    The opening proof is Okamoto's two-generator proof of knowledge
 *    (Okamoto, CRYPTO '92), Fiat-Shamir transformed and bound to the key id
 *    and the responder's identity. A 1-of-N OR-proof (Cramer, Damgard,
 *    Schoenmakers, CRYPTO '94) would additionally prove that v lies in a
 *    given range, at N times the size. It is not needed for safety: a holder
 *    that commits to a value outside the range the game pre-signs for can
 *    complete none of the pre-signatures and only harms itself, exactly as if
 *    it refused to reveal. The game layer must therefore make "no reveal"
 *    lose.
 *
 *    Every commitment needs its own fresh s. Reusing s across two
 *    commitments makes revealing one reveal the other.
 *
 * H is a fixed generator whose discrete log nobody knows: the first valid
 * curve point with even y whose x coordinate is
 * SHA256("FRANK-TECDSA-V1/pedersen-H" || counter) for counter = 0, 1, 2, ...
 * (4 bytes big-endian).
 */
import {
  generateAdaptorSecret,
  verifyAdaptorSecret,
  type AdaptorPoint,
  type AdaptorSecret,
  type AdaptorSecretProof,
  type AdaptorSignatureBytes,
} from '@frank/adaptor-signatures'
import { modAdd, modMul } from '@frank/adaptor-signatures/src/curve.js'
import {
  decodeAdaptorSignature,
  decodeEcdsaSignature,
  decryptSignature,
  encodeEcdsaSignature,
  recoverTweak,
  verifyEncryptedSignature,
  verifyStandardEcdsaSignature,
} from '@frank/adaptor-signatures/src/ecdsa-adaptor.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

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
  CURVE_ORDER,
  DLOG_PROOF_BYTES,
  G,
  hedgedScalar,
  multiply,
  parsePoint,
  parseScalar,
  pointBytes,
  POINT_BYTES,
  proveDlog,
  requireDlogProof,
  SCALAR_BYTES,
  scalarBytes,
  TAG_PREFIX,
  transcript,
  transcriptScalar,
  type Point,
} from './group.js'
import { internalShare, shareIsBurned, type KeyShare } from './key-share.js'
import { drawInRange, type RandomBytes } from './rng.js'
import {
  fail,
  failure,
  failureCode,
  success,
  type ThresholdResult,
} from './result.js'

const ADAPTOR_PROOF_BYTES = 65
const ADAPTOR_SIGNATURE_BYTES = 162
const COMPACT_SIGNATURE_BYTES = 64
const INDEX_BYTES = 4
const MAX_INDEX = 0xffffffff
export const OPENING_PROOF_BYTES = POINT_BYTES + 2 * SCALAR_BYTES

const KIND_POINT = 1
const KIND_COMMITMENT = 2

function deriveSecondGenerator(): Point {
  const tag = asciiBytes(`${TAG_PREFIX}pedersen-H`)
  for (let counter = 0; counter < 1000; counter += 1) {
    const x = sha256(concat(tag, intToBytes(BigInt(counter), 4)))
    try {
      return parsePoint(concat(Uint8Array.of(0x02), x))
    } catch {
      // Not an x coordinate of the curve; try the next counter.
    }
  }
  return fail('internal-error')
}

/** The second Pedersen generator H. See the file header for its derivation. */
export const PEDERSEN_H: Point = deriveSecondGenerator()

/** A lock as passed to `startSign`. */
export type AdaptorLock =
  | {
      readonly kind: 'point'
      /** T = t*G. */
      readonly point: AdaptorPoint
      /** Proof of knowledge of t from `@frank/adaptor-signatures`. */
      readonly proof: AdaptorSecretProof
      /** Proof of knowledge of t bound to this key and its responder. */
      readonly ownerProof: Uint8Array
    }
  | {
      readonly kind: 'commitment'
      /** C = s*G + v*H, 33 bytes. */
      readonly commitment: Uint8Array
      /** Proof of knowledge of an opening of C, bound to key and responder. */
      readonly proof: Uint8Array
      /** The candidate value i this pre-signature is for: lock point C - i*H. */
      readonly index: number
    }

/**
 * The secret side of a lock, held by the responder only and required by its
 * `startSign`. Returned by `createPointLock` / `createCommitmentLock`.
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

/**
 * Context every lock proof is bound to: the key (its id covers both
 * identities and all key-generation material) and the proving party.
 */
function lockContext(keyId: Uint8Array, proverId: Uint8Array): Uint8Array {
  return transcript('lock/context', keyId, proverId)
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
  proverId: Uint8Array,
  commitment: Point,
  announcement: Point,
): bigint {
  return transcriptScalar(
    'proof/opening',
    context,
    proverId,
    pointBytes(commitment),
    pointBytes(PEDERSEN_H),
    pointBytes(announcement),
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
 *   A = a*G + b*H,  e = H(context, prover, C, H, A),
 *   z1 = a + e*s,   z2 = b + e*v.      Wire: A (33) || z1 (32) || z2 (32).
 */
function proveOpening(
  rng: RandomBytes,
  context: Uint8Array,
  proverId: Uint8Array,
  secret: bigint,
  value: bigint,
  commitment: Point,
): Uint8Array {
  const witness = scalarBytes(secret)
  const a = hedgedScalar(rng, 'proof/opening/a', context, proverId, witness)
  const b = hedgedScalar(rng, 'proof/opening/b', context, proverId, witness)
  witness.fill(0)
  const announcement = pedersen(a, b)
  const challenge = openingChallenge(
    context,
    proverId,
    commitment,
    announcement,
  )
  return concat(
    pointBytes(announcement),
    scalarBytes(modAdd(a, modMul(challenge, secret))),
    scalarBytes(modAdd(b, modMul(challenge, value))),
  )
}

/** Verifier: z1*G + z2*H = A + e*C. */
function requireOpeningProof(
  context: Uint8Array,
  proverId: Uint8Array,
  commitment: Point,
  proof: Uint8Array,
): void {
  if (proof.length !== OPENING_PROOF_BYTES) fail('malformed-message')
  const reader = new Reader(proof)
  const announcement = parsePoint(reader.take(POINT_BYTES))
  const z1 = parseScalar(reader.take(SCALAR_BYTES), true)
  const z2 = parseScalar(reader.take(SCALAR_BYTES), true)
  reader.finish()
  const challenge = openingChallenge(
    context,
    proverId,
    commitment,
    announcement,
  )
  if (challenge === 0n) fail('invalid-proof')
  const left = pedersen(z1, z2)
  const right = announcement.add(multiply(commitment, challenge))
  if (!left.equals(right)) fail('invalid-proof')
}

/**
 * Validates a lock against a key and returns its lock point and canonical
 * encoding. Every proof is verified here, before any session exists.
 */
export function resolveLock(
  lock: AdaptorLock,
  keyId: Uint8Array,
  responderId: Uint8Array,
): ResolvedLock {
  const context = lockContext(keyId, responderId)
  const kind = lock.kind
  if (kind === 'point') {
    const point = snapshot(lock.point, POINT_BYTES)
    const proof = snapshot(lock.proof, ADAPTOR_PROOF_BYTES)
    const ownerProof = snapshot(lock.ownerProof, DLOG_PROOF_BYTES)
    if (point === null || proof === null || ownerProof === null) {
      fail('invalid-input')
    }
    const parsed = parsePoint(point)
    const known = verifyAdaptorSecret(
      point as AdaptorPoint,
      proof as AdaptorSecretProof,
    )
    if (!known.ok || !known.value) fail('invalid-proof')
    requireDlogProof(context, responderId, parsed, ownerProof)
    return {
      point,
      encoded: concat(Uint8Array.of(KIND_POINT), point, proof, ownerProof),
    }
  }
  if (kind === 'commitment') {
    const commitment = snapshot(lock.commitment, POINT_BYTES)
    const proof = snapshot(lock.proof, OPENING_PROOF_BYTES)
    if (commitment === null || proof === null) fail('invalid-input')
    const index = indexScalar(lock.index)
    const parsed = parsePoint(commitment)
    requireOpeningProof(context, responderId, parsed, proof)
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
 * Responder-side check: the opening really opens this lock, i.e.
 * `secret * G = T` for a point lock and `secret * G + value * H = C` for a
 * commitment lock (whatever candidate index the session is for). Fails with
 * `lock-not-owned` otherwise.
 */
export function requireLockOpening(
  lock: AdaptorLock,
  opening: LockOpening,
): void {
  if (typeof opening !== 'object' || opening === null) fail('invalid-input')
  const secretBytes = snapshot(opening.secret, SCALAR_BYTES)
  if (secretBytes === null) fail('invalid-input')
  try {
    const secret = parseScalar(secretBytes)
    if (lock.kind === 'point' && opening.kind === 'point') {
      const point = snapshot(lock.point, POINT_BYTES)
      if (point === null) fail('invalid-input')
      if (!multiply(G, secret).equals(parsePoint(point))) fail('lock-not-owned')
      return
    }
    if (lock.kind === 'commitment' && opening.kind === 'commitment') {
      const commitment = snapshot(lock.commitment, POINT_BYTES)
      if (commitment === null) fail('invalid-input')
      const expected = pedersen(secret, indexScalar(opening.value))
      if (!expected.equals(parsePoint(commitment))) fail('lock-not-owned')
      return
    }
    fail('invalid-input')
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

function responderShare(share: KeyShare) {
  const internal = internalShare(share)
  if (shareIsBurned(internal)) fail('key-share-burned')
  // Only the responder may hold lock secrets: the initiator learns every
  // pre-signature first and is the party that extracts.
  if (internal.role !== 'responder') fail('invalid-input')
  return internal
}

export interface PointLockMaterial {
  /** The secret t. Reveal it only by completing a pre-signature. */
  readonly secret: AdaptorSecret
  /** Give this to the other party; both pass it to `startSign` as `lock`. */
  readonly lock: AdaptorLock & { readonly kind: 'point' }
  /** Keep private; the responder passes it to `startSign` as `lockOpening`. */
  readonly opening: LockOpening
}

/** Creates a fresh point lock for a key. Responder only. */
export function createPointLock(input: {
  readonly keyShare: KeyShare
  readonly randomBytes: RandomBytes
}): ThresholdResult<PointLockMaterial> {
  try {
    const share = responderShare(input.keyShare)
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
  /** Keep private; the responder passes it to `startSign` as `lockOpening`. */
  readonly opening: LockOpening
}

/**
 * Commits to `value` (0 to 2^32 - 1) with a fresh secret. Responder only.
 * Use `{ kind: 'commitment', commitment, proof, index }` as the `lock` of one
 * signing session per candidate value `index`; the responder passes the
 * returned `opening` as `lockOpening` in each of them.
 */
export function createCommitmentLock(input: {
  readonly keyShare: KeyShare
  readonly value: number
  readonly randomBytes: RandomBytes
}): ThresholdResult<CommitmentLockMaterial> {
  try {
    const share = responderShare(input.keyShare)
    const rng = input.randomBytes
    if (typeof rng !== 'function') return failure('rng-failed')
    const value = indexScalar(input.value)
    const secret = drawInRange(rng, 1n, CURVE_ORDER)
    const commitment = pedersen(secret, value)
    const context = lockContext(share.keyId, share.localId)
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
): ThresholdResult<Uint8Array> {
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
    fail('invalid-input')
  }
  return {
    publicKey: parsePoint(publicKey),
    publicKeyBytes: publicKey,
    lockPoint: lockPointOf(parsePoint(commitment), indexScalar(input.index)),
    digest,
    signature,
  }
}

/**
 * True if `signature` is a valid adaptor pre-signature for the key, digest
 * and lock point. Uses the verifier of `@frank/adaptor-signatures`.
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
  for (const bit of [0, 1] as const) {
    try {
      const recovered = secp256k1.Signature.fromCompact(signature)
        .addRecoveryBit(bit)
        .recoverPublicKey(digest)
        .toRawBytes(true)
      if (equalBytes(recovered, publicKey)) return bit
    } catch {
      // Try the other bit.
    }
  }
  return null
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
  readonly adaptorSignature: AdaptorSignatureBytes
  readonly secret: Uint8Array
}): ThresholdResult<CompletedSignature> {
  let secret: Uint8Array | null = null
  try {
    secret = snapshot(input.secret, SCALAR_BYTES)
    if (secret === null) return failure('invalid-input')
    const inputs = lockedInputs(input)
    const scalar = parseScalar(secret)
    if (!multiply(G, scalar).equals(inputs.lockPoint)) {
      return failure('invalid-input')
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
    const recovery = recoveryBit(
      inputs.publicKeyBytes,
      inputs.digest,
      signature,
    )
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
  readonly adaptorSignature: AdaptorSignatureBytes
  readonly completedSignature: Uint8Array
}): ThresholdResult<Uint8Array> {
  try {
    const completed = snapshot(
      input.completedSignature,
      COMPACT_SIGNATURE_BYTES,
    )
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
    if (
      !verifyStandardEcdsaSignature(inputs.publicKey, inputs.digest, parsed)
    ) {
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
