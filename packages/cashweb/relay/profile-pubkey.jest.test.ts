import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { MessageConstructor } from './constructors'
import { relayProfilePublicKey } from './profile-pubkey'

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

it('matches bitcore profile public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = relayProfilePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(relayProfilePublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(relayProfilePublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(relayProfilePublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(Buffer.from(relayProfilePublicKey(Buffer.from(ONE, 'hex'), true))).toEqual(
    bitcorePublicKey(ONE, true),
  )
  expect(secret.toString('hex')).toBe(SECRET)
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const privKey = new PrivateKey(SECRET)
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const signed = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    ctor.constructPriceFilter(false, 1, 2),
    privKey,
  )
  expect(Buffer.from(signed.getPublicKey_asU8())).toEqual(
    privKey.toPublicKey().toBuffer(),
  )
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  const uncompressedSigned = ctor.constructProfileMetadata(
    { name: 'Ada', bio: 'profile' },
    ctor.constructPriceFilter(false, 1, 2),
    uncompressed,
  )
  expect(Buffer.from(uncompressedSigned.getPublicKey_asU8())).toEqual(
    uncompressed.toPublicKey().toBuffer(),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)

  const source = readFileSync(join(__dirname, 'constructors.ts'), 'utf8')
  const profileStart = source.indexOf('constructProfileMetadata(')
  const profile = source.slice(
    profileStart,
    source.indexOf('return signedPayload', profileStart),
  )
  expect(profile).toContain('relayProfilePublicKey(')
  expect(profile).not.toContain('toPublicKey')
  expect(profile).not.toContain('crypto.Hash')
  const messageStart = source.indexOf('constructMessage(')
  const message = source.slice(
    messageStart,
    source.indexOf('constructReplyEntry(', messageStart),
  )
  expect(message).toContain('toPublicKey(')
  expect(message).toContain('crypto.Hash.sha256hmac(')
  expect(message).toContain('crypto.Hash.sha256(')
  const helper = readFileSync(join(__dirname, 'profile-pubkey.ts'), 'utf8')
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
  const decode = readFileSync(join(__dirname, 'decode-entry.ts'), 'utf8')
  expect(decode).toContain('stealthOutpointPublicKey(')
  expect(decode).not.toContain('pointToCompressed')
  const crypto = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  expect(crypto).toContain('pointToCompressed')
  expect(crypto).toContain('constructStampAddress')
  expect(crypto).toContain('point.mul')
  expect(crypto).toContain('point.add')
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
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    relayProfilePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('profile-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)
})
