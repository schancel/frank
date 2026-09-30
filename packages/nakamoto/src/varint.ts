import {
  concatBytes,
  decodeUnsignedLE,
  encodeUnsignedLE,
  isPlainBytes,
} from './bytes.js'
import type { EncodingResult } from './encoding-error.js'

// Bitcoin Core ReadCompactSize rejects a non-canonical prefix
// ("non-canonical ReadCompactSize()"). Encode always uses the shortest form.
// Values are bigint so a size above 2^53 does not round.

const UINT64_MAX = (1n << 64n) - 1n

export function encodeVarint(value: bigint): EncodingResult<Uint8Array> {
  if (value < 0n || value > UINT64_MAX) {
    return { ok: false, error: { code: 'varint-out-of-range' } }
  }
  if (value < 0xfdn) {
    return { ok: true, value: Uint8Array.of(Number(value)) }
  }
  if (value <= 0xffffn) {
    const body = encodeUnsignedLE(value, 2)
    if (!body.ok) return body
    return { ok: true, value: concatBytes([Uint8Array.of(0xfd), body.value]) }
  }
  if (value <= 0xffffffffn) {
    const body = encodeUnsignedLE(value, 4)
    if (!body.ok) return body
    return { ok: true, value: concatBytes([Uint8Array.of(0xfe), body.value]) }
  }
  const body = encodeUnsignedLE(value, 8)
  if (!body.ok) return body
  return { ok: true, value: concatBytes([Uint8Array.of(0xff), body.value]) }
}

export function decodeVarint(
  bytes: Uint8Array,
  offset = 0,
): EncodingResult<{ readonly value: bigint; readonly next: number }> {
  if (!isPlainBytes(bytes)) {
    return { ok: false, error: { code: 'bytes-expected' } }
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    return {
      ok: false,
      error: {
        code: 'varint-truncated',
        needed: 1,
        available: Math.max(0, bytes.length - Math.max(0, offset)),
      },
    }
  }
  const first = bytes[offset] ?? 0
  if (first < 0xfd) {
    return { ok: true, value: { value: BigInt(first), next: offset + 1 } }
  }
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
  const minimum =
    first === 0xfd ? 0xfdn : first === 0xfe ? 0x10000n : 0x100000000n
  const start = offset + 1
  const available = bytes.length - start
  if (available < width) {
    return {
      ok: false,
      error: { code: 'varint-truncated', needed: width, available },
    }
  }
  const value = decodeUnsignedLE(bytes.subarray(start, start + width))
  if (value < minimum) {
    return { ok: false, error: { code: 'varint-non-minimal' } }
  }
  return { ok: true, value: { value, next: start + width } }
}
