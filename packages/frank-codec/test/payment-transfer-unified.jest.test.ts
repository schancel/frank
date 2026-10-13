import {
  FrankCodecError,
  cborMap,
  decodeCanonical,
  decodePaymentMember,
  encodeCanonical,
  encodePaymentMember,
  paymentMember,
} from '../src'
import { bytesOf } from '../fixtures/builders'
import { ACCOUNT_REF, KEY_TYPE, STEALTH_METADATA } from '../src/constants'

function ephemeral() {
  const keyBytes = new Uint8Array(33)
  keyBytes[0] = 0x02
  keyBytes.set(bytesOf(32, 9), 1)
  return { keyType: 1, keyBytes }
}

const stamp = {
  network: 'monad',
  transactionId: bytesOf(32, 1),
  value: 1n,
  address: bytesOf(20, 2),
  commitment: bytesOf(32, 4),
  childIndex: 0,
  vout: 1,
  rawTx: bytesOf(8, 6),
}

const stealth = {
  network: 'lotus',
  transactionId: bytesOf(32, 3),
  value: bytesOf(32, 5),
  address: bytesOf(32, 8),
  stealthMetadata: { ephemeralPubKey: ephemeral(), viewTag: 7 },
  token: bytesOf(32, 9),
  rawTx: bytesOf(4, 2),
}

describe('unified payment-member', () => {
  it('round-trips a stamp payment and a stealth payment', () => {
    const decodedStamp = decodePaymentMember(encodePaymentMember(stamp))
    expect(decodedStamp).toEqual(stamp)
    const decodedStealth = decodePaymentMember(encodePaymentMember(stealth))
    expect(decodedStealth.network).toBe('lotus')
    expect(decodedStealth.childIndex).toBeUndefined()
    expect(decodedStealth.stealthMetadata?.viewTag).toBe(7)
    expect(decodedStealth.token).toEqual(stealth.token)
    expect(decodedStealth.value).toEqual(stealth.value)
  })

  it('requires exactly one of the stamp child index and stealth metadata', () => {
    expect(() =>
      encodePaymentMember({
        ...stamp,
        stealthMetadata: stealth.stealthMetadata,
      }),
    ).toThrow(/exactly one of field 7 or field 8/)
    expect(() =>
      encodePaymentMember({
        network: 'monad',
        transactionId: stamp.transactionId,
        value: 1n,
        address: stamp.address,
      }),
    ).toThrow(/exactly one of field 7 or field 8/)
  })

  it('requires a commitment on a stamp and allows a token only with stealth metadata', () => {
    const { commitment: _commitment, ...withoutCommitment } = stamp
    expect(() => encodePaymentMember(withoutCommitment)).toThrow(
      /stamp payment requires a T4 commitment/,
    )
    expect(() =>
      encodePaymentMember({ ...stamp, token: stealth.token }),
    ).toThrow(/token identifier is allowed only on a stealth payment/)
    expect(decodePaymentMember(encodePaymentMember(stealth)).token).toEqual(
      stealth.token,
    )
  })

  it('rejects the old stamp map and the old payment-transfer map', () => {
    const oldStamp = cborMap([
      [0, 0], // raw-cbor-key: retired stamp child index
      [1, stamp.transactionId], // raw-cbor-key: retired layout
      [2, 1n], // raw-cbor-key: retired layout
      [3, stamp.address], // raw-cbor-key: retired layout
      [4, stamp.commitment], // raw-cbor-key: retired layout
    ])
    const oldMetadata = cborMap([
      [
        STEALTH_METADATA.ephemeralPubKey,
        cborMap([
          [ACCOUNT_REF.keyType, KEY_TYPE.secp256k1],
          [ACCOUNT_REF.keyBytes, ephemeral().keyBytes],
        ]),
      ],
    ])
    const oldTransfer = cborMap([
      [0, 'monad'], // raw-cbor-key: retired payment-transfer network tag
      [1, stamp.transactionId], // raw-cbor-key: retired layout
      [3, stamp.address], // raw-cbor-key: retired layout
      [4, 1n], // raw-cbor-key: retired payment-transfer value
      [6, oldMetadata], // raw-cbor-key: retired payment-transfer stealth metadata
    ])
    for (const map of [oldStamp, oldTransfer]) {
      expect(() =>
        paymentMember(decodeCanonical(encodeCanonical(map)), 'payment-member'),
      ).toThrow(FrankCodecError)
    }
  })
})
