import {
  FrankCodecError,
  I64_MAX,
  I64_MIN,
  U64_MAX,
  cborMap,
  decodeCanonical,
  encodeCanonical,
  isValidCanonical,
  toHex,
} from '../src'
import type { Encodable, FrankValue } from '../src'
import { hex } from '../fixtures/builders'

const enc = (v: Encodable): string => toHex(encodeCanonical(v))

describe('canonical encoder', () => {
  it('uses the shortest form for integers, at every width boundary', () => {
    const cases: Array<[Encodable, string]> = [
      [0, '00'],
      [23, '17'],
      [24, '1818'],
      [255, '18ff'],
      [256, '190100'],
      [65535, '19ffff'],
      [65536, '1a00010000'],
      [4294967295, '1affffffff'],
      [4294967296n, '1b0000000100000000'],
      [-1, '20'],
      [-24, '37'],
      [-25, '3818'],
      [-256, '38ff'],
      [-257, '390100'],
      [-65536, '39ffff'],
      [-65537, '3a00010000'],
      [-4294967296, '3affffffff'],
      [-4294967297, '3b0000000100000000'],
    ]
    for (const [v, h] of cases) expect(enc(v)).toBe(h)
  })

  it('encodes declared u64/i64 boundaries exactly and decodes them as bigint', () => {
    expect(enc(U64_MAX)).toBe('1bffffffffffffffff')
    expect(decodeCanonical(hex('1bffffffffffffffff'))).toBe(U64_MAX)
    expect(enc(I64_MAX)).toBe('1b7fffffffffffffff')
    expect(enc(I64_MIN)).toBe('3b7fffffffffffffff')
    expect(decodeCanonical(hex('3b7fffffffffffffff'))).toBe(I64_MIN)
    expect(enc(I64_MAX + 1n)).toBe('1b8000000000000000')
    expect(enc(I64_MIN - 1n)).toBe('3b8000000000000000')
    // Every decoded integer is a bigint, including small ones (C7).
    expect(typeof decodeCanonical(hex('05'))).toBe('bigint')
    // The widest CBOR integers stay representable; beyond them the encoder refuses.
    expect(enc(-(U64_MAX + 1n))).toBe('3bffffffffffffffff')
    expect(() => encodeCanonical(U64_MAX + 1n)).toThrow(RangeError)
    expect(() => encodeCanonical(-(U64_MAX + 2n))).toThrow(RangeError)
  })

  it('refuses numbers that are not safe integers, so no precision is silently lost', () => {
    expect(() => encodeCanonical(1.5)).toThrow(RangeError)
    expect(() => encodeCanonical(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      RangeError,
    )
    expect(() => encodeCanonical(NaN)).toThrow(RangeError)
    expect(() => encodeCanonical(Infinity)).toThrow(RangeError)
    expect(enc(Number.MAX_SAFE_INTEGER)).toBe('1b001fffffffffffff')
  })

  it('refuses values outside the profile', () => {
    expect(() => encodeCanonical(undefined as unknown as Encodable)).toThrow(
      TypeError,
    )
    expect(() => encodeCanonical(new Date() as unknown as Encodable)).toThrow(
      TypeError,
    )
    expect(() => encodeCanonical({ a: 1 } as unknown as Encodable)).toThrow(
      TypeError,
    )
    expect(() =>
      encodeCanonical(new Map([['a', 1]]) as unknown as Encodable),
    ).toThrow(TypeError)
    expect(() => encodeCanonical(new Map([[-1, 1]]))).toThrow(RangeError)
    expect(() => encodeCanonical('\ud800')).toThrow(RangeError)
    expect(() => encodeCanonical('a\udc00b')).toThrow(RangeError)
  })

  it('rejects duplicate keys that collide only after number/bigint normalisation', () => {
    expect(() =>
      encodeCanonical(
        new Map<number | bigint, Encodable>([
          [1, 'a'],
          [1n, 'b'],
        ]),
      ),
    ).toThrow(/duplicate map key/)
  })

  it('encodes strings as UTF-8 with the shortest length head', () => {
    expect(enc('')).toBe('60')
    expect(enc('é')).toBe('62c3a9')
    expect(enc('\u{1F600}')).toBe('64f09f9880')
    expect(enc('a'.repeat(24))).toBe('7818' + '61'.repeat(24))
    expect(enc(new Uint8Array(24))).toBe('5818' + '00'.repeat(24))
    expect(enc(true)).toBe('f5')
    expect(enc(false)).toBe('f4')
    expect(enc(null)).toBe('f6')
  })

  it('is independent of map insertion order at every depth', () => {
    const entries: Array<[number | bigint, Encodable]> = [
      [300, 'c'],
      [0, 'a'],
      [
        23,
        cborMap([
          [9, 1],
          [1, 2],
          [5, 3],
        ]),
      ],
      [24, 'd'],
      [
        1,
        [
          cborMap([
            [2, 1],
            [0, 2],
          ]),
        ],
      ],
      [4294967296n, 'big'],
    ]
    const baseline = enc(new Map(entries))
    // All 720 permutations of the six top-level entries produce the same bytes.
    const perm = (a: typeof entries): Array<typeof entries> =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) =>
            perm([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]),
          )
    const all = perm(entries)
    expect(all).toHaveLength(720)
    for (const p of all) expect(enc(new Map(p))).toBe(baseline)
    // Keys are emitted in ascending (bytewise) order.
    const decoded = decodeCanonical(hex(baseline)) as ReadonlyMap<
      bigint,
      FrankValue
    >
    expect([...decoded.keys()]).toEqual([0n, 1n, 23n, 24n, 300n, 4294967296n])
  })

  it('encodes nested arrays and maps deterministically', () => {
    const v = new Map<number, Encodable>([
      [1, [new Map([[0, 'x']]), 2, [] as Encodable[]]],
    ])
    expect(enc(v)).toBe('a101 83 a1006178 02 80'.replace(/ /g, ''))
  })
})

