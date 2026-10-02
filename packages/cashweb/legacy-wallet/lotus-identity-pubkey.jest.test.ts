import { FrankIdentity } from './lotus-identity'
import { lotusIdentityPublicKey } from './lotus-identity-pubkey'
import { sec1Point, SEC1_N_MINUS_1, SEC1_ONE, SEC1_SECRET } from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned FrankIdentity public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = lotusIdentityPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(lotusIdentityPublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(lotusIdentityPublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(lotusIdentityPublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(lotusIdentityPublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)

  const identity = FrankIdentity.fromPrivateKeyHex(SEC1_SECRET, 'mainnet')
  expect(identity.pubKey).toEqual(sec1Point(SEC1_SECRET, true))
  expect(identity.toPrivateKeyHex()).toBe(SEC1_SECRET)
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => lotusIdentityPublicKey(Buffer.alloc(32), true)).toThrow(
    'lotus-identity-pubkey:scalar-out-of-range',
  )
  expect(() => lotusIdentityPublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'lotus-identity-pubkey:scalar-out-of-range',
  )
  expect(() =>
    lotusIdentityPublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('lotus-identity-pubkey:secret')
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    lotusIdentityPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('lotus-identity-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})
