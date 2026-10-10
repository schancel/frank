import { sha256 } from '@noble/hashes/sha256.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const SECRET_INDEX = 's'
const REGULAR_CHECKSUM_LENGTH = 13
const LONG_CHECKSUM_LENGTH = 15
const SUPPORTED_SECRET_BYTES = new Set([16, 20, 24, 28, 32, 64])
const SUPPORTED_PAYLOAD_GROUPS = new Set([26, 32, 39, 45, 52, 103])
const MAX_STRING_LENGTH = 127
const POLYMOD_INITIAL = 0x23181b3n
const POLYMOD_RESIDUE = 0x10ce0795c2fd1e62an
const GENERATORS = [
  0x19dc500ce73fde210n,
  0x1bfae00def77fe529n,
  0x1fbd920fffe7bee52n,
  0x1739640bdeee3fdadn,
  0x07729a039cfc75f5an,
] as const
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

export interface Codex32Error {
  readonly code: Codex32ErrorCode
}

export type Codex32Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Codex32Error }

export interface Codex32Share {
  readonly threshold: 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  readonly identifier: string
  readonly index: string
  /** Raw GF(32) payload symbols. Shares are not themselves seed bytes. */
  readonly payload: Uint8Array
  /** Present only for the secret index `s` after canonical padding checks. */
  readonly seed: Uint8Array | null
}

export interface EncodeCodex32Input {
  readonly threshold: Codex32Share['threshold']
  readonly identifier: string
  /** Raw seed bytes are only encodable at the secret index `s`. */
  readonly index: string
  readonly secret: Uint8Array
}

export interface SplitCodex32Input {
  readonly threshold: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  readonly identifier: string
  readonly indices: readonly string[]
  readonly secret: Uint8Array
  readonly randomBytes: (length: number) => Uint8Array
}

export interface RecoveredCodex32 {
  readonly secret: Uint8Array
  /** Complete interpolated field symbols, including the final residual bits. */
  readonly payloadSymbols: Uint8Array
}

function fail<T>(code: Codex32ErrorCode): Codex32Result<T> {
  return { ok: false, error: { code } }
}

function valueOf(character: string): number {
  return CHARSET.indexOf(character)
}

function validIdentifier(identifier: string): boolean {
  if (identifier.length !== 4) return false
  for (const character of identifier) {
    if (valueOf(character) < 0) return false
  }
  return true
}

function validIndex(index: string): boolean {
  return index.length === 1 && valueOf(index) >= 0
}

function snapshotSecret(value: unknown): Codex32Result<Uint8Array> {
  try {
    if (
      typeof TYPED_ARRAY_LENGTH_GETTER !== 'function' ||
      typeof TYPED_ARRAY_TAG_GETTER !== 'function' ||
      Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) !== 'Uint8Array'
    ) {
      return fail('bad-format')
    }
    const length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, [])
    if (typeof length !== 'number' || !SUPPORTED_SECRET_BYTES.has(length)) {
      return fail('unsupported-length')
    }
    const copied = new Uint8Array(length)
    Reflect.apply(UINT8_ARRAY_SET, copied, [value])
    return { ok: true, value: copied }
  } catch {
    return fail('bad-format')
  }
}

function snapshotStrings(
  values: unknown,
  minimumLength: number,
): Codex32Result<string[]> {
  try {
    if (!Array.isArray(values)) return fail('bad-format')
    const length = values.length
    if (
      !Number.isSafeInteger(length) ||
      length < minimumLength ||
      length > 31
    ) {
      return fail('insufficient-shares')
    }
    const copied = new Array<string>(length)
    for (let index = 0; index < length; index += 1) {
      const value = values[index]
      if (typeof value !== 'string') return fail('bad-format')
      copied[index] = value
    }
    return { ok: true, value: copied }
  } catch {
    return fail('bad-format')
  }
}

function polymod(values: readonly number[]): bigint {
  let checksum = POLYMOD_INITIAL
  for (const value of values) {
    const top = checksum >> 60n
    checksum = ((checksum & 0x0fffffffffffffffn) << 5n) ^ BigInt(value)
    for (let index = 0; index < GENERATORS.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) !== 0n) {
        checksum ^= GENERATORS[index] ?? 0n
      }
    }
  }
  return checksum
}

