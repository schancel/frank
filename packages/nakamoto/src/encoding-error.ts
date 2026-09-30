// Wire and range failures carry a `code` string. A plain object with that
// code passes the guard, so two copies of this package still agree.

export interface BytesExpected {
  readonly code: 'bytes-expected'
}

export interface Base58InvalidChar {
  readonly code: 'base58-invalid-char'
  readonly index: number
  readonly char: string
}

export interface Base58InvalidType {
  readonly code: 'base58-invalid-type'
}

export interface Base58CheckTooShort {
  readonly code: 'base58check-too-short'
  readonly length: number
}

export interface Base58CheckChecksum {
  readonly code: 'base58check-checksum'
}

export interface VarintOutOfRange {
  readonly code: 'varint-out-of-range'
}

export interface VarintTruncated {
  readonly code: 'varint-truncated'
  readonly needed: number
  readonly available: number
}

export interface VarintNonMinimal {
  readonly code: 'varint-non-minimal'
}

export interface ReaderTruncated {
  readonly code: 'reader-truncated'
  readonly needed: number
  readonly available: number
  /** Set when `needed` is saturated because the declared length is not a safe integer. */
  readonly length?: bigint
}

export interface IntegerWidth {
  readonly code: 'integer-out-of-range'
}

export interface ConvertBitsWidth {
  readonly code: 'convert-bits-width'
  readonly fromBits: number
  readonly toBits: number
}

export interface ConvertBitsRange {
  readonly code: 'convert-bits-range'
  readonly value: number
  readonly fromBits: number
}

export interface ConvertBitsPadding {
  readonly code: 'convert-bits-padding'
}

export interface Base32InvalidValue {
  readonly code: 'base32-invalid-value'
  readonly value: number
}

export interface Base32InvalidChar {
  readonly code: 'base32-invalid-char'
  readonly index: number
  readonly char: string
}

export interface Base32InvalidType {
  readonly code: 'base32-invalid-type'
}

export type EncodingError =
  | BytesExpected
  | Base58InvalidChar
  | Base58InvalidType
  | Base58CheckTooShort
  | Base58CheckChecksum
  | VarintOutOfRange
  | VarintTruncated
  | VarintNonMinimal
  | ReaderTruncated
  | IntegerWidth
  | ConvertBitsWidth
  | ConvertBitsRange
  | ConvertBitsPadding
  | Base32InvalidValue
  | Base32InvalidChar
  | Base32InvalidType

export type EncodingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EncodingError }

const CODES: ReadonlySet<string> = new Set([
  'bytes-expected',
  'base58-invalid-char',
  'base58-invalid-type',
  'base58check-too-short',
  'base58check-checksum',
  'varint-out-of-range',
  'varint-truncated',
  'varint-non-minimal',
  'reader-truncated',
  'integer-out-of-range',
  'convert-bits-width',
  'convert-bits-range',
  'convert-bits-padding',
  'base32-invalid-value',
  'base32-invalid-char',
  'base32-invalid-type',
])

export function isEncodingError(value: unknown): value is EncodingError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && CODES.has(code)
}

/** Programmer errors (wrong byte type, integer width). Wire failures use results. */
export class EncodingException extends Error {
  readonly code: EncodingError['code']
  readonly error: EncodingError

  constructor(error: EncodingError) {
    super(error.code)
    this.name = 'EncodingException'
    this.error = error
    this.code = error.code
  }
}
