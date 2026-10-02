import { Address, PrivateKey, Script } from 'bitcore-lib-xpi'

import {
  p2pkhHashFromPublicKey,
  p2pkhHashFromScript,
  p2pkhLockingScript,
  sameHash,
} from './lotus-address'
import { unspentOutputFromAddress } from './index'

const HASH = 'b50b86a893d80c9e2ee72b199612374b7b4c1cd8'
const LOTUS = 'lotus_16PSJNf1EDEfGvaYzaXJCJZrXH4pgiTo7kyW61iGi'
const SCRIPT = '76a914b50b86a893d80c9e2ee72b199612374b7b4c1cd888ac'
const TXID = '11'.repeat(32)
const WIF = 'L4rK1yDtCWekvXuE6oXD9jCYfFNV2cWRpVuPLBcCU2z8TrisoyY1'

it('builds the p2pkh script from a lotus string and omits that string from the unspent output', () => {
  expect(Buffer.from(p2pkhLockingScript(LOTUS)).toString('hex')).toBe(SCRIPT)
  expect(
    Buffer.from(p2pkhLockingScript(`payto:${LOTUS}?amount=10`)).toString('hex'),
  ).toBe(SCRIPT)

  const key = new PrivateKey(WIF)
  const fromKey = Script.buildPublicKeyHashOut(key.toPublicKey()).toBuffer()
  expect(
    sameHash(
      p2pkhHashFromScript(fromKey),
      p2pkhHashFromPublicKey(key.toPublicKey().toBuffer()),
    ),
  ).toBe(true)
  expect(Buffer.from(p2pkhHashFromScript(fromKey)).toString('hex')).toBe(
    key.toAddress().hashBuffer.toString('hex'),
  )
  expect(Buffer.from(p2pkhLockingScript(key.toAddress().toString()))).toEqual(
    fromKey,
  )
  expect(
    Buffer.from(p2pkhLockingScript(key.toAddress().toCashAddress())),
  ).toEqual(fromKey)

  const unspent = unspentOutputFromAddress({
    txId: TXID,
    outputIndex: 0,
    satoshis: 1000,
    address: LOTUS,
  })
  expect(unspent.script.toBuffer().toString('hex')).toBe(SCRIPT)
  expect(unspent.address).toBeUndefined()

  const scriptHash = new Address(
    Buffer.from(HASH, 'hex'),
    'livenet',
    'scripthash',
  )
  expect(() => p2pkhLockingScript(scriptHash)).toThrow('address-kind')
  expect(() => p2pkhLockingScript(scriptHash.toString())).toThrow(
    'address-kind',
  )
})
