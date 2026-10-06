import {
  FrankCodecError,
  defaultContext,
  validateFrame,
} from '../src'
import {
  M,
  T3C,
  acct1,
  acct2,
  bytesOf,
  deliveryFrame,
  deliveryPayload,
  payment,
  recipientPayloadDigest,
  type5Frame,
  fr,
  NET,
} from '../fixtures/builders'

const ctx = defaultContext()

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const be = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn)
  return out
}

describe('Type 1 delivery: recipient identity P and DLEQ proof co-location (#946)', () => {
  const recipientAcct = acct1(7)
  const dleqProof = T3C.proof

  it('validates a Type 1 delivery with co-located recipient P and DLEQ proof', () => {
    const frame = deliveryFrame({
      recipient: recipientAcct,
      dleqProof,
    })
    const res = validateFrame(frame, ctx)
    expect(res.kind).toBe('parsed')
    if (res.kind !== 'parsed' || res.typed?.type !== 1) {
      throw new Error('expected parsed Type 1 delivery')
    }

    expect(res.typed.recipient).toBeDefined()
    expect(res.typed.recipient?.keyType).toBe(1)
    expect(res.typed.recipient?.keyBytes).toEqual(recipientAcct.get(1))
    expect(res.typed.dleqProof).toBeDefined()
    expect(res.typed.dleqProof).toEqual(dleqProof)
    expect(res.typed.payments.length).toBe(2)
  })

  it('preserves backward compatibility when keys 5 and 6 are absent', () => {
    const frame = deliveryFrame()
    const res = validateFrame(frame, ctx)
    expect(res.kind).toBe('parsed')
    if (res.kind !== 'parsed' || res.typed?.type !== 1) {
      throw new Error('expected parsed Type 1 delivery')
    }

    expect(res.typed.recipient).toBeUndefined()
    expect(res.typed.dleqProof).toBeUndefined()
    expect(res.typed.payments.length).toBe(2)
  })

  it('rejects recipient with invalid keyType (keyType must be 1)', () => {
    // Key type 2 (Ed25519)
    const badAcct2 = acct2(3)
    const frame2 = deliveryFrame({
      recipient: badAcct2,
      dleqProof,
    })
    expect(() => validateFrame(frame2, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frame2, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('recipient key type must be 1')
    }

    // Key type 3 (Schnorr)
    const badAcct3 = M([
      [0, 3],
      [1, bytesOf(32, 9)],
    ])
    const frame3 = deliveryFrame({
      recipient: badAcct3,
      dleqProof,
    })
    expect(() => validateFrame(frame3, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frame3, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('recipient key type must be 1')
    }
  })

  it('rejects recipient with keyType 1 but incorrect key length (requires 33 bytes)', () => {
    const badAcctLength = M([
      [0, 1],
      [1, bytesOf(32, 5)], // 32 bytes instead of 33
    ])
    const frame = deliveryFrame({
      recipient: badAcctLength,
      dleqProof,
    })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frame, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('requires 33 key bytes')
    }
  })

  it('rejects DLEQ proof with incorrect byte length (requires 64 bytes)', () => {
    // 63 bytes
    const shortProof = bytesOf(63, 1)
    const frameShort = deliveryFrame({
      recipient: recipientAcct,
      dleqProof: shortProof,
    })
    expect(() => validateFrame(frameShort, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frameShort, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('byte string size outside 64..64')
    }

    // 65 bytes
    const longProof = bytesOf(65, 1)
    const frameLong = deliveryFrame({
      recipient: recipientAcct,
      dleqProof: longProof,
    })
    expect(() => validateFrame(frameLong, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frameLong, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('byte string size outside 64..64')
    }
  })

  it('rejects DLEQ proof with scalars outside 1..n-1 (T3b)', () => {
    const ok = be(N - 1n)
    const cat = (a: Uint8Array, b: Uint8Array) => Uint8Array.of(...a, ...b)

    // c = 0
    const zeroC = cat(be(0n), ok)
    expect(() =>
      validateFrame(
        deliveryFrame({ recipient: recipientAcct, dleqProof: zeroC }),
        ctx,
      ),
    ).toThrow(FrankCodecError)

    // s = 0
    const zeroS = cat(ok, be(0n))
    expect(() =>
      validateFrame(
        deliveryFrame({ recipient: recipientAcct, dleqProof: zeroS }),
        ctx,
      ),
    ).toThrow(FrankCodecError)

    // c = n
    const nC = cat(be(N), ok)
    expect(() =>
      validateFrame(
        deliveryFrame({ recipient: recipientAcct, dleqProof: nC }),
        ctx,
      ),
    ).toThrow(FrankCodecError)

    // s = n + 1
    const overS = cat(ok, be(N + 1n))
    expect(() =>
      validateFrame(
        deliveryFrame({ recipient: recipientAcct, dleqProof: overS }),
        ctx,
      ),
    ).toThrow(FrankCodecError)
  })

  it('rejects delivery when key 5 is present without key 6 (indices must align)', () => {
    const payload = deliveryPayload({
      recipient: recipientAcct,
    })
    const frame = fr(1, payload)
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frame, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('9')
      expect(err.message).toContain(
        'recipient and DLEQ proof must both be present',
      )
    }
  })

  it('rejects delivery when key 6 is present without key 5 (indices must align)', () => {
    const payload = deliveryPayload({
      dleqProof,
    })
    const frame = fr(1, payload)
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frame, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('9')
      expect(err.message).toContain(
        'recipient and DLEQ proof must both be present',
      )
    }
  })

  it('verifies that payment child indices must align with contiguous 0..n-1', () => {
    const pf = type5Frame()
    const t3 = recipientPayloadDigest(NET, pf)

    // Contiguous indices 0, 1, 2 with co-located recipient and dleqProof
    const contiguousPayments = [
      payment(t3, { index: 0 }),
      payment(t3, { index: 1 }),
      payment(t3, { index: 2 }),
    ]
    const goodFrame = deliveryFrame({
      payloadFrame: pf,
      payments: contiguousPayments,
      recipient: recipientAcct,
      dleqProof,
    })
    const goodRes = validateFrame(goodFrame, ctx)
    expect(goodRes.kind).toBe('parsed')
    if (goodRes.kind === 'parsed' && goodRes.typed?.type === 1) {
      expect(goodRes.typed.payments.length).toBe(3)
      expect(goodRes.typed.payments[0].childIndex).toBe(0)
      expect(goodRes.typed.payments[1].childIndex).toBe(1)
      expect(goodRes.typed.payments[2].childIndex).toBe(2)
    }

    // Gap in child indices: 0 then 2
    const gappedPayments = [
      payment(t3, { index: 0 }),
      payment(t3, { index: 2 }),
    ]
    const badFrame = deliveryFrame({
      payloadFrame: pf,
      payments: gappedPayments,
      recipient: recipientAcct,
      dleqProof,
    })
    expect(() => validateFrame(badFrame, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(badFrame, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('9')
      expect(err.message).toContain(
        'child indices must be exactly contiguous 0..n-1',
      )
    }
  })

  it('keys 5 and 6 are declared optional keys and not treated as undeclared (C12)', () => {
    const payload = deliveryPayload({
      recipient: recipientAcct,
      dleqProof,
    })
    const frame = fr(1, payload)
    const res = validateFrame(frame, ctx)
    expect(res.kind).toBe('parsed')
    if (res.kind === 'parsed' && res.typed?.type === 1) {
      expect(res.typed.unknownFields.size).toBe(0)
    }

    // Adding key 7 (undeclared) fails C12 in strict mode
    const payloadWith7 = new Map(payload)
    payloadWith7.set(7, new Uint8Array([1, 2, 3]))
    const frameWith7 = fr(1, payloadWith7)
    expect(() => validateFrame(frameWith7, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(frameWith7, ctx)
    } catch (e) {
      expect(e).toBeInstanceOf(FrankCodecError)
      const err = e as FrankCodecError
      expect(err.stage).toBe('8.2')
      expect(err.message).toContain('undeclared key 7 (C12)')
    }
  })
})
