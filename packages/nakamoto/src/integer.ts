// Native bigint helpers. `mod` returns the non-negative remainder.
// Fixed-width conversion is unsigned big-endian.

export interface ModulusNotPositive {
  readonly code: 'modulus-not-positive'
}

export interface IntegerOutOfRange {
  readonly code: 'integer-out-of-range'
}

export type IntegerError = ModulusNotPositive | IntegerOutOfRange

export type IntegerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IntegerError }

export function isIntegerError(value: unknown): value is IntegerError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return code === 'modulus-not-positive' || code === 'integer-out-of-range'
}

/** Non-negative remainder of `value` modulo `modulus`. */
export function mod(value: bigint, modulus: bigint): IntegerResult<bigint> {
  if (modulus <= 0n) {
    return { ok: false, error: { code: 'modulus-not-positive' } }
  }
  const remainder = value % modulus
  return {
    ok: true,
    value: remainder >= 0n ? remainder : remainder + modulus,
  }
}

/** Unsigned big-endian, exactly `length` bytes. */
export function bigintToBytes(
  value: bigint,
  length: number,
): IntegerResult<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || value < 0n) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest !== 0n) {
    return { ok: false, error: { code: 'integer-out-of-range' } }
  }
  return { ok: true, value: out }
}

/** Unsigned big-endian. An empty array is zero. */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}
