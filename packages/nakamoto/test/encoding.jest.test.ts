import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decodeBase32, encodeBase32 } from '../src/base32.js'
import { decodeBase58, encodeBase58 } from '../src/base58.js'
import { decodeBase58Check, encodeBase58Check } from '../src/base58check.js'
import { convertBits } from '../src/convert-bits.js'
import { EncodingException, isEncodingError } from '../src/encoding-error.js'
import { ByteReader, ByteWriter } from '../src/reader.js'
import { decodeVarint, encodeVarint } from '../src/varint.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  encoding: {
    Base58: {
      encode(buf: Uint8Array): string
      decode(text: string): { toString(encoding: 'hex'): string }
    }
    Base58Check: {
      encode(buf: Uint8Array): string
      decode(text: string): { toString(encoding: 'hex'): string }
    }
    BufferWriter: new () => {
      writeUInt8(value: number): {
        writeUInt16BE(value: number): {
          writeUInt16LE(value: number): {
            writeUInt32BE(value: number): {
              writeUInt32LE(value: number): {
                concat(): { toString(encoding: 'hex'): string }
              }
            }
          }
        }
      }
      writeUInt32LE(value: number): {
        concat(): { toString(encoding: 'hex'): string }
      }
      writeUInt64BEBN(value: unknown): {
        concat(): { toString(encoding: 'hex'): string }
      }
      writeUInt64LEBN(value: unknown): {
        concat(): { toString(encoding: 'hex'): string }
      }
      writeVarintNum(value: number): {
        concat(): { toString(encoding: 'hex'): string; length: number }
      }
    }
    BufferReader: new (buf: Buffer) => {
      readUInt64LEBN(): { toString(radix: number): string }
      readUInt64BEBN(): { toString(radix: number): string }
      readVarintBN(): { toString(radix: number): string }
    }
  }
  crypto: { BN: new (value: string | number) => unknown }
}

const payload = Uint8Array.of(0, 1, 2, 3, 253, 254, 255)
const payloadBase58 = '1W7N4RuG'
const payloadCheck = '14HV44ipwoaqfg'

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function mustVarint(value: bigint): Uint8Array {
  const encoded = encodeVarint(value)
  if (!encoded.ok) throw new Error(encoded.error.code)
  return encoded.value
}

describe('base58', () => {
  test('the known payload round-trips and matches bitcore', () => {
    expect(encodeBase58(payload)).toBe(payloadBase58)
    expect(encodeBase58(payload)).toBe(
      old.encoding.Base58.encode(Buffer.from(payload)),
    )
    const decoded = decodeBase58(payloadBase58)
    expect(decoded).toEqual({ ok: true, value: payload })
    expect(old.encoding.Base58.decode(payloadBase58).toString('hex')).toBe(
      hex(payload),
    )
  })

  test('leading zero bytes are leading ones', () => {
    expect(encodeBase58(new Uint8Array())).toBe('')
    expect(decodeBase58('')).toEqual({ ok: true, value: new Uint8Array() })
    const zeros = Uint8Array.of(0, 0, 0)
    expect(encodeBase58(zeros)).toBe('111')
    expect(encodeBase58(zeros)).toBe(
      old.encoding.Base58.encode(Buffer.from(zeros)),
    )
    expect(decodeBase58('111')).toEqual({ ok: true, value: zeros })
  })

  test('characters outside the alphabet are a typed error', () => {
    expect(decodeBase58('10')).toEqual({
      ok: false,
      error: { code: 'base58-invalid-char', index: 1, char: '0' },
    })
    expect(decodeBase58(0 as unknown as string)).toEqual({
      ok: false,
      error: { code: 'base58-invalid-type' },
    })
    expect(
      isEncodingError({ code: 'base58-invalid-char', index: 1, char: '0' }),
    ).toBe(true)
    expect(isEncodingError(new Error('Input should be a string'))).toBe(false)
  })

  test('a Node Buffer is not accepted as the byte type', () => {
    expect(() => encodeBase58(Buffer.from(payload))).toThrow(EncodingException)
    try {
      encodeBase58(Buffer.from(payload))
      throw new Error('Buffer was accepted')
    } catch (error) {
      expect(isEncodingError(error)).toBe(true)
      expect(error).toMatchObject({ code: 'bytes-expected' })
    }
  })
})

