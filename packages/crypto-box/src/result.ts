export interface ReservedSuite {
  readonly code: 'reserved-suite'
  readonly suiteId: number
}

export interface SuiteUnknown {
  readonly code: 'suite-unknown'
  readonly suiteId: number
}

export interface BadLength {
  readonly code: 'bad-length'
  readonly actual: number
}

export interface PointInvalid {
  readonly code: 'point-invalid'
}

export interface ScalarOutOfRange {
  readonly code: 'scalar-out-of-range'
}

export interface EnvelopeInvalid {
  readonly code: 'envelope'
}

export interface OpenFailed {
  readonly code: 'open-failed'
}

export interface PaddingInvalid {
  readonly code: 'padding'
}

export interface TooLarge {
  readonly code: 'too-large'
}

export interface RandomUnavailable {
  readonly code: 'random'
}

export interface SenderKey {
  readonly code: 'sender-key'
}

export interface BytesExpected {
  readonly code: 'bytes'
}

export interface AeadFailed {
  readonly code: 'aead'
}

export type SuiteFailure =
  | ReservedSuite
  | SuiteUnknown
  | BadLength
  | PointInvalid
  | ScalarOutOfRange
  | EnvelopeInvalid
  | OpenFailed
  | PaddingInvalid
  | TooLarge
  | RandomUnavailable
  | SenderKey
  | BytesExpected
  | AeadFailed
  | NotSelfOpenable

/**
 * The envelope's ephemeral `enc` is not the one derived from the caller's
 * self-open key: a legacy random-ephemeral envelope, or not sealed by this key.
 */
export interface NotSelfOpenable {
  readonly code: 'not-self-openable'
}

export type SuiteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SuiteFailure }

const CODES: ReadonlySet<string> = new Set([
  'reserved-suite',
  'suite-unknown',
  'bad-length',
  'point-invalid',
  'scalar-out-of-range',
  'envelope',
  'open-failed',
  'padding',
  'too-large',
  'random',
  'sender-key',
  'bytes',
  'aead',
  'not-self-openable',
])

export function isSuiteError(value: unknown): value is SuiteFailure {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && CODES.has(code)
}

export function fail<T>(error: SuiteFailure): SuiteResult<T> {
  return { ok: false, error }
}
