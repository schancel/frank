import { getBytes } from 'ethers'

import { MonadIdentity } from './monad-identity'
import {
  deriveMonadStampChildPrivate,
  deriveMonadStampChildPublic,
} from './monad-stamp-stealth'

const RECIPIENT_PRIVATE_KEY = getBytes(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const PAYLOAD_HASH = getBytes(
  '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
)
const EXPECTED = [
  {
    privateKey:
      'ff9f20d1734c9e6ec79d5157eb51e0c53c4f75f029e80a255b142d31d2d365f3',
    publicKey:
      '038eb8a3da7c063c49de5db6471a10a969f5ed136dab82c96b082b2d05c3a5ff82',
    address: '0xF565a34f04f2782d2c2Cf0E55470F229444504Cc',
  },
  {
    privateKey:
      '2f18e095baaa27815848005066151b42dde518a84fe524b324ee307ef1779306',
    publicKey:
      '0323b73e006a84ec716b1e6144fcece5ca2e52cc5d0880aaf499d9b0f4a9e376f2',
    address: '0xB3CaDc6aa46F0228b589646e891C29017a521c48',
  },
] as const

describe('Monad stamp stealth-child derivation', () => {
  it.each([0, 1, 17])(
    'derives the same payment child publicly and privately at index %i',
    paymentIndex => {
      const recipient = MonadIdentity.fromPrivateKeyHex(
        `0x${Buffer.from(RECIPIENT_PRIVATE_KEY).toString('hex')}`,
      )
      const fromPublic = deriveMonadStampChildPublic({
        payloadHash: PAYLOAD_HASH,
        recipientPublicKey: recipient.compressedPubKey,
        paymentIndex,
      })
      const fromPrivate = deriveMonadStampChildPrivate({
        payloadHash: PAYLOAD_HASH,
        recipientPrivateKey: RECIPIENT_PRIVATE_KEY,
        paymentIndex,
      })

      expect(fromPrivate.address).toBe(fromPublic.address)
      expect(fromPrivate.publicKey).toEqual(fromPublic.publicKey)
      expect(fromPublic.derivationPath).toBe(`m/44/145/${paymentIndex}/0`)
    },
  )

  it('produces distinct EVM destinations for distinct payment indices', () => {
    const recipient = MonadIdentity.fromPrivateKeyHex(
      `0x${Buffer.from(RECIPIENT_PRIVATE_KEY).toString('hex')}`,
    )
    const addresses = [0, 1, 2].map(
      paymentIndex =>
        deriveMonadStampChildPublic({
          payloadHash: PAYLOAD_HASH,
          recipientPublicKey: recipient.compressedPubKey,
          paymentIndex,
        }).address,
    )

    expect(new Set(addresses).size).toBe(addresses.length)
  })

  it.each([0, 1])(
    'matches the cross-language protocol vector at index %i',
    paymentIndex => {
      const derived = deriveMonadStampChildPrivate({
        payloadHash: PAYLOAD_HASH,
        recipientPrivateKey: RECIPIENT_PRIVATE_KEY,
        paymentIndex,
      })

      expect(Buffer.from(derived.privateKey).toString('hex')).toBe(
        EXPECTED[paymentIndex].privateKey,
      )
      expect(Buffer.from(derived.publicKey).toString('hex')).toBe(
        EXPECTED[paymentIndex].publicKey,
      )
      expect(derived.address).toBe(EXPECTED[paymentIndex].address)
    },
  )

  it.each([
    new Uint8Array(),
    new Uint8Array(31),
    new Uint8Array(33),
    new Uint8Array(32),
    getBytes(
      '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    ),
  ])('rejects an invalid payload-hash scalar', payloadHash => {
    expect(() =>
      deriveMonadStampChildPrivate({
        payloadHash,
        recipientPrivateKey: RECIPIENT_PRIVATE_KEY,
        paymentIndex: 0,
      }),
    ).toThrow()
  })

  it.each([-1, 1.5, 0x80000000])(
    'rejects invalid or hardened payment index %p',
    paymentIndex => {
      expect(() =>
        deriveMonadStampChildPrivate({
          payloadHash: PAYLOAD_HASH,
          recipientPrivateKey: RECIPIENT_PRIVATE_KEY,
          paymentIndex,
        }),
      ).toThrow('non-hardened uint31')
    },
  )
})
