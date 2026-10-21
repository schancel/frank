// Stage 8.2 primitive value getters, map field helpers, and feature codec descriptor contract.
import type { FrankValue } from './cbor'
import { U32_MAX } from './constants'
import type { MapShape } from './message-fields.generated'
import { ErrorCategory, ErrorStage, FrankCodecError } from './errors'
import type { DraftPayload, FinalPayload, UnknownFields } from './types'

export function fail(
  category: ErrorCategory,
  stage: ErrorStage,
  path: string,
  message: string,
): FrankCodecError {
  return new FrankCodecError(category, stage, message, path)
}

export const bad = (path: string, message: string): FrankCodecError =>
  fail('schema', '8.2', path, message)

export function isMap(
  v: FrankValue | undefined,
): v is ReadonlyMap<bigint, FrankValue> {
  return v instanceof Map
}

export function uintRange(
  v: FrankValue | undefined,
  path: string,
  min: bigint,
  max: bigint,
): bigint {
  if (typeof v !== 'bigint') throw bad(path, 'expected an unsigned integer')
  if (v < min || v > max) throw bad(path, `integer outside ${min}..${max}`)
  return v
}

export function u32ish(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): number {
  return Number(uintRange(v, path, BigInt(min), BigInt(max)))
}

export function bstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): Uint8Array {
  if (!(v instanceof Uint8Array)) throw bad(path, 'expected a byte string')
  if (v.length < min || v.length > max)
    throw bad(path, `byte string size outside ${min}..${max}`)
  return v
}

export function tstr(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): string {
  if (typeof v !== 'string') throw bad(path, 'expected a text string')
  return textSize(v, path, min, max)
}

function textSize(v: string, path: string, min: number, max: number): string {
  // .size counts UTF-8 bytes; the decoded string is well-formed, so count code points.
  let n = 0
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  if (n < min || n > max) throw bad(path, `text size outside ${min}..${max}`)
  return v
}

export function asList(
  v: FrankValue | undefined,
  path: string,
  min: number,
  max: number,
): FrankValue[] {
  if (!Array.isArray(v)) throw bad(path, 'expected an array')
  if (v.length < min || v.length > max)
    throw bad(path, `array size outside ${min}..${max}`)
  return v
}

export interface MapView {
  get(k: number): FrankValue | undefined
  has(k: number): boolean
  unknown: UnknownFields
}

/**
 * Checks a map against its declared keys. `open` maps (CDDL `* uint => frank-value`) retain
 * undeclared keys only when the enclosing frame is read through V6.3 (`allowUnknown`);
 * otherwise C12 makes an undeclared key a schema error. Closed maps never allow one.
 */
/** Error path of field `key` inside the map at `path` (README error locations). */
export const at = (path: string, key: number | bigint): string =>
  `${path}.${key}`

/** Error path of element `index` of the list in field `key` of the map at `path`. */
export const atItem = (
  path: string,
  key: number | bigint,
  index: number,
): string => `${path}.${key}[${index}]`

/** Read a map through its registered shape (docs/protocol/message-types/fields/). */
export function shaped(
  v: FrankValue | undefined,
  path: string,
  shape: MapShape,
  allowUnknown: boolean,
): MapView {
  return fields(
    v,
    path,
    shape.required,
    shape.optional,
    shape.open,
    allowUnknown,
  )
}

export function fields(
  v: FrankValue | undefined,
  path: string,
  required: readonly number[],
  optional: readonly number[],
  open: boolean,
  allowUnknown: boolean,
): MapView {
  if (!isMap(v)) throw bad(path, 'expected a map')
  for (const k of required) {
    if (!v.has(BigInt(k))) throw bad(path, `missing required key ${k}`)
  }
  const unknown = new Map<bigint, FrankValue>()
  for (const [k, val] of v) {
    const n = k <= BigInt(U32_MAX) ? Number(k) : -1
    if (required.includes(n) || optional.includes(n)) continue
    if (open && allowUnknown) unknown.set(k, val)
    else throw bad(path, `undeclared key ${k} (C12)`)
  }
  return { get: k => v.get(BigInt(k)), has: k => v.has(BigInt(k)), unknown }
}

export interface SchemaVersionContext {
  envelope: number
  effective: number
  minReader?: number
}

/**
 * Composable feature schema descriptor for Stage 8.1/8.2/8.3 and Stage 9 validation.
 * Feature modules run only after Stage 1-7 envelope and canonical CBOR checks succeed
 * under the shared traversal counters and depth budgets.
 */
export interface FeatureCodecDescriptor<
  TDraft extends DraftPayload = DraftPayload,
  TFinal extends FinalPayload = FinalPayload,
> {
  readonly typeId: number
  readonly maxSchemaVersion: number
  readonly maxFrameBytes?: number
  readonly enforceFrameLimitWhenNested?: boolean
  checkTypeLimits?(payload: FrankValue, schemaVersion: number): void
  parseDraft(
    payload: FrankValue,
    allowUnknown: boolean,
    schema: SchemaVersionContext,
  ): TDraft
  checkAllocated?(draft: TDraft): void
  checkSemantics?(typed: TFinal): void
}

export const EMAIL_MESSAGE_ID_MIN_BYTES = 5
export const EMAIL_MESSAGE_ID_MAX_BYTES = 256
const EMAIL_ID_CHARS = '\\x21-\\x3b\\x3d\\x3f\\x41-\\x7e'
const EMAIL_MESSAGE_ID_REGEX = new RegExp(
  `^<[${EMAIL_ID_CHARS}]+@[${EMAIL_ID_CHARS}]+>$`,
)

/**
 * Checks whether a candidate string matches the bounded RFC 5322 `<local@domain>` Message-ID
 * grammar (5..256 printable ASCII bytes excluding whitespace, `<`, `>`, and duplicate `@`).
 */
export function isEmailMessageId(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    candidate.length >= EMAIL_MESSAGE_ID_MIN_BYTES &&
    candidate.length <= EMAIL_MESSAGE_ID_MAX_BYTES &&
    EMAIL_MESSAGE_ID_REGEX.test(candidate)
  )
}
