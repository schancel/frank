import { Wallet, Transaction } from 'ethers'
import { EvmNativeOperationJournal } from './evm-native-operation-journal'
const wallet = new Wallet('0x' + '21'.repeat(32))
const source = wallet.address.toLowerCase()
const target = new Wallet('0x' + '22'.repeat(32)).address.toLowerCase()
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'transaction-set tests',
}
it('durably owns a complete same-account payment/change sequence with roles', async () => {
  const journal = new EvmNativeOperationJournal({
    binding,
    testOnlyEphemeral: true,
  })
  await journal.Open()
  const transactions = [0, 1].map(nonce =>
    Transaction.from({
      type: 0,
      chainId: 10143,
      nonce,
      to: target,
      value: nonce ? 50n : 100n,
      gasPrice: 1n,
      gasLimit: 21000n,
    }),
  )
  const signed = await Promise.all(
    transactions.map(tx => wallet.signTransaction(tx)),
  )
  const row = await journal.prepare(
    {
      kind: 'transaction-set',
      preparationId: 'evm-transaction-set:test',
      recipient: target,
      intendedValueWei: '100',
      members: transactions.map((tx, index) => ({
        source: { kind: 'coin', address: source },
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: index ? [0] : [],
        transactionSet: {
          role: index ? 'change' : 'payment',
          logicalIndex: 0,
          ...(index ? { changeIndex: 0 } : {}),
          balanceBeforeWei: index ? '21050' : '42150',
          balanceAfterWei: index ? '0' : '21050',
        },
      })),
    },
    signed,
  )
  expect(row.members.map(member => member.signed?.rawTransaction)).toEqual(
    signed,
  )
  expect(row.members[1]!.transactionSet?.role).toBe('change')
  expect(journal.canSelect(source, 1)).toBe(false)
  await journal.Close()
})

it('allows an original successor after a predecessor reverts and consumes its nonce', async () => {
  const journal = new EvmNativeOperationJournal({
    binding,
    testOnlyEphemeral: true,
  })
  await journal.Open()
  const transactions = [0, 1].map(nonce =>
    Transaction.from({
      type: 0,
      chainId: 10143,
      nonce,
      to: target,
      value: nonce ? 50n : 100n,
      gasPrice: 1n,
      gasLimit: 21000n,
    }),
  )
  const signed = await Promise.all(
    transactions.map(tx => wallet.signTransaction(tx)),
  )
  const row = await journal.prepare(
    {
      kind: 'transaction-set',
      preparationId: 'evm-transaction-set:revert',
      recipient: target,
      intendedValueWei: '100',
      members: transactions.map((tx, index) => ({
        source: { kind: 'coin', address: source },
        unsignedTransaction: tx.unsignedSerialized,
        dependencies: index ? [0] : [],
        transactionSet: {
          role: index ? 'change' : 'payment',
          logicalIndex: 0,
          ...(index ? { changeIndex: 0 } : {}),
          balanceBeforeWei: index ? '21050' : '42150',
          balanceAfterWei: index ? '0' : '21050',
        },
      })),
    },
    signed,
  )
  const blockHash = '0x' + '11'.repeat(32)
  await journal.recordObservation(
    journal.beginCapture(row.operationId, 0),
    {
      state: 'included-revert',
      transactionHash: row.members[0]!.signed!.transactionHash,
      blockHash,
      blockNumber: 5,
      transactionIndex: 0,
      feeWei: '21000',
    },
    null,
  )
  await expect(journal.markExposed(row.operationId, 1)).resolves.toMatchObject({
    members: [expect.anything(), expect.objectContaining({ exposed: true })],
  })
  await journal.Close()
})

it.each(['included-revert', 'missing', 'pending'] as const)(
  'releases a dependent transaction-set source only when %s consumes its nonce',
  async state => {
    const journal = new EvmNativeOperationJournal({
      binding,
      testOnlyEphemeral: true,
    })
    await journal.Open()
    const transactions = [0, 1].map(nonce =>
      Transaction.from({
        type: 0,
        chainId: 10143,
        nonce,
        to: target,
        value: nonce ? 50n : 100n,
        gasPrice: 1n,
        gasLimit: 21000n,
      }),
    )
    const signed = await Promise.all(
      transactions.map(tx => wallet.signTransaction(tx)),
    )
    const row = await journal.prepare(
      {
        kind: 'transaction-set',
        preparationId: 'evm-transaction-set:terminal-' + state,
        recipient: target,
        intendedValueWei: '100',
        members: transactions.map((tx, index) => ({
          source: { kind: 'coin', address: source },
          unsignedTransaction: tx.unsignedSerialized,
          dependencies: index ? [0] : [],
          transactionSet: {
            role: index ? 'change' : 'payment',
            logicalIndex: 0,
            ...(index ? { changeIndex: 0 } : {}),
            balanceBeforeWei: index ? '21050' : '42150',
            balanceAfterWei: index ? '0' : '21050',
          },
        })),
      },
      signed,
    )
    const blockHash = '0x' + '11'.repeat(32)
    const account = { blockHash, blockNumber: 10, nonce: 2, balanceWei: '777' }
    await journal.recordObservation(
      journal.beginCapture(row.operationId, 0),
      {
        state: 'included-success',
        transactionHash: row.members[0]!.signed!.transactionHash,
        blockHash,
        blockNumber: 10,
        transactionIndex: 0,
        feeWei: '21000',
      },
      account,
    )
    await journal.recordObservation(
      journal.beginCapture(row.operationId, 1),
      state === 'included-revert'
        ? {
            state,
            transactionHash: row.members[1]!.signed!.transactionHash,
            blockHash,
            blockNumber: 10,
            transactionIndex: 1,
            feeWei: '21000',
          }
        : { state },
      account,
    )
    expect(journal.canSelect(source, 2)).toBe(state !== 'pending')
    expect(journal.canSelect(source, 1)).toBe(false)
    if (state !== 'pending') {
      await journal.markTransactionSetInventoryApplied(row.operationId, 1)
      expect(
        journal.get(row.operationId).members[1]!.transactionSet
          ?.inventoryApplied,
      ).toBe(true)
      expect(journal.get(row.operationId).members[1]!.syncApplied).toBe(false)
      const replay = await journal.prepare(
        {
          kind: row.kind,
          preparationId: row.preparationId,
          recipient: row.recipient,
          intendedValueWei: row.intendedValueWei,
          members: row.members.map(
            ({
              source,
              unsignedTransaction,
              dependencies,
              transactionSet,
            }) => ({
              source,
              unsignedTransaction,
              dependencies,
              transactionSet,
            }),
          ),
        },
        signed,
      )
      expect(replay.members[1]!.transactionSet?.inventoryApplied).toBe(true)
      const changedAccount = { ...account, nonce: 3, balanceWei: '999' }
      await journal.recordObservation(
        journal.beginCapture(row.operationId, 1),
        journal.get(row.operationId).members[1]!.observation,
        changedAccount,
      )
      expect(
        journal.get(row.operationId).members[1]!.transactionSet
          ?.inventoryApplied,
      ).toBeUndefined()
    }
    await journal.Close()
  },
)
