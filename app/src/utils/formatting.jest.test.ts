import { pubKeyToColor } from './formatting'

describe('pubKeyToColor', () => {
  it('is deterministic: the same key always produces the same color', () => {
    const pubKey = new Uint8Array([1, 2, 3, 4, 5])
    expect(pubKeyToColor(pubKey)).toBe(pubKeyToColor(pubKey))
    expect(pubKeyToColor(new Uint8Array(pubKey))).toBe(pubKeyToColor(pubKey))
  })

  it('produces different colors for different keys', () => {
    const colors = new Set(
      Array.from({ length: 20 }, (_, i) =>
        pubKeyToColor(new Uint8Array([i, i + 1, i + 2])),
      ),
    )
    // Overwhelmingly likely to all be distinct; not a strict cryptographic guarantee.
    expect(colors.size).toBeGreaterThan(15)
  })

  it('does not crash on an empty key', () => {
    expect(() => pubKeyToColor(new Uint8Array())).not.toThrow()
  })

  it('does not crash on a large key', () => {
    expect(() => pubKeyToColor(new Uint8Array(256).fill(7))).not.toThrow()
  })

  it('returns a valid hsl() color string', () => {
    const color = pubKeyToColor(new Uint8Array([9, 8, 7]))
    expect(color).toMatch(/^hsl\(\d+, \d+(\.\d+)?%, 60%\)$/)
  })
})
