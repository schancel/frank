import { registryIdentityPublicKey } from './identity-pubkey'
import { RegistryHandler } from './index'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned registry identity public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = registryIdentityPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(registryIdentityPublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(registryIdentityPublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(registryIdentityPublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(registryIdentityPublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)

  const privKey = sec1PrivateKey(SEC1_SECRET, true)
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
  const registry = new RegistryHandler({
    registrys: ['https://registry.example'],
    networkName: 'livenet',
  })
  const signed = registry.constructRelayUrlMetadata(
    'https://relay.example',
    privKey,
  )
  expect(Buffer.from(signed.getPublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, true),
  )
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)

  const uncompressed = sec1PrivateKey(SEC1_SECRET, false)
  const uncompressedSigned = registry.constructRelayUrlMetadata(
    'https://relay.example',
    uncompressed,
  )
  expect(Buffer.from(uncompressedSigned.getPublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => registryIdentityPublicKey(Buffer.alloc(32), true)).toThrow(
    'registry-identity-pubkey:scalar-out-of-range',
  )
  expect(() =>
    registryIdentityPublicKey(Buffer.from(N_HEX, 'hex'), true),
  ).toThrow('registry-identity-pubkey:scalar-out-of-range')
  expect(() =>
    registryIdentityPublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('registry-identity-pubkey:secret')
  expect(() => registryIdentityPublicKey(Buffer.alloc(0), false)).toThrow(
    'registry-identity-pubkey:secret',
  )
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    registryIdentityPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('registry-identity-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})
