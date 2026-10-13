import {
  FrankCodecError,
  decodeCanonical,
  defaultContext,
  encodeFrame,
  encodeForwardingEnvelope,
  forwardingPayloadDigest,
  validateFrame,
  type AccountRef,
  type PaymentMember,
} from '../src'
import {
  DIRECT_MESSAGE_DELIVERY,
  FORWARDING_DELIVERY_ENVELOPE,
  FRANK_ENVELOPE,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
} from '../src/constants'
import { M, bytesOf, deliveryFrame, NET } from '../fixtures/builders'

const ctx = defaultContext()

function relay(): AccountRef {
  const keyBytes = new Uint8Array(33)
  keyBytes[0] = 0x02
  keyBytes.set(bytesOf(32, 42), 1)
  return { keyType: 1, keyBytes }
}

function ephemeral(seed: number): AccountRef {
  const keyBytes = new Uint8Array(33)
  keyBytes[0] = 0x02
  keyBytes.set(bytesOf(32, seed), 1)
  return { keyType: 1, keyBytes }
}

function stamp(
  network: string,
  txSeed: number,
  addrSeed: number,
): PaymentMember {
  return {
    network,
    transactionId: bytesOf(32, txSeed),
    value: 1n,
    address: bytesOf(20, addrSeed),
    commitment: bytesOf(32, 0x11),
    childIndex: 0,
  }
}

function stealth(
  network: string,
  txSeed: number,
  addrSeed: number,
): PaymentMember {
  return {
    network,
    transactionId: bytesOf(32, txSeed),
    value: 1n,
    address: bytesOf(20, addrSeed),
    stealthMetadata: { ephemeralPubKey: ephemeral(7) },
  }
}

function deliveryOn(network: string): Uint8Array {
  return encodeFrame(
    {
      typeId: TYPE_DIRECT_MESSAGE_DELIVERY,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    M([[DIRECT_MESSAGE_DELIVERY.network, network]]),
  )
}

function encodeForwarding(
  inner: Uint8Array,
  payments: PaymentMember[],
): Uint8Array {
  return encodeForwardingEnvelope({
    destination: relay(),
    payloadFrame: inner,
    payments,
  })
}

describe('payment item network', () => {
  it('rejects a type 13 frame that still carries key 0', () => {
    const good = encodeForwarding(deliveryFrame(), [stamp(NET, 1, 1)])
    const validated = validateFrame(good, ctx)
    expect(validated.kind).toBe('parsed')
    const envelope = decodeCanonical(good.subarray(9)) as Map<bigint, unknown>
    const payload = decodeCanonical(
      envelope.get(BigInt(FRANK_ENVELOPE.payload)) as Uint8Array,
    ) as Map<bigint, unknown>
    expect(payload.has(0n)).toBe(false) // raw-cbor-key: the retired envelope network tag
    payload.set(0n, NET) // raw-cbor-key: the retired envelope network tag
    const rejected = encodeFrame(
      {
        typeId: TYPE_FORWARDING_DELIVERY_ENVELOPE,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      payload,
    )
    expect(() => validateFrame(rejected, ctx)).toThrow(FrankCodecError)
    try {
      validateFrame(rejected, ctx)
    } catch (error) {
      expect(error).toBeInstanceOf(FrankCodecError)
      const codec = error as FrankCodecError
      expect(codec.category).toBe('schema')
      expect(codec.stage).toBe('8.2')
      expect(codec.detail).toContain('undeclared key 0')
    }
  })

  it('validates one stamp item and one stealth item on two networks', () => {
    const frame = encodeForwarding(deliveryFrame(), [
      stamp('frank-test', 1, 1),
      stealth('lotus', 2, 2),
    ])
    const validated = validateFrame(frame, ctx)
    expect(validated.kind).toBe('parsed')
    if (validated.typed?.type !== TYPE_FORWARDING_DELIVERY_ENVELOPE)
      throw new Error('expected a forwarding envelope')
    const [first, second] = validated.typed.payments
    expect(first.network).toBe('frank-test')
    expect(first.childIndex).toBe(0)
    expect(first.stealthMetadata).toBeUndefined()
    expect(second.network).toBe('lotus')
    expect(second.childIndex).toBeUndefined()
    expect(second.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
  })

  it('computes the forwarding digest from the inner type-10 network', () => {
    const frank = deliveryOn('frank-test')
    const lotus = deliveryOn('lotus-test')
    const frankDigest = forwardingPayloadDigest(frank)
    const lotusDigest = forwardingPayloadDigest(lotus)
    expect(frankDigest).not.toEqual(lotusDigest)
    const frame = encodeForwarding(frank, [stamp('lotus', 3, 3)])
    const envelope = decodeCanonical(frame.subarray(9)) as Map<bigint, unknown>
    const payload = decodeCanonical(
      envelope.get(BigInt(FRANK_ENVELOPE.payload)) as Uint8Array,
    ) as Map<bigint, Uint8Array>
    expect(payload.has(0n)).toBe(false) // raw-cbor-key: the retired envelope network tag
    expect(
      payload.get(BigInt(FORWARDING_DELIVERY_ENVELOPE.payloadDigest)),
    ).toEqual(frankDigest)
    expect(
      payload.get(BigInt(FORWARDING_DELIVERY_ENVELOPE.payloadDigest)),
    ).not.toEqual(lotusDigest)
  })
})
