const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const SECRET_INDEX = 's'
const CHECKSUM_LENGTH = 13
const MIN_SECRET_BYTES = 16
const MAX_STANDARD_SECRET_BYTES = 32
const MAX_STRING_LENGTH = 93
const POLYMOD_INITIAL = 0x23181b3n
const POLYMOD_RESIDUE = 0x10ce0795c2fd1e62an
const GENERATORS = [
  0x19dc500ce73fde210n,
  0x1bfae00def77fe529n,
  0x1fbd920fffe7bee52n,
  0x1739640bdeee3fdadn,
  0x07729a039cfc75f5an,
] as const

export type Codex32ErrorCode =
  | 'bad-format'
  | 'bad-checksum'
  | 'unsupported-length'
  | 'invalid-threshold'
  | 'invalid-identifier'
  | 'invalid-index'
  | 'noncanonical-padding'
  | 'insufficient-shares'
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
  const residue =
    polymod([...values, ...new Array<number>(CHECKSUM_LENGTH).fill(0)]) ^
    POLYMOD_RESIDUE
  const out = new Array<number>(CHECKSUM_LENGTH)
  for (let index = 0; index < CHECKSUM_LENGTH; index += 1) {
    const shift = BigInt(5 * (CHECKSUM_LENGTH - 1 - index))
    out[index] = Number((residue >> shift) & 31n)
  }
  return out
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
  if (bits >= 5 || accumulator !== 0) return fail('noncanonical-padding')
  if (
    output.length < MIN_SECRET_BYTES ||
    output.length > MAX_STANDARD_SECRET_BYTES
  ) {
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
  const result = `ms1${values
    .map(value => CHARSET[value] ?? '')
    .join('')}${checksum(values)
    .map(value => CHARSET[value] ?? '')
    .join('')}`
  if (result.length > MAX_STRING_LENGTH) return fail('unsupported-length')
  return { ok: true, value: result }
}

/** Encode the BIP-93 standard-checksum form (16 through 32 secret bytes). */
export function encodeCodex32(
  input: EncodeCodex32Input,
): Codex32Result<string> {
  if (parseThreshold(String(input.threshold)) !== input.threshold) {
    return fail('invalid-threshold')
  }
  if (!validIdentifier(input.identifier)) return fail('invalid-identifier')
  if (!validIndex(input.index)) return fail('invalid-index')
  if (input.threshold === 0 && input.index !== SECRET_INDEX) {
    return fail('invalid-index')
  }
  if (!(input.secret instanceof Uint8Array)) return fail('bad-format')
  if (
    input.secret.length < MIN_SECRET_BYTES ||
    input.secret.length > MAX_STANDARD_SECRET_BYTES
  ) {
    return fail('unsupported-length')
  }
  return encodeGroups(
    input.threshold,
    input.identifier,
    input.index,
    bytesToGroups(input.secret),
  )
}

