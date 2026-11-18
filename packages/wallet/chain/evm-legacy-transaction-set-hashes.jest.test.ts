import { Transaction, Wallet } from 'ethers'
import { createLegacyTransactionSetPayments } from './evm-legacy-transaction-set'
import type { EvmNativeOperation } from '../storage/evm-native-operation-journal'
import type { EvmTransactionSetPreparer } from '../evm-transaction-set'

const signer = new Wallet('0x' + '11'.repeat(32))
const signed = async (nonce: number, value: bigint) => {
  const raw = await signer.signTransaction({
    type: 2,
    chainId: 10143n,
    nonce,
    to: '0x' + '22'.repeat(20),
    value,
    gasLimit: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
  return { rawTransaction: raw, transactionHash: Transaction.from(raw).hash! }
}
const included = (transactionHash: string, state: 'included-success' | 'included-revert') => ({
  state,
  transactionHash,
  blockNumber: 5,
  blockHash: '0x' + 'ab'.repeat(32),
  feeWei: '21000',
})

/** A finished Send: a change transfer that landed, one that reverted, one given up before it was
 * broadcast, one whose nonce another transaction took, and the payment. */
async function finishedSend(): Promise<EvmNativeOperation> {
  const [landed, reverted, givenUp, taken, payment] = await Promise.all(
    [0, 1, 2, 3, 4].map(nonce => signed(nonce, nonce === 4 ? 1_000_000n : 1n)),
  )
  const member = (
    signing: Awaited<ReturnType<typeof signed>>,
    role: 'change' | 'payment',
    exposed: boolean,
    observation: Record<string, unknown>,
  ) => ({
    source: { kind: 'main', address: signer.address.toLowerCase() },
    unsignedTransaction: Transaction.from(signing.rawTransaction).unsignedSerialized,
    dependencies: [],
    signed: signing,
    exposed,
    observation,
    account: { nonce: 9, balanceWei: '0', blockNumber: 6, blockHash: '0x' + 'cd'.repeat(32) },
    syncApplied: false,
    transactionSet: { role, inventoryApplied: true },
  })
  return {
    operationId: 'op-1',
    kind: 'transaction-set',
    cancelled: false,
    preparationId: 'evm-transaction-set:legacy-1',
    members: [
      member(landed, 'change', true, included(landed.transactionHash, 'included-success')),
      member(reverted, 'change', true, included(reverted.transactionHash, 'included-revert')),
      member(givenUp, 'change', false, { state: 'abandoned', blockNumber: 6 }),
      member(taken, 'change', true, { state: 'missing' }),
      member(payment, 'payment', true, included(payment.transactionHash, 'included-success')),
    ],
  } as unknown as EvmNativeOperation
}

describe('the hashes a finished Send reports', () => {
  it('names only transactions the chain included, never bytes that were not broadcast or can never land', async () => {
    const row = await finishedSend()
    const payments = createLegacyTransactionSetPayments({
      preparer: {} as EvmTransactionSetPreparer,
      sendTransaction: async () => {
        throw new Error('a finished Send is not sent again')
      },
      refresh: async () => undefined,
      operations: () => [],
      readOperation: async id => (id === row.operationId ? row : undefined),
    })
    const result = await payments.resumeLegacySend(row.operationId)
    expect(result.txHash).toBe(row.members[4]!.signed!.transactionHash)
    expect(result.intermediateTxHashes).toEqual([
      row.members[0]!.signed!.transactionHash,
      row.members[1]!.signed!.transactionHash,
    ])
    expect(result.totalFeePaid).toBe(63_000n)
  })
})
