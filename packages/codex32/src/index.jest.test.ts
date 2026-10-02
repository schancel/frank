import {
  decodeCodex32,
  encodeCodex32,
  recoverCodex32,
  splitCodex32,
  validateCodex32Checksum,
} from './index.js'

function seed(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => index)
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  )
}

describe('Codex32 standard-checksum core', () => {
  it('decodes official regular vectors 6-8 with nonzero discarded bits', () => {
    const vectors = [
      [
        'ms10testsxxxxxxxxxxxxxxxxxxxxxxxxxx4nzvca9cmczlw',
        '318c6318c6318c6318c6318c6318c631',
      ],
      [
        'ms10seedsyqsjygeyy5nzw2pf9g4jctfw9ucrzv3nxs6nvdau84gz0632s0xs',
        '202122232425262728292a2b2c2d2e2f3031323334353637',
      ],
      [
        'ms10seedsgpq5ys6yg4rywjzfff95cn2wfag9z5jn2324v46ct9d9hrcduqw8c3lccl',
        '404142434445464748494a4b4c4d4e4f505152535455565758595a5b',
      ],
    ] as const
    for (const [vector, expected] of vectors) {
      expect(validateCodex32Checksum(vector)).toBe(true)
      const decoded = decodeCodex32(vector)
      expect(decoded.ok && decoded.value.seed).toEqual(fromHex(expected))
    }
    expect(validateCodex32Checksum(`${vectors[0][0].slice(0, -1)}q`)).toBe(
      false,
    )

    const shareVector = 'ms12namea320zyxwvutsrqpnmlkjhgfedcaxrpp870hkkqrm'
    const decoded = decodeCodex32(shareVector)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.value.threshold).toBe(2)
      expect(decoded.value.identifier).toBe('name')
      expect(decoded.value.index).toBe('a')
      expect(decoded.value.seed).toBeNull()
    }
  })

  it('rejects checksum-valid and generated 17-byte regular material', () => {
    const invalid = 'ms10seedsqqqsyqcyq5rqwzqfpg9scrgwpugqwngczcas22rt6'
    expect(validateCodex32Checksum(invalid)).toBe(true)
    expect(decodeCodex32(invalid)).toEqual({
      ok: false,
      error: { code: 'unsupported-length' },
    })
    const seventeen = new Uint8Array(17)
    expect(
      encodeCodex32({
        threshold: 0,
        identifier: 'seed',
        index: 's',
        secret: seventeen,
      }),
    ).toEqual({ ok: false, error: { code: 'unsupported-length' } })
    expect(
      splitCodex32({
        threshold: 2,
        identifier: 'seed',
        indices: ['q', 'p'],
        secret: seventeen,
        randomBytes: length => new Uint8Array(length),
      }),
    ).toEqual({ ok: false, error: { code: 'unsupported-length' } })
  })

  it('encodes and strictly decodes canonical seed material', () => {
    const encoded = encodeCodex32({
      threshold: 0,
      identifier: 'cash',
      index: 's',
      secret: seed(),
    })
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    const decoded = decodeCodex32(encoded.value)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.threshold).toBe(0)
    expect(decoded.value.identifier).toBe('cash')
    expect(decoded.value.seed).toEqual(seed())
    expect(
      encodeCodex32({
        threshold: decoded.value.threshold,
        identifier: decoded.value.identifier,
        index: decoded.value.index,
        secret: decoded.value.seed ?? new Uint8Array(),
      }),
    ).toEqual(encoded)
  })

  it('never exposes raw seed bytes at a non-secret share index', () => {
    expect(
      encodeCodex32({
        threshold: 2,
        identifier: 'cash',
        index: 'q',
        secret: seed(),
      }),
    ).toEqual({ ok: false, error: { code: 'invalid-index' } })
    expect(
      encodeCodex32({
        threshold: 2,
        identifier: 'cash',
        index: 's',
        secret: seed(),
      }).ok,
    ).toBe(true)
  })

  it('enforces the expanded-HRP printable length boundary', () => {
    const length91 =
      'ms10testsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqj73p44avakdp6'
    const length92 =
      'ms10testsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv03l8asvlgsgr'
    const length93 =
      'ms10testsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfwat0yy6r5na0'
    expect(length91).toHaveLength(91)
    expect(length92).toHaveLength(92)
    expect(length93).toHaveLength(93)
    expect(validateCodex32Checksum(length91)).toBe(true)
    expect(validateCodex32Checksum(length92)).toBe(false)
    expect(validateCodex32Checksum(length93)).toBe(false)
  })

  it('splits and recovers from every threshold-sized subset', () => {
    const split = splitCodex32({
      threshold: 3,
      identifier: 'cash',
      indices: ['q', 'p', 'z', 'r', 'y'],
      secret: seed(),
      randomBytes: length =>
        Uint8Array.from({ length }, (_, index) => (index * 73 + 19) & 0xff),
    })
    expect(split.ok).toBe(true)
    if (!split.ok) return
    const subsets = [
      [0, 1, 2],
      [0, 3, 4],
      [1, 2, 4],
    ]
    for (const subset of subsets) {
      const recovered = recoverCodex32(
        subset.map(index => split.value[index] ?? ''),
      )
      expect(recovered).toEqual({ ok: true, value: seed() })
    }
  })

  it('rejects corruption, duplicates, inconsistent sets, and weak RNG shapes', () => {
    const make = (identifier: string, material = seed()) =>
      splitCodex32({
        threshold: 2,
        identifier,
        indices: ['q', 'p', 'z'],
        secret: material,
        randomBytes: (length: number) => new Uint8Array(length).fill(7),
      })
    const left = make('cash')
    const right = make('swap')
    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    if (!left.ok || !right.ok) return
    expect(recoverCodex32([left.value[0] ?? '', left.value[0] ?? ''])).toEqual({
      ok: false,
      error: { code: 'duplicate-share' },
    })
    expect(recoverCodex32([left.value[0] ?? '', right.value[1] ?? ''])).toEqual(
      {
        ok: false,
        error: { code: 'inconsistent-share' },
      },
    )
    const otherSeed = seed()
    otherSeed[0] ^= 0xff
    const other = make('cash', otherSeed)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(
      recoverCodex32([
        left.value[0] ?? '',
        left.value[1] ?? '',
        other.value[2] ?? '',
      ]),
    ).toEqual({ ok: false, error: { code: 'wrong-share-count' } })
    const corrupted = `${left.value[0]?.slice(0, -1)}q`
    expect(decodeCodex32(corrupted).ok).toBe(false)
    expect(
      splitCodex32({
        threshold: 2,
        identifier: 'cash',
        indices: ['q', 'p'],
        secret: seed(),
        randomBytes: () => new Uint8Array(1),
      }),
    ).toEqual({ ok: false, error: { code: 'rng-failed' } })
  })
})