describe('base58check', () => {
  test('the known payload round-trips and matches bitcore', () => {
    expect(encodeBase58Check(payload)).toBe(payloadCheck)
    expect(encodeBase58Check(payload)).toBe(
      old.encoding.Base58Check.encode(Buffer.from(payload)),
    )
    expect(decodeBase58Check(payloadCheck)).toEqual({
      ok: true,
      value: payload,
    })
    expect(old.encoding.Base58Check.decode(payloadCheck).toString('hex')).toBe(
      hex(payload),
    )
  })

  test('a truncated checksum is rejected', () => {
    expect(decodeBase58Check(payloadCheck.slice(0, 1))).toEqual({
      ok: false,
      error: { code: 'base58check-too-short', length: 1 },
    })
    const full = decodeBase58(encodeBase58Check(payload))
    if (!full.ok) throw new Error(full.error.code)
    const short = full.value.slice(0, -1)
    const decoded = decodeBase58Check(encodeBase58(short))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) {
      expect(['base58check-too-short', 'base58check-checksum']).toContain(
        decoded.error.code,
      )
    }
  })

  test('a flipped checksum byte is rejected', () => {
    const full = decodeBase58(payloadCheck)
    if (!full.ok) throw new Error(full.error.code)
    const flippedPayload = new Uint8Array(full.value)
    flippedPayload[0] = (flippedPayload[0] ?? 0) + 1
    expect(decodeBase58Check(encodeBase58(flippedPayload))).toEqual({
      ok: false,
      error: { code: 'base58check-checksum' },
    })
    const flippedChecksum = new Uint8Array(full.value)
    const last = flippedChecksum.length - 1
    flippedChecksum[last] = (flippedChecksum[last] ?? 0) ^ 1
    expect(decodeBase58Check(encodeBase58(flippedChecksum))).toEqual({
      ok: false,
      error: { code: 'base58check-checksum' },
    })
    const address = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'
    expect(decodeBase58Check(address).ok).toBe(true)
    expect(decodeBase58Check(`${address}a`).ok).toBe(false)
    expect(isEncodingError({ code: 'base58check-checksum' })).toBe(true)
    expect(isEncodingError(new Error('Checksum mismatch'))).toBe(false)
  })

  test('Bitcoin Core base58 key vectors agree with bitcore', () => {
    const dataDir = join(__dirname, '../../bitcore-lib-xpi/test/data/bitcoind')
    const valid = JSON.parse(
      readFileSync(join(dataDir, 'base58_keys_valid.json'), 'utf8'),
    ) as [string, string, { addrType: string }][]
    const invalid = JSON.parse(
      readFileSync(join(dataDir, 'base58_keys_invalid.json'), 'utf8'),
    ) as [string][]
    const compare = (address: string) => {
      let oldHex: string | undefined
      try {
        oldHex = old.encoding.Base58Check.decode(address).toString('hex')
      } catch {
        expect(decodeBase58Check(address).ok).toBe(false)
        return
      }
      const decoded = decodeBase58Check(address)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok || oldHex === undefined) return
      expect(hex(decoded.value)).toBe(oldHex)
      expect(encodeBase58Check(decoded.value)).toBe(address)
    }
    expect(decodeBase58Check(valid[0]?.[0] ?? '').ok).toBe(true)
    for (const [address] of valid) compare(address)
    for (const [address] of invalid) compare(address)
  })
})