describe('strict decoder', () => {
  it('round-trips every accepted value to identical bytes', () => {
    const values: Encodable[] = [
      0,
      -1,
      U64_MAX,
      'text',
      new Uint8Array([1, 2, 3]),
      [1, [2, [3, []]]],
      new Map([
        [
          0,
          new Map([
            [1, 'a'],
            [0, 'b'],
          ]),
        ],
      ]),
      true,
      null,
    ]
    for (const v of values) {
      const bytes = encodeCanonical(v)
      expect(toHex(encodeCanonical(reEncodable(decodeCanonical(bytes))))).toBe(
        toHex(bytes),
      )
    }
  })

  it('accepts only bytes equal to their own canonical re-encoding (mutation sweep)', () => {
    // Every single-byte mutation and every truncation of a rich item either fails with a
    // FrankCodecError or, when accepted, re-encodes to exactly the mutated input (C10).
    const item = encodeCanonical(
      new Map<number, Encodable>([
        [0, new Uint8Array(30)],
        [1, 'héllo'],
        [2, [1, 300, 70000, 5000000000n, -1, -300, U64_MAX, true, false, null]],
        [
          3,
          new Map<number, Encodable>([
            [0, []],
            [24, 'x'],
          ]),
        ],
      ]),
    )
    let accepted = 0
    let rejected = 0
    const check = (b: Uint8Array): void => {
      try {
        const v = decodeCanonical(b)
        expect(toHex(encodeCanonical(reEncodable(v)))).toBe(toHex(b))
        accepted++
      } catch (e) {
        if (!(e instanceof FrankCodecError)) throw e
        rejected++
      }
    }
    for (let i = 0; i < item.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const m = item.slice()
        m[i] ^= 1 << bit
        check(m)
      }
      check(item.slice(0, i))
    }
    check(item)
    expect(rejected).toBeGreaterThan(item.length)
    expect(accepted).toBeGreaterThan(0)
  })

  it('reports each malformed/noncanonical/schema class with the documented category', () => {
    const cat = (h: string): string => {
      try {
        decodeCanonical(hex(h))
      } catch (e) {
        return (e as FrankCodecError).category
      }
      return 'accepted'
    }
    expect(cat('')).toBe('malformed')
    expect(cat('1c')).toBe('malformed')
    expect(cat('1d')).toBe('malformed')
    expect(cat('1e')).toBe('malformed')
    expect(cat('1f')).toBe('malformed') // indefinite integer
    expect(cat('df')).toBe('malformed') // indefinite tag
    expect(cat('ff')).toBe('malformed') // stray break
    expect(cat('1800')).toBe('noncanonical')
    expect(cat('190017')).toBe('noncanonical')
    expect(cat('1a0000ffff')).toBe('noncanonical')
    expect(cat('1b00000000ffffffff')).toBe('noncanonical')
    expect(cat('5f4101ff')).toBe('noncanonical')
    expect(cat('7fff')).toBe('noncanonical')
    expect(cat('9fff')).toBe('noncanonical')
    expect(cat('bfff')).toBe('noncanonical')
    expect(cat('f90000')).toBe('schema')
    expect(cat('f9ffff')).toBe('schema')
    expect(cat('fa00000000')).toBe('schema')
    expect(cat('fb0000000000000000')).toBe('schema')
    expect(cat('c000')).toBe('schema')
    expect(cat('d8ff00')).toBe('schema')
    expect(cat('f7')).toBe('schema')
    expect(cat('e0')).toBe('schema')
    expect(cat('f820')).toBe('schema')
    expect(cat('f810')).toBe('malformed')
    expect(cat('f4')).toBe('accepted')
    expect(cat('f5')).toBe('accepted')
    expect(cat('f6')).toBe('accepted')
    // Two items: extra data is malformed and pass A wins over anything pass B would say.
    expect(cat('0000')).toBe('malformed')
    expect(cat('f9000000')).toBe('malformed')
  })

  it('rejects malformed indefinite strings in pass A and non-uint keys as schema', () => {
    const cat = (h: string): string => {
      try {
        decodeCanonical(hex(h))
      } catch (e) {
        return (e as FrankCodecError).category
      }
      return 'accepted'
    }
    expect(cat('5f6161ff')).toBe('malformed') // text chunk inside a byte string
    expect(cat('5f5f4101ffff')).toBe('malformed') // nested indefinite chunk
    expect(cat('7f4161ff')).toBe('malformed')
    expect(cat('bf01ff')).toBe('malformed') // break where a map value belongs
    expect(cat('9f')).toBe('malformed') // truncated indefinite array
    expect(cat('a1 6161 01'.replace(/ /g, ''))).toBe('schema')
    expect(cat('a1 20 01'.replace(/ /g, ''))).toBe('schema')
    expect(cat('a1 f4 01'.replace(/ /g, ''))).toBe('schema')
    expect(cat('a2 01 00 01 00'.replace(/ /g, ''))).toBe('noncanonical')
    expect(cat('a2 01 00 00 00'.replace(/ /g, ''))).toBe('noncanonical')
    expect(cat('a2 00 00 01 00'.replace(/ /g, ''))).toBe('accepted')
    // Key ordering is numeric on minimal encodings: 23 (17) < 24 (18 18) < 256 (19 0100).
    expect(cat('a3 17 00 1818 00 190100 00'.replace(/ /g, ''))).toBe('accepted')
    expect(cat('a2 1818 00 17 00'.replace(/ /g, ''))).toBe('noncanonical')
  })

  it('accepts exactly the permitted classes', () => {
    expect(decodeCanonical(hex('f4'))).toBe(false)
    expect(decodeCanonical(hex('f6'))).toBe(null)
    expect(decodeCanonical(hex('6568c3a96c6c'.slice(0, 0) + '62c3a9'))).toBe(
      'é',
    )
    expect(isValidCanonical(hex('a0'))).toBe(true)
    expect(isValidCanonical(hex('a1'))).toBe(false)
  })

  it('returns byte strings that are exact views of the input', () => {
    const v = decodeCanonical(hex('43010203')) as Uint8Array
    expect(Array.from(v)).toEqual([1, 2, 3])
  })
})

/** Converts a decoded value back to an encoder input (bigints stay bigints). */
function reEncodable(v: FrankValue): Encodable {
  if (Array.isArray(v)) return v.map(reEncodable)
  if (v instanceof Map) {
    return new Map(
      [...(v as ReadonlyMap<bigint, FrankValue>)].map(([k, x]) => [
        k,
        reEncodable(x),
      ]),
    )
  }
  return v as Encodable
}
