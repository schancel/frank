import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, PublicKey, Script } from 'bitcore-lib-xpi'

import { p2pkhScriptFromPublicKey } from '../legacy-wallet'
import { relayChangePublicKey } from './relay-change-pubkey'

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

it('matches bitcore relay change-address public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = relayChangePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(relayChangePublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(relayChangePublicKey(secret, false).length).toBe(65)
  expect(relayChangePublicKey(secret, false)[0]).toBe(0x04)
  expect(secret.toString('hex')).toBe(SECRET)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(relayChangePublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(relayChangePublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const privKey = new PrivateKey(SECRET)
  const point = relayChangePublicKey(Uint8Array.from(privKey.toBuffer()), true)
  const pubkey = new PublicKey(Buffer.from(point))
  expect(pubkey.toBuffer()).toEqual(privKey.toPublicKey().toBuffer())
  expect(pubkey.toBuffer().length).toBe(33)
  const script = p2pkhScriptFromPublicKey(pubkey)
  expect(script.length).toBe(25)
  expect(script).toEqual(
    Script.buildPublicKeyHashOut(privKey.toPublicKey()).toBuffer(),
  )
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  const uncompressedPoint = relayChangePublicKey(
    Uint8Array.from(uncompressed.toBuffer()),
    false,
  )
  const uncompressedPub = new PublicKey(Buffer.from(uncompressedPoint))
  expect(uncompressedPub.toBuffer()).toEqual(
    uncompressed.toPublicKey().toBuffer(),
  )
  expect(uncompressedPub.toBuffer().length).toBe(65)
  expect(uncompressedPub.toBuffer()[0]).toBe(0x04)
  const uncompressedScript = p2pkhScriptFromPublicKey(uncompressedPub)
  expect(uncompressedScript).toEqual(
    Script.buildPublicKeyHashOut(uncompressed.toPublicKey()).toBuffer(),
  )
  expect(uncompressedScript.equals(script)).toBe(false)
  expect(uncompressed.toBuffer().toString('hex')).toBe(SECRET)

  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const start = source.indexOf('async deleteMessage(')
  const body = source.slice(start, source.indexOf('async putProfile(', start))
  expect(body).toContain('relayChangePublicKey(')
  expect(body).toContain('new PublicKey(')
  expect(body).toContain('forwardUTXOsToPubkey(')
  expect(body).not.toContain('toPublicKey')
  expect(source).toContain("from 'bitcore-lib-xpi'")
  expect(source).not.toContain('publicFromPrivate')

  const helper = readFileSync(join(__dirname, 'relay-change-pubkey.ts'), 'utf8')
  const impl = helper.slice(
    helper.indexOf('export function relayChangePublicKey'),
  )
  expect(impl).toContain('publicFromPrivate(')
  expect(impl).toContain('privateKeyFromSecretBytes(')
  expect(impl).not.toContain('toPublicKey')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('fromSeed')
  expect(helper).not.toContain('lotus')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => relayChangePublicKey(Buffer.alloc(32), true)).toThrow(
    'relay-change-pubkey:scalar-out-of-range',
  )
  expect(() => relayChangePublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'relay-change-pubkey:scalar-out-of-range',
  )
  expect(() =>
    relayChangePublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('relay-change-pubkey:secret')
  expect(() => relayChangePublicKey(Buffer.alloc(0), false)).toThrow(
    'relay-change-pubkey:secret',
  )
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    relayChangePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('relay-change-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)

  const keptKey = new PrivateKey(SECRET)
  const before = keptKey.toPublicKey().toBuffer()
  expect(keptKey.toBuffer().toString('hex')).toBe(SECRET)
  expect(before.equals(bitcorePublicKey(SECRET, true))).toBe(true)
})
