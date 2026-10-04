/**
 * The two Paillier proofs of key generation.
 *
 * 1. Modulus proof: `gcd(N, phi(N)) = 1`, so Paillier encryption under N is a
 *    bijection and every ciphertext has exactly one plaintext.
 * 2. Range proof: a ciphertext encrypts a value in a short interval.
 *
 * The third key-generation proof (the ciphertext encrypts the discrete log of
 * a given point) is interactive and lives in `keygen.ts`.
 */
import { bytesToInt, concat, equalBytes, intToBytes, Reader } from './bytes.js'
import { hasSmallPrimeFactor, modInverse, modPow } from './bigint.js'
import { HASH_BYTES, SHARE_HIGH, SHARE_LOW, transcript } from './group.js'
import {
  ciphertextBytes,
  drawUnit,
  encrypt,
  encryptAsOwner,
  MODULUS_BYTES,
  modulusBytes,
  parseUnit,
  unitBytes,
  type PaillierPublicKey,
  type PaillierSecretKey,
} from './paillier.js'
import { draw, drawInRange, type RandomBytes } from './rng.js'
import { fail } from './result.js'

// --- Modulus proof ---------------------------------------------------------
//
// CITATION UNVERIFIED: the section number and parameters below were written
// from memory and have not been confirmed against the paper.
//
// Goldberg, Reyzin, Sagga, Baldimtsi, "Efficient Noninteractive Certification
// of RSA Moduli and Beyond" (ASIACRYPT 2019, ePrint 2018/057), Section 3.2,
// the protocol for the relation "Paillier-N": the prover shows that
// pseudorandom elements rho_i of Z_N^* all have N-th roots modulo N. If
// gcd(N, phi(N)) != 1, raising to the N-th power is not a permutation of
// Z_N^* and, once N has no prime factor below alpha, each rho_i has a root
// with probability at most 1/alpha. With alpha = 6370 and
// m = ceil(128 / log2(alpha)) = 11 the soundness error is below 2^-128.
//
// This is the proof Lindell 2017 calls for in Protocol 3.1 step 3 (the
// language L_P of valid Paillier keys). It does NOT show that N is a product
// of exactly two primes; the protocol does not need that (README, "Why this
// is enough").

export const MODULUS_PROOF_ROUNDS = 11
export const MODULUS_PROOF_BYTES = MODULUS_PROOF_ROUNDS * MODULUS_BYTES

/**
 * The i-th challenge: 272 hash-derived bytes reduced mod N (within 2^-128 of
 * uniform), re-derived with the next attempt number in the negligible case
 * that it is zero or shares a factor with N.
 */
function modulusChallenge(
  session: Uint8Array,
  prover: Uint8Array,
  key: PaillierPublicKey,
  index: number,
): bigint {
  const modulus = modulusBytes(key)
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const blocks: Uint8Array[] = []
    for (let block = 0; block < 9; block += 1) {
      blocks.push(
        transcript(
          'proof/paillier-n',
          session,
          prover,
          modulus,
          intToBytes(BigInt(index), 4),
          intToBytes(BigInt(attempt), 4),
          intToBytes(BigInt(block), 4),
        ),
      )
    }
    const wide = concat(...blocks).subarray(0, MODULUS_BYTES + 16)
    const value = bytesToInt(wide) % key.n
    if (value !== 0n && modInverse(value, key.n) !== null) return value
  }
  return fail('invalid-paillier')
}

export function proveModulus(
  session: Uint8Array,
  prover: Uint8Array,
  key: PaillierSecretKey,
): Uint8Array {
  const rootExponent = modInverse(key.n, key.phi)
  if (rootExponent === null) fail('invalid-paillier')
  const roots: Uint8Array[] = []
  for (let index = 0; index < MODULUS_PROOF_ROUNDS; index += 1) {
    const challenge = modulusChallenge(session, prover, key, index)
    roots.push(unitBytes(modPow(challenge, rootExponent, key.n)))
  }
  return concat(...roots)
}

/**
 * Verifier of the modulus proof. `key` has already passed `parseModulus`
 * (exactly 2048 bits, odd).
 */
export function requireModulusProof(
  session: Uint8Array,
  prover: Uint8Array,
  key: PaillierPublicKey,
  proof: Uint8Array,
): void {
  if (proof.length !== MODULUS_PROOF_BYTES) fail('malformed-message')
  if (hasSmallPrimeFactor(key.n)) fail('invalid-paillier')
  const reader = new Reader(proof)
  for (let index = 0; index < MODULUS_PROOF_ROUNDS; index += 1) {
    const root = parseUnit(key, reader.take(MODULUS_BYTES))
    const challenge = modulusChallenge(session, prover, key, index)
    if (modPow(root, key.n, key.n) !== challenge) fail('invalid-proof')
  }
  reader.finish()
}

