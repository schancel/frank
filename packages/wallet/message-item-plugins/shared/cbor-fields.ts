/**
 * Small field combinators for the plugins that encode their item as one canonical restricted-CBOR
 * map (`@frank/codec`'s `encodeCanonical`/`decodeCanonical`, docs/protocol/cbor section 3).
 *
 * Each plugin states its own schema with these: which integer key carries which property, and
 * what shape that property has. Encoding refuses a property the schema does not name; decoding
 * refuses an unknown key, a missing required key and a value of the wrong shape. Pure: no I/O, no
 * wallet state.
 *
 * The bytes are the bare CBOR map, not a FRNK frame. On the canonical direct message path they
 * travel inside the generic plugin item frame (type 27), which names the item type.
 */
import { encodeCanonical, type Encodable, type FrankValue } from '@frank/codec'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { isCanonicalChainIdentifier } from './chain-identifiers'

export interface Field<T> {
  enc(value: T, path: string): Encodable
  dec(value: FrankValue, path: string): T
}

/** Internal failure carrying a path; turned into the typed registry errors at the item boundary. */
class FieldError extends Error {}

const fail = (path: string, message: string): never => {
  throw new FieldError(`${path}: ${message}`)
}

export const text: Field<string> = {
  enc: (v, path) => (typeof v === 'string' ? v : fail(path, 'expected text')),
  dec: (v, path) => (typeof v === 'string' ? v : fail(path, 'expected text')),
}

const utf8 = {
  encode: (s: string) => new TextEncoder().encode(s),
  decode: (b: Uint8Array) =>
    new TextDecoder('utf-8', { fatal: true }).decode(b),
}

/** Text that may exceed the profile's text-string limit (an inline image): carried as the UTF-8
 * bytes in a byte string. */
export const longText: Field<string> = {
  enc: (v, path) =>
    typeof v === 'string' ? utf8.encode(v) : fail(path, 'expected text'),
  dec: (v, path) => {
    if (!(v instanceof Uint8Array)) return fail(path, 'expected a byte string')
    try {
      return utf8.decode(v)
    } catch {
      return fail(path, 'not valid UTF-8')
    }
  },
}

export const bool: Field<boolean> = {
  enc: (v, path) =>
    typeof v === 'boolean' ? v : fail(path, 'expected a boolean'),
  dec: (v, path) =>
    typeof v === 'boolean' ? v : fail(path, 'expected a boolean'),
}

/**
 * A finite JavaScript number, losslessly. A safe integer is a CBOR integer. Any other finite
 * number (the profile has no floats) is its shortest decimal text, and only that exact text is
 * accepted back, so each number has one encoding.
 */
export const num: Field<number> = {
  enc: (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      return fail(path, 'expected a finite number')
    if (Number.isSafeInteger(v)) return Object.is(v, -0) ? 0 : v
    return String(v)
  },
  dec: (v, path) => {
    if (typeof v === 'bigint') {
      if (
        v > BigInt(Number.MAX_SAFE_INTEGER) ||
        v < BigInt(Number.MIN_SAFE_INTEGER)
      )
        return fail(path, 'integer outside the safe range')
      return Number(v)
    }
    if (typeof v === 'string') {
      const n = Number(v)
      if (!Number.isFinite(n) || Number.isSafeInteger(n) || String(n) !== v)
        return fail(path, 'not a canonical non-integer number')
      return n
    }
    return fail(path, 'expected a number')
  },
}

export function oneOf<const T extends readonly string[]>(
  ...values: T
): Field<T[number]> {
  const check = (v: unknown, path: string): T[number] =>
    typeof v === 'string' && values.includes(v)
      ? (v as T[number])
      : fail(path, `expected one of ${values.join(', ')}`)
  return { enc: check, dec: check }
}

export function list<T>(of: Field<T>): Field<T[]> {
  return {
    enc: (v, path) =>
      Array.isArray(v)
        ? v.map((e, i) => of.enc(e, `${path}[${i}]`))
        : fail(path, 'expected an array'),
    dec: (v, path) =>
      Array.isArray(v)
        ? v.map((e, i) => of.dec(e, `${path}[${i}]`))
        : fail(path, 'expected an array'),
  }
}