/** Strictly decode one canonical lowercase standard-checksum Codex32 string. */
export function decodeCodex32(text: string): Codex32Result<Codex32Share> {
  if (
    typeof text !== 'string' ||
    text.length > MAX_STRING_LENGTH ||
    !text.startsWith('ms1') ||
    text !== text.toLowerCase()
  ) {
    return fail('bad-format')
  }
  const data = text.slice(3)
  if (data.length < 6 + CHECKSUM_LENGTH) return fail('bad-format')
  const values: number[] = []
  for (const character of data) {
    const value = valueOf(character)
    if (value < 0) return fail('bad-format')
    values.push(value)
  }
  if (polymod(values) !== POLYMOD_RESIDUE) return fail('bad-checksum')
  const threshold = parseThreshold(data[0] ?? '')
  if (threshold === null) return fail('invalid-threshold')
  const identifier = data.slice(1, 5)
  if (!validIdentifier(identifier)) return fail('invalid-identifier')
  const index = data[5] ?? ''
  if (!validIndex(index) || (threshold === 0 && index !== SECRET_INDEX)) {
    return fail('invalid-index')
  }
  const payload = values.slice(6, -CHECKSUM_LENGTH)
  if (payload.length < 26 || payload.length > 52) {
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

/** Check only the canonical lowercase standard Codex32 checksum framing. */
export function validateCodex32Checksum(text: string): boolean {
  if (
    typeof text !== 'string' ||
    text.length > MAX_STRING_LENGTH ||
    !text.startsWith('ms1') ||
    text !== text.toLowerCase()
  ) {
    return false
  }
  const values: number[] = []
  for (const character of text.slice(3)) {
    const value = valueOf(character)
    if (value < 0) return false
    values.push(value)
  }
  return values.length >= CHECKSUM_LENGTH && polymod(values) === POLYMOD_RESIDUE
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
 * Split seed bytes with BIP-93's GF(32) threshold construction. This is not a
 * generic Shamir API: identifiers, indices, encoding, and field are Codex32.
 */
export function splitCodex32(
  input: SplitCodex32Input,
): Codex32Result<readonly string[]> {
  if (input.threshold < 2 || input.threshold > 9) {
    return fail('invalid-threshold')
  }
  if (!validIdentifier(input.identifier)) return fail('invalid-identifier')
  if (
    !(input.secret instanceof Uint8Array) ||
    input.secret.length < MIN_SECRET_BYTES ||
    input.secret.length > MAX_STANDARD_SECRET_BYTES
  ) {
    return fail('unsupported-length')
  }
  if (input.indices.length < input.threshold || input.indices.length > 31) {
    return fail('insufficient-shares')
  }
  const seen = new Set<string>()
  for (const index of input.indices) {
    if (!validIndex(index) || index === SECRET_INDEX)
      return fail('invalid-index')
    if (seen.has(index)) return fail('duplicate-share')
    seen.add(index)
  }
  const secretGroups = bytesToGroups(input.secret)
  const randomLength = secretGroups.length * (input.threshold - 1)
  let suppliedRandom: Uint8Array
  try {
    suppliedRandom = input.randomBytes(randomLength)
  } catch {
    return fail('rng-failed')
  }
  if (
    !(suppliedRandom instanceof Uint8Array) ||
    suppliedRandom.length !== randomLength
  ) {
    return fail('rng-failed')
  }
  const random = new Uint8Array(suppliedRandom)
  const secretX = valueOf(SECRET_INDEX)
  const shareGroups = input.indices.map(
    () => new Array<number>(secretGroups.length),
  )
  for (let column = 0; column < secretGroups.length; column += 1) {
    const shiftedCoefficients = [secretGroups[column] ?? 0]
    for (let degree = 1; degree < input.threshold; degree += 1) {
      shiftedCoefficients.push(
        (random[column * (input.threshold - 1) + degree - 1] ?? 0) & 31,
      )
    }
    for (let share = 0; share < input.indices.length; share += 1) {
      const x = valueOf(input.indices[share] ?? '') ^ secretX
      const columns = shareGroups[share]
      if (columns !== undefined)
        columns[column] = evaluate(shiftedCoefficients, x)
    }
  }
  random.fill(0)
  const encoded: string[] = []
  for (let share = 0; share < input.indices.length; share += 1) {
    const groups = shareGroups[share]
    if (groups === undefined) return fail('bad-format')
    const item = encodeGroups(
      input.threshold,
      input.identifier,
      input.indices[share] ?? '',
      groups,
    )
    if (!item.ok) return item
    encoded.push(item.value)
  }
  return { ok: true, value: encoded }
}

/** Recover seed bytes from at least the threshold number of consistent shares. */
export function recoverCodex32(
  encodedShares: readonly string[],
): Codex32Result<Uint8Array> {
  if (encodedShares.length === 0 || encodedShares.length > 31) {
    return fail('insufficient-shares')
  }
  const parsed: Codex32Share[] = []
  for (const encoded of encodedShares) {
    const share = decodeCodex32(encoded)
    if (!share.ok) return share
    parsed.push(share.value)
  }
  const first = parsed[0]
  if (first === undefined || first.threshold === 0) {
    return fail('invalid-threshold')
  }
  if (parsed.length < first.threshold) return fail('insufficient-shares')
  const seen = new Set<string>()
  for (const share of parsed) {
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
  const secretGroups = new Array<number>(groupRows[0]?.length ?? 0)
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
  return { ok: true, value: recovered.value }
}
