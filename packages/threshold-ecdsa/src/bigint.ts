/**
 * Arbitrary-precision helpers for the Paillier side of the protocol.
 *
 * SIDE CHANNELS: JavaScript `bigint` arithmetic is not constant-time and this
 * file does not pretend otherwise. `modPow` branches on exponent bits and
 * `modInverse` runs the extended Euclidean algorithm. Both are used on secret
 * values (Paillier decryption, a homomorphic multiplication by a secret
 * scalar). The threat model in the README excludes an attacker who can
 * measure this process's timing.
 */
import { bytesToInt } from './bytes.js'
import { draw, type RandomBytes } from './rng.js'
import { fail } from './result.js'

/** `base^exponent mod modulus` for `exponent >= 0`, `modulus > 1`. */
export function modPow(
  base: bigint,
  exponent: bigint,
  modulus: bigint,
): bigint {
  if (exponent < 0n || modulus <= 1n) fail('internal-error')
  let result = 1n
  let square = ((base % modulus) + modulus) % modulus
  let rest = exponent
  while (rest > 0n) {
    if (rest & 1n) result = (result * square) % modulus
    square = (square * square) % modulus
    rest >>= 1n
  }
  return result
}

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) {
    const next = a % b
    a = b
    b = next
  }
  return a
}

/** The inverse of `value` modulo `modulus`, or null if they share a factor. */
export function modInverse(value: bigint, modulus: bigint): bigint | null {
  if (modulus <= 1n) fail('internal-error')
  let r0 = modulus
  let r1 = ((value % modulus) + modulus) % modulus
  let t0 = 0n
  let t1 = 1n
  while (r1 !== 0n) {
    const quotient = r0 / r1
    const r2 = r0 - quotient * r1
    r0 = r1
    r1 = r2
    const t2 = t0 - quotient * t1
    t0 = t1
    t1 = t2
  }
  if (r0 !== 1n) return null
  return ((t0 % modulus) + modulus) % modulus
}

/** Number of bits in a non-negative public integer. */
export function bitLength(value: bigint): number {
  if (value < 0n) fail('internal-error')
  return value === 0n ? 0 : value.toString(2).length
}

/**
 * Bound below which a verifier checks a Paillier modulus for prime factors:
 * the parameter alpha of Goldberg, Reyzin, Sagga and Baldimtsi,
 * "Efficient Noninteractive Certification of RSA Moduli and Beyond"
 * (ePrint 2018/057), Section 3.2.
 */
export const SMALL_PRIME_BOUND = 6370

function sieve(bound: number): readonly bigint[] {
  const composite = new Uint8Array(bound)
  const primes: bigint[] = []
  for (let candidate = 2; candidate < bound; candidate += 1) {
    if (composite[candidate]) continue
    primes.push(BigInt(candidate))
    for (
      let multiple = candidate * candidate;
      multiple < bound;
      multiple += candidate
    ) {
      composite[multiple] = 1
    }
  }
  return primes
}

/** Every prime below `SMALL_PRIME_BOUND`. */
export const SMALL_PRIMES: readonly bigint[] = sieve(SMALL_PRIME_BOUND)

/** True if some prime below `SMALL_PRIME_BOUND` divides `value`. */
export function hasSmallPrimeFactor(value: bigint): boolean {
  for (const prime of SMALL_PRIMES) {
    if (value % prime === 0n) return true
  }
  return false
}

const MILLER_RABIN_ROUNDS = 40

/**
 * Miller-Rabin with `MILLER_RABIN_ROUNDS` random bases drawn from `rng`
 * (error at most 4^-40 for any composite), after trial division by every
 * prime below `SMALL_PRIME_BOUND`. `candidate` must be odd and larger than
 * `SMALL_PRIME_BOUND^2`.
 */
export function isProbablePrime(candidate: bigint, rng: RandomBytes): boolean {
  if (candidate < BigInt(SMALL_PRIME_BOUND * SMALL_PRIME_BOUND)) {
    fail('internal-error')
  }
  if ((candidate & 1n) === 0n || hasSmallPrimeFactor(candidate)) return false
  const minusOne = candidate - 1n
  let odd = minusOne
  let twos = 0
  while ((odd & 1n) === 0n) {
    odd >>= 1n
    twos += 1
  }
  const width = Math.ceil(bitLength(candidate) / 8)
  for (let round = 0; round < MILLER_RABIN_ROUNDS; round += 1) {
    // Base in [2, candidate - 2], within 2^-128 of uniform.
    const base = 2n + (bytesToInt(draw(rng, width + 16)) % (candidate - 3n))
    let power = modPow(base, odd, candidate)
    if (power === 1n || power === minusOne) continue
    let witness = true
    for (let step = 1; step < twos; step += 1) {
      power = (power * power) % candidate
      if (power === minusOne) {
        witness = false
        break
      }
    }
    if (witness) return false
  }
  return true
}

/**
 * A random prime of exactly `bits` bits with its two top bits set, so the
 * product of two such primes has exactly `2 * bits` bits. Each candidate is
 * `bits / 8` fresh bytes from `rng` with the two top bits and the low bit
 * forced to one; composite candidates are discarded, not incremented, so the
 * procedure is a deterministic function of the `rng` stream.
 */
export function generatePrime(bits: number, rng: RandomBytes): bigint {
  if (bits % 8 !== 0 || bits < 512) fail('internal-error')
  for (let attempt = 0; attempt < 100000; attempt += 1) {
    const bytes = draw(rng, bits / 8)
    bytes[0] = (bytes[0] ?? 0) | 0xc0
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) | 0x01
    const candidate = bytesToInt(bytes)
    bytes.fill(0)
    if (isProbablePrime(candidate, rng)) return candidate
  }
  return fail('rng-failed')
}
