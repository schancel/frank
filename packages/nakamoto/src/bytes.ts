import { EncodingException, type EncodingResult } from './encoding-error.js'
import { bigintToBytes, bytesToBigint } from './integer.js'

/** A real Uint8Array, not a subclass. Subclasses are a different byte type. */
export function isPlainBytes(value: unknown): value is Uint8Array {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { constructor?: unknown }).constructor === Uint8Array
  )
}

export function copyBytes(value: Uint8Array): Uint8Array {
  if (!isPlainBytes(value)) {
    throw new EncodingException({ code: 'bytes-expected' })
  }
  return new Uint8Array(value)
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = bytes[bytes.length - 1 - index] ?? 0
  }
  return out
}

export function encodeUnsignedBE(
  value: bigint,
  length: number,
): EncodingResult<Uint8Array> {
  if (value < 0n) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  const encoded = bigintToBytes(value, length)
  if (!encoded.ok) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return encoded
}

export function encodeUnsignedLE(
  value: bigint,
  length: number,
): EncodingResult<Uint8Array> {
  const encoded = encodeUnsignedBE(value, length)
  if (!encoded.ok) return encoded
  return { ok: true, value: reverseBytes(encoded.value) }
}

export function decodeUnsignedBE(bytes: Uint8Array): bigint {
  return bytesToBigint(bytes)
}

export function decodeUnsignedLE(bytes: Uint8Array): bigint {
  return bytesToBigint(reverseBytes(bytes))
}

export function encodeNumberLE(
  value: number,
  length: number,
  max: number,
): EncodingResult<Uint8Array> {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return encodeUnsignedLE(BigInt(value), length)
}

export function encodeNumberBE(
  value: number,
  length: number,
  max: number,
): EncodingResult<Uint8Array> {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return encodeUnsignedBE(BigInt(value), length)
}
