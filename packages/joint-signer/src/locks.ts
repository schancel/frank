/**
 * Adaptor locks in the format of `@frank/threshold-ecdsa` (`src/lock.ts`),
 * for backends that do not get them from that package.
 *
 * The definitions are that package's, byte for byte: the tag prefix, the
 * transcript framing, the second generator H, the proof layouts and the
 * canonical lock encoding. A lock made here for a key id and a holder
 * identity is accepted by that package's `resolveLock` for the same pair, and
 * the other way round (the test suite checks both directions).
 *
 * Two kinds:
 *  - point lock: T = t*G with two proofs of knowledge of t;
 *  - commitment lock: C = s*G + v*H with a proof of knowledge of (s, v);
 *    the lock point for candidate value i is C - i*H, which is s*G exactly
 *    when i = v.
 *
 * A lock's public proofs show that someone knows its secret and named the
 * holder. They do not show that the holder made it. The holder must
 * therefore check its own opening (`lockOpenedBy`) before pre-signing.
 */
import { generateAdaptorSecret } from '@frank/adaptor-signatures'
import {
  G,
  hashToScalar,
  modAdd,
  modMul,
  pointBytes,
  pointFromBytes,
  scalarBytes,
  scalarFromBytesCanonical,
  taggedHash,
  type Point,
} from '@frank/adaptor-signatures/src/curve.js'
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

import { ascii, concat, draw, recoveryBit, snapshot, uint32 } from './bytes.js'
import { fail, Failure, failure, success } from './result.js'
import type {
  JointLock,
  JointLockOpening,
  JointSignerResult,
  RandomBytes,
} from './types.js'

const TAG_PREFIX = 'FRANK-TECDSA-V1/'
const KIND_POINT = 1
const KIND_COMMITMENT = 2
const MAX_INDEX = 0xffffffff

/** `H_tag(TAG_PREFIX || label, len(part) || part ...)`, as in that package. */
function transcript(label: string, ...parts: Uint8Array[]): Uint8Array {
  const framed: Uint8Array[] = []
  for (const part of parts) framed.push(uint32(part.length), part)
  return taggedHash(TAG_PREFIX + label, ...framed)
}

function transcriptScalar(label: string, ...parts: Uint8Array[]): bigint {
  return hashToScalar(transcript(label, ...parts))
}

function parsePoint(bytes: Uint8Array): Point {
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
    fail('invalid-input')
  }
  try {
    return pointFromBytes(bytes)
  } catch {
    return fail('invalid-input')
  }
}

function parseScalar(bytes: Uint8Array, allowZero = false): bigint {
  try {
    return scalarFromBytesCanonical(bytes, allowZero)
  } catch {
    return fail('invalid-input')
  }
}

function deriveSecondGenerator(): Point {
  const tag = ascii(`${TAG_PREFIX}pedersen-H`)
  for (let counter = 0; counter < 1000; counter += 1) {
    const x = sha256(concat(tag, uint32(counter)))
    try {
      return pointFromBytes(concat(Uint8Array.of(0x02), x))
    } catch {
      // Not an x coordinate of the curve; try the next counter.
    }
  }
  return fail('internal-error')
}

/** The second Pedersen generator H of `@frank/threshold-ecdsa`. */
export const PEDERSEN_H: Point = deriveSecondGenerator()

function lockContext(keyId: Uint8Array, holderId: Uint8Array): Uint8Array {
  return transcript('lock/context', keyId, holderId)
}

function indexOf(value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INDEX) {
    fail('invalid-input')
  }
  return BigInt(value)
}

/** A uniform non-zero scalar from 48 caller-supplied random bytes. */
function randomScalar(randomBytes: RandomBytes): bigint {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wide = draw(randomBytes, 48)
    let value = 0n
    for (const byte of wide) value = (value << 8n) | BigInt(byte)
    wide.fill(0)
    const scalar = modAdd(value, 0n)
    if (scalar !== 0n) return scalar
  }
  return fail('rng-failed')
}

/** `left*G + right*H`; either scalar, not both, may be zero. */
function pedersen(left: bigint, right: bigint): Point {
  if (left === 0n && right === 0n) fail('invalid-input')
  if (left === 0n) return PEDERSEN_H.multiply(right)
  if (right === 0n) return G.multiply(left)
  const sum = G.multiply(left).add(PEDERSEN_H.multiply(right))
  try {
    sum.assertValidity()
  } catch {
    return fail('invalid-input')
  }
  return sum
}

