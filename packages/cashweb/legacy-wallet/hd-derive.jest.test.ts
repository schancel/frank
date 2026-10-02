import {
  BTC_MAINNET,
  BTC_TESTNET,
  cryptoBackend,
  deriveHdPath,
  encodeAddress,
  hdPrivateFromSeed,
  parseHdPrivate,
  pubkeyHashFromBytes,
  serializeHdPrivate,
  XPI_MAINNET,
  XPI_TESTNET,
} from '@frank/nakamoto'

import { lotusFromPublicKey } from './lotus-address'
import {
  privateKeyFromHdPath,
  walletChangePrivateKey,
  walletReceivePrivateKey,
} from './index'
import { must, pointOf } from '../nakamoto-oracle'

// BIP-0032 test vector 1. Bitcoin Core checks these xprv strings in
// src/test/bip32_tests.cpp (master, then m/0'/1/2'/2).
const VECTOR_1_MASTER =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
const VECTOR_1_CHILD =
  'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334'
const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'

function secretHex(key: { toBuffer(): Uint8Array }): string {
  return Buffer.from(key.toBuffer()).toString('hex')
}

function lotusOf(pub: Uint8Array, networkName: 'livenet' | 'testnet'): string {
  const hash = must(
    pubkeyHashFromBytes(cryptoBackend.hash160(Uint8Array.from(pub))),
  )
  const chain = networkName === 'testnet' ? XPI_TESTNET : XPI_MAINNET
  return must(encodeAddress({ kind: 'p2pkh', hash }, chain, 'lotus'))
}

function childPoint(secret: Uint8Array): Buffer {
  return pointOf(secret, true)
}

it('derives the published BIP32 child and the coin-type 899 paths', () => {
  const seed = Uint8Array.from(Buffer.from(VECTOR_1_SEED, 'hex'))
  const fromSeed = must(hdPrivateFromSeed(seed))
  expect(must(serializeHdPrivate(fromSeed, BTC_MAINNET))).toBe(VECTOR_1_MASTER)

  const master = must(parseHdPrivate(VECTOR_1_MASTER, BTC_MAINNET))
  const published = must(deriveHdPath(master, "m/0'/1/2'/2"))
  expect(must(serializeHdPrivate(published, BTC_MAINNET))).toBe(VECTOR_1_CHILD)
  const derived = privateKeyFromHdPath(VECTOR_1_MASTER, "m/0'/1/2'/2")
  const publishedSecret = Uint8Array.from(published.privateKey.bytes)
  expect(secretHex(derived)).toBe(Buffer.from(publishedSecret).toString('hex'))
  const publishedPoint = childPoint(publishedSecret)
  expect(Buffer.from(derived.toPublicKey().toBuffer())).toEqual(publishedPoint)
  expect(lotusFromPublicKey(derived.toPublicKey(), 'livenet')).toBe(
    lotusOf(publishedPoint, 'livenet'),
  )

  const receive0 = walletReceivePrivateKey(VECTOR_1_MASTER, 0)
  const nakamotoReceive0 = must(deriveHdPath(master, "m/44'/899'/0'/0/0"))
  const receiveSecret = Uint8Array.from(nakamotoReceive0.privateKey.bytes)
  expect(secretHex(receive0)).toBe(Buffer.from(receiveSecret).toString('hex'))
  const receivePoint = childPoint(receiveSecret)
  expect(Buffer.from(receive0.toPublicKey().toBuffer())).toEqual(receivePoint)
  expect(lotusFromPublicKey(receive0.toPublicKey(), 'livenet')).toBe(
    lotusOf(receivePoint, 'livenet'),
  )

  const change0 = walletChangePrivateKey(VECTOR_1_MASTER, 0)
  const nakamotoChange0 = must(deriveHdPath(master, "m/44'/899'/0'/1/0"))
  expect(secretHex(change0)).toBe(
    Buffer.from(nakamotoChange0.privateKey.bytes).toString('hex'),
  )
  expect(secretHex(change0)).not.toBe(secretHex(receive0))

  const receive1 = walletReceivePrivateKey(VECTOR_1_MASTER, 1)
  const nakamotoReceive1 = must(deriveHdPath(master, "m/44'/899'/0'/0/1"))
  expect(secretHex(receive1)).toBe(
    Buffer.from(nakamotoReceive1.privateKey.bytes).toString('hex'),
  )
  expect(secretHex(receive1)).not.toBe(secretHex(receive0))

  const testnet = must(serializeHdPrivate(fromSeed, BTC_TESTNET))
  const testChild = privateKeyFromHdPath(testnet, "m/0'/1")
  const nakamotoTestChild = must(
    deriveHdPath(must(parseHdPrivate(testnet, BTC_TESTNET)), "m/0'/1"),
  )
  expect(testnet.startsWith('tprv')).toBe(true)
  expect(secretHex(testChild)).toBe(
    Buffer.from(nakamotoTestChild.privateKey.bytes).toString('hex'),
  )
  const testPoint = childPoint(
    Uint8Array.from(nakamotoTestChild.privateKey.bytes),
  )
  expect(Buffer.from(testChild.toPublicKey().toBuffer())).toEqual(testPoint)
  expect(lotusFromPublicKey(testChild.toPublicKey(), 'testnet')).toBe(
    lotusOf(testPoint, 'testnet'),
  )

  expect(() => privateKeyFromHdPath(VECTOR_1_MASTER, 'm/00')).toThrow(
    'hd-derive:hd-path',
  )
  expect(() => walletReceivePrivateKey(VECTOR_1_MASTER, -1)).toThrow(
    'hd-derive:hd-path',
  )
})
