import { sha256 } from '@noble/hashes/sha256.js'

const SECRET_INDEX = 's'
const LONG_CHECKSUM_LENGTH = 15
const POLYMOD_INITIAL = 0x23181b3n
const LONG_POLYMOD_RESIDUE = 0x43381e570bf4798ab26n
const LONG_GENERATORS = [
  0x3d59d273535ea62d897n,
  0x7a9becb6361c6c51507n,
  0x543f9b7e6c38d8a2a0en,
  0x0c577eaeccf1990d13cn,
  0x1887f74f8dc71b10651n,
] as const
const MASTER_ROOT_LENGTH = 32
const MASTER_PAYLOAD_LENGTH = 64
const MASTER_VALIDATION_PREFIX = Uint8Array.from(
  'frank/master-validation/v1',
  character => character.charCodeAt(0),
)
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

export type Codex32ErrorCode =
  | 'bad-format'
  | 'bad-checksum'
  | 'unsupported-length'
  | 'invalid-threshold'
  | 'invalid-identifier'
  | 'invalid-index'
  | 'insufficient-shares'
  | 'wrong-share-count'
  | 'duplicate-share'
  | 'inconsistent-share'
  | 'rng-failed'

export type RecoveryShareErrorCode = Codex32ErrorCode

export interface Codex32Error {
  readonly code: Codex32ErrorCode
}

export type RecoveryShareError = Codex32Error

export type Codex32Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Codex32Error }

export type RecoveryShareResult<T> = Codex32Result<T>

/** Share index and GF(32) symbol payload used by threshold interpolation. */
export interface RecoveryShareMetadata {
  readonly index: string
  readonly payload: Uint8Array
}

export interface SplitGf32SymbolsInput {
  readonly payload: Uint8Array
  readonly threshold: number
  readonly indices: readonly string[]
  readonly randomBytes: (length: number) => Uint8Array
}

export type SplitRecoverySharesInput = SplitGf32SymbolsInput

/** Alphabet and primitives for application-owned formats, not standard Codex32 strings. */
export const GF32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function fail<T>(code: Codex32ErrorCode): Codex32Result<T> {
  return { ok: false, error: { code } }
}

function valueOf(character: string): number {
  return GF32_ALPHABET.indexOf(character)
}

function validIndex(index: string): boolean {
  return index.length === 1 && valueOf(index) >= 0
}

function longPolymod(
  values: readonly number[],
  initial = POLYMOD_INITIAL,
): bigint {
  let checksum = initial
  for (const value of values) {
    const top = checksum >> 70n
    checksum = ((checksum & 0x3fffffffffffffffffn) << 5n) ^ BigInt(value)
    for (let index = 0; index < LONG_GENERATORS.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) !== 0n) {
        checksum ^= LONG_GENERATORS[index] ?? 0n
      }
    }
  }
  return checksum
}

function bytesToGroups(bytes: Uint8Array): number[] {
  const groups: number[] = []
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      groups.push((accumulator >> bits) & 31)
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0) groups.push((accumulator << (5 - bits)) & 31)
  return groups
}

// GF(32), represented in the five-bit alphabet values, reduced by
// x^5 + x^3 + 1. Addition is XOR.
function multiply(left: number, right: number): number {
  let a = left
  let b = right
  let result = 0
  for (let bit = 0; bit < 5; bit += 1) {
    if ((b & 1) !== 0) result ^= a
    b >>= 1
    a <<= 1
    if ((a & 0x20) !== 0) a ^= 0x29
  }
  return result & 31
}

function inverse(value: number): number {
  if (value === 0) throw new Error('zero has no inverse')
  let result = 1
  for (let exponent = 0; exponent < 30; exponent += 1) {
    result = multiply(result, value)
  }
  return result
}

function evaluate(coefficients: readonly number[], x: number): number {
  let result = 0
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    result = multiply(result, x) ^ (coefficients[index] ?? 0)
  }
  return result
}

function snapshotExactBytes(
  value: unknown,
  expectedLength: number,
): Codex32Result<Uint8Array> {
  try {
    if (
      typeof TYPED_ARRAY_LENGTH_GETTER !== 'function' ||
      typeof TYPED_ARRAY_TAG_GETTER !== 'function' ||
      Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) !== 'Uint8Array'
    ) {
      return fail('bad-format')
    }
    const length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, [])
    if (length !== expectedLength) return fail('unsupported-length')
    const copied = new Uint8Array(length)
    Reflect.apply(UINT8_ARRAY_SET, copied, [value])
    return { ok: true, value: copied }
  } catch {
    return fail('bad-format')
  }
}

