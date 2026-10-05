/**
 * Randomness. The package never reads an ambient random source: every random
 * byte comes through a caller-supplied function, validated and copied here.
 */
import { sha256 } from '@noble/hashes/sha256.js'

import {
  bytesToInt,
  concat,
  intToBytes,
  snapshot,
  asciiBytes,
} from './bytes.js'
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

function byteLength(value: bigint): number {
  let length = 0
  let rest = value
  while (rest > 0n) {
    length += 1
    rest >>= 8n
  }
  return length
}

/**
 * A value in `[0, bound)`. Draws 16 bytes more than the bound needs and
 * reduces, so the result is within 2^-128 of uniform without a
 * data-dependent retry loop. `bound` is always public.
 */
export function drawBelow(randomBytes: RandomBytes, bound: bigint): bigint {
  if (bound <= 0n) fail('internal-error')
  const wide = draw(randomBytes, byteLength(bound) + 16)
  const value = bytesToInt(wide) % bound
  wide.fill(0)
  return value
}

/** A value in `[low, high)`. */
export function drawInRange(
  randomBytes: RandomBytes,
  low: bigint,
  high: bigint,
): bigint {
  return low + drawBelow(randomBytes, high - low)
}

/**
 * Deterministic byte stream: block `i` is `SHA256(domain || seed || i)` with
 * a 32-bit big-endian counter starting at 0, and calls consume the stream in
 * order. Used to re-derive a party's Paillier primes from a seed and by the
 * test vectors as a reproducible stand-in for a CSPRNG.
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
        if (counter > 0xffffffff) fail('internal-error')
        buffered = sha256(concat(prefix, intToBytes(BigInt(counter), 4)))
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
