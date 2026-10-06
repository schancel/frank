import {
  FrankCodecError,
  defaultContext,
  validateFrame,
  paymentCommitment,
  recipientPayloadDigest,
} from '../src'
import {
  M,
  bytesOf,
  deliveryFrame,
  deliveryPayload,
  type5Frame,
  NET,
} from '../fixtures/builders'

const ctx = defaultContext()

describe('UTXO payment-member extensions', () => {
  const pf = type5Frame()
  const t3 = recipientPayloadDigest(NET, pf)

  it('parses payment-member with field 5 (vout: 0, 1, 4294967295)', () => {
    const p0 = M([
      [0, 0],
      [1, bytesOf(32, 1)],
      [2, new Uint8Array(32)],
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
      [5, 0], // vout: 0
    ])
    const p1 = M([
      [0, 1],
      [1, bytesOf(32, 2)],
      [2, new Uint8Array(32)],
      [3, bytesOf(20, 11)],
      [4, paymentCommitment(t3, 1)],
      [5, 4294967295], // vout: max u32
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    const validated = validateFrame(frame, ctx)
    expect(validated.typed).toBeDefined()
    if (validated.typed?.type === 1) {
      expect(validated.typed.payments[0].vout).toBe(0)
      expect(validated.typed.payments[1].vout).toBe(4294967295)
    }
  })

  it('rejects vout exceeding uint32 range or negative', () => {
    const badVout = M([
      [0, 0],
      [1, bytesOf(32, 1)],
      [2, new Uint8Array(32)],
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
      [5, 4294967296n], // > u32 max
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [badVout] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })

  it('accepts payment-member with satoshi amount as uint64 bigint', () => {
    const pSatoshi = M([
      [0, 0],
      [1, bytesOf(32, 1)],
      [2, 50_000n], // 50,000 satoshis (uint)
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
      [5, 1],
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [pSatoshi] })
    const validated = validateFrame(frame, ctx)
    if (validated.typed?.type === 1) {
      expect(validated.typed.payments[0].value).toBe(50_000n)
      expect(validated.typed.payments[0].vout).toBe(1)
    }
  })

  it('rejects negative satoshi amount', () => {
    const badAmount = M([
      [0, 0],
      [1, bytesOf(32, 1)],
      [2, -1n], // negative integer (major type 1)
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [badAmount] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })

  it('allows same transactionId when vout differs across payment members in one delivery', () => {
    const sharedTxId = bytesOf(32, 42)
    const p0 = M([
      [0, 0],
      [1, sharedTxId], // Same txid
      [2, 10_000n],
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
      [5, 0], // output 0
    ])
    const p1 = M([
      [0, 1],
      [1, sharedTxId], // Same txid
      [2, 20_000n],
      [3, bytesOf(20, 11)],
      [4, paymentCommitment(t3, 1)],
      [5, 1], // output 1
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    const validated = validateFrame(frame, ctx)
    expect(validated.typed).toBeDefined()
    if (validated.typed?.type === 1) {
      expect(validated.typed.payments.length).toBe(2)
      expect(validated.typed.payments[0].vout).toBe(0)
      expect(validated.typed.payments[1].vout).toBe(1)
    }
  })

  it('rejects duplicate (transactionId, vout) across payment members', () => {
    const sharedTxId = bytesOf(32, 42)
    const p0 = M([
      [0, 0],
      [1, sharedTxId],
      [2, 10_000n],
      [3, bytesOf(20, 10)],
      [4, paymentCommitment(t3, 0)],
      [5, 0],
    ])
    const p1 = M([
      [0, 1],
      [1, sharedTxId],
      [2, 20_000n],
      [3, bytesOf(20, 11)],
      [4, paymentCommitment(t3, 1)],
      [5, 0], // Duplicate vout on same txid!
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })
})