function expandBchHrp(hrp: string): number[] {
  if (!/^[a-z]{1,83}$/.test(hrp)) throw new Error('invalid BCH prefix')
  const codes = Array.from(hrp, character => character.charCodeAt(0))
  return [
    ...codes.map(value => value >> 5),
    0,
    ...codes.map(value => value & 31),
  ]
}

/** Pure GF(32) interpolation, including a degree-zero (one-share) polynomial. */
export function interpolateGf32Symbols(
  shares: readonly RecoveryShareMetadata[],
  targetIndex: string,
): Codex32Result<Uint8Array> {
  let xs: number[]
  let rows: Uint8Array[]
  try {
    if (!Array.isArray(shares) || shares.length < 1 || shares.length > 9) {
      return fail('wrong-share-count')
    }
    xs = shares.map(share => valueOf(String(share.index)))
    rows = shares.map(share => share.payload)
  } catch {
    return fail('bad-format')
  }
  if (typeof targetIndex !== 'string' || !validIndex(targetIndex)) {
    return fail('invalid-index')
  }
  const length = rows[0]?.length ?? 0
  if (xs.some(x => x < 0)) return fail('invalid-index')
  if (new Set(xs).size !== xs.length) return fail('duplicate-share')
  if (rows.some(row => !(row instanceof Uint8Array) || row.length !== length)) {
    return fail('inconsistent-share')
  }
  const target = valueOf(targetIndex)
  // Lagrange weights depend only on the indices: compute them once for all columns.
  const weights = xs.map((x, current) => {
    let numerator = 1
    let denominator = 1
    for (let other = 0; other < xs.length; other += 1) {
      if (other === current) continue
      numerator = multiply(numerator, target ^ (xs[other] ?? 0))
      denominator = multiply(denominator, x ^ (xs[other] ?? 0))
    }
    return multiply(numerator, inverse(denominator))
  })
  const output = new Uint8Array(length)
  for (let column = 0; column < length; column += 1) {
    let value = 0
    for (let row = 0; row < rows.length; row += 1) {
      value ^= multiply(rows[row]?.[column] ?? 0, weights[row] ?? 0)
    }
    output[column] = value
  }
  return { ok: true, value: output }
}

/** Construct Frank's v1 64-byte R || validation payload. */
export function createMasterPayload(
  root: Uint8Array,
): Codex32Result<Uint8Array> {
  const snapshot = snapshotExactBytes(root, MASTER_ROOT_LENGTH)
  if (!snapshot.ok) return snapshot
  const ownedRoot = snapshot.value
  const preimage = new Uint8Array(
    MASTER_VALIDATION_PREFIX.length + 1 + MASTER_ROOT_LENGTH,
  )
  try {
    preimage.set(MASTER_VALIDATION_PREFIX)
    preimage.set(ownedRoot, MASTER_VALIDATION_PREFIX.length + 1)
    const payload = new Uint8Array(MASTER_PAYLOAD_LENGTH)
    payload.set(ownedRoot)
    payload.set(sha256(preimage), MASTER_ROOT_LENGTH)
    return { ok: true, value: payload }
  } finally {
    ownedRoot.fill(0)
    preimage.fill(0)
  }
}

/** Validate Frank's v1 master payload and return an owned root copy. */
export function validateMasterPayload(
  payload: Uint8Array,
): Codex32Result<Uint8Array> {
  const snapshot = snapshotExactBytes(payload, MASTER_PAYLOAD_LENGTH)
  if (!snapshot.ok) return snapshot
  const owned = snapshot.value
  const root = owned.slice(0, MASTER_ROOT_LENGTH)
  const expected = createMasterPayload(root)
  if (!expected.ok) {
    root.fill(0)
    owned.fill(0)
    return expected
  }
  let difference = 0
  for (
    let index = MASTER_ROOT_LENGTH;
    index < MASTER_PAYLOAD_LENGTH;
    index += 1
  ) {
    difference |= (owned[index] ?? 0) ^ (expected.value[index] ?? 0)
  }
  owned.fill(0)
  expected.value.fill(0)
  if (difference !== 0) {
    root.fill(0)
    return fail('bad-format')
  }
  return { ok: true, value: root }
}

