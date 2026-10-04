/**
 * secp256k1 helpers, transcript hashing, hash commitments and the two
 * Fiat-Shamir sigma proofs the protocols use.
 *
 * Curve arithmetic comes from `@frank/adaptor-signatures` (a wrapper around
 * `@noble/curves`); see its `curve.ts` for the side-channel posture, which
 * this package inherits: no branch here is keyed on a secret, but JavaScript
 * `bigint` arithmetic is not constant-time.
 */
import {
  CURVE_ORDER,
  G,
  hashToScalar,
  mod,
  modAdd,
  modInv,
  modMul,
  modNeg,
  modSub,
  pointBytes,
  pointFromBytes,
  scalarBytes,
  scalarFromBytesCanonical,
  taggedHash,
  type Point,
} from '@frank/adaptor-signatures/src/curve.js'

import { keccak_256 } from '@noble/hashes/sha3.js'

import { bytesToInt, concat, equalBytes, intToBytes } from './bytes.js'
import { fail } from './result.js'
import { draw, type RandomBytes } from './rng.js'

export {
  CURVE_ORDER,
  G,
  mod,
  modAdd,
  modInv,
  modMul,
  modNeg,
  modSub,
  pointBytes,
  scalarBytes,
}
export type { Point }

export const POINT_BYTES = 33
export const SCALAR_BYTES = 32
export const HASH_BYTES = 32

/** Every domain-separation tag of this package's own protocol starts with this. */
export const TAG_PREFIX = 'FRANK-DKLS2P-V1/'

/**
 * Parses a compressed point: exactly 33 bytes, prefix 02 or 03, on the curve.
 * secp256k1 has cofactor 1, so every such point is in the prime-order group,
 * and the identity has no 33-byte encoding.
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

/** Parses a canonical 32-byte scalar in `[1, q)` (or `[0, q)`). */
export function parseScalar(bytes: Uint8Array, allowZero = false): bigint {
  if (bytes.length !== SCALAR_BYTES) fail('malformed-message')
  try {
    return scalarFromBytesCanonical(bytes, allowZero)
  } catch {
    return fail('out-of-range')
  }
}

/** `scalar * point` for `scalar` in `[1, q)`, constant-shape path of Noble. */
export function multiply(point: Point, scalar: bigint): Point {
  if (scalar <= 0n || scalar >= CURVE_ORDER) fail('internal-error')
  return point.multiply(scalar)
}

/** The 33-byte encoding of a point that must not be the identity. */
export function encodePoint(point: Point): Uint8Array {
  try {
    point.assertValidity()
  } catch {
    return fail('invalid-point')
  }
  return pointBytes(point)
}

/**
 * Domain-separated hash of a list of byte strings under an explicit prefix.
 * Each part is prefixed with its 4-byte big-endian length, so distinct part
 * lists never collide:
 *
 *   SHA256(SHA256(tag) || SHA256(tag) || len(p1) || p1 || len(p2) || p2 ...)
 */
export function transcriptWith(
  prefix: string,
  label: string,
  ...parts: readonly Uint8Array[]
): Uint8Array {
  const framed: Uint8Array[] = []
  for (const part of parts) {
    framed.push(intToBytes(part.length, 4), part)
  }
  return taggedHash(prefix + label, ...framed)
}

export function transcript(
  label: string,
  ...parts: readonly Uint8Array[]
): Uint8Array {
  return transcriptWith(TAG_PREFIX, label, ...parts)
}

/** A transcript hash reduced mod q (bias below 2^-127). */
export function transcriptScalar(
  label: string,
  ...parts: readonly Uint8Array[]
): bigint {
  return hashToScalar(transcript(label, ...parts))
}

/** Hash commitment with a 32-byte nonce; binding and hiding in the ROM. */
export function commit(
  label: string,
  binding: Uint8Array,
  committer: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return transcript(`commit/${label}`, binding, committer, payload, nonce)
}

export function requireOpening(
  commitment: Uint8Array,
  label: string,
  binding: Uint8Array,
  committer: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array,
): void {
  if (
    !equalBytes(commitment, commit(label, binding, committer, payload, nonce))
  ) {
    fail('invalid-commitment')
  }
}

/**
 * A hedged secret scalar in `[1, q)`: 512 hash bits over 32 fresh random
 * bytes, a purpose label, a context and optional secret material, reduced
 * mod q. A repeating RNG still cannot repeat a value across two contexts, and
 * a predictable one does not expose it to someone who lacks the secret.
 */
