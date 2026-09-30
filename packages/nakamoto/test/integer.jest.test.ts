import {
  bigintToBytes,
  bytesToBigint,
  isIntegerError,
  mod,
} from '../src/integer.js'

describe('bigint helpers', () => {
  test('mod returns a non-negative remainder', () => {
    expect(mod(7n, 5n)).toEqual({ ok: true, value: 2n })
    expect(mod(-1n, 5n)).toEqual({ ok: true, value: 4n })
    expect(mod(-3n, 5n)).toEqual({ ok: true, value: 2n })
    expect(mod(0n, 5n)).toEqual({ ok: true, value: 0n })
    expect(mod(5n, 5n)).toEqual({ ok: true, value: 0n })
    expect(mod(-5n, 5n)).toEqual({ ok: true, value: 0n })
    expect(mod(1n, 0n)).toEqual({
      ok: false,
      error: { code: 'modulus-not-positive' },
    })
    expect(mod(1n, -3n)).toEqual({
      ok: false,
      error: { code: 'modulus-not-positive' },
    })
    expect(isIntegerError({ code: 'modulus-not-positive' })).toBe(true)
    expect(isIntegerError({ code: 'other' })).toBe(false)
  })

  test('fixed-width bytes are unsigned big-endian', () => {
    expect(bigintToBytes(0x01ffn, 2)).toEqual({
      ok: true,
      value: Uint8Array.of(0x01, 0xff),
    })
    expect(bigintToBytes(0n, 1)).toEqual({
      ok: true,
      value: Uint8Array.of(0x00),
    })
    expect(bigintToBytes(0n, 0)).toEqual({ ok: true, value: new Uint8Array(0) })
    expect(bigintToBytes(256n, 1)).toEqual({
      ok: false,
      error: { code: 'integer-out-of-range' },
    })
    expect(bigintToBytes(-1n, 2)).toEqual({
      ok: false,
      error: { code: 'integer-out-of-range' },
    })
    expect(bytesToBigint(Uint8Array.of(0x01, 0x00))).toBe(256n)
    expect(bytesToBigint(new Uint8Array())).toBe(0n)
    const encoded = bigintToBytes(0xabcdefn, 4)
    expect(encoded.ok).toBe(true)
    if (encoded.ok) expect(bytesToBigint(encoded.value)).toBe(0xabcdefn)
  })
})
