import { createHash } from 'crypto'

import { walletChangeP2pkhScript, walletChangePublicKey } from './change-pubkey'
import { p2pkhScriptFromPublicKey } from './index'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

function p2pkhFromPoint(point: Buffer): Buffer {
  const hash = createHash('ripemd160')
    .update(createHash('sha256').update(point).digest())
    .digest()
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    hash,
    Buffer.from([0x88, 0xac]),
  ])
}

it('matches the pinned change public keys and the 25-byte P2PKH script', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = walletChangePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(walletChangePublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(walletChangePublicKey(secret, false).length).toBe(65)
  expect(secret.toString('hex')).toBe(SEC1_SECRET)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(walletChangePublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(walletChangePublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)

  const privKey = sec1PrivateKey(SEC1_SECRET, true)
  const script = walletChangeP2pkhScript(privKey)
  const compressedPoint = sec1Point(SEC1_SECRET, true)
  expect(script.length).toBe(25)
  expect(script).toEqual(p2pkhFromPoint(compressedPoint))
  expect(script).toEqual(p2pkhScriptFromPublicKey(privKey.toPublicKey()))
  expect(Buffer.from(privKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)

  const uncompressed = sec1PrivateKey(SEC1_SECRET, false)
  const uncompressedScript = walletChangeP2pkhScript(uncompressed)
  expect(uncompressedScript.length).toBe(25)
  expect(uncompressedScript).toEqual(p2pkhFromPoint(sec1Point(SEC1_SECRET, false)))
  expect(uncompressedScript.equals(script)).toBe(false)
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
  expect(Buffer.from(uncompressed.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
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
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    walletChangePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('wallet-change-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)

  const keptKey = sec1PrivateKey(SEC1_SECRET, true)
  const missing = {
    toBuffer: () => Buffer.from(SEC1_SECRET, 'hex'),
  }
  expect(() => walletChangeP2pkhScript(missing)).toThrow(
    'wallet-change-pubkey:compressed',
  )
  expect(Buffer.from(keptKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
})
