import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { MessageConstructor } from './constructors'
import { messageSourcePublicKey } from './message-source-pubkey'

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

it('matches bitcore message source public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = messageSourcePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(messageSourcePublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(messageSourcePublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(messageSourcePublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(messageSourcePublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(secret.toString('hex')).toBe(SECRET)
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const sourceKey = new PrivateKey(SECRET)
  const destination = new PrivateKey(ONE).toPublicKey()
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const built = ctor.constructMessage(
    {} as never,
    Uint8Array.from([1, 2, 3]),
    sourceKey,
    destination,
    0,
  )
  expect(Buffer.from(built.message.getSourcePublicKey_asU8())).toEqual(
    sourceKey.toPublicKey().toBuffer(),
  )
  expect(built.message.getSourcePublicKey_asU8().length).toBe(33)
  expect(sourceKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  const uncompressedBuilt = ctor.constructMessage(
    {} as never,
    Uint8Array.from([1, 2, 3]),
    uncompressed,
    destination,
    0,
  )
  expect(Buffer.from(uncompressedBuilt.message.getSourcePublicKey_asU8())).toEqual(
    uncompressed.toPublicKey().toBuffer(),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
  expect(uncompressed.toBuffer().toString('hex')).toBe(SECRET)

  const source = readFileSync(join(__dirname, 'constructors.ts'), 'utf8')
  const messageStart = source.indexOf('constructMessage(')
  const message = source.slice(
    messageStart,
    source.indexOf('constructReplyEntry(', messageStart),
  )
  expect(message).toContain('messageSourcePublicKey(')
  expect(message).not.toContain('toPublicKey')
  expect(message).toContain('crypto.Hash.sha256hmac(')
  expect(message).toContain('crypto.Hash.sha256(')
  const stealthStart = source.indexOf('constructStealthEntry(')
  const stealth = source.slice(
    stealthStart,
    source.indexOf('constructImageEntry(', stealthStart),
  )
  expect(stealth).toContain('stealthEphemeralPublicKey(')
  expect(stealth).not.toContain('.publicKey')
  expect(stealth).not.toContain('toPublicKey')
  const helper = readFileSync(join(__dirname, 'message-source-pubkey.ts'), 'utf8')
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => messageSourcePublicKey(Buffer.alloc(32), true)).toThrow(
    'message-source-pubkey:scalar-out-of-range',
  )
  expect(() => messageSourcePublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'message-source-pubkey:scalar-out-of-range',
  )
  expect(() =>
    messageSourcePublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('message-source-pubkey:secret')
  expect(() => messageSourcePublicKey(Buffer.alloc(0), false)).toThrow(
    'message-source-pubkey:secret',
  )
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    messageSourcePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('message-source-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)
})
