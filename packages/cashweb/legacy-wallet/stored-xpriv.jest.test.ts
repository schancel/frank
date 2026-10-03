import {
  BTC_MAINNET,
  BTC_TESTNET,
  hdPrivateFromSeed,
  serializeHdPrivate,
} from '@frank/nakamoto'

import { hdPrivateKeyFromStored } from './index'
import { must } from '../nakamoto-oracle'

const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'
const VECTOR_1_MASTER =
  'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'

it('reads the xprv string out of a toObject-shaped record', () => {
  const seed = Uint8Array.from(Buffer.from(VECTOR_1_SEED, 'hex'))
  const node = must(hdPrivateFromSeed(seed))
  const xprv = must(serializeHdPrivate(node, BTC_MAINNET))
  expect(xprv).toBe(VECTOR_1_MASTER)
  const record = {
    network: 'livenet',
    depth: node.depth,
    parentFingerPrint: 0,
    childIndex: node.childIndex,
    chainCode: Buffer.from(node.chainCode).toString('hex'),
    privateKey: Buffer.from(node.privateKey.bytes).toString('hex'),
    xprivkey: xprv,
  }

  expect(hdPrivateKeyFromStored(xprv)).toBe(VECTOR_1_MASTER)
  expect(hdPrivateKeyFromStored(record)).toBe(xprv)
  expect(hdPrivateKeyFromStored({ toString: () => xprv })).toBe(xprv)

  const tprv = must(serializeHdPrivate(node, BTC_TESTNET))
  expect(tprv.startsWith('tprv')).toBe(true)
  expect(
    hdPrivateKeyFromStored({
      ...record,
      network: 'testnet',
      xprivkey: tprv,
    }),
  ).toBe(tprv)
  expect(hdPrivateKeyFromStored(tprv)).toBe(tprv)
})
