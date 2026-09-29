import {
  FrankCodecError,
  contentHash,
  decodeCanonical,
  defaultContext,
  encodeFrame,
  parseFrame,
  toHex,
  validateFrame,
} from '../src'
import { WORKED_RETAINED, WORKED_TEXT_HI, hex, M } from '../fixtures/builders'

function failure(f: () => unknown): FrankCodecError {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(FrankCodecError)
    return e as FrankCodecError
  }
  throw new Error('expected a FrankCodecError')
}

describe('README section 1 worked examples', () => {
  it('encodes the 23-byte type-17 frame exactly', () => {
    const f = encodeFrame(
      { typeId: 17, schemaVersion: 1, minReaderVersion: 1 },
      M([[0, 'hi']]),
    )
    expect(f.length).toBe(23)
    expect(toHex(f)).toBe('46524e4b010000000ea40011010102010345a100626869')
    expect(f).toEqual(WORKED_TEXT_HI)
  })

  it('parses the type-17 frame and exposes its exact bytes', () => {
    const r = parseFrame(WORKED_TEXT_HI)
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.typeId).toBe(17)
    expect(r.typed).toMatchObject({ type: 17, text: 'hi' })
    expect(r.frame).toEqual(WORKED_TEXT_HI)
    expect(toHex(contentHash(r))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('encodes the 0xffff0001 frame in shortest form and retains it byte-for-byte', () => {
    const f = encodeFrame(
      { typeId: 0xffff0001, schemaVersion: 1, minReaderVersion: 1 },
      new Map(),
    )
    expect(toHex(f)).toBe('46524e4b010000000ea4001affff0001010102010341a0')
    expect(f).toEqual(WORKED_RETAINED)
    for (const op of ['generic', 'typed'] as const) {
      const r = validateFrame(
        WORKED_RETAINED,
        defaultContext({ operation: op, opaqueRetentionAllowed: true }),
      )
      expect(r.kind).toBe('retained')
      if (r.kind === 'retained') {
        expect(r.reason).toBe('unknown-type')
        expect(r.frame).toEqual(WORKED_RETAINED)
      }
    }
    // Without root retention the same bytes are unsupported at stage 7.
    const e = failure(() => validateFrame(WORKED_RETAINED, defaultContext()))
    expect([e.category, e.stage]).toEqual(['unsupported', '7'])
  })
})

describe('README section 9 pass A/B examples', () => {
  it('reports `78 05 61` (truncated, non-minimal header) as malformed in pass A', () => {
    const e = failure(() => decodeCanonical(hex('780561')))
    expect([e.category, e.pass]).toEqual(['malformed', 'A'])
  })

  it('reports {"b":1,"a":2} as a schema error at its first key, not as an ordering error', () => {
    const e = failure(() => decodeCanonical(hex('a2616201616102')))
    expect([e.category, e.pass]).toEqual(['schema', 'B'])
    expect(e.message).toContain('C1a')
  })
})
