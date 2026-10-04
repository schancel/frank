/**
 * secp256k1 helpers, transcript hashing, hash commitments and the two
 * Fiat-Shamir sigma proofs the protocols use.
 *
 * Curve arithmetic is reused from `@frank/adaptor-signatures` (which wraps
 * `@noble/curves`); see that package's `curve.ts` for its side-channel
 * posture. This file adds strict wire parsing and session-bound proofs whose
 * nonces come from the caller's CSPRNG instead of an ambient source.
 */
import {
  CURVE_ORDER,
  G,
  hashToScalar,
  mod,
  modAdd,
  modMul,
  pointBytes,
  pointFromBytes,
  scalarBytes,
  scalarFromBytesCanonical,
  taggedHash,
  type Point,
} from '@frank/adaptor-signatures/src/curve.js'

import { bytesToInt, concat, equalBytes, intToBytes } from './bytes.js'
import { draw, type RandomBytes } from './rng.js'
import { fail } from './result.js'

export { CURVE_ORDER, G, pointBytes, scalarBytes }
export type { Point }

export const POINT_BYTES = 33
export const SCALAR_BYTES = 32
export const HASH_BYTES = 32

/** Every domain-separation tag of this package starts with this prefix. */
export const TAG_PREFIX = 'FRANK-TECDSA-V1/'

/**
 * `floor(n / 3)`. Key shares live in `[SHARE_LOW, 2 * SHARE_LOW)`, the range
 * Lindell 2017 Protocol 3.1 step 1 requires of P1's share so that the range
 * proof of Appendix A (which has slack 3) proves the encrypted share is below
 * the group order.
 */
export const SHARE_LOW: bigint = CURVE_ORDER / 3n
export const SHARE_HIGH: bigint = 2n * SHARE_LOW

/**
 * Parses a compressed point: exactly 33 bytes, prefix 02 or 03, on the
 * curve. secp256k1 has cofactor 1, so every such point is in the prime-order
 * group, and the identity has no 33-byte encoding.
 */
export function parsePoint(bytes: Uint8Array): Point {
  if (bytes.length !== POINT_BYTES) fail('malformed-message')
  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) fail('invalid-point')
  try {
    return pointFromBytes(bytes)
  } catch {
    return fail('invalid-point')
  }
}

/** Parses a canonical 32-byte scalar in `[1, n)` (or `[0, n)`). */
export function parseScalar(bytes: Uint8Array, allowZero = false): bigint {
  if (bytes.length !== SCALAR_BYTES) fail('malformed-message')
  try {
    return scalarFromBytesCanonical(bytes, allowZero)
  } catch {
    return fail('out-of-range')
  }
}

/** `scalar * point` for `scalar` in `[1, n)`. */
export function multiply(point: Point, scalar: bigint): Point {
  if (scalar <= 0n || scalar >= CURVE_ORDER) fail('internal-error')
  return point.multiply(scalar)
}

/**
 * Domain-separated hash of a list of byte strings. Each part is prefixed with
 * its 4-byte big-endian length, so distinct part lists never collide:
 *
 *   SHA256(SHA256(tag) || SHA256(tag) || len(p1) || p1 || len(p2) || p2 ...)
 *
 * with `tag = TAG_PREFIX || label`.
 */
export function transcript(
  label: string,
  ...parts: readonly Uint8Array[]
): Uint8Array {
  const framed: Uint8Array[] = []
  for (const part of parts) {
    framed.push(intToBytes(BigInt(part.length), 4), part)
  }
  return taggedHash(TAG_PREFIX + label, ...framed)
}

/** A transcript hash reduced to a scalar. */
export function transcriptScalar(
  label: string,
  ...parts: readonly Uint8Array[]
): bigint {
  return hashToScalar(transcript(label, ...parts))
}

/**
 * Hash commitment `H(label, session, committer, payload, nonce)` with a
 * 32-byte random nonce. Binding by collision resistance; hiding in the
 * random-oracle model. This instantiates the commitment functionality of
 * Lindell 2017, Section 2.2.
 */
export function commit(
  label: string,
  session: Uint8Array,
  committer: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return transcript(`commit/${label}`, session, committer, payload, nonce)
}

export function requireOpening(
  commitment: Uint8Array,
  label: string,
  session: Uint8Array,
  committer: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array,
): void {
  if (
    !equalBytes(commitment, commit(label, session, committer, payload, nonce))
  ) {
    fail('invalid-commitment')
  }
}

/**
 * A hedged secret scalar in `[1, n)`: 512 hash bits over 32 fresh random
 * bytes, a purpose label, the session binding and optional long-term secret
 * material, reduced mod n. Fresh randomness makes every session's nonces
 * independent; mixing in the session and the secret means a repeating or
 * predictable RNG still cannot repeat a nonce across two different sessions
 * or expose it to someone who lacks the secret.
 */
