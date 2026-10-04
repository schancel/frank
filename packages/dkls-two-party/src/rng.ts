/**
 * Randomness. The package never reads an ambient random source: every random
 * byte comes through a caller-supplied function, validated and copied here.
 */
import { sha256 } from '@noble/hashes/sha256.js'

import { asciiBytes, concat, intToBytes, snapshot } from './bytes.js'
import { fail } from './result.js'

/** Must return exactly `length` fresh cryptographically secure random bytes. */
export type RandomBytes = (length: number) => Uint8Array

const MAX_DRAW = 1 << 16

/** Draws exactly `length` bytes, copying the result. Fails with `rng-failed`. */
export function draw(randomBytes: RandomBytes, length: number): Uint8Array {
  if (typeof randomBytes !== 'function') fail('rng-failed')
  if (!Number.isInteger(length) || length <= 0 || length > MAX_DRAW) {
    fail('internal-error')
  }
  let produced: unknown
  try {
    produced = randomBytes(length)
  } catch {
    fail('rng-failed')
  }
  const copied = snapshot(produced, length)
  if (copied === null) fail('rng-failed')
  return copied
}

/**
 * Deterministic byte stream for tests and test vectors: block `i` is
 * `SHA256(SHA256(domain) || seed || i)` with a 32-bit big-endian counter.
 * NOT a CSPRNG for production use.
 */
export function deterministicStream(
  domain: string,
  seed: Uint8Array,
): RandomBytes {
  const prefix = concat(sha256(asciiBytes(domain)), seed)
  let counter = 0
  let buffered: Uint8Array = new Uint8Array(0)
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      if (buffered.length === 0) {
        buffered = sha256(concat(prefix, intToBytes(counter, 4)))
        counter += 1
      }
      const take = Math.min(buffered.length, length - filled)
      out.set(buffered.subarray(0, take), filled)
      buffered = buffered.subarray(take)
      filled += take
    }
    return out
  }
}
