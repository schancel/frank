import {
  FrankCodecError,
  defaultContext,
  validateFrame,
  storagePaymentCommitment,
  forwardingPayloadDigest,
  encodeForwardingEnvelope,
  isForwardingEnvelopeFrame,
  projectForwardingEnvelope,
  validateForwardingEnvelope,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  type CanonicalForwardingEnvelope,
  type PaymentMember,
  type AccountRef,
} from '../src'
import {
  M,
  bytesOf,
  deliveryFrame,
  NET,
} from '../fixtures/builders'

const ctx = defaultContext()

function relayAccount(seed: number): AccountRef {
  const k = new Uint8Array(33)
  k[0] = 0x02
  k.set(bytesOf(32, seed), 1)
  return { keyType: 1, keyBytes: k }
}

describe('Type 25: Forwarding Delivery Envelope', () => {
  const innerFrame = deliveryFrame()
  const destinationRelay = relayAccount(42)
  const digest = forwardingPayloadDigest(NET, innerFrame)

  const samplePayment: PaymentMember = {
    childIndex: 0,
    transactionId: bytesOf(32, 101),
    value: 100_000n,
    address: bytesOf(20, 1),
    commitment: storagePaymentCommitment(digest, 0),
    vout: 0,
  }

  it('encodes, validates, and projects a valid forwarding delivery envelope', () => {
    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [samplePayment],
      endpoint: 'https://relay.frank.org/message/cbor',
      expiresAt: 1750000000,
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    expect(frameBytes.length).toBeGreaterThan(innerFrame.length)

    const validated = validateForwardingEnvelope(frameBytes, ctx)
    expect(validated.typeId).toBe(TYPE_FORWARDING_DELIVERY_ENVELOPE)
    expect(isForwardingEnvelopeFrame(validated)).toBe(true)

    const typed = validated.typed!
    expect(typed.type).toBe(25)
    expect(typed.network).toBe(NET)
    expect(typed.destination.keyType).toBe(1)
    expect(typed.destination.keyBytes).toEqual(destinationRelay.keyBytes)
    expect(typed.endpoint).toBe('https://relay.frank.org/message/cbor')
    expect(typed.expiresAt).toBe(1750000000)
    expect(typed.payments).toHaveLength(1)
    expect(typed.payments[0].childIndex).toBe(0)
    expect(typed.payments[0].value).toBe(100_000n)
    expect(typed.payments[0].vout).toBe(0)

    // Inner frame is opened as Type 1
    expect(typed.payloadFrame.typeId).toBe(TYPE_DIRECT_MESSAGE_DELIVERY)
    expect(typed.payloadFrame.typed?.type).toBe(1)

    // Projection matches
    const projected = projectForwardingEnvelope(validated)
    expect(projected.network).toBe(NET)
    expect(projected.endpoint).toBe('https://relay.frank.org/message/cbor')
    expect(projected.expiresAt).toBe(1750000000)
    expect(projected.payments).toHaveLength(1)
  })

  it('accepts envelope without optional endpoint and expiresAt', () => {
    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [samplePayment],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    const validated = validateForwardingEnvelope(frameBytes, ctx)
    expect(validated.typed?.endpoint).toBeUndefined()
    expect(validated.typed?.expiresAt).toBeUndefined()
  })

  it('validates multiple ordered payments with UTXO vouts', () => {
    const p0: PaymentMember = {
      childIndex: 0,
      transactionId: bytesOf(32, 201),
      value: 50_000n,
      address: bytesOf(20, 1),
      commitment: storagePaymentCommitment(digest, 0),
      vout: 0,
    }
    const p1: PaymentMember = {
      childIndex: 1,
      transactionId: bytesOf(32, 201), // same txid, different vout
      value: 50_000n,
      address: bytesOf(20, 2),
      commitment: storagePaymentCommitment(digest, 1),
      vout: 1,
    }

    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [p0, p1],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    const validated = validateForwardingEnvelope(frameBytes, ctx)
    expect(validated.typed?.payments).toHaveLength(2)
    expect(validated.typed?.payments[0].vout).toBe(0)
    expect(validated.typed?.payments[1].vout).toBe(1)
  })

  it('rejects envelope if network does not match inner delivery frame network', () => {
    const envelope: CanonicalForwardingEnvelope = {
      network: 'different-network',
      destination: destinationRelay,
      payloadFrame: innerFrame, // inner network is NET ('frank-test')
      payments: [samplePayment],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(FrankCodecError)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(/forwarding network differs from the type-1 network/)
  })

  it('rejects destination account with keyType other than 1', () => {
    const badDest: AccountRef = {
      keyType: 2, // Ed25519
      keyBytes: bytesOf(32, 99),
    }

    expect(() =>
      encodeForwardingEnvelope({
        network: NET,
        destination: badDest,
        payloadFrame: innerFrame,
        payments: [samplePayment],
      }),
    ).toThrow(/destination account must be key type 1/)
  })

  it('rejects duplicate childIndex in storage payment members', () => {
    const p0: PaymentMember = {
      childIndex: 0,
      transactionId: bytesOf(32, 301),
      value: 10_000n,
      address: bytesOf(20, 1),
      commitment: storagePaymentCommitment(digest, 0),
    }
    const pDup: PaymentMember = {
      childIndex: 0,
      transactionId: bytesOf(32, 302),
      value: 10_000n,
      address: bytesOf(20, 2),
      commitment: storagePaymentCommitment(digest, 0),
    }

    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [p0, pDup],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(FrankCodecError)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(/duplicate child index/)
  })

  it('rejects non-contiguous childIndex in payment members', () => {
    const p0: PaymentMember = {
      childIndex: 0,
      transactionId: bytesOf(32, 401),
      value: 10_000n,
      address: bytesOf(20, 1),
      commitment: storagePaymentCommitment(digest, 0),
    }
    const pGap: PaymentMember = {
      childIndex: 2, // gap: missing index 1
      transactionId: bytesOf(32, 402),
      value: 10_000n,
      address: bytesOf(20, 2),
      commitment: storagePaymentCommitment(digest, 2),
    }

    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [p0, pGap],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(FrankCodecError)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(/contiguous/)
  })

  it('rejects duplicate transaction ID without distinguishing vout', () => {
    const sharedTxId = bytesOf(32, 501)
    const p0: PaymentMember = {
      childIndex: 0,
      transactionId: sharedTxId,
      value: 10_000n,
      address: bytesOf(20, 1),
      commitment: storagePaymentCommitment(digest, 0),
    }
    const p1: PaymentMember = {
      childIndex: 1,
      transactionId: sharedTxId, // same txid, no vout
      value: 10_000n,
      address: bytesOf(20, 2),
      commitment: storagePaymentCommitment(digest, 1),
    }

    const envelope: CanonicalForwardingEnvelope = {
      network: NET,
      destination: destinationRelay,
      payloadFrame: innerFrame,
      payments: [p0, p1],
    }

    const frameBytes = encodeForwardingEnvelope(envelope)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(FrankCodecError)
    expect(() => validateFrame(frameBytes, ctx)).toThrow(/duplicate transaction id/)
  })
})
