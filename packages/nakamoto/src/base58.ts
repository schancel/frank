import { bigintToBytes, bytesToBigint } from './integer.js'
import { copyBytes } from './bytes.js'
import type { EncodingResult } from './encoding-error.js'

/** Bitcoin base58 alphabet. Zero, O, I, and l are absent. */
export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const DIGIT = new Int16Array(128).fill(-1)
for (let index = 0; index < BASE58_ALPHABET.length; index += 1) {
  DIGIT[BASE58_ALPHABET.charCodeAt(index)] = index
}

function unsignedByteLength(value: bigint): number {
  let length = 0
  let rest = value
  while (rest > 0n) {
    rest >>= 8n
    length += 1
  }
  return length
}

/** Leading zero bytes become leading `1` characters. */
export function encodeBase58(bytes: Uint8Array): string {
  const payload = copyBytes(bytes)
  let zeros = 0
  while (zeros < payload.length && payload[zeros] === 0) zeros += 1
  let value = bytesToBigint(payload.subarray(zeros))
  const digits: number[] = []
  while (value > 0n) {
    digits.push(Number(value % 58n))
    value /= 58n
  }
  let out = '1'.repeat(zeros)
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    out += BASE58_ALPHABET.charAt(digits[index] ?? 0)
  }
  return out
}

export function decodeBase58(text: string): EncodingResult<Uint8Array> {
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'base58-invalid-type' } }
  }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros += 1
  let value = 0n
  for (let index = zeros; index < text.length; index += 1) {
    const char = text.charAt(index)
    const code = text.charCodeAt(index)
    const digit = code < 128 ? DIGIT[code] ?? -1 : -1
    if (digit < 0) {
      return {
        ok: false,
        error: { code: 'base58-invalid-char', index, char },
      }
    }
    value = value * 58n + BigInt(digit)
  }
  if (value === 0n) {
    return { ok: true, value: new Uint8Array(zeros) }
  }
  const body = bigintToBytes(value, unsignedByteLength(value))
  if (!body.ok) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  const out = new Uint8Array(zeros + body.value.length)
  out.set(body.value, zeros)
  return { ok: true, value: out }
}