// --- Range proof -----------------------------------------------------------
//
// Lindell 2017 (ePrint 2017/552), Appendix A, "Range proof": a cut-and-choose
// proof, with slack 3, that a Paillier ciphertext c = Enc(x'; r) has
// x' in [0, l) for l = floor(n / 3), where n is the curve order. What it
// actually proves is x' in (-l, 2l). Key generation applies it to
// c_key - Enc(l), so an honest share x in [l, 2l) is accepted and any accepted
// c_key encrypts a value in (0, 3l), a subset of [0, n).
//
//   Commit:    for each round i, pick u in [l, 2l), set v = u - l, and let
//              (c1, c2) be encryptions of (u, v) in a random order.
//   Challenge: one bit per round.
//   Respond:   bit 0: open both ciphertexts.
//              bit 1: open c + c_j for the j with x' + w_j in [l, 2l).
//   Verify:    bit 0: both openings are right, one plaintext is in [l, 2l)
//              and the other in [0, l).
//              bit 1: the opening is right and its plaintext is in [l, 2l).
//
// A prover whose x' is outside (-l, 2l) can answer at most one of the two
// challenges per round, so cheating succeeds with probability 2^-ROUNDS.
//
// Two things differ from the text of the paper, neither changing the proof:
//
//  - ROUNDS is 80, not 40.
//  - The prover does not send the 2 * ROUNDS ciphertexts (82 KB). It sends
//    one hash over a per-ciphertext hash ("leaf") of each. The verifier
//    recomputes every leaf it can from the response (both leaves of a bit-0
//    round; for a bit-1 round the leaf of c_j = Enc(sum; r) - c), takes the
//    one remaining leaf of a bit-1 round from the response, and compares the
//    hash. By collision resistance the prover is bound to all ciphertexts
//    before it sees the challenge, exactly as if it had sent them.
//
// The proof is interactive: the verifier commits to its challenge before the
// prover's commitment is sent (keygen.ts), which gives soundness 2^-80 per
// key-generation attempt and zero knowledge against a malicious verifier.

export const RANGE_ROUNDS = 80
export const RANGE_CHALLENGE_BYTES = RANGE_ROUNDS / 8
export const RANGE_COMMIT_BYTES = HASH_BYTES
const VALUE_BYTES = 32
const RANGE_SECRET_ROUND_BYTES =
  2 * VALUE_BYTES + 2 * MODULUS_BYTES + 2 * HASH_BYTES
const OPEN_BOTH_BYTES = 1 + 2 * VALUE_BYTES + 2 * MODULUS_BYTES
const OPEN_SUM_BYTES = 1 + VALUE_BYTES + MODULUS_BYTES + HASH_BYTES
/** Largest possible response: every round opens both ciphertexts. */
export const RANGE_RESPONSE_MAX_BYTES = RANGE_ROUNDS * OPEN_BOTH_BYTES
/** Smallest possible response: every round opens one sum. */
export const RANGE_RESPONSE_MIN_BYTES = RANGE_ROUNDS * OPEN_SUM_BYTES

export interface RangeCommitment {
  /** Hash over all ciphertext leaves, sent to the verifier. */
  readonly wire: Uint8Array
  /** Per round `w1 || w2 || r1 || r2 || leaf1 || leaf2`. Secret. */
  readonly secret: Uint8Array
}

function challengeBit(challenge: Uint8Array, round: number): number {
  return ((challenge[round >> 3] ?? 0) >> (round & 7)) & 1
}

function leaf(ciphertext: bigint): Uint8Array {
  return transcript('proof/range/leaf', ciphertextBytes(ciphertext))
}

function commitmentDigest(leaves: readonly Uint8Array[]): Uint8Array {
  return transcript('proof/range/commit', ...leaves)
}

/** The prover's first message. Uses the key owner's fast encryption. */
export function rangeCommit(
  key: PaillierSecretKey,
  rng: RandomBytes,
): RangeCommitment {
  const leaves: Uint8Array[] = []
  const secret: Uint8Array[] = []
  for (let round = 0; round < RANGE_ROUNDS; round += 1) {
    const upper = drawInRange(rng, SHARE_LOW, SHARE_HIGH)
    const lower = upper - SHARE_LOW
    const swap = ((draw(rng, 1)[0] ?? 0) & 1) === 1
    const w1 = swap ? lower : upper
    const w2 = swap ? upper : lower
    const r1 = drawUnit(key, rng)
    const r2 = drawUnit(key, rng)
    const leaf1 = leaf(encryptAsOwner(key, w1, r1))
    const leaf2 = leaf(encryptAsOwner(key, w2, r2))
    leaves.push(leaf1, leaf2)
    secret.push(
      intToBytes(w1, VALUE_BYTES),
      intToBytes(w2, VALUE_BYTES),
      unitBytes(r1),
      unitBytes(r2),
      leaf1,
      leaf2,
    )
  }
  return { wire: commitmentDigest(leaves), secret: concat(...secret) }
}