describe('varint', () => {
  test('widths match the old writer vectors', () => {
    const cases: ReadonlyArray<readonly [bigint, number, string]> = [
      [1n, 1, '01'],
      [1000n, 3, 'fde803'],
      [1n << 17n, 5, 'fe00000200'],
      [1n << 33n, 9, 'ff0000000002000000'],
    ]
    for (const [value, length, encoded] of cases) {
      const bytes = mustVarint(value)
      expect(bytes).toHaveLength(length)
      expect(hex(bytes)).toBe(encoded)
      const decoded = decodeVarint(bytes)
      expect(decoded).toEqual({
        ok: true,
        value: { value, next: length },
      })
      if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const theirs = new old.encoding.BufferWriter()
          .writeVarintNum(Number(value))
          .concat()
        expect(theirs.toString('hex')).toBe(encoded)
        expect(theirs.length).toBe(length)
      }
    }
  })

  test('values above 2^53 stay exact', () => {
    const above = (1n << 53n) + 1n
    const bytes = mustVarint(above)
    expect(bytes).toHaveLength(9)
    const decoded = decodeVarint(bytes)
    expect(decoded).toEqual({ ok: true, value: { value: above, next: 9 } })
    const max = (1n << 64n) - 1n
    const maxBytes = Uint8Array.of(
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    )
    expect(decodeVarint(maxBytes)).toEqual({
      ok: true,
      value: { value: max, next: 9 },
    })
    const theirs = new old.encoding.BufferReader(
      Buffer.from(maxBytes),
    ).readVarintBN()
    expect(theirs.toString(10)).toBe(max.toString(10))
  })

  test('a truncated or non-minimal compact size is rejected', () => {
    expect(decodeVarint(Uint8Array.of(0xfd))).toEqual({
      ok: false,
      error: { code: 'varint-truncated', needed: 2, available: 0 },
    })
    expect(decodeVarint(Uint8Array.of(0xfd, 0x01, 0x00))).toEqual({
      ok: false,
      error: { code: 'varint-non-minimal' },
    })
    expect(decodeVarint(Uint8Array.of(0xfe, 0xff, 0xff, 0x00, 0x00))).toEqual({
      ok: false,
      error: { code: 'varint-non-minimal' },
    })
    const negative = encodeVarint(-1n)
    expect(negative).toEqual({
      ok: false,
      error: { code: 'varint-out-of-range' },
    })
    expect(encodeVarint(1n << 64n)).toEqual({
      ok: false,
      error: { code: 'varint-out-of-range' },
    })
  })
})

