import { createRequire } from 'module'
import {
  decodeScriptNum,
  encodeScriptNum,
  isMinimalScriptNum,
  isScriptNumError,
} from '../src/script-num.js'

// Dev-only oracle. The library source does not import this package.
const oldCrypto = (
  createRequire(__filename)('bitcore-lib-xpi') as {
    crypto: { BN: OldBN }
  }
).crypto

const vectors: ReadonlyArray<readonly [bigint, string]> = [
  [0n, ''],
  [1n, '01'],
  [10n, '0a'],
  [127n, '7f'],
  [128n, '8000'],
  [255n, 'ff00'],
  [256n, '0001'],
  [1000n, 'e803'],
  [65535n, 'ffff00'],
  [65536n, '000001'],
  [65537n, '010001'],
  [-1n, '81'],
  [-127n, 'ff'],
  [-128n, '8080'],
  [-255n, 'ff80'],
  [-256n, '0081'],
  [-1000n, 'e883'],
  [-65536n, '000081'],
  [-65537n, '010081'],
]

type OldBuffer = { toString(encoding: 'hex'): string; length: number }
type OldNumber = { toString(base: 10): string }
type OldBN = {
  fromString(value: string, base: number): { toScriptNumBuffer(): OldBuffer }
  fromScriptNumBuffer(
    buf: Uint8Array,
    requireMinimal?: boolean,
    size?: number,
  ): OldNumber
}

const oldBN = oldCrypto.BN as unknown as OldBN

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

describe('script numbers', () => {
  test('little-endian vectors match the chain encoding', () => {
    for (const [value, encoded] of vectors) {
      const bytes = encodeScriptNum(value)
      expect(hex(bytes)).toBe(encoded)
      expect(Buffer.isBuffer(bytes)).toBe(false)
      const decoded = decodeScriptNum(bytes, { maxBytes: 8 })
      expect(decoded).toEqual({ ok: true, value })
    }
  })

  test('minimal encoding rejects negative zero and extra zero bytes', () => {
    expect(isMinimalScriptNum(fromHex('80'))).toBe(false)
    expect(decodeScriptNum(fromHex('80'))).toEqual({
      ok: false,
      error: { code: 'script-num-non-minimal' },
    })
    expect(decodeScriptNum(fromHex('00'))).toEqual({
      ok: false,
      error: { code: 'script-num-non-minimal' },
    })
    expect(decodeScriptNum(fromHex('0000'))).toEqual({
      ok: false,
      error: { code: 'script-num-non-minimal' },
    })
    expect(decodeScriptNum(fromHex('8000'))).toEqual({ ok: true, value: 128n })
    expect(decodeScriptNum(fromHex('80'), { requireMinimal: false })).toEqual({
      ok: true,
      value: 0n,
    })
    expect(isScriptNumError({ code: 'script-num-non-minimal' })).toBe(true)
    expect(isScriptNumError(new Error('non-minimally encoded'))).toBe(false)
  })

  test('the default size limit is 4 bytes', () => {
    const five = encodeScriptNum(1n << 31n)
    expect(five).toHaveLength(5)
    expect(hex(five)).toBe('0000008000')
    expect(decodeScriptNum(five)).toEqual({
      ok: false,
      error: { code: 'script-num-overflow', maxBytes: 4, length: 5 },
    })
    expect(decodeScriptNum(five, { maxBytes: 5 })).toEqual({
      ok: true,
      value: 1n << 31n,
    })
    expect(
      isScriptNumError({ code: 'script-num-overflow', maxBytes: 4, length: 5 }),
    ).toBe(true)
  })

  test('encode and decode agree with bitcore on the same bytes', () => {
    const samples = vectors.map(([value]) => value)
    for (let n = -500; n <= 500; n += 1) samples.push(BigInt(n))
    for (const value of samples) {
      const ours = encodeScriptNum(value)
      const theirs = oldBN
        .fromString(value.toString(10), 10)
        .toScriptNumBuffer()
      expect(hex(ours)).toBe(theirs.toString('hex'))
      const round = oldBN.fromScriptNumBuffer(Buffer.from(ours), true, 8)
      expect(round.toString(10)).toBe(value.toString(10))
    }
    expect(() =>
      oldBN.fromScriptNumBuffer(Buffer.from([0x80]), true, 4),
    ).toThrow(/non-minimally/)
    const overflow = Buffer.from(encodeScriptNum(1n << 31n))
    expect(() => oldBN.fromScriptNumBuffer(overflow, false, 4)).toThrow(
      /overflow/,
    )
  })
})
