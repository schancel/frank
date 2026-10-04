/**
 * Byte helpers: defensive copies, fixed-width integers, a strict reader and a
 * few bit-vector operations. Nothing here interprets cryptographic meaning.
 */
import { fail } from './result.js'

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
)?.get
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get
const UINT8_ARRAY_SET = Uint8Array.prototype.set

/**
 * Copies a caller-supplied value if and only if it is a real `Uint8Array`
 * whose length lies in `[minLength, maxLength]`; null otherwise. Uses the
 * intrinsic getters so a subclass or proxy cannot lie about its length.
 */
export function snapshotBounded(
  bytes: unknown,
  minLength: number,
  maxLength: number,
): Uint8Array | null {
  try {
    if (
      typeof TYPED_ARRAY_LENGTH_GETTER !== 'function' ||
      typeof TYPED_ARRAY_TAG_GETTER !== 'function' ||
      Reflect.apply(TYPED_ARRAY_TAG_GETTER, bytes, []) !== 'Uint8Array'
    ) {
      return null
    }
    const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
    if (
      typeof length !== 'number' ||
      length < minLength ||
      length > maxLength
    ) {
      return null
    }
    const copied = new Uint8Array(length)
    Reflect.apply(UINT8_ARRAY_SET, copied, [bytes])
    return copied
  } catch {
    return null
  }
}

export function snapshot(bytes: unknown, length: number): Uint8Array | null {
  return snapshotBounded(bytes, length, length)
}

/** Comparison whose running time depends only on the lengths. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let index = 0; index < left.length; index += 1) {
    different |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return different === 0
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Big-endian bytes to a non-negative integer. */
export function bytesToInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0)
  }
  return value
}

/** A non-negative integer to exactly `length` big-endian bytes. */
export function intToBytes(value: bigint | number, length: number): Uint8Array {
  let rest = BigInt(value)
  if (rest < 0n) fail('internal-error')
  const out = new Uint8Array(length)
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest !== 0n) fail('internal-error')
  return out
}

export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code > 0x7f) fail('internal-error')
    out[index] = code
  }
  return out
}

export function wipe(
  ...buffers: readonly (Uint8Array | null | undefined)[]
): void {
  for (const buffer of buffers) buffer?.fill(0)
}

/** `left XOR right`, equal lengths. */
export function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== right.length) fail('internal-error')
  const out = new Uint8Array(left.length)
  for (let index = 0; index < left.length; index += 1) {
    out[index] = (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return out
}

/** Bit `index` of a bit vector stored least-significant-bit first per byte. */
export function bit(vector: Uint8Array, index: number): number {
  return ((vector[index >> 3] ?? 0) >> (index & 7)) & 1
}

/**
 * Sequential reader over an owned buffer. Every read is bounds-checked and
 * `finish` rejects trailing bytes, so a message has exactly one encoding.
 */
export class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      fail('malformed-message')
    }
    const out = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  byte(): number {
    return this.take(1)[0] ?? 0
  }

  /** A 4-byte big-endian length followed by that many bytes, at most `max`. */
  variable(max: number): Uint8Array {
    const length = Number(bytesToInt(this.take(4)))
    if (length > max) fail('malformed-message')
    return this.take(length)
  }

  remaining(): number {
    return this.bytes.length - this.offset
  }

  finish(): void {
    if (this.offset !== this.bytes.length) fail('malformed-message')
  }
}

/** `len (4) || bytes`, the inverse of `Reader.variable`. */
export function variable(bytes: Uint8Array): Uint8Array {
  return concat(intToBytes(bytes.length, 4), bytes)
}
