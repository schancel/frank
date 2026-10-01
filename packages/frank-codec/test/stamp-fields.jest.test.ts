import { FrankCodecError, defaultContext, validateFrame } from '../src'
import { isCompressedPoint, isProofEncoding } from '../src/point'
import {
  T3C,
  deliveryFrame,
  fr,
  stampAccount,
  statementFrame,
  statementPayload,
  type5Payload,
  acct1,
} from '../fixtures/builders'

const ctx = defaultContext()
const outcome = (f: Uint8Array, c = ctx): string => {
  try {
    validateFrame(f, c)
    return 'parsed'
  } catch (e) {
    if (e instanceof FrankCodecError) return `${e.category}@${e.stage}`
    throw e
  }
}
const be = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn)
  return out
}
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

describe('type-5 stamp point encoding (T3b)', () => {
  it('accepts the secp256k1 generator and the T3c points, in either parity', () => {
    const g = new Uint8Array(33)
    g[0] = 0x02
    g.set(
      be(0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n),
      1,
    )
    expect(isCompressedPoint(g)).toBe(true)
    g[0] = 0x03
    expect(isCompressedPoint(g)).toBe(true)
    for (const k of [T3C.stampKey, T3C.ephemeral, T3C.shared])
      expect(isCompressedPoint(k)).toBe(true)
  })

  it('rejects a bad prefix, an x at or above p, an off-curve x and a wrong length', () => {
    const at = (prefix: number, x: bigint) => {
      const b = new Uint8Array(33)
      b[0] = prefix
      b.set(be(x), 1)
      return b
    }
    expect(isCompressedPoint(at(2, 1n))).toBe(true)
    expect(isCompressedPoint(at(2, P + 1n))).toBe(false)
    expect(isCompressedPoint(at(2, P))).toBe(false)
    expect(isCompressedPoint(at(2, 5n))).toBe(false)
    expect(isCompressedPoint(at(4, 1n))).toBe(false)
    expect(isCompressedPoint(at(0, 1n))).toBe(false)
    expect(isCompressedPoint(new Uint8Array(33))).toBe(false)
    expect(isCompressedPoint(T3C.ephemeral.slice(0, 32))).toBe(false)
  })

  it('bounds each proof scalar to 1..n-1 independently', () => {
    const ok = be(N - 1n)
    const cat = (a: Uint8Array, b: Uint8Array) => Uint8Array.of(...a, ...b)
    expect(isProofEncoding(cat(ok, ok))).toBe(true)
    expect(isProofEncoding(cat(be(1n), be(1n)))).toBe(true)
    expect(isProofEncoding(cat(be(0n), ok))).toBe(false)
    expect(isProofEncoding(cat(ok, be(0n)))).toBe(false)
    expect(isProofEncoding(cat(be(N), ok))).toBe(false)
    expect(isProofEncoding(cat(ok, be(N)))).toBe(false)
    expect(isProofEncoding(cat(be(N + 1n), ok))).toBe(false)
    expect(isProofEncoding(cat(ok, be(N + 1n)))).toBe(false)
  })
})

describe('typed exposure of the stamp fields', () => {
  it("reads E, X and the proof from a type-5 frame, and P' from a statement", () => {
    const r = validateFrame(fr(5, type5Payload()), ctx)
    if (r.kind !== 'parsed' || r.typed?.type !== 5) throw new Error('not typed')
    expect(r.typed.ephemeralPoint).toEqual(T3C.ephemeral)
    expect(r.typed.sharedPoint).toEqual(T3C.shared)
    expect(r.typed.dleqProof).toEqual(T3C.proof)
    const s = validateFrame(statementFrame(), ctx)
    if (s.kind !== 'parsed' || s.typed?.type !== 4) throw new Error('not typed')
    expect(s.typed.stampKey).toEqual({ keyType: 1, keyBytes: T3C.stampKey })
    expect(s.typed.schemaVersion).toBe(2)
  })

  it('does not compare the stamp key with the routing recipient (S8)', () => {
    expect(outcome(deliveryFrame({ destination: acct1(4) }))).toBe('parsed')
    expect(outcome(deliveryFrame({ destination: stampAccount() }))).toBe(
      'parsed',
    )
  })
})

describe('type-4 schema versions (S10a.1)', () => {
  it('requires field 8 exactly from schema 2', () => {
    const noKey = statementPayload({ stampKey: null })
    expect(outcome(fr(4, noKey, 1, 1))).toBe('parsed')
    expect(outcome(fr(4, noKey, 2, 2))).toBe('schema@8.2')
    expect(outcome(fr(4, statementPayload(), 1, 1))).toBe('schema@8.2')
    expect(outcome(fr(4, statementPayload(), 2, 2))).toBe('parsed')
  })

  it("reads a newer statement schema through the reader's highest one", () => {
    // Schema 3 read by a reader whose highest type-4 schema is 2: field 8 is still required.
    expect(outcome(fr(4, statementPayload({ stampKey: null }), 3, 1))).toBe(
      'schema@8.2',
    )
    expect(outcome(fr(4, statementPayload(), 3, 1))).toBe('parsed')
    // A reader that only knows schema 1 sees field 8 as an unknown field and keeps it (V6.3).
    const v1Reader = defaultContext({
      supportedSchemas: ctx.supportedSchemas.map(s =>
        s.typeId === 4 ? { ...s, schemaVersion: 1 } : s,
      ),
    })
    expect(outcome(fr(4, statementPayload(), 2, 1), v1Reader)).toBe('parsed')
    // ...and does not require it, since field 8 is not part of the schema it reads.
    expect(
      outcome(fr(4, statementPayload({ stampKey: null }), 2, 1), v1Reader),
    ).toBe('parsed')
  })
})
