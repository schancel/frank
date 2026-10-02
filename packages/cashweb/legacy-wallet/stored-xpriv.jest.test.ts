import { HDPrivateKey, Networks } from 'bitcore-lib-xpi'

import { hdPrivateKeyFromStored } from './index'

const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f'

it('builds the bitcore key from a toObject record that omits checksum', () => {
  const key = HDPrivateKey.fromSeed(VECTOR_1_SEED, Networks.livenet)
  const full = key.toObject() as {
    network: string
    depth: number
    parentFingerPrint: number
    childIndex: number
    chainCode: string
    privateKey: string
    xprivkey: string
  }
  const slim = {
    network: full.network,
    depth: full.depth,
    parentFingerPrint: full.parentFingerPrint,
    childIndex: full.childIndex,
    chainCode: full.chainCode,
    privateKey: full.privateKey,
    xprivkey: full.xprivkey,
  }

  expect(hdPrivateKeyFromStored(key).toString()).toBe(key.toString())
  expect(hdPrivateKeyFromStored(slim).toString()).toBe(key.toString())
  expect(hdPrivateKeyFromStored(full).toString()).toBe(full.xprivkey)

  const testnet = HDPrivateKey.fromSeed(VECTOR_1_SEED, Networks.testnet)
  const testRecord = testnet.toObject() as typeof full
  expect(hdPrivateKeyFromStored(testRecord).toString()).toBe(testnet.toString())
  expect(testnet.toString().startsWith('tprv')).toBe(true)
})