export function hedgedScalar(
  rng: RandomBytes,
  purpose: string,
  session: Uint8Array,
  ...secrets: readonly Uint8Array[]
): bigint {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fresh = draw(rng, 32)
    const low = transcript(`nonce/${purpose}/0`, fresh, session, ...secrets)
    const high = transcript(`nonce/${purpose}/1`, fresh, session, ...secrets)
    const wide = concat(high, low)
    const value = mod(bytesToInt(wide))
    fresh.fill(0)
    low.fill(0)
    high.fill(0)
    wide.fill(0)
    if (value !== 0n) return value
  }
  return fail('rng-failed')
}

// --- Schnorr proof of knowledge of a discrete logarithm --------------------
//
// Fiat-Shamir transform of Schnorr's identification protocol (Schnorr,
// CRYPTO '89). It instantiates the functionality F_zk^{R_DL} of Lindell 2017,
// Section 2.2, in the random-oracle model. Wire form: A (33) || z (32).

export const DLOG_PROOF_BYTES = POINT_BYTES + SCALAR_BYTES

function dlogChallenge(
  session: Uint8Array,
  prover: Uint8Array,
  statement: Point,
  commitment: Point,
): bigint {
  return transcriptScalar(
    'proof/dlog',
    session,
    prover,
    pointBytes(statement),
    pointBytes(commitment),
  )
}

/** Proves knowledge of `witness` with `statement = witness * G`. */
export function proveDlog(
  rng: RandomBytes,
  session: Uint8Array,
  prover: Uint8Array,
  witness: bigint,
  statement: Point,
): Uint8Array {
  const secret = scalarBytes(witness)
  const nonce = hedgedScalar(rng, 'proof/dlog', session, prover, secret)
  secret.fill(0)
  const commitment = multiply(G, nonce)
  const challenge = dlogChallenge(session, prover, statement, commitment)
  const response = modAdd(nonce, modMul(challenge, witness))
  return concat(pointBytes(commitment), scalarBytes(response))
}

export function requireDlogProof(
  session: Uint8Array,
  prover: Uint8Array,
  statement: Point,
  proof: Uint8Array,
): void {
  if (proof.length !== DLOG_PROOF_BYTES) fail('malformed-message')
  const commitment = parsePoint(proof.subarray(0, POINT_BYTES))
  const response = parseScalar(proof.subarray(POINT_BYTES))
  const challenge = dlogChallenge(session, prover, statement, commitment)
  if (challenge === 0n) fail('invalid-proof')
  // response * G == commitment + challenge * statement
  const left = multiply(G, response)
  const right = commitment.add(multiply(statement, challenge))
  if (!left.equals(right)) fail('invalid-proof')
}

// --- Proof of equality of discrete logarithms ------------------------------
//
// Fiat-Shamir transform of the Chaum-Pedersen protocol (CRYPTO '92): proves
// knowledge of k with `first = k * G` and `second = k * base`. Used only for
// the nonce shares of adaptor signing. Wire form: e (32) || z (32).

export const DLEQ_PROOF_BYTES = 2 * SCALAR_BYTES

function dleqChallenge(
  session: Uint8Array,
  prover: Uint8Array,
  base: Point,
  first: Point,
  second: Point,
  commitFirst: Point,
  commitSecond: Point,
): bigint {
  return transcriptScalar(
    'proof/dleq',
    session,
    prover,
    pointBytes(base),
    pointBytes(first),
    pointBytes(second),
    pointBytes(commitFirst),
    pointBytes(commitSecond),
  )
}

export function proveDleq(
  rng: RandomBytes,
  session: Uint8Array,
  prover: Uint8Array,
  witness: bigint,
  base: Point,
  first: Point,
  second: Point,
): Uint8Array {
  const secret = scalarBytes(witness)
  const nonce = hedgedScalar(rng, 'proof/dleq', session, prover, secret)
  secret.fill(0)
  const challenge = dleqChallenge(
    session,
    prover,
    base,
    first,
    second,
    multiply(G, nonce),
    multiply(base, nonce),
  )
  const response = modAdd(nonce, modMul(challenge, witness))
  return concat(scalarBytes(challenge), scalarBytes(response))
}

export function requireDleqProof(
  session: Uint8Array,
  prover: Uint8Array,
  base: Point,
  first: Point,
  second: Point,
  proof: Uint8Array,
): void {
  if (proof.length !== DLEQ_PROOF_BYTES) fail('malformed-message')
  // A zero challenge or response has negligible probability for an honest
  // prover and is rejected, which also keeps every scalar multiplier nonzero.
  const challenge = parseScalar(proof.subarray(0, SCALAR_BYTES))
  const response = parseScalar(proof.subarray(SCALAR_BYTES))
  let commitFirst: Point
  let commitSecond: Point
  try {
    commitFirst = multiply(G, response).subtract(multiply(first, challenge))
    commitSecond = multiply(base, response).subtract(
      multiply(second, challenge),
    )
    // The identity cannot be hashed as a 33-byte point; an honest proof never
    // produces it.
    commitFirst.assertValidity()
    commitSecond.assertValidity()
  } catch {
    return fail('invalid-proof')
  }
  const expected = dleqChallenge(
    session,
    prover,
    base,
    first,
    second,
    commitFirst,
    commitSecond,
  )
  if (expected !== challenge) fail('invalid-proof')
}
