// Restricted deterministic CBOR (README section 3): canonical encoder plus the two-pass
// validator/decoder of section 9 ("passes A and B").
import {
  MAX_ARRAY_ELEMENTS,
  MAX_BYTE_STRING_BYTES,
  MAX_CONTAINERS,
  MAX_DEPTH,
  MAX_ITEMS,
  MAX_MAP_ENTRIES,
  MAX_TEXT_STRING_BYTES,
  U64_MAX,
} from './constants'
import { CborPass, ErrorCategory, ErrorStage, FrankCodecError } from './errors'
import { isValidUtf8, utf8Decode, utf8Encode } from './utf8'

/** A decoded value of the restricted profile. Every integer is a `bigint` (C7). */
export type FrankValue =
  | bigint
  | boolean
  | null
  | string
  | Uint8Array
  | FrankValue[]
  | ReadonlyMap<bigint, FrankValue>

/**
 * A value accepted by the encoder. Integers may be `number` (safe integers only) or `bigint`;
 * maps are `Map`s whose iteration order is irrelevant to the output.
 */
export type Encodable =
  | number
  | bigint
  | boolean
  | null
  | string
  | Uint8Array
  | readonly Encodable[]
  | ReadonlyMap<number | bigint, Encodable>

// ---------------------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------------------

const NINT_MIN = -(U64_MAX + 1n)

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function encodeHead(major: number, arg: bigint): Uint8Array {
  const m = major << 5
  if (arg < 24n) return Uint8Array.of(m | Number(arg))
  if (arg < 0x100n) return Uint8Array.of(m | 24, Number(arg))
  if (arg < 0x10000n)
    return Uint8Array.of(m | 25, Number(arg >> 8n), Number(arg & 0xffn))
  if (arg < 0x100000000n) {
    return Uint8Array.of(
      m | 26,
      Number((arg >> 24n) & 0xffn),
      Number((arg >> 16n) & 0xffn),
      Number((arg >> 8n) & 0xffn),
      Number(arg & 0xffn),
    )
  }
  const out = new Uint8Array(9)
  out[0] = m | 27
  let v = arg
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function toBigInt(v: number | bigint, what: string): bigint {
  if (typeof v === 'bigint') return v
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`${what}: number is not a safe integer (use bigint)`)
  }
  return BigInt(v)
}

const ENCODE_DEPTH_GUARD = 256

function encodeInto(v: Encodable, out: Uint8Array[], depth: number): void {
  if (depth > ENCODE_DEPTH_GUARD)
    throw new RangeError('value is nested too deeply to encode')
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = toBigInt(v, 'integer')
    if (n >= 0n) {
      if (n > U64_MAX) throw new RangeError('integer above 2^64-1')
      out.push(encodeHead(0, n))
    } else {
      if (n < NINT_MIN) throw new RangeError('integer below -2^64')
      out.push(encodeHead(1, -1n - n))
    }
  } else if (typeof v === 'boolean') {
    out.push(Uint8Array.of(v ? 0xf5 : 0xf4))
  } else if (v === null) {
    out.push(Uint8Array.of(0xf6))
  } else if (typeof v === 'string') {
    const b = utf8Encode(v)
    out.push(encodeHead(3, BigInt(b.length)), b)
  } else if (v instanceof Uint8Array) {
    out.push(encodeHead(2, BigInt(v.length)), v)
  } else if (Array.isArray(v)) {
    out.push(encodeHead(4, BigInt(v.length)))
    for (const e of v) encodeInto(e as Encodable, out, depth + 1)
  } else if (v instanceof Map) {
    const entries: Array<[bigint, Encodable]> = []
    const seen = new Set<bigint>()
    for (const [k, val] of v as ReadonlyMap<number | bigint, Encodable>) {
      if (typeof k !== 'number' && typeof k !== 'bigint') {
        throw new TypeError('map keys must be unsigned integers (C1a)')
      }
      const key = toBigInt(k, 'map key')
      if (key < 0n || key > U64_MAX)
        throw new RangeError('map key is not a uint64')
      if (seen.has(key)) throw new RangeError(`duplicate map key ${key} (C4)`)
      seen.add(key)
      entries.push([key, val])
    }
    // Keys are minimally encoded unsigned integers, so numeric order is bytewise order (C1).
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    out.push(encodeHead(5, BigInt(entries.length)))
    for (const [k, val] of entries) {
      out.push(encodeHead(0, k))
      encodeInto(val, out, depth + 1)
    }
  } else {
    throw new TypeError('value is outside the restricted CBOR profile')
  }
}