describe('reader and writer', () => {
  test('integer widths match the old vectors', () => {
    const writer = new ByteWriter()
    writer.write(Uint8Array.of(0)).write(Uint8Array.of(1))
    expect(hex(writer.finish())).toBe('0001')
    expect(hex(new ByteWriter().writeUInt8(1).finish())).toBe('01')
    expect(hex(new ByteWriter().writeUInt16BE(1).finish())).toBe('0001')
    expect(hex(new ByteWriter().writeUInt16LE(1).finish())).toBe('0100')
    expect(hex(new ByteWriter().writeUInt32BE(1).finish())).toBe('00000001')
    expect(hex(new ByteWriter().writeUInt32LE(1).finish())).toBe('01000000')
    expect(hex(new ByteWriter().writeUInt64BE(1n).finish())).toBe(
      '0000000000000001',
    )
    expect(hex(new ByteWriter().writeUInt64LE(1n).finish())).toBe(
      '0100000000000000',
    )
    const one = new old.crypto.BN(1)
    expect(
      new old.encoding.BufferWriter().writeUInt32LE(1).concat().toString('hex'),
    ).toBe('01000000')
    expect(
      new old.encoding.BufferWriter()
        .writeUInt64BEBN(one)
        .concat()
        .toString('hex'),
    ).toBe('0000000000000001')
    expect(
      new old.encoding.BufferWriter()
        .writeUInt64LEBN(one)
        .concat()
        .toString('hex'),
    ).toBe('0100000000000000')
  })

  test('reads the old integer and varint fixtures', () => {
    const blank = new ByteReader(new Uint8Array())
    expect(blank.finished()).toBe(true)
    expect(hex(blank.readAll())).toBe('')

    const ten = new ByteReader(new Uint8Array(10))
    expect(ten.read(0)).toEqual({ ok: true, value: new Uint8Array() })
    expect(ten.finished()).toBe(false)
    const two = ten.read(2)
    expect(two.ok && two.value).toHaveLength(2)
    expect(ten.position).toBe(2)
    expect(ten.finished()).toBe(false)

    expect(new ByteReader(Uint8Array.of(1)).readUInt8()).toEqual({
      ok: true,
      value: 1,
    })
    expect(new ByteReader(fromHex('0001')).readUInt16BE()).toEqual({
      ok: true,
      value: 1,
    })
    expect(new ByteReader(fromHex('0100')).readUInt16LE()).toEqual({
      ok: true,
      value: 1,
    })
    expect(new ByteReader(fromHex('00000001')).readUInt32BE()).toEqual({
      ok: true,
      value: 1,
    })
    expect(new ByteReader(fromHex('01000000')).readUInt32LE()).toEqual({
      ok: true,
      value: 1,
    })
    expect(new ByteReader(fromHex('0000000000000001')).readUInt64BE()).toEqual({
      ok: true,
      value: 1n,
    })
    expect(new ByteReader(fromHex('0100000000000000')).readUInt64LE()).toEqual({
      ok: true,
      value: 1n,
    })
    expect(new ByteReader(fromHex('00ca9a3b00000000')).readUInt64LE()).toEqual({
      ok: true,
      value: 1_000_000_000n,
    })
    expect(new ByteReader(fromHex('0100000001000000')).readUInt64LE()).toEqual({
      ok: true,
      value: (1n << 32n) + 1n,
    })
    expect(new ByteReader(fromHex('0040075af0750700')).readUInt64LE()).toEqual({
      ok: true,
      value: 21_000_000n * 100_000_000n,
    })
    expect(new ByteReader(fromHex('ffffffffffff1f00')).readUInt64LE()).toEqual({
      ok: true,
      value: (1n << 53n) - 1n,
    })
    expect(new ByteReader(fromHex('0000000000002000')).readUInt64LE()).toEqual({
      ok: true,
      value: 1n << 53n,
    })
    const allOnes = new Uint8Array(8).fill(0xff)
    const uint64 = (1n << 64n) - 1n
    expect(new ByteReader(allOnes).readUInt64LE()).toEqual({
      ok: true,
      value: uint64,
    })
    expect(new ByteReader(allOnes).readUInt64BE()).toEqual({
      ok: true,
      value: uint64,
    })
    expect(
      new old.encoding.BufferReader(Buffer.from(allOnes))
        .readUInt64LEBN()
        .toString(10),
    ).toBe(uint64.toString(10))
    expect(
      new old.encoding.BufferReader(Buffer.from(allOnes))
        .readUInt64BEBN()
        .toString(10),
    ).toBe(uint64.toString(10))

    expect(new ByteReader(Uint8Array.of(50)).readVarint()).toEqual({
      ok: true,
      value: 50n,
    })
    expect(new ByteReader(Uint8Array.of(253, 253, 0)).readVarint()).toEqual({
      ok: true,
      value: 253n,
    })
    expect(new ByteReader(fromHex('fd50c3')).readVarint()).toEqual({
      ok: true,
      value: 50000n,
    })
    expect(new ByteReader(fromHex('fe50c30000')).readVarint()).toEqual({
      ok: false,
      error: { code: 'varint-non-minimal' },
    })
    expect(new ByteReader(mustVarint(1n << 54n)).readVarint()).toEqual({
      ok: true,
      value: 1n << 54n,
    })

    const reversed = new ByteReader(Uint8Array.of(0, 1))
    expect(hex(reversed.reverse().readAll())).toBe('0100')
    expect(new ByteReader(Uint8Array.of(0, 1, 2)).readReverse(2)).toEqual({
      ok: true,
      value: Uint8Array.of(1, 0),
    })
  })

  test('a short read is a typed truncation, including a varint length', () => {
    expect(new ByteReader(Uint8Array.of(1)).read(2)).toEqual({
      ok: false,
      error: { code: 'reader-truncated', needed: 2, available: 1 },
    })
    expect(new ByteReader(fromHex('0a00')).readBytesPrefixed()).toEqual({
      ok: false,
      error: { code: 'reader-truncated', needed: 10, available: 1 },
    })
    const script = fromHex(
      '73010000003766404f00000000b305434f00000000f203' +
        '0000f1030000001027000048ee00000064000000004653656520626974636f696' +
        'e2e6f72672f666562323020696620796f7520686176652074726f75626c652063' +
        '6f6e6e656374696e6720616674657220323020466562727561727900473045022' +
        '1008389df45f0703f39ec8c1cc42c13810ffcae14995bb648340219e353b63b53' +
        'eb022009ec65e1c1aaeec1fd334c6b684bde2b3f573060d5b70c3a46723326e4e' +
        '8a4f1',
    )
    const cursor = new ByteReader(script)
    const first = cursor.readBytesPrefixed()
    const second = cursor.readBytesPrefixed()
    expect(first.ok && hex(first.value)).toBe(
      '010000003766404f00000000b305434f00000000f2030000f1030000001027000048ee00000064000000004653656520626974636f696e2e6f72672f666562323020696620796f7520686176652074726f75626c6520636f6e6e656374696e6720616674657220323020466562727561727900',
    )
    expect(second.ok && hex(second.value)).toBe(
      '30450221008389df45f0703f39ec8c1cc42c13810ffcae14995bb648340219e353b63b53eb022009ec65e1c1aaeec1fd334c6b684bde2b3f573060d5b70c3a46723326e4e8a4f1',
    )
  })

  test('an integer that does not fit the width throws a typed error', () => {
    expect(() => new ByteWriter().writeUInt8(256)).toThrow(EncodingException)
    expect(() => new ByteWriter().writeUInt64LE(-1n)).toThrow(EncodingException)
    expect(() => new ByteWriter().writeVarint(1n << 64n)).toThrow(
      EncodingException,
    )
    try {
      new ByteWriter().writeUInt32LE(-1)
    } catch (error) {
      expect(error).toMatchObject({ code: 'integer-out-of-range' })
      expect(isEncodingError(error)).toBe(true)
    }
  })
})