function lockPointOf(commitment: Point, index: bigint): Point {
  if (index === 0n) return commitment
  const point = commitment.subtract(PEDERSEN_H.multiply(index))
  try {
    point.assertValidity()
  } catch {
    return fail('invalid-input')
  }
  return point
}

function describe<T>(error: unknown): JointSignerResult<T> {
  if (error instanceof Failure) return failure(error.code)
  return failure('internal-error')
}

/** A point lock for `keyId`, held by `holderId`, with its secret `t`. */
export function createPointLock(input: {
  readonly keyId: Uint8Array
  readonly holderId: Uint8Array
  readonly randomBytes: RandomBytes
}): JointSignerResult<{
  readonly secret: Uint8Array
  readonly lock: JointLock & { readonly kind: 'point' }
  readonly opening: JointLockOpening & { readonly kind: 'point' }
}> {
  try {
    const material = generateAdaptorSecret(input.randomBytes)
    if (!material.ok) return failure('rng-failed')
    const secret = Uint8Array.from(material.value.secret)
    const point = Uint8Array.from(material.value.point)
    const t = parseScalar(secret)
    // Owner proof (Schnorr): A = a*G, e = H(context, holder, T, A), z = a + e*t.
    const context = lockContext(input.keyId, input.holderId)
    const a = randomScalar(input.randomBytes)
    const announcement = pointBytes(G.multiply(a))
    const e = transcriptScalar(
      'proof/dlog',
      context,
      input.holderId,
      point,
      announcement,
    )
    const ownerProof = concat(
      announcement,
      scalarBytes(modAdd(a, modMul(e, t))),
    )
    return success({
      secret,
      lock: {
        kind: 'point',
        point,
        proof: Uint8Array.from(material.value.proof),
        ownerProof,
      },
      opening: { kind: 'point', secret: secret.slice() },
    })
  } catch (error) {
    return describe(error)
  }
}

/** A commitment to `value` for `keyId`, held by `holderId`, with its secret `s`. */
export function createCommitmentLock(input: {
  readonly keyId: Uint8Array
  readonly holderId: Uint8Array
  readonly value: number
  readonly randomBytes: RandomBytes
}): JointSignerResult<{
  readonly secret: Uint8Array
  readonly commitment: Uint8Array
  readonly proof: Uint8Array
  readonly opening: JointLockOpening & { readonly kind: 'commitment' }
}> {
  try {
    const value = indexOf(input.value)
    const s = randomScalar(input.randomBytes)
    const commitment = pointBytes(pedersen(s, value))
    // Okamoto: A = a*G + b*H, e = H(context, holder, C, H, A),
    // z1 = a + e*s, z2 = b + e*v.
    const context = lockContext(input.keyId, input.holderId)
    const a = randomScalar(input.randomBytes)
    const b = randomScalar(input.randomBytes)
    const announcement = pointBytes(pedersen(a, b))
    const e = transcriptScalar(
      'proof/opening',
      context,
      input.holderId,
      commitment,
      pointBytes(PEDERSEN_H),
      announcement,
    )
    return success({
      secret: scalarBytes(s),
      commitment,
      proof: concat(
        announcement,
        scalarBytes(modAdd(a, modMul(e, s))),
        scalarBytes(modAdd(b, modMul(e, value))),
      ),
      opening: {
        kind: 'commitment',
        secret: scalarBytes(s),
        value: input.value,
      },
    })
  } catch (error) {
    return describe(error)
  }
}

/** The lock point `C - index*H`, 33 bytes. No proof is checked. */
export function commitmentLockPoint(
  commitment: Uint8Array,
  index: number,
): JointSignerResult<Uint8Array> {
  try {
    const copied = snapshot(commitment, 33)
    if (copied === null) return failure('invalid-input')
    return success(pointBytes(lockPointOf(parsePoint(copied), indexOf(index))))
  } catch (error) {
    return describe(error)
  }
}

/**
 * The canonical encoding of a lock, as `@frank/threshold-ecdsa` binds it into
 * a session. Only lengths are checked here; whoever consumes the encoding
 * verifies the proofs.
 */
export function encodeLock(lock: JointLock): Uint8Array | null {
  if (lock === null || typeof lock !== 'object') return null
  if (lock.kind === 'point') {
    const point = snapshot(lock.point, 33)
    const proof = snapshot(lock.proof, 65)
    const ownerProof = snapshot(lock.ownerProof, 65)
    if (point === null || proof === null || ownerProof === null) return null
    return concat(Uint8Array.of(KIND_POINT), point, proof, ownerProof)
  }
  if (lock.kind === 'commitment') {
    const commitment = snapshot(lock.commitment, 33)
    const proof = snapshot(lock.proof, 97)
    const index = lock.index
    if (commitment === null || proof === null) return null
    if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) return null
    return concat(
      Uint8Array.of(KIND_COMMITMENT),
      commitment,
      pointBytes(PEDERSEN_H),
      proof,
      uint32(index),
    )
  }
  return null
}

