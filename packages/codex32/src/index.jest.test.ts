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

describe('Codex32 standard-checksum core', () => {
  it('matches the published BIP-93 checksum vector', () => {
    const vector = 'ms10testsxxxxxxxxxxxxxxxxxxxxxxxxxx4nzvca9cmczlw'
    expect(validateCodex32Checksum(vector)).toBe(true)
    expect(validateCodex32Checksum(`${vector.slice(0, -1)}q`)).toBe(false)

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
    const make = (identifier: string) =>
      splitCodex32({
        threshold: 2,
        identifier,
        indices: ['q', 'p'],
        secret: seed(),
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