describe('convertBits', () => {
  test('regroups the cashaddr fixtures', () => {
    expect(convertBits([1], 16, 10)).toEqual({ ok: true, value: [0, 16] })
    expect(convertBits([1, 2], 16, 10)).toEqual({
      ok: true,
      value: [0, 16, 0, 512],
    })
    expect(convertBits([16], 2, 10)).toEqual({
      ok: false,
      error: { code: 'convert-bits-range', value: 16, fromBits: 2 },
    })
  })

  test('strict mode rejects leftover padding', () => {
    expect(convertBits([1], 16, 10, true)).toEqual({
      ok: false,
      error: { code: 'convert-bits-padding' },
    })
  })
})

describe('cashaddr base32', () => {
  test('encodes and decodes the 5-bit charset', () => {
    expect(encodeBase32([0, 1, 2, 3, 4, 5])).toEqual({
      ok: true,
      value: 'qpzry9',
    })
    const symbols = Array.from({ length: 32 }, (_, index) => index)
    const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    expect(encodeBase32(symbols)).toEqual({ ok: true, value: alphabet })
    expect(decodeBase32(alphabet + alphabet)).toEqual({
      ok: true,
      value: symbols.concat(symbols),
    })
  })

  test('an out-of-range value or a foreign character is typed', () => {
    expect(encodeBase32([35])).toEqual({
      ok: false,
      error: { code: 'base32-invalid-value', value: 35 },
    })
    expect(decodeBase32('abc')).toEqual({
      ok: false,
      error: { code: 'base32-invalid-char', index: 1, char: 'b' },
    })
    expect(decodeBase32('aqQ')).toEqual({
      ok: false,
      error: { code: 'base32-invalid-char', index: 2, char: 'Q' },
    })
    expect(isEncodingError(new Error('Invalid Argument: value b'))).toBe(false)
  })
})