/** Encodes one value as canonical restricted CBOR, independent of map insertion order. */
export function encodeCanonical(value: Encodable): Uint8Array {
  const out: Uint8Array[] = []
  encodeInto(value, out, 0)
  return concat(out)
}

/** Builds a map from `[key, value]` pairs; the pair order never affects the encoding. */
export function cborMap(
  entries: Iterable<readonly [number | bigint, Encodable]>,
): Map<number | bigint, Encodable> {
  return new Map(entries)
}

// ---------------------------------------------------------------------------------------------
// Shared counters and validation location
// ---------------------------------------------------------------------------------------------

/** R1: counters shared by an envelope, its payload, and every recursively opened child. */
export interface Counters {
  containers: number
  items: number
}

export function newCounters(): Counters {
  return { containers: 0, items: 0 }
}

/** Where a CBOR failure is reported: section 9 stage label plus a location string. */
export interface CborSite {
  stage: ErrorStage
  location: string
}

function err(
  site: CborSite,
  pass: CborPass,
  category: ErrorCategory,
  message: string,
): FrankCodecError {
  return new FrankCodecError(category, site.stage, message, site.location, pass)
}

// ---------------------------------------------------------------------------------------------
// Head reader
// ---------------------------------------------------------------------------------------------

interface Head {
  major: number
  ai: number
  /** The argument. For major 7 it is the simple value (ai 24) or the float bit pattern. */
  arg: bigint
  indefinite: boolean
  /** Bytes occupied by the head (initial byte plus argument bytes). */
  size: number
}

function readHead(
  b: Uint8Array,
  off: number,
  site: CborSite,
  pass: CborPass,
): Head {
  if (off >= b.length)
    throw err(site, pass, 'malformed', 'truncated: missing item head')
  const ib = b[off]
  const major = ib >> 5
  const ai = ib & 0x1f
  if (ai < 24) return { major, ai, arg: BigInt(ai), indefinite: false, size: 1 }
  if (ai >= 28 && ai <= 30) {
    throw err(site, pass, 'malformed', `reserved additional information ${ai}`)
  }
  if (ai === 31) {
    if (major === 0 || major === 1 || major === 6) {
      throw err(
        site,
        pass,
        'malformed',
        'indefinite length on an integer or tag',
      )
    }
    return { major, ai, arg: 0n, indefinite: true, size: 1 }
  }
  const n = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8
  if (off + 1 + n > b.length) {
    throw err(site, pass, 'malformed', 'truncated: incomplete argument')
  }
  let arg = 0n
  for (let i = 0; i < n; i++) arg = (arg << 8n) | BigInt(b[off + 1 + i])
  return { major, ai, arg, indefinite: false, size: 1 + n }
}

function isMinimal(h: Head): boolean {
  if (h.ai < 24) return true
  if (h.ai === 24) return h.arg >= 24n
  if (h.ai === 25) return h.arg >= 0x100n
  if (h.ai === 26) return h.arg >= 0x10000n
  return h.arg >= 0x100000000n
}

const BREAK = 0xff
const BIG_LIMIT = 0x7fffffffn

/** Converts a declared length/count to a comparable number without wrapping (R5). */
function lenNum(arg: bigint): number {
  return arg > BIG_LIMIT ? Number.MAX_SAFE_INTEGER : Number(arg)
}

// ---------------------------------------------------------------------------------------------
// Pass A: streaming syntax and resource pass
// ---------------------------------------------------------------------------------------------

interface ScanState {
  b: Uint8Array
  counters: Counters
  site: CborSite
}

function chargeItem(s: ScanState): void {
  s.counters.items += 1
  if (s.counters.items > MAX_ITEMS) {
    throw err(s.site, 'A', 'resource', `more than ${MAX_ITEMS} items`)
  }
}

function enterContainer(s: ScanState, depth: number): number {
  s.counters.containers += 1
  if (s.counters.containers > MAX_CONTAINERS) {
    throw err(s.site, 'A', 'resource', `more than ${MAX_CONTAINERS} containers`)
  }
  const d = depth + 1
  if (d > MAX_DEPTH)
    throw err(s.site, 'A', 'resource', `nesting deeper than ${MAX_DEPTH}`)
  return d
}

