import { XPI_MAINNET, parseTransaction, verifyScript } from '@frank/nakamoto'

import { p2pkhScriptFromPublicKey, signTransactionInputs } from './index'
import { utxoPrivateKeyFromSecret } from '../types/utxo'
import { WalletOutput, WalletTransaction } from './wallet-tx'

const TXID_A = '11'.repeat(32)
const TXID_B = '22'.repeat(32)
const SECRET_A = '11'.repeat(32)
const SECRET_B = '22'.repeat(32)

function keyFrom(hex: string) {
  return utxoPrivateKeyFromSecret(Uint8Array.from(Buffer.from(hex, 'hex')))
}

function lockingScript(key: {
  toPublicKey(): { toBuffer(): Uint8Array }
}): Buffer {
  return Buffer.from(p2pkhScriptFromPublicKey(key.toPublicKey()))
}

function spendable(
  key: { toPublicKey(): { toBuffer(): Uint8Array } },
  txId: string,
  satoshis: number,
) {
  return {
    txId,
    outputIndex: 0,
    script: lockingScript(key).toString('hex'),
    satoshis,
  }
}

function unsignedHex(
  script: Uint8Array,
  txidDisplay: string,
  satoshis: number,
): string {
  const txid = Buffer.from(txidDisplay, 'hex').reverse()
  const value = Buffer.alloc(8)
  value.writeBigUInt64LE(BigInt(satoshis))
  return Buffer.concat([
    Buffer.from('02000000', 'hex'),
    Buffer.of(1),
    txid,
    Buffer.alloc(4),
    Buffer.of(0),
    Buffer.from('ffffffff', 'hex'),
    Buffer.of(1),
    value,
    Buffer.of(script.length),
    Buffer.from(script),
    Buffer.from('00000000', 'hex'),
  ]).toString('hex')
}

function scriptHex(transaction: WalletTransaction): string[] {
  return transaction.inputs.map(input =>
    input.script.toBuffer().toString('hex'),
  )
}

it('signs legacy wallet inputs with explicit fork-id assignments and refuses a partial sign', () => {
  const key = keyFrom(SECRET_A)
  const other = keyFrom(SECRET_B)
  const script = lockingScript(key)
  const transaction = new WalletTransaction()
    .from([spendable(key, TXID_A, 50_000)])
    .addOutput(
      new WalletOutput({
        satoshis: 40_000,
        script,
      }),
    )
  expect(transaction.toBuffer().toString('hex')).toBe(
    unsignedHex(script, TXID_A, 40_000),
  )
  const before = scriptHex(transaction)
  expect(before).toEqual([''])

  signTransactionInputs(transaction, [key], 'livenet')

  const unlocking = Uint8Array.from(transaction.inputs[0].script.toBuffer())
  expect(unlocking.length).toBeGreaterThan(0)
  const signatureLength = unlocking[0]
  expect(signatureLength).toBeGreaterThan(8)
  expect(signatureLength).toBeLessThan(0x4c)
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
        script,
      }),
    )
  const unsigned = scriptHex(partial)
  expect(unsigned).toEqual(['', ''])
  expect(() => signTransactionInputs(partial, [key], 'livenet')).toThrow(
    'sign-partial',
  )
  expect(scriptHex(partial)).toEqual(unsigned)
})