export function hedgedScalarWith(
  prefix: string,
  rng: RandomBytes,
  purpose: string,
  context: Uint8Array,
  ...secrets: readonly Uint8Array[]
): bigint {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fresh = draw(rng, 32)
    const low = transcriptWith(
      prefix,
      `nonce/${purpose}/0`,
      fresh,
      context,
      ...secrets,
    )
    const high = transcriptWith(
      prefix,
      `nonce/${purpose}/1`,
      fresh,
      context,
      ...secrets,
    )
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

export function hedgedScalar(
  rng: RandomBytes,
  purpose: string,
  context: Uint8Array,
  ...secrets: readonly Uint8Array[]
): bigint {
  return hedgedScalarWith(TAG_PREFIX, rng, purpose, context, ...secrets)
}

// --- Schnorr proof of knowledge of a discrete logarithm --------------------
//
// Fiat-Shamir transform of Schnorr's identification protocol. Wire form:
// A (33) || z (32). The prefix parameter exists only so that lock owner
// proofs can be produced in the exact format of `@frank/threshold-ecdsa`.

export const DLOG_PROOF_BYTES = POINT_BYTES + SCALAR_BYTES

function dlogChallenge(
  prefix: string,
  context: Uint8Array,
  prover: Uint8Array,
  statement: Point,
  commitment: Point,
): bigint {
  return hashToScalar(
    transcriptWith(
      prefix,
      'proof/dlog',
      context,
      prover,
      pointBytes(statement),
      pointBytes(commitment),
    ),
  )
}

/** Proves knowledge of `witness` with `statement = witness * G`. */
export function proveDlog(
  rng: RandomBytes,
  context: Uint8Array,
  prover: Uint8Array,
  witness: bigint,
  statement: Point,
  prefix: string = TAG_PREFIX,
): Uint8Array {
  const secret = scalarBytes(witness)
  const nonce = hedgedScalarWith(
    prefix,
    rng,
    'proof/dlog',
    context,
    prover,
    secret,
  )
  secret.fill(0)
  const commitment = multiply(G, nonce)
  const challenge = dlogChallenge(
    prefix,
    context,
    prover,
    statement,
    commitment,
  )
  const response = modAdd(nonce, modMul(challenge, witness))
  return concat(pointBytes(commitment), scalarBytes(response))
}

export function requireDlogProof(
  context: Uint8Array,
  prover: Uint8Array,
  statement: Point,
  proof: Uint8Array,
  prefix: string = TAG_PREFIX,
): void {
  if (proof.length !== DLOG_PROOF_BYTES) fail('malformed-message')
  const commitment = parsePoint(proof.subarray(0, POINT_BYTES))
  const response = parseScalar(proof.subarray(POINT_BYTES))
  const challenge = dlogChallenge(
    prefix,
    context,
    prover,
    statement,
    commitment,
  )
  if (challenge === 0n) fail('invalid-proof')
  // response * G == commitment + challenge * statement
  const left = multiply(G, response)
  const right = commitment.add(multiply(statement, challenge))
  if (!left.equals(right)) fail('invalid-proof')
}

// --- Proof of equality of discrete logarithms ------------------------------
//
// Fiat-Shamir transform of the Chaum-Pedersen protocol: proves knowledge of k
// with `first = k * G` and `second = k * base`. Wire form: e (32) || z (32).

export const DLEQ_PROOF_BYTES = 2 * SCALAR_BYTES

function dleqChallenge(
  context: Uint8Array,
  prover: Uint8Array,
  base: Point,
  first: Point,
  second: Point,
  commitFirst: Point,
  commitSecond: Point,
): bigint {
  return transcriptScalar(
    'proof/dleq',
    context,
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
  context: Uint8Array,
  prover: Uint8Array,
  witness: bigint,
  base: Point,
  first: Point,
  second: Point,
): Uint8Array {
  const secret = scalarBytes(witness)
  const nonce = hedgedScalar(rng, 'proof/dleq', context, prover, secret)
  secret.fill(0)
  const challenge = dleqChallenge(
    context,
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
  context: Uint8Array,
  prover: Uint8Array,
  base: Point,
  first: Point,
  second: Point,
  proof: Uint8Array,
): void {
  if (proof.length !== DLEQ_PROOF_BYTES) fail('malformed-message')
  // A zero challenge or response has negligible probability for an honest
  // prover and is rejected, which keeps every multiplier nonzero.
  const challenge = parseScalar(proof.subarray(0, SCALAR_BYTES))
  const response = parseScalar(proof.subarray(SCALAR_BYTES))
  let commitFirst: Point
  let commitSecond: Point
  try {
    commitFirst = multiply(G, response).subtract(multiply(first, challenge))
    commitSecond = multiply(base, response).subtract(
      multiply(second, challenge),
    )
    commitFirst.assertValidity()
    commitSecond.assertValidity()
  } catch {
    return fail('invalid-proof')
  }
  const expected = dleqChallenge(
    context,
    prover,
    base,
    first,
    second,
    commitFirst,
    commitSecond,
  )
  if (expected !== challenge) fail('invalid-proof')
}

/** The 20-byte EVM address of a public key. */
export function evmAddress(publicKey: Point): Uint8Array {
  const uncompressed = publicKey.toRawBytes(false)
  return keccak_256(uncompressed.subarray(1)).slice(12)
}