/** A string-keyed record. The profile's maps take integer keys only, so this is an array of
 * `[key, value]` pairs in ascending key order with no repeated key. */
export function record<T>(of: Field<T>): Field<Record<string, T>> {
  return {
    enc: (v, path) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v))
        return fail(path, 'expected an object')
      return Object.keys(v)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map(k => [k, of.enc(v[k], `${path}.${k}`)])
    },
    dec: (v, path) => {
      if (!Array.isArray(v)) return fail(path, 'expected an array of pairs')
      const out: Record<string, T> = {}
      let previous: string | undefined
      for (const pair of v) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'string'
        )
          return fail(path, 'expected [text, value] pairs')
        const key = pair[0]
        if (previous !== undefined && !(previous < key))
          return fail(path, 'keys must be ascending and unique')
        previous = key
        Object.defineProperty(out, key, {
          value: of.dec(pair[1], `${path}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Bounded fields. Every rule is applied on encode and on decode alike, so an item this side will
// write is exactly an item the other side will read.
// ---------------------------------------------------------------------------------------------

/** A field whose value must pass one check in both directions. */
function checked<T>(
  base: Field<T>,
  check: (value: T, path: string) => void,
): Field<T> {
  return {
    enc: (v, path) => {
      const encoded = base.enc(v, path)
      check(v, path)
      return encoded
    },
    dec: (v, path) => {
      const decoded = base.dec(v, path)
      check(decoded, path)
      return decoded
    },
  }
}

const utf8Length = (s: string): number => utf8.encode(s).length

/**
 * An integer in `min..max` inclusive, carried as a CBOR integer and nothing else: no text form,
 * no fraction, no value outside the range. For every count, index, nonce, card, die face,
 * quantity and timestamp.
 */
export function int(min: number, max: number): Field<number> {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
    throw new Error('int(min, max) needs safe integer bounds')
  const inRange = (n: number, path: string): number =>
    n < min || n > max ? fail(path, `expected an integer in ${min}..${max}`) : n
  return {
    enc: (v, path) =>
      typeof v === 'number' && Number.isSafeInteger(v)
        ? inRange(Object.is(v, -0) ? 0 : v, path)
        : fail(path, `expected an integer in ${min}..${max}`),
    dec: (v, path) => {
      if (typeof v !== 'bigint')
        return fail(path, `expected an integer in ${min}..${max}`)
      if (v < BigInt(min) || v > BigInt(max))
        return fail(path, `expected an integer in ${min}..${max}`)
      return Number(v)
    },
  }
}

/** Milliseconds since the epoch, within the range a JavaScript `Date` can represent. */
export const MAX_TIMESTAMP_MS = 8_640_000_000_000_000
export const timestampMs: Field<number> = int(0, MAX_TIMESTAMP_MS)

/** A finite number in `min..max` that may have a fraction (see {@link num} for its encoding). */
export function decimal(min: number, max: number): Field<number> {
  return checked(num, (v, path) => {
    if (v < min || v > max) fail(path, `expected a number in ${min}..${max}`)
  })
}

/** Text of at most `maxBytes` UTF-8 bytes (and at least `minBytes`). */
export function str(maxBytes: number, minBytes = 0): Field<string> {
  return checked(text, (v, path) => {
    const length = utf8Length(v)
    if (length < minBytes || length > maxBytes)
      fail(path, `expected ${minBytes}..${maxBytes} bytes of text`)
  })
}

/** Text carried as bytes ({@link longText}) of at most `maxBytes` UTF-8 bytes. */
export function longStr(maxBytes: number, minBytes = 0): Field<string> {
  return checked(longText, (v, path) => {
    const length = utf8Length(v)
    if (length < minBytes || length > maxBytes)
      fail(path, `expected ${minBytes}..${maxBytes} bytes`)
  })
}

/** Text matching `pattern` exactly. The pattern must bound the length itself. */
export function matching(pattern: RegExp, what: string): Field<string> {
  return checked(text, (v, path) => {
    if (!pattern.test(v)) fail(path, `expected ${what}`)
  })
}

/** An amount in a chain's smallest unit: decimal digits only, no sign, no leading zero, at most
 * 78 digits (the length of the largest 256-bit value). */
export const amount: Field<string> = matching(
  /^(?:0|[1-9][0-9]{0,77})$/,
  'a decimal amount of at most 78 digits',
)

/** An amount a person typed, in display units: digits with an optional fraction, no sign, no
 * exponent, at most 40 digits on each side. */
export const displayAmount: Field<string> = matching(
  /^[0-9]{1,40}(?:\.[0-9]{1,40})?$/,
  'a decimal number with at most 40 digits on each side of the point',
)

/** Hexadecimal text of `minBytes..maxBytes` bytes, with or without a `0x` prefix. */
export function hex(minBytes: number, maxBytes = minBytes): Field<string> {
  const pattern = new RegExp(
    `^(?:0x)?(?:[0-9a-fA-F]{2}){${minBytes},${maxBytes}}$`,
  )
  return matching(
    pattern,
    minBytes === maxBytes
      ? `${minBytes} bytes of hexadecimal`
      : `${minBytes}..${maxBytes} bytes of hexadecimal`,
  )
}

/** A 32-byte hash as hexadecimal, with or without `0x`. */
export const hash32: Field<string> = hex(32)

/** An EVM address: `0x` and 40 hexadecimal digits. The checksum case is not verified here. */
export const evmAddress: Field<string> = matching(
  /^0x[0-9a-fA-F]{40}$/,
  'an EVM address',
)

/** An address on any supported chain (EVM hex, base58, a prefixed UTXO address): a bounded token
 * with no spaces or control characters. Its chain decides whether it is valid there. */
export const chainAddress: Field<string> = matching(
  /^[0-9A-Za-z][0-9A-Za-z:_.-]{0,127}$/,
  'an address of at most 128 characters',
)

/** A transaction identifier on any supported chain: hexadecimal (with or without `0x`) or base58,
 * at most 128 characters. */
export const transactionId: Field<string> = matching(
  /^[0-9A-Za-z]{1,128}$/,
  'a transaction identifier of at most 128 characters',
)

/** A short machine identifier (a table, round, swap or instance id): letters, digits and
 * `: _ . -`, at most `maxLength` characters. */
export function token(maxLength = 64): Field<string> {
  return matching(
    new RegExp(`^[0-9A-Za-z][0-9A-Za-z:_.-]{0,${maxLength - 1}}$`),
    `an identifier of at most ${maxLength} characters`,
  )
}

/** A canonical chain identifier from the protocol registry (docs/protocol/chains/v1.json). */
export const chainIdentifier: Field<string> = checked(text, (v, path) => {
  if (!isCanonicalChainIdentifier(v))
    fail(path, 'expected a canonical chain identifier')
})

/** A list of at most `max` elements (and at least `min`). The size is checked before any element
 * is read. */
export function listOf<T>(of: Field<T>, max: number, min = 0): Field<T[]> {
  const inner = list(of)
  const sized = (v: unknown, path: string): void => {
    if (Array.isArray(v) && (v.length < min || v.length > max))
      fail(path, `expected ${min}..${max} elements`)
  }
  return {
    enc: (v, path) => (sized(v, path), inner.enc(v, path)),
    dec: (v, path) => (sized(v, path), inner.dec(v, path)),
  }
}

/** A string-keyed record of at most `max` entries whose keys pass `key`. The size is checked
 * before any entry is read. */
export function recordOf<T>(
  key: Field<string>,
  of: Field<T>,
  max: number,
): Field<Record<string, T>> {
  const inner = record(of)
  return {
    enc: (v, path) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v)
        if (keys.length > max) fail(path, `expected at most ${max} entries`)
        for (const k of keys) key.enc(k, `${path} key`)
      }
      return inner.enc(v, path)
    },
    dec: (v, path) => {
      if (Array.isArray(v) && v.length > max)
        fail(path, `expected at most ${max} entries`)
      const out = inner.dec(v, path)
      for (const k of Object.keys(out)) key.enc(k, `${path} key`)
      return out
    },
  }
}

export interface Slot<T> {
  key: number
  field: Field<T>
  optional: boolean
}

export const req = <T>(key: number, field: Field<T>): Slot<T> => ({
  key,
  field,
  optional: false,
})
export const opt = <T>(key: number, field: Field<T>): Slot<T> => ({
  key,
  field,
  optional: true,
})

/** One slot for every property of `T`, so a property added to the type without a slot does not
 * compile. */
export type Spec<T> = { [K in keyof T]-?: Slot<Exclude<T[K], undefined>> }

function slots<T>(spec: Spec<T>): Array<[string, Slot<unknown>]> {
  const entries = Object.entries(spec) as Array<[string, Slot<unknown>]>
  const seen = new Set<number>()
  for (const [name, slot] of entries) {
    if (seen.has(slot.key))
      throw new Error(`duplicate CBOR key ${slot.key} at ${name}`)
    seen.add(slot.key)
  }
  return entries
}

function encodeStruct<T>(
  entries: Array<[string, Slot<unknown>]>,
  value: T,
  path: string,
  ignore?: string,
): Map<number, Encodable> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail(path, 'expected an object')
  const input = value as Record<string, unknown>
  const names = new Set(entries.map(([name]) => name))
  for (const name of Object.keys(input)) {
    if (name !== ignore && !names.has(name) && input[name] !== undefined)
      fail(`${path}.${name}`, 'not a field of this item')
  }
  const out = new Map<number, Encodable>()
  for (const [name, slot] of entries) {
    const v = input[name]
    if (v === undefined) {
      if (!slot.optional) fail(`${path}.${name}`, 'required')
      continue
    }
    out.set(slot.key, slot.field.enc(v, `${path}.${name}`))
  }
  return out
}

function decodeStruct(
  entries: Array<[string, Slot<unknown>]>,
  value: FrankValue,
  path: string,
): Record<string, unknown> {
  if (!(value instanceof Map)) return fail(path, 'expected a map')
  const byKey = new Map(entries.map(([name, slot]) => [BigInt(slot.key), name]))
  for (const key of value.keys()) {
    if (!byKey.has(key)) fail(path, `unknown key ${key}`)
  }
  const out: Record<string, unknown> = {}
  for (const [name, slot] of entries) {
    const v = value.get(BigInt(slot.key))
    if (v === undefined) {
      if (!slot.optional) fail(`${path}.${name}`, 'required')
      continue
    }
    out[name] = slot.field.dec(v, `${path}.${name}`)
  }
  return out
}

/** A nested object with its own integer-keyed map. */
export function struct<T>(spec: Spec<T>): Field<T> {
  const entries = slots(spec)
  return {
    enc: (v, path) => encodeStruct(entries, v, path),
    dec: (v, path) => decodeStruct(entries, v, path) as T,
  }
}

export interface ItemCodec<T> {
  encode(item: T): Uint8Array
  decode(bytes: Uint8Array, context: MessageItemDecodeContext): T
}

/**
 * The codec for one item type: `spec` covers every property except `type`, which is implied by
 * the plugin that owns the bytes and is not written.
 */
export function cborItemCodec<T extends { type: string }>(
  type: T['type'],
  spec: Spec<Omit<T, 'type'>>,
): ItemCodec<T> {
  const entries = slots(spec)
  return {
    encode(item) {
      try {
        if ((item as { type?: unknown } | null)?.type !== type)
          fail('item.type', `expected ${type}`)
        return encodeCanonical(encodeStruct(entries, item, 'item', 'type'))
      } catch (error) {
        throw new MessageItemEncodeError(type, detailOf(error))
      }
    },
    decode(bytes, context) {
      try {
        // Under the enclosing message's counters and depth, never a fresh budget.
        const body = decodeStruct(
          entries,
          context.budget.decodeCbor(bytes, type),
          'item',
        )
        return { type, ...body } as T
      } catch (error) {
        throw new MessageItemDecodeError(type, detailOf(error))
      }
    },
  }
}

export function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
