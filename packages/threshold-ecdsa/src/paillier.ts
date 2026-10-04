/**
 * Paillier encryption with generator `g = 1 + N`, as used by Lindell,
 * "Fast Secure Two-Party ECDSA Signing" (CRYPTO 2017, ePrint 2017/552),
 * Section 2.3 ("Paillier encryption").
 *
 *   Enc_N(m; r) = (1 + N)^m * r^N mod N^2 = (1 + m*N) * r^N mod N^2
 *   Dec(c)      = L(c^phi mod N^2) * phi^-1 mod N,   L(u) = (u - 1) / N
 *
 * The scheme is an additively homomorphic bijection
 * `Z_N x Z_N^* -> Z_{N^2}^*` exactly when `gcd(N, phi(N)) = 1`; the proof in
 * `paillier-proofs.ts` convinces the other party of that.
 *
 * Wire widths are fixed: a modulus is 256 bytes, an element of Z_N is 256
 * bytes, a ciphertext is 512 bytes, all big-endian.
 */
import { bytesToInt, intToBytes } from './bytes.js'
import { gcd, generatePrime, modInverse, modPow, bitLength } from './bigint.js'
import { drawBelow, type RandomBytes } from './rng.js'
import { fail } from './result.js'

export const PAILLIER_MODULUS_BITS = 2048
export const PAILLIER_PRIME_BITS = PAILLIER_MODULUS_BITS / 2
export const MODULUS_BYTES = PAILLIER_MODULUS_BITS / 8
export const PRIME_BYTES = PAILLIER_PRIME_BITS / 8
export const CIPHERTEXT_BYTES = 2 * MODULUS_BYTES

export interface PaillierPublicKey {
  readonly n: bigint
  /** `n * n`. */
  readonly nn: bigint
}

export interface PaillierSecretKey extends PaillierPublicKey {
  readonly p: bigint
  readonly q: bigint
  /** `(p - 1) * (q - 1)`. */
  readonly phi: bigint
  /** `phi^-1 mod n`. */
  readonly phiInverse: bigint
  /** `p * p` and `q * q`, for the key owner's faster encryption. */
  readonly pp: bigint
  readonly qq: bigint
  /** `(p * p)^-1 mod q * q`. */
  readonly ppInverse: bigint
}

export function paillierPublicKey(n: bigint): PaillierPublicKey {
  return { n, nn: n * n }
}

/**
 * Builds a secret key from two primes, checking everything that can be
 * checked without re-running primality tests: distinct, both exactly
 * `PAILLIER_PRIME_BITS` bits with the two top bits set, odd, and
 * `gcd(N, phi(N)) = 1`.
 */
export function paillierSecretKey(p: bigint, q: bigint): PaillierSecretKey {
  const top = 3n << BigInt(PAILLIER_PRIME_BITS - 2)
  if (
    p === q ||
    (p & 1n) === 0n ||
    (q & 1n) === 0n ||
    bitLength(p) !== PAILLIER_PRIME_BITS ||
    bitLength(q) !== PAILLIER_PRIME_BITS ||
    (p & top) !== top ||
    (q & top) !== top
  ) {
    fail('invalid-paillier')
  }
  const n = p * q
  const phi = (p - 1n) * (q - 1n)
  const phiInverse = modInverse(phi, n)
  const pp = p * p
  const qq = q * q
  const ppInverse = modInverse(pp, qq)
  if (
    bitLength(n) !== PAILLIER_MODULUS_BITS ||
    phiInverse === null ||
    ppInverse === null
  ) {
    fail('invalid-paillier')
  }
  return { n, nn: n * n, p, q, phi, phiInverse, pp, qq, ppInverse }
}

/**
 * Generates a key from two random 1024-bit primes drawn from `rng`. The
 * result is a deterministic function of the `rng` byte stream.
 */
export function generatePaillierKey(rng: RandomBytes): PaillierSecretKey {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const p = generatePrime(PAILLIER_PRIME_BITS, rng)
    const q = generatePrime(PAILLIER_PRIME_BITS, rng)
    if (p === q) continue
    // Two distinct primes of equal bit length always satisfy
    // gcd(N, phi(N)) = 1; paillierSecretKey re-checks it regardless.
    return paillierSecretKey(p, q)
  }
  return fail('rng-failed')
}

/** A uniformly random element of Z_N^*. */
export function drawUnit(key: PaillierPublicKey, rng: RandomBytes): bigint {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = drawBelow(rng, key.n)
    if (candidate !== 0n && gcd(candidate, key.n) === 1n) return candidate
  }
  return fail('rng-failed')
}

/** `Enc_N(message; randomness)` for `0 <= message < N`, `randomness` in Z_N^*. */
export function encrypt(
  key: PaillierPublicKey,
  message: bigint,
  randomness: bigint,
): bigint {
  if (message < 0n || message >= key.n) fail('internal-error')
  if (randomness <= 0n || randomness >= key.n) fail('internal-error')
  const mask = modPow(randomness, key.n, key.nn)
  return ((1n + message * key.n) * mask) % key.nn
}