/** Scans one item starting at `off`; returns the offset just past it. */
function scanItem(s: ScanState, start: number, depth: number): number {
  const b = s.b
  let off = start
  for (;;) {
    const h = readHead(b, off, s.site, 'A')
    if (h.major === 7 && h.indefinite) {
      throw err(s.site, 'A', 'malformed', 'stray break code')
    }
    chargeItem(s)
    off += h.size
    switch (h.major) {
      case 0:
      case 1:
        return off
      case 2:
      case 3: {
        if (h.indefinite) return scanIndefiniteString(s, off, h.major)
        return scanString(s, off, h.arg, h.major)
      }
      case 4: {
        const d = enterContainer(s, depth)
        if (h.indefinite) {
          let count = 0
          for (;;) {
            if (off >= b.length)
              throw err(s.site, 'A', 'malformed', 'truncated indefinite array')
            if (b[off] === BREAK) return off + 1
            count += 1
            if (count > MAX_ARRAY_ELEMENTS) {
              throw err(
                s.site,
                'A',
                'resource',
                `array has more than ${MAX_ARRAY_ELEMENTS} elements`,
              )
            }
            off = scanItem(s, off, d)
          }
        }
        if (lenNum(h.arg) > MAX_ARRAY_ELEMENTS) {
          throw err(
            s.site,
            'A',
            'resource',
            `array declares more than ${MAX_ARRAY_ELEMENTS} elements`,
          )
        }
        const n = Number(h.arg)
        for (let i = 0; i < n; i++) off = scanItem(s, off, d)
        return off
      }
      case 5: {
        const d = enterContainer(s, depth)
        if (h.indefinite) {
          let count = 0
          for (;;) {
            if (off >= b.length)
              throw err(s.site, 'A', 'malformed', 'truncated indefinite map')
            if (b[off] === BREAK) return off + 1
            count += 1
            if (count > MAX_MAP_ENTRIES) {
              throw err(
                s.site,
                'A',
                'resource',
                `map has more than ${MAX_MAP_ENTRIES} entries`,
              )
            }
            off = scanItem(s, off, d)
            if (off >= b.length)
              throw err(s.site, 'A', 'malformed', 'truncated map value')
            if (b[off] === BREAK)
              throw err(s.site, 'A', 'malformed', 'break inside a map entry')
            off = scanItem(s, off, d)
          }
        }
        if (lenNum(h.arg) > MAX_MAP_ENTRIES) {
          throw err(
            s.site,
            'A',
            'resource',
            `map declares more than ${MAX_MAP_ENTRIES} entries`,
          )
        }
        const n = Number(h.arg)
        for (let i = 0; i < n; i++) {
          off = scanItem(s, off, d)
          off = scanItem(s, off, d)
        }
        return off
      }
      case 6:
        // A tag wraps exactly one further item; loop instead of recursing so a long tag chain
        // cannot exhaust the stack. Tags are forbidden, but pass A only reports syntax.
        continue
      default: {
        // Major 7. Break was handled above.
        if (h.ai === 24 && h.arg < 32n) {
          throw err(s.site, 'A', 'malformed', 'two-byte simple value below 32')
        }
        return off
      }
    }
  }
}

function scanString(
  s: ScanState,
  off: number,
  arg: bigint,
  major: number,
): number {
  const limit = major === 2 ? MAX_BYTE_STRING_BYTES : MAX_TEXT_STRING_BYTES
  // R1/pass A: the declared length is checked when the header is read, before the content.
  if (arg > BigInt(limit)) {
    throw err(
      s.site,
      'A',
      'resource',
      `${major === 2 ? 'byte' : 'text'} string longer than ${limit}`,
    )
  }
  const n = Number(arg)
  if (off + n > s.b.length)
    throw err(s.site, 'A', 'malformed', 'truncated string content')
  if (major === 3 && !isValidUtf8(s.b, off, off + n)) {
    throw err(s.site, 'A', 'malformed', 'invalid UTF-8')
  }
  return off + n
}

function scanIndefiniteString(
  s: ScanState,
  start: number,
  major: number,
): number {
  const limit = major === 2 ? MAX_BYTE_STRING_BYTES : MAX_TEXT_STRING_BYTES
  let off = start
  let total = 0
  for (;;) {
    if (off >= s.b.length)
      throw err(s.site, 'A', 'malformed', 'truncated indefinite string')
    if (s.b[off] === BREAK) return off + 1
    const h = readHead(s.b, off, s.site, 'A')
    if (h.major !== major || h.indefinite) {
      throw err(
        s.site,
        'A',
        'malformed',
        'indefinite string chunk is not a definite string',
      )
    }
    off += h.size
    if (h.arg > BigInt(limit - total)) {
      throw err(
        s.site,
        'A',
        'resource',
        'indefinite string exceeds the string limit',
      )
    }
    total += Number(h.arg)
    off = scanString(s, off, h.arg, major)
  }
}

