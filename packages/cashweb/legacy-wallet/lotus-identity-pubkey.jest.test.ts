import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { FrankIdentity } from './lotus-identity'
import { lotusIdentityPublicKey } from './lotus-identity-pubkey'

const SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcorePublicKey(hex: string, compressed: boolean): Buffer {
  const key = compressed
    ? new PrivateKey(hex)
    : new PrivateKey(Buffer.from(hex, 'hex'))
  return key.toPublicKey().toBuffer()
}

it('matches bitcore FrankIdentity public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = lotusIdentityPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(lotusIdentityPublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(lotusIdentityPublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(lotusIdentityPublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(lotusIdentityPublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(secret.toString('hex')).toBe(SECRET)
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const identity = FrankIdentity.fromPrivateKeyHex(SECRET, 'mainnet')
  expect(identity.pubKey).toEqual(bitcorePublicKey(SECRET, true))
  expect(identity.toPrivateKeyHex()).toBe(SECRET)

  const source = readFileSync(join(__dirname, 'lotus-identity.ts'), 'utf8')
  const ctorStart = source.indexOf('constructor(secret: Uint8Array')
  const ctor = source.slice(
    ctorStart,
    source.indexOf('static generate', ctorStart),
  )
  expect(ctor).toContain('lotusIdentityPublicKey(')
  expect(ctor).not.toContain('toPublicKey')
  const helper = readFileSync(
    join(__dirname, 'lotus-identity-pubkey.ts'),
    'utf8',
  )
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('point.add')
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
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    lotusIdentityPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('lotus-identity-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)
})