/**
 * Prover's response. `witness` is the plaintext x' in [0, l) of the
 * statement ciphertext and `witnessRandomness` its encryption randomness.
 */
export function rangeRespond(
  key: PaillierPublicKey,
  commitmentSecret: Uint8Array,
  witness: bigint,
  witnessRandomness: bigint,
  challenge: Uint8Array,
): Uint8Array {
  if (
    commitmentSecret.length !== RANGE_ROUNDS * RANGE_SECRET_ROUND_BYTES ||
    challenge.length !== RANGE_CHALLENGE_BYTES ||
    witness < 0n ||
    witness >= SHARE_LOW
  ) {
    fail('internal-error')
  }
  const reader = new Reader(commitmentSecret)
  const out: Uint8Array[] = []
  for (let round = 0; round < RANGE_ROUNDS; round += 1) {
    const w1 = reader.take(VALUE_BYTES)
    const w2 = reader.take(VALUE_BYTES)
    const r1 = reader.take(MODULUS_BYTES)
    const r2 = reader.take(MODULUS_BYTES)
    const leaf1 = reader.take(HASH_BYTES)
    const leaf2 = reader.take(HASH_BYTES)
    if (challengeBit(challenge, round) === 0) {
      out.push(Uint8Array.of(0), w1, w2, r1, r2)
      continue
    }
    // Exactly one of the two masks keeps the sum inside [l, 2l).
    const sum1 = witness + bytesToInt(w1)
    const firstFits = sum1 >= SHARE_LOW && sum1 < SHARE_HIGH
    const sum = firstFits ? sum1 : witness + bytesToInt(w2)
    if (sum < SHARE_LOW || sum >= SHARE_HIGH) fail('internal-error')
    const randomness =
      (witnessRandomness * bytesToInt(firstFits ? r1 : r2)) % key.n
    out.push(
      Uint8Array.of(firstFits ? 1 : 2),
      intToBytes(sum, VALUE_BYTES),
      unitBytes(randomness),
      firstFits ? leaf2 : leaf1,
    )
    w1.fill(0)
    w2.fill(0)
    r1.fill(0)
    r2.fill(0)
  }
  reader.finish()
  return concat(...out)
}

function inUpper(value: bigint): boolean {
  return value >= SHARE_LOW && value < SHARE_HIGH
}

function inLower(value: bigint): boolean {
  return value >= 0n && value < SHARE_LOW
}

/**
 * Verifier. `statement` is the validated ciphertext being proven (already
 * shifted by the caller), `commitment` the prover's first message and
 * `challenge` the verifier's own challenge. `response` must be consumed
 * exactly.
 */
export function requireRangeProof(
  key: PaillierPublicKey,
  statement: bigint,
  commitment: Uint8Array,
  challenge: Uint8Array,
  response: Uint8Array,
): void {
  if (challenge.length !== RANGE_CHALLENGE_BYTES) fail('internal-error')
  if (commitment.length !== RANGE_COMMIT_BYTES) fail('malformed-message')
  const statementInverse = modInverse(statement, key.nn)
  if (statementInverse === null) fail('invalid-paillier')
  const reader = new Reader(response)
  const leaves: Uint8Array[] = []
  for (let round = 0; round < RANGE_ROUNDS; round += 1) {
    const kind = reader.byte()
    if (challengeBit(challenge, round) === 0) {
      if (kind !== 0) fail('invalid-proof')
      const w1 = bytesToInt(reader.take(VALUE_BYTES))
      const w2 = bytesToInt(reader.take(VALUE_BYTES))
      const r1 = parseUnit(key, reader.take(MODULUS_BYTES))
      const r2 = parseUnit(key, reader.take(MODULUS_BYTES))
      const ordered =
        (inUpper(w1) && inLower(w2)) || (inLower(w1) && inUpper(w2))
      if (!ordered) fail('invalid-proof')
      leaves.push(leaf(encrypt(key, w1, r1)), leaf(encrypt(key, w2, r2)))
    } else {
      if (kind !== 1 && kind !== 2) fail('invalid-proof')
      const sum = bytesToInt(reader.take(VALUE_BYTES))
      const randomness = parseUnit(key, reader.take(MODULUS_BYTES))
      const otherLeaf = reader.take(HASH_BYTES)
      if (!inUpper(sum)) fail('invalid-proof')
      // statement + c_j = Enc(sum; randomness), so c_j is determined.
      const opened = leaf(
        (encrypt(key, sum, randomness) * statementInverse) % key.nn,
      )
      if (kind === 1) leaves.push(opened, otherLeaf)
      else leaves.push(otherLeaf, opened)
    }
  }
  reader.finish()
  if (!equalBytes(commitmentDigest(leaves), commitment)) fail('invalid-proof')
}
