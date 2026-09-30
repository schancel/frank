import {
  concatBytes,
  copyBytes,
  decodeUnsignedBE,
  decodeUnsignedLE,
  encodeNumberBE,
  encodeNumberLE,
  encodeUnsignedBE,
  encodeUnsignedLE,
  reverseBytes,
} from './bytes.js'
import { EncodingException, type EncodingResult } from './encoding-error.js'
import { decodeVarint, encodeVarint } from './varint.js'

const UINT64_MAX = (1n << 64n) - 1n

function readWidth(
  bytes: Uint8Array,
  offset: number,
  length: number,
): EncodingResult<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0) {
    return {
      ok: false,
      error: {
        code: 'reader-truncated',
        needed: 0,
        available: Math.max(0, bytes.length - offset),
      },
    }
  }
  const available = bytes.length - offset
  if (length > available) {
    return {
      ok: false,
      error: { code: 'reader-truncated', needed: length, available },
    }
  }
  return { ok: true, value: bytes.slice(offset, offset + length) }
}

export class ByteReader {
  private data: Uint8Array
  private offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.data = copyBytes(bytes)
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.data.length
    ) {
      throw new EncodingException({
        code: 'reader-truncated',
        needed: Number.isSafeInteger(offset) ? offset : 0,
        available: this.data.length,
      })
    }
    this.offset = offset
  }

  get position(): number {
    return this.offset
  }

  finished(): boolean {
    return this.offset >= this.data.length
  }

  read(length: number): EncodingResult<Uint8Array> {
    const slice = readWidth(this.data, this.offset, length)
    if (!slice.ok) return slice
    this.offset += length
    return slice
  }

  readAll(): Uint8Array {
    const value = this.data.slice(this.offset)
    this.offset = this.data.length
    return value
  }

  readReverse(length: number): EncodingResult<Uint8Array> {
    const slice = this.read(length)
    if (!slice.ok) return slice
    return { ok: true, value: reverseBytes(slice.value) }
  }

  reverse(): this {
    this.data = reverseBytes(this.data)
    return this
  }

  readUInt8(): EncodingResult<number> {
    return this.readNumber(1, false)
  }

  readUInt16BE(): EncodingResult<number> {
    return this.readNumber(2, false)
  }

  readUInt16LE(): EncodingResult<number> {
    return this.readNumber(2, true)
  }

  readUInt32BE(): EncodingResult<number> {
    return this.readNumber(4, false)
  }

  readUInt32LE(): EncodingResult<number> {
    return this.readNumber(4, true)
  }

  readUInt64BE(): EncodingResult<bigint> {
    return this.readBig(false)
  }

  readUInt64LE(): EncodingResult<bigint> {
    return this.readBig(true)
  }

  readVarint(): EncodingResult<bigint> {
    const decoded = decodeVarint(this.data, this.offset)
    if (!decoded.ok) return decoded
    this.offset = decoded.value.next
    return { ok: true, value: decoded.value.value }
  }

  /** Varint length, then that many bytes. A short buffer does not allocate or move. */
  readBytesPrefixed(): EncodingResult<Uint8Array> {
    const start = this.offset
    const length = this.readVarint()
    if (!length.ok) return length
    const available = this.data.length - this.offset
    if (length.value > BigInt(available)) {
      this.offset = start
      const exact = length.value
      const saturated = exact > BigInt(Number.MAX_SAFE_INTEGER)
      return {
        ok: false,
        error: {
          code: 'reader-truncated',
          needed: saturated ? Number.MAX_SAFE_INTEGER : Number(exact),
          available,
          ...(saturated ? { length: exact } : {}),
        },
      }
    }
    return this.read(Number(length.value))
  }

  private readNumber(length: number, little: boolean): EncodingResult<number> {
    const slice = this.read(length)
    if (!slice.ok) return slice
    const value = little
      ? decodeUnsignedLE(slice.value)
      : decodeUnsignedBE(slice.value)
    return { ok: true, value: Number(value) }
  }

  private readBig(little: boolean): EncodingResult<bigint> {
    const slice = this.read(8)
    if (!slice.ok) return slice
    const value = little
      ? decodeUnsignedLE(slice.value)
      : decodeUnsignedBE(slice.value)
    return { ok: true, value }
  }
}

export class ByteWriter {
  private readonly chunks: Uint8Array[] = []

  write(bytes: Uint8Array): this {
    this.chunks.push(copyBytes(bytes))
    return this
  }

  writeReverse(bytes: Uint8Array): this {
    return this.write(reverseBytes(copyBytes(bytes)))
  }

  writeUInt8(value: number): this {
    return this.push(encodeNumberLE(value, 1, 0xff))
  }

  writeUInt16BE(value: number): this {
    return this.push(encodeNumberBE(value, 2, 0xffff))
  }

  writeUInt16LE(value: number): this {
    return this.push(encodeNumberLE(value, 2, 0xffff))
  }

  writeUInt32BE(value: number): this {
    return this.push(encodeNumberBE(value, 4, 0xffffffff))
  }

  writeUInt32LE(value: number): this {
    return this.push(encodeNumberLE(value, 4, 0xffffffff))
  }

  writeUInt64BE(value: bigint): this {
    if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
      throw new EncodingException({ code: 'integer-out-of-range' })
    }
    return this.push(encodeUnsignedBE(value, 8))
  }

  writeUInt64LE(value: bigint): this {
    if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
      throw new EncodingException({ code: 'integer-out-of-range' })
    }
    return this.push(encodeUnsignedLE(value, 8))
  }

  writeVarint(value: bigint): this {
    const encoded = encodeVarint(value)
    if (!encoded.ok) throw new EncodingException(encoded.error)
    this.chunks.push(encoded.value)
    return this
  }

  finish(): Uint8Array {
    return concatBytes(this.chunks)
  }

  private push(result: EncodingResult<Uint8Array>): this {
    if (!result.ok) throw new EncodingException(result.error)
    this.chunks.push(result.value)
    return this
  }
}
