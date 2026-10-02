import { HDPrivateKey, Networks, PrivateKey } from 'bitcore-lib-xpi'

import {
  privateKeyFromHdPath,
  walletChangePrivateKey,
  walletReceivePrivateKey,
} from './index'

// BIP-0032 test vector 1. Bitcoin Core checks these xprv strings in
// src/test/bip32_tests.cpp (master, then m/0'/1/2'/2).
const VECTOR_1_MASTER =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
const VECTOR_1_CHILD =
  'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334'
const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'

function secretHex(key: PrivateKey): string {
  return key.toBuffer().toString('hex')
}

it('derives the published BIP32 child and the existing coin-type 899 paths', () => {

  const master = new HDPrivateKey(VECTOR_1_MASTER)
  const published = master.deriveChild("m/0'/1/2'/2")
  expect(published.toString()).toBe(VECTOR_1_CHILD)
  const derived = privateKeyFromHdPath(master, "m/0'/1/2'/2")
  expect(secretHex(derived)).toBe(secretHex(published.privateKey))
  expect(derived.toPublicKey().toBuffer().length).toBe(33)
  expect(derived.toAddress().toXAddress()).toBe(
    published.privateKey.toAddress().toXAddress(),
  )

  const receive0 = walletReceivePrivateKey(master, 0)
  const bitcoreReceive0 = master
    .deriveChild(44, true)
    .deriveChild(899, true)
    .deriveChild(0, true)
    .deriveChild(0)
    .deriveChild(0).privateKey
  expect(secretHex(receive0)).toBe(secretHex(bitcoreReceive0))
  expect(receive0.toPublicKey().toBuffer().toString('hex')).toBe(
    bitcoreReceive0.toPublicKey().toBuffer().toString('hex'),
  )
  expect(receive0.toAddress().toXAddress()).toBe(
    bitcoreReceive0.toAddress().toXAddress(),
  )

  const change0 = walletChangePrivateKey(master, 0)
  const bitcoreChange0 = master
    .deriveChild("m/44'/899'/0'/1/0").privateKey
  expect(secretHex(change0)).toBe(secretHex(bitcoreChange0))
  expect(secretHex(change0)).not.toBe(secretHex(receive0))

  const receive1 = walletReceivePrivateKey(master, 1)
  const bitcoreReceive1 = master
    .deriveChild("m/44'/899'/0'/0/1").privateKey
  expect(secretHex(receive1)).toBe(secretHex(bitcoreReceive1))
  expect(secretHex(receive1)).not.toBe(secretHex(receive0))

  const fromSeed = HDPrivateKey.fromSeed as (
    seed: string,
    network: Networks.Network,
  ) => HDPrivateKey
  const testnet = fromSeed(VECTOR_1_SEED, Networks.testnet)
  const testChild = privateKeyFromHdPath(testnet, "m/0'/1")
  const bitcoreTestChild = testnet.deriveChild("m/0'/1").privateKey
  expect(testnet.toString().startsWith('tprv')).toBe(true)
  expect(secretHex(testChild)).toBe(secretHex(bitcoreTestChild))
  expect(testChild.toAddress().toXAddress()).toBe(
    bitcoreTestChild.toAddress().toXAddress(),
  )

  expect(() => privateKeyFromHdPath(master, 'm/00')).toThrow(
    'hd-derive:hd-path',
  )
  expect(() => walletReceivePrivateKey(master, -1)).toThrow(
    'hd-derive:hd-path',
  )
})
