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
  ACCOUNT_REF,
  DIRECT_MESSAGE_DELIVERY,
  FORWARDING_DELIVERY_ENVELOPE,
  FRANK_ENVELOPE,
  PAYMENT_MEMBER,
  STEALTH_METADATA,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
} from '../src/constants'
import {
  M,
  NET,
  bytesOf,
  deliveryFrame,
  payment,
  recipientPayloadDigest,
  type5Frame,
} from '../fixtures/builders'

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
      stamp(NET, 1, 1),
      stealth('xpi-testnet', 2, 2),
    ])
    const validated = validateFrame(frame, ctx)
    expect(validated.kind).toBe('parsed')
    if (validated.typed?.type !== TYPE_FORWARDING_DELIVERY_ENVELOPE)
      throw new Error('expected a forwarding envelope')
    const [first, second] = validated.typed.payments
    expect(first.network).toBe(NET)
    expect(first.childIndex).toBe(0)
    expect(first.stealthMetadata).toBeUndefined()
    expect(second.network).toBe('xpi-testnet')
    expect(second.childIndex).toBeUndefined()
    expect(second.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
  })

  it('computes the forwarding digest from the inner type-10 network', () => {
    const frank = deliveryOn('frank-test')
    const lotus = deliveryOn('lotus-test')
    const frankDigest = forwardingPayloadDigest(frank)
    const lotusDigest = forwardingPayloadDigest(lotus)
    expect(frankDigest).not.toEqual(lotusDigest)
    const frame = encodeForwarding(frank, [stamp('frank-test', 3, 3)])
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

  it('rejects a type 10 stamp payment whose network is not the delivery network', () => {
    const t3 = recipientPayloadDigest(NET, type5Frame())
    const relabelled = payment(t3, { index: 0 })
    relabelled.set(PAYMENT_MEMBER.network, 'xpi-mainnet')
    expect(
      validateFrame(
        deliveryFrame({ payments: [payment(t3, { index: 0 })] }),
        ctx,
      ).kind,
    ).toBe('parsed')
    try {
      validateFrame(deliveryFrame({ payments: [relabelled] }), ctx)
      throw new Error('expected a semantic error')
    } catch (error) {
      expect(error).toBeInstanceOf(FrankCodecError)
      expect((error as FrankCodecError).category).toBe('semantic')
      expect((error as FrankCodecError).detail).toContain(
        'stamp payment network differs from the delivery network (S3)',
      )
    }
  })

  it('rejects a type 13 stamp payment whose network is not the inner type-10 network', () => {
    // The encoder refuses it.
    expect(() =>
      encodeForwarding(deliveryOn('frank-test'), [stamp('xpi-mainnet', 3, 3)]),
    ).toThrow(/stamp payment network differs from the delivery network/)
    // A frame written without the encoder is rejected on receive.
    const good = encodeForwarding(deliveryFrame(), [stamp(NET, 1, 1)])
    const envelope = decodeCanonical(good.subarray(9)) as Map<bigint, unknown>
    const payload = decodeCanonical(
      envelope.get(BigInt(FRANK_ENVELOPE.payload)) as Uint8Array,
    ) as Map<bigint, unknown>
    const [member] = payload.get(
      BigInt(FORWARDING_DELIVERY_ENVELOPE.payments),
    ) as Map<bigint, unknown>[]
    member.set(BigInt(PAYMENT_MEMBER.network), 'xpi-mainnet')
    const relabelled = encodeFrame(
      {
        typeId: TYPE_FORWARDING_DELIVERY_ENVELOPE,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      payload,
    )
    try {
      validateFrame(relabelled, ctx)
      throw new Error('expected a semantic error')
    } catch (error) {
      expect(error).toBeInstanceOf(FrankCodecError)
      expect((error as FrankCodecError).category).toBe('semantic')
    }
  })

  it('rejects a stealth payment on an unregistered network in type 10 and type 13', () => {
    for (const network of ['lotus', 'zz-not-a-chain']) {
      expect(() =>
        encodeForwarding(deliveryFrame(), [
          stamp(NET, 1, 1),
          stealth(network, 2, 2),
        ]),
      ).toThrow(/not a chain identifier in docs\/protocol\/chains\/v1.json/)
      const t3 = recipientPayloadDigest(NET, type5Frame())
      const unregistered = M([
        [PAYMENT_MEMBER.network, network],
        [PAYMENT_MEMBER.transactionId, bytesOf(32, 9)],
        [PAYMENT_MEMBER.value, 1n],
        [PAYMENT_MEMBER.address, bytesOf(20, 9)],
        [
          PAYMENT_MEMBER.stealthMetadata,
          M([
            [
              STEALTH_METADATA.ephemeralPubKey,
              M([
                [ACCOUNT_REF.keyType, 1n],
                [ACCOUNT_REF.keyBytes, ephemeral(7).keyBytes],
              ]),
            ],
          ]),
        ],
      ])
      expect(() =>
        validateFrame(
          deliveryFrame({
            payments: [payment(t3, { index: 0 }), unregistered],
          }),
          ctx,
        ),
      ).toThrow(/not a chain identifier/)
    }
  })

  it('reports a non-type-10 inner frame as a codec error', () => {
    const notType10 = encodeFrame(
      {
        typeId: TYPE_FORWARDING_DELIVERY_ENVELOPE,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      M([[0, 'frank-test']]), // raw-cbor-key: arbitrary payload of the wrong frame type
    )
    expect(() => encodeForwarding(notType10, [stamp(NET, 1, 1)])).toThrow(
      FrankCodecError,
    )
    expect(() => encodeForwarding(notType10, [stamp(NET, 1, 1)])).toThrow(
      /forwarding digest requires a type-10 inner frame/,
    )
  })
})
