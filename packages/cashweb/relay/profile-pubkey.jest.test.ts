import { MessageConstructor } from './constructors'
import { relayProfilePublicKey } from './profile-pubkey'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned profile public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = relayProfilePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(relayProfilePublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(relayProfilePublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(relayProfilePublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(relayProfilePublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)

  const privKey = sec1PrivateKey(SEC1_SECRET, true)
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const signed = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    ctor.constructPriceFilter(false, 1, 2),
    privKey,
  )
  expect(Buffer.from(signed.getPublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, true),
  )
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)

  const uncompressed = sec1PrivateKey(SEC1_SECRET, false)
  const uncompressedSigned = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    ctor.constructPriceFilter(false, 1, 2),
    uncompressed,
  )
  expect(Buffer.from(uncompressedSigned.getPublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => relayProfilePublicKey(Buffer.alloc(32), true)).toThrow(
    'profile-pubkey:scalar-out-of-range',
  )
  expect(() => relayProfilePublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'profile-pubkey:scalar-out-of-range',
  )
  expect(() =>
    relayProfilePublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('profile-pubkey:secret')
  expect(() => relayProfilePublicKey(Buffer.alloc(0), false)).toThrow(
    'profile-pubkey:secret',
  )
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    relayProfilePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('profile-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})
