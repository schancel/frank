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
import { PAYMENT_MEMBER, TYPE_DIRECT_MESSAGE_DELIVERY } from '../src/constants'

const ctx = defaultContext()

describe('UTXO payment-member extensions', () => {
  const pf = type5Frame()
  const t3 = recipientPayloadDigest(NET, pf)

  it('parses payment-member with field 5 (vout: 0, 1, 4294967295)', () => {
    const p0 = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, bytesOf(32, 1)],
      [PAYMENT_MEMBER.value, new Uint8Array(32)],
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
      [PAYMENT_MEMBER.vout, 0], // vout: 0
    ])
    const p1 = M([
      [PAYMENT_MEMBER.childIndex, 1],
      [PAYMENT_MEMBER.transactionId, bytesOf(32, 2)],
      [PAYMENT_MEMBER.value, new Uint8Array(32)],
      [PAYMENT_MEMBER.address, bytesOf(20, 11)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 1)],
      [PAYMENT_MEMBER.vout, 4294967295], // vout: max u32
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    const validated = validateFrame(frame, ctx)
    expect(validated.typed).toBeDefined()
    if (validated.typed?.type === TYPE_DIRECT_MESSAGE_DELIVERY) {
      expect(validated.typed.payments[0].vout).toBe(0)
      expect(validated.typed.payments[1].vout).toBe(4294967295)
    }
  })

  it('rejects vout exceeding uint32 range or negative', () => {
    const badVout = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, bytesOf(32, 1)],
      [PAYMENT_MEMBER.value, new Uint8Array(32)],
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
      [PAYMENT_MEMBER.vout, 4294967296n], // > u32 max
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [badVout] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })

  it('accepts payment-member with satoshi amount as uint64 bigint', () => {
    const pSatoshi = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, bytesOf(32, 1)],
      [PAYMENT_MEMBER.value, 50_000n], // 50,000 satoshis (uint)
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
      [PAYMENT_MEMBER.vout, 1],
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [pSatoshi] })
    const validated = validateFrame(frame, ctx)
    if (validated.typed?.type === TYPE_DIRECT_MESSAGE_DELIVERY) {
      expect(validated.typed.payments[0].value).toBe(50_000n)
      expect(validated.typed.payments[0].vout).toBe(1)
    }
  })

  it('rejects negative satoshi amount', () => {
    const badAmount = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, bytesOf(32, 1)],
      [PAYMENT_MEMBER.value, -1n], // negative integer (major type 1)
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
    ])
    const frame = deliveryFrame({ payloadFrame: pf, payments: [badAmount] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })

  it('allows same transactionId when vout differs across payment members in one delivery', () => {
    const sharedTxId = bytesOf(32, 42)
    const p0 = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, sharedTxId], // Same txid
      [PAYMENT_MEMBER.value, 10_000n],
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
      [PAYMENT_MEMBER.vout, 0], // output 0
    ])
    const p1 = M([
      [PAYMENT_MEMBER.childIndex, 1],
      [PAYMENT_MEMBER.transactionId, sharedTxId], // Same txid
      [PAYMENT_MEMBER.value, 20_000n],
      [PAYMENT_MEMBER.address, bytesOf(20, 11)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 1)],
      [PAYMENT_MEMBER.vout, 1], // output 1
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    const validated = validateFrame(frame, ctx)
    expect(validated.typed).toBeDefined()
    if (validated.typed?.type === TYPE_DIRECT_MESSAGE_DELIVERY) {
      expect(validated.typed.payments.length).toBe(2)
      expect(validated.typed.payments[0].vout).toBe(0)
      expect(validated.typed.payments[1].vout).toBe(1)
    }
  })

  it('rejects duplicate (transactionId, vout) across payment members', () => {
    const sharedTxId = bytesOf(32, 42)
    const p0 = M([
      [PAYMENT_MEMBER.childIndex, 0],
      [PAYMENT_MEMBER.transactionId, sharedTxId],
      [PAYMENT_MEMBER.value, 10_000n],
      [PAYMENT_MEMBER.address, bytesOf(20, 10)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 0)],
      [PAYMENT_MEMBER.vout, 0],
    ])
    const p1 = M([
      [PAYMENT_MEMBER.childIndex, 1],
      [PAYMENT_MEMBER.transactionId, sharedTxId],
      [PAYMENT_MEMBER.value, 20_000n],
      [PAYMENT_MEMBER.address, bytesOf(20, 11)],
      [PAYMENT_MEMBER.commitment, paymentCommitment(t3, 1)],
      [PAYMENT_MEMBER.vout, 0], // Duplicate vout on same txid!
    ])

    const frame = deliveryFrame({ payloadFrame: pf, payments: [p0, p1] })
    expect(() => validateFrame(frame, ctx)).toThrow(FrankCodecError)
  })
})