/**
 * True if `opening` is the secret material of `lock`: `t*G == T` for a point
 * lock, `s*G + v*H == C` for a commitment lock. The holder of a lock must
 * check this before pre-signing under it.
 */
export function lockOpenedBy(
  lock: JointLock,
  opening: JointLockOpening,
): boolean {
  try {
    if (lock === null || typeof lock !== 'object') return false
    if (opening === null || typeof opening !== 'object') return false
    const secret = snapshot(opening.secret, 32)
    if (secret === null) return false
    try {
      const s = parseScalar(secret)
      if (lock.kind === 'point' && opening.kind === 'point') {
        const point = snapshot(lock.point, 33)
        return point !== null && G.multiply(s).equals(parsePoint(point))
      }
      if (lock.kind === 'commitment' && opening.kind === 'commitment') {
        const commitment = snapshot(lock.commitment, 33)
        if (commitment === null) return false
        return pedersen(s, indexOf(opening.value)).equals(
          parsePoint(commitment),
        )
      }
      return false
    } finally {
      secret.fill(0)
    }
  } catch {
    return false
  }
}

/** The opening as the forked wasm takes it: `t`, or `s || v (4, BE)`. */
export function encodeOpening(opening: JointLockOpening): Uint8Array | null {
  if (opening === null || typeof opening !== 'object') return null
  const secret = snapshot(opening.secret, 32)
  if (secret === null) return null
  if (opening.kind === 'point') return secret
  if (opening.kind === 'commitment') {
    const value = opening.value
    if (!Number.isInteger(value) || value < 0 || value > MAX_INDEX) return null
    return concat(secret, uint32(value))
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
  const publicKey = snapshot(input.publicKey, 33)
  const commitment = snapshot(input.commitment, 33)
  const digest = snapshot(input.digest, 32)
  const signature = snapshot(input.adaptorSignature, 162)
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
    lockPoint: lockPointOf(parsePoint(commitment), indexOf(input.index)),
    digest,
    signature,
  }
}

function isLockedSignature(inputs: LockedInputs): boolean {
  try {
    return verifyEncryptedSignature(
      inputs.publicKey,
      inputs.lockPoint,
      inputs.digest,
      decodeAdaptorSignature(inputs.signature),
    )
  } catch {
    return false
  }
}

/**
 * Completes a pre-signature locked to `C - index*H` with the commitment's
 * secret. Succeeds only if `index` is the committed value. Publishing the
 * result reveals `secret`.
 */
export function completeCommitmentLock(input: {
  readonly publicKey: Uint8Array
  readonly commitment: Uint8Array
  readonly index: number
  readonly digest: Uint8Array
  readonly adaptorSignature: Uint8Array
  readonly secret: Uint8Array
}): JointSignerResult<{
  readonly signature: Uint8Array
  readonly recovery: 0 | 1
}> {
  let secret: Uint8Array | null = null
  try {
    secret = snapshot(input.secret, 32)
    if (secret === null) return failure('invalid-input')
    const inputs = lockedInputs(input)
    const scalar = parseScalar(secret)
    if (!G.multiply(scalar).equals(inputs.lockPoint)) {
      return failure('invalid-input')
    }
    if (!isLockedSignature(inputs)) return failure('invalid-signature')
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
    return describe(error)
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
}): JointSignerResult<Uint8Array> {
  try {
    const completed = snapshot(input.completedSignature, 64)
    if (completed === null) return failure('invalid-input')
    const inputs = lockedInputs(input)
    if (!isLockedSignature(inputs)) return failure('invalid-signature')
    let parsed
    try {
      parsed = decodeEcdsaSignature(completed)
    } catch {
      return failure('invalid-signature')
    }
    if (
      !verifyStandardEcdsaSignature(inputs.publicKey, inputs.digest, parsed)
    ) {
      return failure('invalid-signature')
    }
    try {
      return success(
        scalarBytes(
          recoverTweak(
            inputs.lockPoint,
            decodeAdaptorSignature(inputs.signature),
            parsed,
          ),
        ),
      )
    } catch {
      return failure('invalid-signature')
    }
  } catch (error) {
    return describe(error)
  }
}
