import { PrivateKey, Script, Transaction } from 'bitcore-lib-xpi'
import { XPI_MAINNET, parseTransaction, verifyScript } from '@frank/nakamoto'

import { signTransactionInputs } from './index'
import { WalletOutput, WalletTransaction } from './wallet-tx'

const TXID_A = '11'.repeat(32)
const TXID_B = '22'.repeat(32)

function lockingScript(key: PrivateKey): Buffer {
  return Buffer.from(Script.buildPublicKeyHashOut(key.toPublicKey()).toBuffer())
}

function spendable(key: PrivateKey, txId: string, satoshis: number) {
  return {
    txId,
    outputIndex: 0,
    script: lockingScript(key).toString('hex'),
    satoshis,
  }
}

function oneInput(key: PrivateKey): WalletTransaction {
  return new WalletTransaction().from([spendable(key, TXID_A, 50_000)]).addOutput(
    new WalletOutput({
      satoshis: 40_000,
      script: lockingScript(key),
    }),
  )
}

function bitcoreUnsigned(key: PrivateKey): Transaction {
  return new Transaction()
    .from([spendable(key, TXID_A, 50_000)])
    .addOutput(
      new Transaction.Output({
        satoshis: 40_000,
        script: Script.buildPublicKeyHashOut(key.toPublicKey()),
      }),
    )
}

function scriptHex(transaction: WalletTransaction): string[] {
  return transaction.inputs.map(input =>
    input.script.toBuffer().toString('hex'),
  )
}

it('signs legacy wallet inputs with explicit fork-id assignments and refuses a partial sign', () => {
  const key = new PrivateKey()
  const other = new PrivateKey()
  const transaction = oneInput(key)
  const oracle = bitcoreUnsigned(key)
  expect(transaction.toBuffer().toString('hex')).toBe(oracle.toBuffer().toString('hex'))
  expect(transaction.txid).toBe(oracle.txid)
  const before = scriptHex(transaction)
  expect(before).toEqual([''])

  signTransactionInputs(transaction, [key], 'livenet')

  const unlocking = Uint8Array.from(transaction.inputs[0].script.toBuffer())
  expect(unlocking.length).toBeGreaterThan(0)
  const signatureLength = unlocking[0]
  expect(signatureLength).toBeGreaterThan(8)
  expect(signatureLength).toBeLessThan(0x4c)
  // First push is DER plus ALL|FORKID. SIGHASH_LOTUS|ALL would be 0x61.
  expect(unlocking[signatureLength]).toBe(0x41)
  expect(scriptHex(transaction)).not.toEqual(before)

  const parsed = parseTransaction(
    Uint8Array.from(transaction.toBuffer()),
    XPI_MAINNET,
  )
  if (!parsed.ok) throw new Error(parsed.error.code)
  const locking = Uint8Array.from(transaction.inputs[0].output.script)
  const spent = [
    {
      value: BigInt(transaction.inputs[0].output.satoshis),
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

  const partial = new WalletTransaction()
    .from([spendable(key, TXID_A, 50_000), spendable(other, TXID_B, 50_000)])
    .addOutput(
      new WalletOutput({
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