function checksum(values: readonly number[]): number[] {
  const checksumLength =
    values.length + REGULAR_CHECKSUM_LENGTH + 5 <= 93
      ? REGULAR_CHECKSUM_LENGTH
      : LONG_CHECKSUM_LENGTH
  if (checksumLength === LONG_CHECKSUM_LENGTH) return longChecksum(values)
  const residue =
    polymod([
      ...values,
      ...new Array<number>(REGULAR_CHECKSUM_LENGTH).fill(0),
    ]) ^ POLYMOD_RESIDUE
  const out = new Array<number>(REGULAR_CHECKSUM_LENGTH)
  for (let index = 0; index < REGULAR_CHECKSUM_LENGTH; index += 1) {
    const shift = BigInt(5 * (REGULAR_CHECKSUM_LENGTH - 1 - index))
    out[index] = Number((residue >> shift) & 31n)
  }
  return out
}

function longPolymod(values: readonly number[]): bigint {
  let checksum = POLYMOD_INITIAL
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

function longChecksum(values: readonly number[]): number[] {
  const residue =
    longPolymod([
      ...values,
      ...new Array<number>(LONG_CHECKSUM_LENGTH).fill(0),
    ]) ^ LONG_POLYMOD_RESIDUE
  const out = new Array<number>(LONG_CHECKSUM_LENGTH)
  for (let index = 0; index < LONG_CHECKSUM_LENGTH; index += 1) {
    const shift = BigInt(5 * (LONG_CHECKSUM_LENGTH - 1 - index))
    out[index] = Number((residue >> shift) & 31n)
  }
  return out
}

function checksumLengthForEncodedLength(length: number): number | null {
  const expandedLength = length + 2
  if (expandedLength <= 93) return REGULAR_CHECKSUM_LENGTH
  if (expandedLength >= 96 && expandedLength <= 1023) {
    return LONG_CHECKSUM_LENGTH
  }
  return null
}

function supportedEncodedLength(length: number): boolean {
  return [48, 54, 61, 67, 74, 127].includes(length)
}

function validChecksum(values: readonly number[], checksumLength: number) {
  return checksumLength === REGULAR_CHECKSUM_LENGTH
    ? polymod(values) === POLYMOD_RESIDUE
    : longPolymod(values) === LONG_POLYMOD_RESIDUE
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

function groupsToBytes(groups: readonly number[]): Codex32Result<Uint8Array> {
  const output: number[] = []
  let accumulator = 0
  let bits = 0
  for (const group of groups) {
    accumulator = (accumulator << 5) | group
    bits += 5
    while (bits >= 8) {
      bits -= 8
      output.push((accumulator >> bits) & 0xff)
      accumulator &= (1 << bits) - 1
    }
  }
  // BIP-93 regular strings deliberately discard the residual 0-4 bits. They
  // are not padding and need not be zero (official vectors 6-8 exercise this).
  if (!SUPPORTED_SECRET_BYTES.has(output.length)) {
    return fail('unsupported-length')
  }
  return { ok: true, value: new Uint8Array(output) }
}

function parseThreshold(character: string): Codex32Share['threshold'] | null {
  if (character === '0') return 0
  const parsed = Number(character)
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 9) return null
  return parsed as Codex32Share['threshold']
}

function encodeGroups(
  threshold: Codex32Share['threshold'],
  identifier: string,
  index: string,
  payload: readonly number[],
): Codex32Result<string> {
  const prefix = `${threshold}${identifier}${index}`
  const values = [...prefix.split('').map(valueOf), ...payload]
  let check: number[] | null = null
  try {
    check = checksum(values)
    const result = `ms1${values
      .map(value => CHARSET[value] ?? '')
      .join('')}${check.map(value => CHARSET[value] ?? '').join('')}`
    if (result.length > MAX_STRING_LENGTH) return fail('unsupported-length')
    return { ok: true, value: result }
  } finally {
    values.fill(0)
    check?.fill(0)
  }
}

/** Encode a pinned BIP-93 secret, including the 64-byte long form. */
export function encodeCodex32(
  input: EncodeCodex32Input,
): Codex32Result<string> {
  let threshold: Codex32Share['threshold']
  let identifier: string
  let index: string
  let secret: Uint8Array | null = null
  try {
    const secretSnapshot = snapshotSecret(input.secret)
    if (!secretSnapshot.ok) return secretSnapshot
    secret = secretSnapshot.value
    threshold = input.threshold
    identifier = input.identifier
    index = input.index
  } catch {
    secret?.fill(0)
    return fail('bad-format')
  }
  if (secret === null) return fail('bad-format')
  let groups: number[] | null = null
  try {
    if (
      typeof threshold !== 'number' ||
      parseThreshold(`${threshold}`) !== threshold
    ) {
      return fail('invalid-threshold')
    }
    if (typeof identifier !== 'string') return fail('invalid-identifier')
    if (typeof index !== 'string') return fail('invalid-index')
    if (!validIdentifier(identifier)) return fail('invalid-identifier')
    if (!validIndex(index)) return fail('invalid-index')
    // This public API encodes raw seed bytes, which are only meaningful at the
    // secret index. Threshold shares use the internal symbol encoder in split().
    if (index !== SECRET_INDEX) return fail('invalid-index')
    groups = bytesToGroups(secret)
    return encodeGroups(threshold, identifier, index, groups)
  } finally {
    secret.fill(0)
    groups?.fill(0)
  }
}

/** Strictly decode one uniformly-cased pinned BIP-93 Codex32 string. */
export function decodeCodex32(text: string): Codex32Result<Codex32Share> {
  const checksumLength =
    typeof text === 'string'
      ? checksumLengthForEncodedLength(text.length)
      : null
  if (
    typeof text !== 'string' ||
    text.length > MAX_STRING_LENGTH ||
    checksumLength === null ||
    !supportedEncodedLength(text.length) ||
    (text !== text.toLowerCase() && text !== text.toUpperCase())
  ) {
    return fail(
      checksumLength === null || !supportedEncodedLength(text.length)
        ? 'unsupported-length'
        : 'bad-format',
    )
  }
  const canonical = text.toLowerCase()
  if (!canonical.startsWith('ms1')) return fail('bad-format')
  const data = canonical.slice(3)
  if (data.length < 6 + checksumLength) return fail('bad-format')
  const values: number[] = []
  for (const character of data) {
    const value = valueOf(character)
    if (value < 0) return fail('bad-format')
    values.push(value)
  }
  if (!validChecksum(values, checksumLength)) return fail('bad-checksum')
  const threshold = parseThreshold(data[0] ?? '')
  if (threshold === null) return fail('invalid-threshold')
  const identifier = data.slice(1, 5)
  if (!validIdentifier(identifier)) return fail('invalid-identifier')
  const index = data[5] ?? ''
  if (!validIndex(index) || (threshold === 0 && index !== SECRET_INDEX)) {
    return fail('invalid-index')
  }
  const payload = values.slice(6, -checksumLength)
  if (!SUPPORTED_PAYLOAD_GROUPS.has(payload.length)) {
    return fail('unsupported-length')
  }
  let seed: Uint8Array | null = null
  if (index === SECRET_INDEX) {
    const decoded = groupsToBytes(payload)
    if (!decoded.ok) return decoded
    seed = decoded.value
  }
  return {
    ok: true,
    value: {
      threshold,
      identifier,
      index,
      payload: new Uint8Array(payload),
      seed,
    },
  }
}

/** Check the pinned regular or long Codex32 checksum framing. */
export function validateCodex32Checksum(text: string): boolean {
  if (typeof text !== 'string') return false
  const checksumLength = checksumLengthForEncodedLength(text.length)
  if (checksumLength === null) return false
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return false
  const canonical = text.toLowerCase()
  if (!canonical.startsWith('ms1')) return false
  const values: number[] = []
  for (const character of canonical.slice(3)) {
    const value = valueOf(character)
    if (value < 0) return false
    values.push(value)
  }
  return (
    values.length >= checksumLength && validChecksum(values, checksumLength)
  )
}

/**
 * Return the complete canonical GF(32) payload for a secret without creating
 * an encoded `s`-index backup string. Signup ceremonies use this to compare
 * all payload symbols, including the residual bits that byte recovery drops.
 */
export function codex32SecretPayloadSymbols(
  secretValue: Uint8Array,
): Codex32Result<Uint8Array> {
  const snapshot = snapshotSecret(secretValue)
  if (!snapshot.ok) return snapshot
  const secret = snapshot.value
  let groups: number[] | null = null
  try {
    groups = bytesToGroups(secret)
    return { ok: true, value: new Uint8Array(groups) }
  } finally {
    secret.fill(0)
    groups?.fill(0)
  }
}

// GF(32), represented in the Codex32 alphabet's five-bit values, reduced by
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

function interpolateAt(
  points: readonly { readonly x: number; readonly y: number }[],
  target: number,
): number {
  let output = 0
  for (let current = 0; current < points.length; current += 1) {
    const point = points[current]
    if (point === undefined) continue
    let numerator = 1
    let denominator = 1
    for (let other = 0; other < points.length; other += 1) {
      if (other === current) continue
      const otherPoint = points[other]
      if (otherPoint === undefined) continue
      numerator = multiply(numerator, target ^ otherPoint.x)
      denominator = multiply(denominator, point.x ^ otherPoint.x)
    }
    output ^= multiply(point.y, multiply(numerator, inverse(denominator)))
  }
  return output
}

/**
 * Interpolate the payload symbols at any index from decoded shares. With exactly the
 * threshold number of shares of one split this yields the share (or, at `s`, the secret)
 * that split has at that index, so it also answers whether a further share belongs to the
 * same split. The caller supplies shares of one header; indices must be distinct.
 */
export function interpolateCodex32Symbols(
  shares: readonly Pick<Codex32Share, 'index' | 'payload'>[],
  targetIndex: string,
): Codex32Result<Uint8Array> {
  let xs: number[]
  let rows: Uint8Array[]
  try {
    if (!Array.isArray(shares) || shares.length < 2 || shares.length > 9) {
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

/** Convert interpolated secret-index payload symbols to seed bytes. */
export function codex32SymbolsToBytes(
  symbols: Uint8Array,
): Codex32Result<Uint8Array> {
  if (!(symbols instanceof Uint8Array)) return fail('bad-format')
  return groupsToBytes(Array.from(symbols))
}

/**
 * Split seed bytes with BIP-93's GF(32) threshold construction. This is not a
 * generic Shamir API: identifiers, indices, encoding, and field are Codex32.
 */
export function splitCodex32(
  input: SplitCodex32Input,
): Codex32Result<readonly string[]> {
  let secret: Uint8Array | null = null
  let threshold: SplitCodex32Input['threshold']
  let identifier: string
  let indices: string[] | null
  let randomBytes: SplitCodex32Input['randomBytes']
  try {
    const secretSnapshot = snapshotSecret(input.secret)
    if (!secretSnapshot.ok) return secretSnapshot
    secret = secretSnapshot.value
    threshold = input.threshold
    identifier = input.identifier
    const indicesSnapshot = snapshotStrings(
      input.indices,
      typeof threshold === 'number' &&
        Number.isInteger(threshold) &&
        threshold >= 2 &&
        threshold <= 9
        ? threshold
        : 0,
    )
    if (!indicesSnapshot.ok) {
      secret.fill(0)
      return indicesSnapshot
    }
    indices = indicesSnapshot.value
    randomBytes = input.randomBytes
  } catch {
    secret?.fill(0)
    return fail('bad-format')
  }
  if (secret === null || indices === null) {
    secret?.fill(0)
    return fail('bad-format')
  }
  let random: Uint8Array | null = null
  let secretGroups: number[] | null = null
  let shareGroups: number[][] | null = null
  try {
    if (
      typeof threshold !== 'number' ||
      !Number.isInteger(threshold) ||
      threshold < 2 ||
      threshold > 9
    ) {
      return fail('invalid-threshold')
    }
    if (typeof identifier !== 'string') return fail('invalid-identifier')
    if (!validIdentifier(identifier)) return fail('invalid-identifier')
    const seen = new Set<string>()
    for (const index of indices) {
      if (!validIndex(index) || index === SECRET_INDEX) {
        return fail('invalid-index')
      }
      if (seen.has(index)) return fail('duplicate-share')
      seen.add(index)
    }
    secretGroups = bytesToGroups(secret)
    const randomLength = secretGroups.length * (threshold - 1)
    if (typeof randomBytes !== 'function') return fail('rng-failed')
    let suppliedRandom: Uint8Array
    try {
      suppliedRandom = randomBytes(randomLength)
      if (
        !(suppliedRandom instanceof Uint8Array) ||
        suppliedRandom.length !== randomLength
      ) {
        return fail('rng-failed')
      }
      random = new Uint8Array(suppliedRandom)
    } catch {
      return fail('rng-failed')
    }
    const secretX = valueOf(SECRET_INDEX)
    shareGroups = indices.map(
      () => new Array<number>(secretGroups?.length ?? 0),
    )
    for (let column = 0; column < secretGroups.length; column += 1) {
      const shiftedCoefficients = [secretGroups[column] ?? 0]
      for (let degree = 1; degree < threshold; degree += 1) {
        shiftedCoefficients.push(
          (random[column * (threshold - 1) + degree - 1] ?? 0) & 31,
        )
      }
      for (let share = 0; share < indices.length; share += 1) {
        const x = valueOf(indices[share] ?? '') ^ secretX
        const columns = shareGroups[share]
        if (columns !== undefined) {
          columns[column] = evaluate(shiftedCoefficients, x)
        }
      }
      shiftedCoefficients.fill(0)
    }
    const encoded: string[] = []
    for (let share = 0; share < indices.length; share += 1) {
      const groups = shareGroups[share]
      if (groups === undefined) return fail('bad-format')
      const item = encodeGroups(
        threshold,
        identifier,
        indices[share] ?? '',
        groups,
      )
      if (!item.ok) return item
      encoded.push(item.value)
    }
    return { ok: true, value: encoded }
  } finally {
    secret.fill(0)
    secretGroups?.fill(0)
    random?.fill(0)
    for (const groups of shareGroups ?? []) groups.fill(0)
  }
}

/** Recover seed bytes from exactly the threshold number of consistent shares. */
export function recoverCodex32Exact(
  encodedShares: readonly string[],
): Codex32Result<RecoveredCodex32> {
  const snapshot = snapshotStrings(encodedShares, 1)
  if (!snapshot.ok) return snapshot
  const snapshots = snapshot.value
  const parsed: Codex32Share[] = []
  let secretGroups: number[] | null = null
  try {
    for (const encoded of snapshots) {
      const share = decodeCodex32(encoded)
      if (!share.ok) return share
      parsed.push(share.value)
    }
    const first = parsed[0]
    if (first === undefined || first.threshold === 0) {
      return fail('invalid-threshold')
    }
    if (parsed.length !== first.threshold) return fail('wrong-share-count')
    const seen = new Set<string>()
    for (const share of parsed) {
      if (share.index === SECRET_INDEX) return fail('invalid-index')
      if (seen.has(share.index)) return fail('duplicate-share')
      seen.add(share.index)
      if (
        share.threshold !== first.threshold ||
        share.identifier !== first.identifier ||
        share.payload.length !== first.payload.length
      ) {
        return fail('inconsistent-share')
      }
    }
    const groupRows = parsed.map(share => share.payload)
    secretGroups = new Array<number>(groupRows[0]?.length ?? 0)
    const target = valueOf(SECRET_INDEX)
    for (let column = 0; column < secretGroups.length; column += 1) {
      secretGroups[column] = interpolateAt(
        parsed.map((share, row) => ({
          x: valueOf(share.index),
          y: groupRows[row]?.[column] ?? 0,
        })),
        target,
      )
    }
    const recovered = groupsToBytes(secretGroups)
    if (!recovered.ok) return recovered
    return {
      ok: true,
      value: {
        secret: recovered.value,
        payloadSymbols: new Uint8Array(secretGroups),
      },
    }
  } finally {
    secretGroups?.fill(0)
    for (const share of parsed) {
      share.payload.fill(0)
      share.seed?.fill(0)
    }
  }
}

/** Backwards-compatible byte-only recovery. Prefer recoverCodex32Exact. */
export function recoverCodex32(
  encodedShares: readonly string[],
): Codex32Result<Uint8Array> {
  const recovered = recoverCodex32Exact(encodedShares)
  if (!recovered.ok) return recovered
  const secret = new Uint8Array(recovered.value.secret)
  recovered.value.secret.fill(0)
  recovered.value.payloadSymbols.fill(0)
  return { ok: true, value: secret }
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
