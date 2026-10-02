import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { relayChangeAddressPublicKey } from './change-address-pubkey'

const SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcorePublicKey(hex: string, compressed: boolean): Buffer {
  const key = compressed
    ? new PrivateKey(hex)
    : new PrivateKey(Buffer.from(hex, 'hex'))
  return key.toPublicKey().toBuffer()
}

it('matches bitcore change-address public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  for (const hex of [SECRET, N_MINUS_1, ONE]) {
    for (const compressed of [true, false]) {
      const bytes = Buffer.from(hex, 'hex')
      const point = relayChangeAddressPublicKey(bytes, compressed)
      const oracle = bitcorePublicKey(hex, compressed)
      expect(Buffer.from(point)).toEqual(oracle)
      expect(point.length).toBe(compressed ? 33 : 65)
      if (compressed) {
        expect(point[0] === 0x02 || point[0] === 0x03).toBe(true)
      } else {
        expect(point[0]).toBe(0x04)
      }
      const wrapped = new PublicKey(Buffer.from(point))
      expect(wrapped.toBuffer()).toEqual(oracle)
      expect(wrapped.compressed).toBe(compressed)
      expect(bytes.toString('hex')).toBe(hex)
    }
  }
  expect(secret.toString('hex')).toBe(SECRET)

  const privKey = new PrivateKey(SECRET)
  expect((privKey as unknown as { compressed?: boolean }).compressed).toBe(
    true,
  )
  expect(
    Buffer.from(
      relayChangeAddressPublicKey(Uint8Array.from(privKey.toBuffer()), true),
    ),
  ).toEqual(privKey.toPublicKey().toBuffer())
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  expect(
    (uncompressed as unknown as { compressed?: boolean }).compressed,
  ).toBe(false)
  expect(
    Buffer.from(
      relayChangeAddressPublicKey(
        Uint8Array.from(uncompressed.toBuffer()),
        false,
      ),
    ),
  ).toEqual(uncompressed.toPublicKey().toBuffer())
  expect(uncompressed.toBuffer().toString('hex')).toBe(SECRET)
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)

  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const start = source.indexOf('async deleteMessage(digest: string)')
  const body = source.slice(start, source.indexOf('async putProfile(', start))
  expect(body).toContain('relayChangeAddressPublicKey(')
  expect(body).toContain('new PublicKey(')
  expect(body).not.toContain('toPublicKey')

  const helper = readFileSync(
    join(__dirname, 'change-address-pubkey.ts'),
    'utf8',
  )
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('sha256')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
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
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    relayChangeAddressPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('change-address-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)
})
