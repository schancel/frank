// Private, fixed-schema deterministic-CBOR codec for crypto-box envelopes.
// This is deliberately not a general CBOR implementation.

import {
  ENC_LENGTH,
  ENVELOPE_VERSION,
  LEGACY_ENVELOPE_VERSION,
  MAX_MESSAGE,
  MAX_PADDING,
  SALT_LENGTH,
} from './ids.js'

const MAP_SIZE = 6
const AEAD_TAG_LENGTH = 16
const INNER_LENGTH_PREFIX = 4
const MIN_CIPHERTEXT = INNER_LENGTH_PREFIX + AEAD_TAG_LENGTH
const MAX_CIPHERTEXT =
  INNER_LENGTH_PREFIX + MAX_MESSAGE + MAX_PADDING + AEAD_TAG_LENGTH
const MAX_ENVELOPE = 88 + MAX_CIPHERTEXT
const LEGACY_HEADER = 1 + 2 + 2 + SALT_LENGTH + ENC_LENGTH
const MAX_LEGACY_ENVELOPE = LEGACY_HEADER + MAX_CIPHERTEXT

export interface DecodedEnvelope {
  readonly version: number
  readonly suiteId: number
  readonly kemId: number
  readonly salt: Uint8Array
  readonly enc: Uint8Array
  readonly ciphertext: Uint8Array
}

function head(major: number, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('CBOR value out of range')
  }
  const prefix = major << 5
  if (value < 24) return Uint8Array.of(prefix | value)
  if (value <= 0xff) return Uint8Array.of(prefix | 24, value)
  if (value <= 0xffff) {
    return Uint8Array.of(prefix | 25, value >>> 8, value & 0xff)
  }
  return Uint8Array.of(
    prefix | 26,
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  )
}

function encodedLength(major: number, bytes: Uint8Array): Uint8Array {
  const prefix = head(major, bytes.length)
  const out = new Uint8Array(prefix.length + bytes.length)
  out.set(prefix)
  out.set(bytes, prefix.length)
  return out
}

export function encodeEnvelope(
  suiteId: number,
  kemId: number,
  salt: Uint8Array,
  enc: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const fields = [
    head(5, MAP_SIZE),
    head(0, 0),
    head(0, ENVELOPE_VERSION),
    head(0, 1),
    head(0, suiteId),
    head(0, 2),
    head(0, kemId),
    head(0, 3),
    encodedLength(2, salt),
    head(0, 4),
    encodedLength(2, enc),
    head(0, 5),
    encodedLength(2, ciphertext),
  ]
  let length = 0
  for (const field of fields) length += field.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const field of fields) {
    out.set(field, offset)
    offset += field.length
  }
  return out
}

class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length
  }

  readExact(value: number): boolean {
    if (this.bytes[this.offset] !== value) return false
    this.offset += 1
    return true
  }

  readUint(major: number): number | null {
    const initial = this.bytes[this.offset]
    if (initial === undefined || initial >>> 5 !== major) return null
    this.offset += 1
    const additional = initial & 0x1f
    if (additional < 24) return additional
    if (additional === 24) {
      const value = this.bytes[this.offset]
      if (value === undefined || value < 24) return null
      this.offset += 1
      return value
    }
    if (additional === 25) {
      const high = this.bytes[this.offset]
      const low = this.bytes[this.offset + 1]
      if (high === undefined || low === undefined) return null
      const value = high * 0x100 + low
      if (value <= 0xff) return null
      this.offset += 2
      return value
    }
    if (additional === 26) {
      const a = this.bytes[this.offset]
      const b = this.bytes[this.offset + 1]
      const c = this.bytes[this.offset + 2]
      const d = this.bytes[this.offset + 3]
      if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined
      ) {
        return null
      }
      const value = a * 0x1000000 + b * 0x10000 + c * 0x100 + d
      if (value <= 0xffff) return null
      this.offset += 4
      return value
    }
    return null
  }

  readBytes(exactLength: number | null, maxLength: number): Uint8Array | null {
    const length = this.readUint(2)
    if (
      length === null ||
      length > maxLength ||
      (exactLength !== null && length !== exactLength) ||
      length > this.bytes.length - this.offset
    ) {
      return null
    }
    const value = new Uint8Array(
      this.bytes.subarray(this.offset, this.offset + length),
    )
    this.offset += length
    return value
  }
}

function decodeCborEnvelope(bytes: Uint8Array): DecodedEnvelope | null {
  if (bytes.length > MAX_ENVELOPE) return null
  const reader = new Reader(bytes)
  if (!reader.readExact(0xa0 | MAP_SIZE)) return null
  if (!reader.readExact(0)) return null
  const version = reader.readUint(0)
  if (!reader.readExact(1)) return null
  const suiteId = reader.readUint(0)
  if (!reader.readExact(2)) return null
  const kemId = reader.readUint(0)
  if (!reader.readExact(3)) return null
  const salt = reader.readBytes(SALT_LENGTH, SALT_LENGTH)
  if (!reader.readExact(4)) return null
  const enc = reader.readBytes(ENC_LENGTH, ENC_LENGTH)
  if (!reader.readExact(5)) return null
  const ciphertext = reader.readBytes(null, MAX_CIPHERTEXT)
  if (
    version !== ENVELOPE_VERSION ||
    suiteId === null ||
    kemId === null ||
    salt === null ||
    enc === null ||
    ciphertext === null ||
    ciphertext.length < MIN_CIPHERTEXT ||
    !reader.done
  ) {
    return null
  }
  return { version, suiteId, kemId, salt, enc, ciphertext }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 0x100 + (bytes[offset + 1] ?? 0)
}

function decodeLegacyEnvelope(bytes: Uint8Array): DecodedEnvelope | null {
  if (
    bytes.length < LEGACY_HEADER + MIN_CIPHERTEXT ||
    bytes.length > MAX_LEGACY_ENVELOPE
  ) {
    return null
  }
  const saltOffset = 5
  const encOffset = saltOffset + SALT_LENGTH
  const ciphertextOffset = encOffset + ENC_LENGTH
  return {
    version: LEGACY_ENVELOPE_VERSION,
    suiteId: readU16(bytes, 1),
    kemId: readU16(bytes, 3),
    salt: new Uint8Array(bytes.subarray(saltOffset, encOffset)),
    enc: new Uint8Array(bytes.subarray(encOffset, ciphertextOffset)),
    ciphertext: new Uint8Array(bytes.subarray(ciphertextOffset)),
  }
}

export function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope | null {
  if (bytes[0] === LEGACY_ENVELOPE_VERSION) return decodeLegacyEnvelope(bytes)
  if (bytes[0] === (0xa0 | MAP_SIZE)) return decodeCborEnvelope(bytes)
  return null
}
