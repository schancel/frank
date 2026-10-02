import {
  BCH_MAINNET,
  XPI_MAINNET,
  XPI_TESTNET,
  encodeAddress,
  privateKeyFromWif,
  publicFromPrivate,
  pubkeyHashFromBytes,
} from '@frank/nakamoto'

import {
  lotusFromAddress,
  lotusFromPrivateKey,
  lotusFromPublicKey,
  p2pkhHashFromPublicKey,
  p2pkhHashFromScript,
  p2pkhLockingScript,
  sameHash,
} from './lotus-address'
import { Wallet, unspentOutputFromAddress } from './index'
import { utxoPrivateKeyFromSecret } from '../types/utxo'
import { must } from '../nakamoto-oracle'

const HASH = 'b50b86a893d80c9e2ee72b199612374b7b4c1cd8'
const LOTUS = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
const SCRIPT = '76a914b50b86a893d80c9e2ee72b199612374b7b4c1cd888ac'
const TXID = '11'.repeat(32)
const WIF = 'L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1'
const LOTUSD_P2PKH = '76a9149a1c78a507689f6f54b847ad1cef1e614ee23f1e88ac'
const LOTUSD_POINT =
  '03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd'

function hashOf(hex: string) {
  return must(pubkeyHashFromBytes(Uint8Array.from(Buffer.from(hex, 'hex'))))
}

it('builds the p2pkh script from a lotus string and omits that string from the unspent output', () => {
  expect(Buffer.from(p2pkhLockingScript(LOTUS)).toString('hex')).toBe(SCRIPT)
  expect(
    Buffer.from(p2pkhLockingScript(`payto:${LOTUS}?amount=10`)).toString('hex'),
  ).toBe(SCRIPT)

  const parsed = must(privateKeyFromWif(WIF, XPI_MAINNET))
  const point = must(publicFromPrivate(parsed))
  expect(Buffer.from(point.compressed).toString('hex')).toBe(LOTUSD_POINT)
  const key = utxoPrivateKeyFromSecret(parsed.bytes)
  parsed.bytes.fill(0)
  const lotusdHash = hashOf('9a1c78a507689f6f54b847ad1cef1e614ee23f1e')
  const mainnet = must(
    encodeAddress({ kind: 'p2pkh', hash: lotusdHash }, XPI_MAINNET, 'lotus'),
  )
  const testnet = must(
    encodeAddress({ kind: 'p2pkh', hash: lotusdHash }, XPI_TESTNET, 'lotus'),
  )
  const cashaddr = must(
    encodeAddress({ kind: 'p2pkh', hash: lotusdHash }, BCH_MAINNET, 'cashaddr'),
  )
  const fromKey = Buffer.from(p2pkhLockingScript(mainnet))
  expect(fromKey.toString('hex')).toBe(LOTUSD_P2PKH)
  expect(
    sameHash(
      p2pkhHashFromScript(fromKey),
      p2pkhHashFromPublicKey(key.toPublicKey().toBuffer()),
    ),
  ).toBe(true)
  expect(Buffer.from(p2pkhHashFromScript(fromKey)).toString('hex')).toBe(
    '9a1c78a507689f6f54b847ad1cef1e614ee23f1e',
  )
  expect(lotusFromPrivateKey(key, 'livenet')).toBe(mainnet)
  expect(lotusFromPublicKey(key.toPublicKey(), 'testnet')).toBe(testnet)
  expect(lotusFromAddress(mainnet, 'livenet')).toBe(mainnet)
  expect(Buffer.from(p2pkhLockingScript(cashaddr))).toEqual(fromKey)
  expect(Buffer.from(p2pkhLockingScript(mainnet))).toEqual(fromKey)

  const unspent = unspentOutputFromAddress({
    txId: TXID,
    outputIndex: 0,
    satoshis: 1000,
    address: LOTUS,
  })
  expect(unspent.script).toBe(SCRIPT)
  expect('address' in unspent).toBe(false)

  const scriptHash = {
    hashBuffer: Uint8Array.from(Buffer.from(HASH, 'hex')),
    type: 'scripthash',
  }
  expect(() => p2pkhLockingScript(scriptHash)).toThrow('address-kind')
  const scriptHashString = must(
    encodeAddress(
      { kind: 'p2sh', hash: hashOf(HASH) },
      BCH_MAINNET,
      'cashaddr',
    ),
  )
  expect(() => p2pkhLockingScript(scriptHashString)).toThrow('address-kind')
})

it('returns the Lotus identity string from myAddress', () => {
  const parsed = must(privateKeyFromWif(WIF, XPI_MAINNET))
  const key = utxoPrivateKeyFromSecret(parsed.bytes)
  parsed.bytes.fill(0)
  const wallet = new Wallet({} as never, { networkName: 'livenet' })
  wallet._identityPrivKey = key
  expect(wallet.myAddress).toBe(lotusFromPrivateKey(key, 'livenet'))
  expect(wallet.displayAddress).toBe(wallet.myAddress)
  const missing = new Wallet({} as never, { networkName: 'testnet' })
  expect(missing.myAddress).toBeUndefined()
})
