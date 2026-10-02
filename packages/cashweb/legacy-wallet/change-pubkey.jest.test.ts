import { PrivateKey, Script } from 'bitcore-lib-xpi'

import { walletChangeP2pkhScript, walletChangePublicKey } from './change-pubkey'
import { p2pkhScriptFromPublicKey } from './index'

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

function bitcoreChangeScript(hex: string, compressed: boolean): Buffer {
  const key = compressed
    ? new PrivateKey(hex)
    : new PrivateKey(Buffer.from(hex, 'hex'))
  return Script.buildPublicKeyHashOut(key.toPublicKey()).toBuffer()
}

it('matches bitcore change public keys and the 25-byte P2PKH script', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = walletChangePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(walletChangePublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(walletChangePublicKey(secret, false).length).toBe(65)
  expect(secret.toString('hex')).toBe(SECRET)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(walletChangePublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(walletChangePublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const privKey = new PrivateKey(SECRET)
  const script = walletChangeP2pkhScript(privKey)
  expect(script.length).toBe(25)
  expect(script).toEqual(bitcoreChangeScript(SECRET, true))
  expect(script).toEqual(p2pkhScriptFromPublicKey(privKey.toPublicKey()))
  expect(privKey.toBuffer().toString('hex')).toBe(SECRET)

  const uncompressed = new PrivateKey(Buffer.from(SECRET, 'hex'))
  const uncompressedScript = walletChangeP2pkhScript(uncompressed)
  expect(uncompressedScript.length).toBe(25)
  expect(uncompressedScript).toEqual(bitcoreChangeScript(SECRET, false))
  expect(uncompressedScript.equals(script)).toBe(false)
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
  expect(uncompressed.toBuffer().toString('hex')).toBe(SECRET)

})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => walletChangePublicKey(Buffer.alloc(32), true)).toThrow(
    'wallet-change-pubkey:scalar-out-of-range',
  )
  expect(() => walletChangePublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'wallet-change-pubkey:scalar-out-of-range',
  )
  expect(() =>
    walletChangePublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('wallet-change-pubkey:secret')
  expect(() => walletChangePublicKey(Buffer.alloc(0), false)).toThrow(
    'wallet-change-pubkey:secret',
  )
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    walletChangePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('wallet-change-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)

  const keptKey = new PrivateKey(SECRET)
  const missing = {
    toBuffer: () => Buffer.from(SECRET, 'hex'),
  } as PrivateKey
  expect(() => walletChangeP2pkhScript(missing)).toThrow(
    'wallet-change-pubkey:compressed',
  )
  expect(keptKey.toBuffer().toString('hex')).toBe(SECRET)
})
