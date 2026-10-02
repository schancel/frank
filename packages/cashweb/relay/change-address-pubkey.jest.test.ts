import { relayChangeAddressPublicKey } from './change-address-pubkey'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned change-address public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  for (const hex of [SEC1_SECRET, SEC1_N_MINUS_1, SEC1_ONE]) {
    for (const compressed of [true, false]) {
      const bytes = Buffer.from(hex, 'hex')
      const point = relayChangeAddressPublicKey(bytes, compressed)
      expect(Buffer.from(point)).toEqual(sec1Point(hex, compressed))
      expect(point.length).toBe(compressed ? 33 : 65)
      if (compressed) {
        expect(point[0] === 0x02 || point[0] === 0x03).toBe(true)
      } else {
        expect(point[0]).toBe(0x04)
      }
      expect(bytes.toString('hex')).toBe(hex)
    }
  }
  expect(secret.toString('hex')).toBe(SEC1_SECRET)

  const privKey = sec1PrivateKey(SEC1_SECRET, true)
  expect(privKey.compressed).toBe(true)
  expect(
    Buffer.from(
      relayChangeAddressPublicKey(Uint8Array.from(privKey.toBuffer()), true),
    ),
  ).toEqual(sec1Point(SEC1_SECRET, true))
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)

  const uncompressed = sec1PrivateKey(SEC1_SECRET, false)
  expect(uncompressed.compressed).toBe(false)
  expect(
    Buffer.from(
      relayChangeAddressPublicKey(
        Uint8Array.from(uncompressed.toBuffer()),
        false,
      ),
    ),
  ).toEqual(sec1Point(SEC1_SECRET, false))
  expect(Buffer.from(uncompressed.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => relayChangeAddressPublicKey(Buffer.alloc(32), true)).toThrow(
    'change-address-pubkey:scalar-out-of-range',
  )
  expect(() =>
    relayChangeAddressPublicKey(Buffer.from(N_HEX, 'hex'), true),
  ).toThrow('change-address-pubkey:scalar-out-of-range')
  expect(() =>
    relayChangeAddressPublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('change-address-pubkey:secret')
  expect(() => relayChangeAddressPublicKey(Buffer.alloc(0), false)).toThrow(
    'change-address-pubkey:secret',
  )
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    relayChangeAddressPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('change-address-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})