// ---------------------------------------------------------------------------------------------
// Pass B: canonicality and profile-class pass, producing the decoded value
// ---------------------------------------------------------------------------------------------

function decodeItem(
  b: Uint8Array,
  start: number,
  site: CborSite,
): { v: FrankValue; end: number } {
  const h = readHead(b, start, site, 'B')
  // Within one item, non-minimal and indefinite encodings are noncanonical and are reported
  // before a forbidden class (README section 9, passes A and B).
  if (h.major !== 6 && h.major !== 7) checkCanonicalHead(h, site)
  let off = start + h.size
  switch (h.major) {
    case 0:
      return { v: h.arg, end: off }
    case 1:
      return { v: -1n - h.arg, end: off }
    case 2: {
      const n = Number(h.arg)
      return { v: b.subarray(off, off + n), end: off + n }
    }
    case 3: {
      const n = Number(h.arg)
      return { v: utf8Decode(b, off, off + n), end: off + n }
    }
    case 4: {
      const n = Number(h.arg)
      const arr: FrankValue[] = []
      for (let i = 0; i < n; i++) {
        const r = decodeItem(b, off, site)
        arr.push(r.v)
        off = r.end
      }
      return { v: arr, end: off }
    }
    case 5: {
      const n = Number(h.arg)
      const map = new Map<bigint, FrankValue>()
      let prev: bigint | undefined
      for (let i = 0; i < n; i++) {
        const kh = readHead(b, off, site, 'B')
        if (kh.major !== 0) {
          if (kh.major !== 6 && kh.major !== 7) checkCanonicalHead(kh, site)
          throw err(
            site,
            'B',
            'schema',
            'map key is not an unsigned integer (C1a)',
          )
        }
        checkCanonicalHead(kh, site)
        const key = kh.arg
        if (prev !== undefined && key <= prev) {
          throw err(
            site,
            'B',
            'noncanonical',
            key === prev
              ? `duplicate map key ${key} (C4)`
              : `map key ${key} out of order (C4)`,
          )
        }
        prev = key
        const r = decodeItem(b, off + kh.size, site)
        map.set(key, r.v)
        off = r.end
      }
      return { v: map, end: off }
    }
    case 6:
      throw err(site, 'B', 'schema', 'tags are forbidden (C5)')
    default:
      if (h.ai === 20) return { v: false, end: off }
      if (h.ai === 21) return { v: true, end: off }
      if (h.ai === 22) return { v: null, end: off }
      throw err(site, 'B', 'schema', 'float or forbidden simple value (C5)')
  }
}

function checkCanonicalHead(h: Head, site: CborSite): void {
  if (h.indefinite)
    throw err(site, 'B', 'noncanonical', 'indefinite-length item (C3)')
  if (!isMinimal(h))
    throw err(site, 'B', 'noncanonical', 'non-minimal argument (C2)')
}

/**
 * Validates exactly one restricted-CBOR data item occupying all of `bytes` (C9) and returns it.
 * Pass A (syntax and resources) runs completely before pass B (canonicality and profile class).
 * `baseDepth` is the depth of the enclosing container (0 for a stand-alone item).
 */
export function decodeSingleItem(
  bytes: Uint8Array,
  site: CborSite,
  counters: Counters = newCounters(),
  baseDepth = 0,
): FrankValue {
  const state: ScanState = { b: bytes, counters, site }
  const end = scanItem(state, 0, baseDepth)
  if (end !== bytes.length) {
    throw err(
      site,
      'A',
      'malformed',
      'extra data after the single CBOR item (C9)',
    )
  }
  return decodeItem(bytes, 0, site).v
}

/** Strictly decodes one canonical restricted-CBOR item; throws {@link FrankCodecError}. */
export function decodeCanonical(bytes: Uint8Array): FrankValue {
  return decodeSingleItem(bytes, { stage: 'cbor', location: 'item' })
}

/** True when `bytes` is exactly one valid canonical restricted-CBOR item. */
export function isValidCanonical(bytes: Uint8Array): boolean {
  try {
    decodeCanonical(bytes)
    return true
  } catch (e) {
    if (e instanceof FrankCodecError) return false
    throw e
  }
}