/**
 * The same value as `encrypt`, computed by the key owner with the Chinese
 * remainder theorem: `randomness^N` is raised separately modulo `p^2` and
 * `q^2` (with the exponent reduced modulo the group orders `p(p-1)` and
 * `q(q-1)`) and recombined. About twice as fast; used only for the owner's
 * own encryptions in key generation.
 */
export function encryptAsOwner(
  key: PaillierSecretKey,
  message: bigint,
  randomness: bigint,
): bigint {
  if (message < 0n || message >= key.n) fail('internal-error')
  if (randomness <= 0n || randomness >= key.n) fail('internal-error')
  const maskP = modPow(randomness, key.n % (key.p * (key.p - 1n)), key.pp)
  const maskQ = modPow(randomness, key.n % (key.q * (key.q - 1n)), key.qq)
  const lift = ((((maskQ - maskP) * key.ppInverse) % key.qq) + key.qq) % key.qq
  const mask = maskP + key.pp * lift
  return ((1n + message * key.n) * mask) % key.nn
}

/** The plaintext in `[0, N)` of a validated ciphertext. */
export function decrypt(key: PaillierSecretKey, ciphertext: bigint): bigint {
  const u = modPow(ciphertext, key.phi, key.nn)
  // For a valid ciphertext u = 1 mod N. Anything else means the ciphertext
  // was not in Z_{N^2}^*, which parsing already excludes.
  if ((u - 1n) % key.n !== 0n) fail('invalid-paillier')
  return (((u - 1n) / key.n) * key.phiInverse) % key.n
}

/** Homomorphic addition of plaintexts. */
export function addCiphertexts(
  key: PaillierPublicKey,
  left: bigint,
  right: bigint,
): bigint {
  return (left * right) % key.nn
}

/** Homomorphic multiplication of the plaintext by `scalar >= 0`. */
export function scaleCiphertext(
  key: PaillierPublicKey,
  ciphertext: bigint,
  scalar: bigint,
): bigint {
  return modPow(ciphertext, scalar, key.nn)
}

/**
 * Homomorphic addition of the public constant `-value` for `0 <= value < N`,
 * with randomness 1: multiplies by `(1 + N)^-value = 1 - value*N mod N^2`.
 */
export function subtractConstant(
  key: PaillierPublicKey,
  ciphertext: bigint,
  value: bigint,
): bigint {
  if (value < 0n || value >= key.n) fail('internal-error')
  const factor = (((1n - value * key.n) % key.nn) + key.nn) % key.nn
  return (ciphertext * factor) % key.nn
}

// --- Strict wire parsing ---------------------------------------------------

/**
 * Parses a peer's modulus: exactly 256 bytes, exactly 2048 bits (top bit
 * set), odd. The small-factor and gcd(N, phi(N)) = 1 checks belong to the
 * modulus proof in `paillier-proofs.ts`.
 */
export function parseModulus(bytes: Uint8Array): PaillierPublicKey {
  if (bytes.length !== MODULUS_BYTES) fail('malformed-message')
  const n = bytesToInt(bytes)
  if (bitLength(n) !== PAILLIER_MODULUS_BITS || (n & 1n) === 0n) {
    fail('invalid-paillier')
  }
  return paillierPublicKey(n)
}

/** Parses an element of Z_N^*: 256 bytes, `0 < value < N`, coprime to N. */
export function parseUnit(key: PaillierPublicKey, bytes: Uint8Array): bigint {
  if (bytes.length !== MODULUS_BYTES) fail('malformed-message')
  const value = bytesToInt(bytes)
  if (value <= 0n || value >= key.n || gcd(value, key.n) !== 1n) {
    fail('invalid-paillier')
  }
  return value
}

/**
 * Parses a ciphertext: 512 bytes, `0 < c < N^2`, coprime to N (so it lies in
 * Z_{N^2}^* and has a unique decryption).
 */
export function parseCiphertext(
  key: PaillierPublicKey,
  bytes: Uint8Array,
): bigint {
  if (bytes.length !== CIPHERTEXT_BYTES) fail('malformed-message')
  const value = bytesToInt(bytes)
  if (value <= 0n || value >= key.nn || gcd(value, key.n) !== 1n) {
    fail('invalid-paillier')
  }
  return value
}

export function modulusBytes(key: PaillierPublicKey): Uint8Array {
  return intToBytes(key.n, MODULUS_BYTES)
}

export function unitBytes(value: bigint): Uint8Array {
  return intToBytes(value, MODULUS_BYTES)
}

export function ciphertextBytes(value: bigint): Uint8Array {
  return intToBytes(value, CIPHERTEXT_BYTES)
}
