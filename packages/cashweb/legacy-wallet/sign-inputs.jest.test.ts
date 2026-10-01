import { readFileSync } from 'fs'
import { join } from 'path'

import {
  PrivateKey,
  Script,
  Transaction,
} from 'bitcore-lib-xpi'
import {
  XPI_MAINNET,
  parseTransaction,
  verifyScript,
} from '@frank/nakamoto'

import { signTransactionInputs } from './index'

const TXID_A = '11'.repeat(32)
const TXID_B = '22'.repeat(32)

function lockingScript(key: PrivateKey): Script {
  return Script.buildPublicKeyHashOut(key.toPublicKey())
}

function spendable(key: PrivateKey, txId: string, satoshis: number) {
  return {
    txId,
    outputIndex: 0,
    script: lockingScript(key).toHex(),
    satoshis,
  }
}

function oneInput(key: PrivateKey): Transaction {
  return new Transaction()
    .from([spendable(key, TXID_A, 50_000)])
    .addOutput(
      new Transaction.Output({
        satoshis: 40_000,
        script: lockingScript(key),
      }),
    )
}

function scriptHex(transaction: Transaction): string[] {
  return transaction.inputs.map(input => input.script.toBuffer().toString('hex'))
}

it('signs legacy wallet inputs with explicit lotus assignments and refuses a partial sign', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  expect(source).not.toContain('.sign(signingKeys)')

  const key = new PrivateKey()
  const other = new PrivateKey()
  const transaction = oneInput(key)
  const before = scriptHex(transaction)
  expect(before).toEqual([''])

  signTransactionInputs(transaction, [key], 'livenet')

  const unlocking = Uint8Array.from(transaction.inputs[0].script.toBuffer())
  expect(unlocking.length).toBeGreaterThan(0)
  const signatureLength = unlocking[0]
  expect(signatureLength).toBeGreaterThan(8)
  expect(signatureLength).toBeLessThan(0x4c)
  // First push is DER plus the lotus sighash byte. ALL|FORKID would be 0x41.
  expect(unlocking[signatureLength]).toBe(0x61)
  expect(scriptHex(transaction)).not.toEqual(before)

  const parsed = parseTransaction(Uint8Array.from(transaction.toBuffer()), XPI_MAINNET)
  if (!parsed.ok) throw new Error(parsed.error.code)
  const locking = Uint8Array.from(transaction.inputs[0].output!.script.toBuffer())
  const spent = [
    {
      value: BigInt(transaction.inputs[0].output!.satoshis),
      scriptPubKey: locking,
    },
  ]
  expect(
    verifyScript(unlocking, locking, {
      chain: XPI_MAINNET,
      transaction: parsed.value,
      inputIndex: 0,
      spent,
    }),
  ).toEqual({ ok: true, value: true })

  const partial = new Transaction()
    .from([spendable(key, TXID_A, 50_000), spendable(other, TXID_B, 50_000)])
    .addOutput(
      new Transaction.Output({
        satoshis: 80_000,
        script: lockingScript(key),
      }),
    )
  const unsigned = scriptHex(partial)
  expect(unsigned).toEqual(['', ''])
  expect(() => signTransactionInputs(partial, [key], 'livenet')).toThrow(
    'sign-partial',
  )
  expect(scriptHex(partial)).toEqual(unsigned)
})
