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

function type1(network: string): Uint8Array {
  return encodeFrame(
    { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
    M([[0, network]]),
  )
}

function encodeType25(
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
  it('rejects a type 25 frame that still carries key 0', () => {
    const good = encodeType25(deliveryFrame(), [stamp(NET, 1, 1)])
    const validated = validateFrame(good, ctx)
    expect(validated.kind).toBe('parsed')
    const envelope = decodeCanonical(good.subarray(9)) as Map<bigint, unknown>
    const payload = decodeCanonical(envelope.get(3n) as Uint8Array) as Map<
      bigint,
      unknown
    >
    expect(payload.has(0n)).toBe(false)
    payload.set(0n, NET)
    const rejected = encodeFrame(
      { typeId: 25, schemaVersion: 1, minReaderVersion: 1 },
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
    const frame = encodeType25(deliveryFrame(), [
      stamp('frank-test', 1, 1),
      stealth('lotus', 2, 2),
    ])
    const validated = validateFrame(frame, ctx)
    expect(validated.kind).toBe('parsed')
    if (validated.typed?.type !== 25) throw new Error('type 25')
    const [first, second] = validated.typed.payments
    expect(first.network).toBe('frank-test')
    expect(first.childIndex).toBe(0)
    expect(first.stealthMetadata).toBeUndefined()
    expect(second.network).toBe('lotus')
    expect(second.childIndex).toBeUndefined()
    expect(second.stealthMetadata?.ephemeralPubKey.keyType).toBe(1)
  })

  it('computes the forwarding digest from the inner type-1 network', () => {
    const frank = type1('frank-test')
    const lotus = type1('lotus-test')
    const frankDigest = forwardingPayloadDigest(frank)
    const lotusDigest = forwardingPayloadDigest(lotus)
    expect(frankDigest).not.toEqual(lotusDigest)
    const frame = encodeType25(frank, [stamp('lotus', 3, 3)])
    const envelope = decodeCanonical(frame.subarray(9)) as Map<bigint, unknown>
    const payload = decodeCanonical(envelope.get(3n) as Uint8Array) as Map<
      bigint,
      Uint8Array
    >
    expect(payload.has(0n)).toBe(false)
    expect(payload.get(3n)).toEqual(frankDigest)
    expect(payload.get(3n)).not.toEqual(lotusDigest)
  })
})
