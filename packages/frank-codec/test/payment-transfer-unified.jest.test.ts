import {
  FrankCodecError,
  cborMap,
  decodeCanonical,
  decodePaymentMember,
  encodeCanonical,
  encodePaymentMember,
  paymentMember,
  stealthMetadata,
} from '../src'
import { bytesOf } from '../fixtures/builders'
import {
  ACCOUNT_REF,
  KEY_TYPE,
  PAYMENT_MEMBER,
  STEALTH_METADATA,
} from '../src/constants'

function ephemeral() {
  const keyBytes = new Uint8Array(33)
  keyBytes[0] = 0x02
  keyBytes.set(bytesOf(32, 9), 1)
  return { keyType: 1, keyBytes }
}

const stamp = {
  network: 'monad-testnet',
  transactionId: bytesOf(32, 1),
  value: 1n,
  address: bytesOf(20, 2),
  commitment: bytesOf(32, 4),
  childIndex: 0,
  vout: 1,
  rawTx: bytesOf(8, 6),
}

const stealth = {
  network: 'xpi-mainnet',
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
    expect(decodedStealth.network).toBe('xpi-mainnet')
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
        network: 'monad-testnet',
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

  it('rejects a stealth payment on a network that is not in the chain registry', () => {
    for (const network of ['lotus', 'monad', 'zz-not-a-chain']) {
      expect(() => encodePaymentMember({ ...stealth, network })).toThrow(
        /not a chain identifier in docs\/protocol\/chains\/v1.json/,
      )
      const map = decodeCanonical(encodePaymentMember(stealth)) as Map<
        bigint,
        unknown
      >
      map.set(BigInt(PAYMENT_MEMBER.network), network)
      expect(() => paymentMember(map, 'payment-member')).toThrow(
        /not a chain identifier/,
      )
    }
  })
})

function mapOf(
  entries: Array<[number | bigint, unknown]>,
): Map<bigint, unknown> {
  return new Map(entries.map(([k, v]) => [BigInt(k), v]))
}

function secp(bytes: Uint8Array): Map<bigint, unknown> {
  return mapOf([
    [ACCOUNT_REF.keyType, BigInt(KEY_TYPE.secp256k1)],
    [ACCOUNT_REF.keyBytes, bytes],
  ])
}

/** The member as a CBOR map, with `changes` applied (`undefined` deletes a key). */
function memberMap(
  base: Parameters<typeof encodePaymentMember>[0],
  changes: Array<[number, unknown]>,
): Map<bigint, unknown> {
  const map = decodeCanonical(encodePaymentMember(base)) as Map<bigint, unknown>
  for (const [key, value] of changes) {
    if (value === undefined) map.delete(BigInt(key))
    else map.set(BigInt(key), value)
  }
  return map
}

describe('payment-member and stealth-metadata validation', () => {
  const secp33 = ephemeral().keyBytes
  const ed32 = bytesOf(32, 0x22)

  it('rejects stealth metadata that is malformed', () => {
    for (const notMap of ['bad', 123n, null, [], new Uint8Array(1)]) {
      expect(() => stealthMetadata(notMap as never)).toThrow(FrankCodecError)
    }
    expect(() =>
      stealthMetadata(mapOf([[STEALTH_METADATA.viewTag, 42n]])),
    ).toThrow(/missing required key 0/)
    // Key type 1 needs 33 bytes and key type 2 needs 32.
    expect(() =>
      stealthMetadata(mapOf([[STEALTH_METADATA.ephemeralPubKey, secp(ed32)]])),
    ).toThrow(/requires 33 key bytes/)
    expect(() =>
      stealthMetadata(
        mapOf([
          [
            STEALTH_METADATA.ephemeralPubKey,
            mapOf([
              [ACCOUNT_REF.keyType, BigInt(KEY_TYPE.ed25519)],
              [ACCOUNT_REF.keyBytes, secp33],
            ]),
          ],
        ]),
      ),
    ).toThrow(/requires 32 key bytes/)
    // The view tag is at most 65535.
    expect(
      stealthMetadata(
        mapOf([
          [STEALTH_METADATA.ephemeralPubKey, secp(secp33)],
          [STEALTH_METADATA.viewTag, 65535n],
        ]),
      ).viewTag,
    ).toBe(65535)
    expect(() =>
      stealthMetadata(
        mapOf([
          [STEALTH_METADATA.ephemeralPubKey, secp(secp33)],
          [STEALTH_METADATA.viewTag, 65536n],
        ]),
      ),
    ).toThrow(/integer outside/)
    expect(() =>
      stealthMetadata(
        mapOf([
          [STEALTH_METADATA.ephemeralPubKey, secp(secp33)],
          // raw-cbor-key: key 2 is undeclared in stealth metadata
          [2, 'unexpected'],
        ]),
      ),
    ).toThrow(/undeclared key 2/)
  })

  it('rejects a payment member that is not a map', () => {
    for (const notMap of ['not a map', 123n, null, []]) {
      expect(() => paymentMember(notMap as never, 'payment-member')).toThrow(
        FrankCodecError,
      )
    }
  })

  it('rejects payment-member fields outside their bounds', () => {
    const cases: Array<[Map<bigint, unknown>, RegExp]> = [
      [
        memberMap(stamp, [[PAYMENT_MEMBER.transactionId, new Uint8Array(0)]]),
        /byte string size outside 1..128/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.transactionId, new Uint8Array(129)]]),
        /byte string size outside 1..128/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.rawTx, new Uint8Array(16385)]]),
        /byte string size outside 1..16384/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.value, 'invalid-value']]),
        /expected a 32-byte string or an unsigned integer/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.value, new Uint8Array(31)]]),
        /byte string size outside 32..32/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.commitment, new Uint8Array(31)]]),
        /byte string size outside 32..32/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.vout, 4294967296n]]),
        /integer outside/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.address, new Uint8Array(0)]]),
        /byte string size outside 1..128/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.network, '']]),
        /text size outside 1..64/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.network, 'a'.repeat(65)]]),
        /text size outside 1..64/,
      ],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.network, 'Monad']]),
        /network tag does not match S1/,
      ],
      // raw-cbor-key: key 10 is undeclared in a payment member
      [memberMap(stamp, [[10, 'unexpected']]), /undeclared key 10/],
      [
        memberMap(stamp, [[PAYMENT_MEMBER.transactionId, undefined]]),
        /missing required key 1/,
      ],
    ]
    for (const [map, error] of cases) {
      expect(() => paymentMember(map, 'payment-member')).toThrow(error)
    }
    // The boundary values themselves are accepted.
    expect(
      paymentMember(
        memberMap(stamp, [
          [PAYMENT_MEMBER.transactionId, new Uint8Array(128)],
          [PAYMENT_MEMBER.rawTx, new Uint8Array(16384)],
        ]),
        'payment-member',
      ).transactionId,
    ).toHaveLength(128)
  })
})
