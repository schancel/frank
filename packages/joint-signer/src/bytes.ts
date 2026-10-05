/** Byte helpers and the EVM view of a public key. */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { fail } from './result.js'
import type { RandomBytes } from './types.js'

/** Copies a caller-supplied byte array of an exact length, or returns null. */
export function snapshot(value: unknown, length?: number): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null
  if (length !== undefined && value.length !== length) return null
  return Uint8Array.from(value)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}

export function uint32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  )
}

/** SHA-256 over a tag and length-prefixed fields: no two field lists collide. */
export function transcriptHash(
  tag: string,
  ...fields: Uint8Array[]
): Uint8Array {
  const parts: Uint8Array[] = [sha256(ascii(tag))]
  for (const field of fields) parts.push(uint32(field.length), field)
  return sha256(concat(...parts))
}

/** Draws exactly `length` bytes from the caller's CSPRNG, copying the result. */
export function draw(randomBytes: RandomBytes, length: number): Uint8Array {
  if (typeof randomBytes !== 'function') fail('rng-failed')
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

/** Sequential reader over length-prefixed fields. Returns null past the end. */
export class Reader {
  private offset = 0
  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array | null {
    if (length < 0 || this.offset + length > this.bytes.length) return null
    const out = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  byte(): number | null {
    const out = this.take(1)
    return out === null ? null : out[0] ?? null
  }

  uint32(): number | null {
    const out = this.take(4)
    if (out === null) return null
    return (
      ((out[0] ?? 0) * 0x1000000 +
        ((out[1] ?? 0) << 16) +
        ((out[2] ?? 0) << 8) +
        (out[3] ?? 0)) >>>
      0
    )
  }

  field(maxLength: number): Uint8Array | null {
    const length = this.uint32()
    if (length === null || length > maxLength) return null
    return this.take(length)
  }

  get finished(): boolean {
    return this.offset === this.bytes.length
  }
}

export function field(bytes: Uint8Array): Uint8Array {
  return concat(uint32(bytes.length), bytes)
}

/** The 20-byte EVM address of a 33-byte compressed public key, or null. */
export function evmAddress(publicKey: Uint8Array): Uint8Array | null {
  try {
    const point = secp256k1.ProjectivePoint.fromHex(publicKey)
    return keccak_256(point.toRawBytes(false).subarray(1)).slice(12)
  } catch {
    return null
  }
}

const HALF_ORDER = secp256k1.CURVE.n >> 1n

/**
 * The yParity under which `signature` (r || s) recovers `publicKey` for
 * `digest`, or null when it is not a low-s signature of that key.
 */
export function recoveryBit(
  publicKey: Uint8Array,
  digest: Uint8Array,
  signature: Uint8Array,
): 0 | 1 | null {
  try {
    const parsed = secp256k1.Signature.fromCompact(signature)
    if (parsed.s > HALF_ORDER) return null
    for (const bit of [0, 1] as const) {
      let recovered: Uint8Array
      try {
        recovered = parsed
          .addRecoveryBit(bit)
          .recoverPublicKey(digest)
          .toRawBytes(true)
      } catch {
        continue
      }
      if (equalBytes(recovered, publicKey)) return bit
    }
    return null
  } catch {
    return null
  }
}