/** Long BCH framing over an explicit human-readable prefix and five-bit values. */
export function createLongBchChecksum(
  hrp: string,
  values: readonly number[],
): number[] {
  const expanded = expandBchHrp(hrp)
  if (
    expanded.length + values.length + LONG_CHECKSUM_LENGTH < 96 ||
    expanded.length + values.length + LONG_CHECKSUM_LENGTH > 1023 ||
    values.some(value => !Number.isInteger(value) || value < 0 || value > 31)
  ) {
    throw new Error('invalid long BCH framing')
  }
  const residue =
    longPolymod(
      [...expanded, ...values, ...new Array<number>(15).fill(0)],
      1n,
    ) ^ LONG_POLYMOD_RESIDUE
  return Array.from({ length: 15 }, (_, index) =>
    Number((residue >> BigInt(5 * (14 - index))) & 31n),
  )
}

export function verifyLongBchChecksum(
  hrp: string,
  values: readonly number[],
): boolean {
  const expanded = expandBchHrp(hrp)
  return (
    expanded.length + values.length >= 96 &&
    expanded.length + values.length <= 1023 &&
    values.every(
      value => Number.isInteger(value) && value >= 0 && value <= 31,
    ) &&
    longPolymod([...expanded, ...values], 1n) === LONG_POLYMOD_RESIDUE
  )
}

/** Split application-owned symbols in one polynomial pass; caller owns returned rows. */
export function splitGf32Symbols(
  input: SplitGf32SymbolsInput,
): Codex32Result<readonly Uint8Array[]> {
  const { payload, threshold, indices, randomBytes } = input
  if (!(payload instanceof Uint8Array) || payload.some(value => value > 31))
    return fail('bad-format')
  if (
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > 9 ||
    indices.length < threshold ||
    indices.length > 31 ||
    (threshold === 1 && indices.length !== 1)
  )
    return fail('invalid-threshold')
  if (indices.some(index => !validIndex(index) || index === SECRET_INDEX))
    return fail('invalid-index')
  if (new Set(indices).size !== indices.length) return fail('duplicate-share')
  let random: Uint8Array | undefined
  const rows = indices.map(() => new Uint8Array(payload.length))
  let transferred = false
  try {
    const count = payload.length * (threshold - 1)
    const supplied = randomBytes(count)
    if (!(supplied instanceof Uint8Array) || supplied.length !== count)
      return fail('rng-failed')
    random = new Uint8Array(supplied)
    for (let column = 0; column < payload.length; column++) {
      const coefficients = [payload[column] ?? 0]
      try {
        for (let degree = 1; degree < threshold; degree++)
          coefficients.push(
            (random[column * (threshold - 1) + degree - 1] ?? 0) & 31,
          )
        indices.forEach((index, row) => {
          rows[row]![column] = evaluate(
            coefficients,
            valueOf(index) ^ valueOf(SECRET_INDEX),
          )
        })
      } finally {
        coefficients.fill(0)
      }
    }
    transferred = true
    return { ok: true, value: rows }
  } catch {
    return fail('rng-failed')
  } finally {
    random?.fill(0)
    if (!transferred) rows.forEach(row => row.fill(0))
  }
}

/** Explicit alias for `splitGf32Symbols` in recovery-share callers. */
export function splitRecoveryShares(
  input: SplitRecoverySharesInput,
): Codex32Result<readonly Uint8Array[]> {
  return splitGf32Symbols(input)
}

/** Explicit alias for `interpolateGf32Symbols` (defaults `targetIndex` to `'s'`). */
export function combineRecoveryShares(
  shares: readonly RecoveryShareMetadata[],
  targetIndex: string = SECRET_INDEX,
): Codex32Result<Uint8Array> {
  return interpolateGf32Symbols(shares, targetIndex)
}

/** Canonical padded byte/symbol conversion for application-owned payload lengths. */
export function bytesToGf32Symbols(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytesToGroups(bytes))
}

export function gf32SymbolsToBytes(
  symbols: Uint8Array,
  byteLength: number,
): Codex32Result<Uint8Array> {
  if (
    !(symbols instanceof Uint8Array) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    symbols.length !== Math.ceil((byteLength * 8) / 5) ||
    symbols.some(value => value > 31)
  )
    return fail('bad-format')
  const output = new Uint8Array(byteLength)
  let accumulator = 0,
    bits = 0,
    cursor = 0
  for (const symbol of symbols) {
    accumulator = (accumulator << 5) | symbol
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output[cursor++] = (accumulator >> bits) & 255
      accumulator &= (1 << bits) - 1
    }
  }
  if (accumulator !== 0) {
    output.fill(0)
    return fail('bad-format')
  }
  return { ok: true, value: output }
}
