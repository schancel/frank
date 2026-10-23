import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Wallet } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore, LevelRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal, evmNativeOperationDigest } from './storage/evm-native-operation-journal'
import * as durability from './storage/level-durability'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import type { EvmTransactionSetPolicy } from './evm-transaction-set-types'
const signer = (index: number) =>
  new Wallet('0x' + index.toString(16).padStart(64, '0'))
const policy: EvmTransactionSetPolicy = {
  sourceOrder: [
    'stealth',
    'stamp',
    'change',
    'deterministic',
    'root',
    'identity',
  ],
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 1000n,
  radix: 2,
  jitterBps: 1500,
  maxChangeOutputs: 16,
  head: 100,
}
async function setup(values = [1000000n, 900000n], selectedPolicy = policy) {
  const store = new MemoryRecordStore<
    import('./evm-coin-list').StoredEvmListCoin
  >()
  const coins = await EvmCoinList.open(store)
  for (const [index, valueWei] of values.entries())
    await coins.put({
      account: signer(index + 1).address,
      privateKey: signer(index + 1).privateKey,
      nonce: 4,
      valueWei,
      origin: 'stealth',
      lastSpentInBlock: 50,
    })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'test',
    },
  })
  await journal.Open()
  const options = {
    coins,
    journal,
    policy: () => selectedPolicy,
    recoverySpendRule: selectedPolicy.spendRule,
    random: () => 0.01,
    deriveChange: (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    }),
  }
  return {
    store,
    coins,
    journal,
    options,
    preparer: new EvmTransactionSetPreparer(options),
  }
}
const kdf = (index: number) => signer(50 + index).address

it('constructs one complete signed set with private change, exact source conservation, and shuffled contiguous nonces', async () => {
  const { preparer, coins, journal } = await setup()
  const derive = jest.fn(kdf)
  const result = await preparer.constructTransactionSet({
    operationId: 'one',
    amountWei: 300000n,
    kdf: derive,
  })
  expect(result.bundle).toHaveLength(1)
  expect(result.otherTransactions.length).toBeGreaterThan(1)
  expect(derive.mock.calls.every(([index]) => index === 0)).toBe(true)
  const all = [...result.bundle, ...result.otherTransactions]
  expect(all.reduce((sum, tx) => sum + tx.valueWei + tx.gasLimit, 0n)).toBe(
    1000000n,
  )
  expect(all.map(tx => tx.nonce).sort((a, b) => a - b)).toEqual(
    all.map((_, index) => 4 + index),
  )
  expect(result.bundle[0]!.nonce).not.toBe(4)
  expect(
    journal.list()[0]!.members.every(member => member.signed !== null),
  ).toBe(true)
  for (const tx of all)
    expect(Transaction.from(tx.rawTransaction).from?.toLowerCase()).toBe(
      signer(1).address.toLowerCase(),
    )
  expect(coins.heldBy('one').length).toBe(all.length)
  expect(
    JSON.stringify(result, (_, value) =>
      typeof value === 'bigint' ? String(value) : value,
    ),
  ).not.toContain('privateKey')
  expect(await preparer.constructTransactionSet({ operationId: 'one', amountWei: 300000n, kdf })).toEqual(result)
  await expect(preparer.constructTransactionSet({ operationId: 'one', amountWei: 300000n, kdf: () => signer(70).address })).rejects.toThrow('conflicts with original intent')

})

it('reserves disjoint inputs and fresh targets across concurrent operations and a reopened preparer', async () => {
  const { preparer, options, journal } = await setup()
  const [a, b] = await Promise.all(
    ['a', 'b'].map(operationId =>
      preparer.constructTransactionSet({
        operationId,
        amountWei: 300000n,
        kdf,
      }),
    ),
  )
  expect(a.bundle[0]!.sourceAccount).not.toBe(b.bundle[0]!.sourceAccount)
  const targets = [...a.otherTransactions, ...b.otherTransactions].map(
    tx => tx.destination,
  )
  expect(new Set(targets).size).toBe(targets.length)
  const reopened = new EvmTransactionSetPreparer(options)
  expect(
    await reopened.constructTransactionSet({
      operationId: 'a',
      amountWei: 300000n,
      kdf,
    }),
  ).toEqual(a)
  expect(journal.list()).toHaveLength(2)
})

it('passes exact calldata using its reviewed gas bound and keeps uncertain refund ownership observable', async () => {
  const { preparer, journal } = await setup([1000000n], {
    ...policy,
    paymentGasLimit: () => 60000n,
    paymentFeeIsExact: false,
  })
  const result = await preparer.constructTransactionSet({
    operationId: 'call',
    amountWei: 100000n,
    kdf,
    calldata: '0x123400',
  })
  expect(Transaction.from(result.bundle[0]!.rawTransaction).data).toBe(
    '0x123400',
  )
  expect(result.bundle[0]!.gasLimit).toBe(60000n)
  expect(
    journal
      .list()[0]!
      .members.some(member => member.transactionSet?.refundPending),
  ).toBe(true)
})

it('redistributes the entire remainder with durable spacing dependencies without making unrelated sources wait', async () => {
  const { preparer, coins } = await setup([1000000n, 900000n], {
    ...policy,
    spendRule: { belowWei: 2000000n, waitBlocks: 3 },
  })
  const a = await preparer.constructTransactionSet({
    operationId: 'blocked',
    amountWei: 300000n,
    kdf,
  })
  expect(a.otherTransactions.length).toBeGreaterThan(0)
  const transactions = [...a.bundle, ...a.otherTransactions]
  expect(transactions.reduce((sum, tx) => sum + tx.valueWei + tx.gasLimit, 0n)).toBe(1000000n)
  expect(a.bundle[0]!.nonce).toBe(4)
  const row = preparer.getOperation('blocked')!
  expect(row.members[row.members.length - 1]!.transactionSet!.balanceAfterWei).toBe('0')
  expect(row.members.slice(1).every(member => member.transactionSet!.predecessorWaitBlocks === 3)).toBe(true)
  expect(coins.heldBy('blocked')).toHaveLength(transactions.length)
  const b = await preparer.constructTransactionSet({
    operationId: 'unrelated',
    amountWei: 300000n,
    kdf,
  })
  expect(b.bundle[0]!.sourceAccount).not.toBe(a.bundle[0]!.sourceAccount)
})

it('settles owned change repeatedly and retains execution-gas refunds under the next source nonce', async () => {
  const { preparer, coins, options } = await setup([1000000n], {
    ...policy,
    paymentGasLimit: () => 60000n,
    paymentFeeIsExact: false,
  })
  const set = await preparer.constructTransactionSet({
    operationId: 'settle',
    amountWei: 100000n,
    kdf,
    calldata: '0x1234',
  })
  const row = preparer.getOperation('settle')!
  const finalNonce = Math.max(
    ...[...set.bundle, ...set.otherTransactions].map(tx => tx.nonce),
  )
  const blockHash = '0x' + '11'.repeat(32)
  for (const [index, member] of row.members.entries()) {
    const observation = {
      state: 'included-success' as const,
      transactionHash: member.signed!.transactionHash,
      blockHash,
      blockNumber: 101,
      transactionIndex: index,
      feeWei: '21000',
    }
    const account = {
      blockHash,
      blockNumber: 101,
      nonce: finalNonce + 1,
      balanceWei: '12345',
    }
    await preparer.markExposed('settle', index)
    await preparer.recordObservation('settle', index, observation, account)
    await preparer.recordObservation('settle', index, observation, account)
  }
  const refund = coins.get(set.bundle[0]!.sourceAccount, finalNonce + 1)!
  expect(refund.valueWei).toBe(12345n)
  expect(refund.state).toBe('unspent')
  for (const change of set.otherTransactions)
    expect(coins.get(change.destination, 0)?.valueWei).toBe(change.valueWei)
  expect(() => new EvmTransactionSetPreparer(options)).not.toThrow()
})

it('deduplicates one operation across independently composed preparers sharing inventory', async () => {
  const { preparer, options, journal } = await setup()
  const other = new EvmTransactionSetPreparer(options)
  const results = await Promise.all(
    [preparer, other].map(builder =>
      builder.constructTransactionSet({
        operationId: 'same',
        amountWei: 300000n,
        kdf,
      }),
    ),
  )
  expect(results[0]).toEqual(results[1])
  expect(journal.list()).toHaveLength(1)
})

it('applies the final ten-times sweep threshold once and budgets the construction fee separately', async () => {
  const effectiveMinimum = 10n * 21000n
  const economicPolicy = { ...policy, dustWei: effectiveMinimum }
  const below = await setup(
    [100000n + 21000n + effectiveMinimum + 21000n - 1n],
    economicPolicy,
  )
  const belowSet = await below.preparer.constructTransactionSet({
    operationId: 'below-economic',
    amountWei: 100000n,
    kdf,
  })
  expect(belowSet.otherTransactions).toHaveLength(0)
  expect(belowSet.bundle[0]!.valueWei + belowSet.bundle[0]!.gasLimit).toBe(
    100000n + 21000n + effectiveMinimum + 21000n - 1n,
  )
  const at = await setup(
    [100000n + 21000n + effectiveMinimum + 21000n],
    economicPolicy,
  )
  const atSet = await at.preparer.constructTransactionSet({
    operationId: 'at-economic',
    amountWei: 100000n,
    kdf,
  })
  expect(atSet.bundle[0]!.valueWei).toBe(100000n)
  expect(atSet.otherTransactions).toHaveLength(1)
  expect(atSet.otherTransactions[0]!.valueWei).toBe(effectiveMinimum)
})

it('retains source key rows while journal reconciliation still needs them after inventory-only settlement', async () => {
  const { preparer, coins } = await setup([121000n])
  const set = await preparer.constructTransactionSet({
    operationId: 'retain-key',
    amountWei: 100000n,
    kdf,
  })
  await coins.recordMined(
    { account: set.bundle[0]!.sourceAccount, nonce: 4 },
    { block: 101 },
  )
  expect(await coins.prune(102)).toBe(0)
  expect(coins.get(set.bundle[0]!.sourceAccount, 4)?.privateKey).toBeDefined()
})

it('does not resurrect an observed source balance after later confirmed nonce advancement and pruning', async () => {
  const { preparer, coins, options } = await setup([321123n], {
    ...policy,
    spendRule: { belowWei: 2000000n, waitBlocks: 3 },
  })
  const set = await preparer.constructTransactionSet({
    operationId: 'old-remainder',
    amountWei: 300000n,
    kdf,
  })
  const blockHash = '0x' + '11'.repeat(32),
    source = set.bundle[0]!.sourceAccount
  await preparer.recordObservation(
    'old-remainder',
    0,
    {
      state: 'included-success',
      transactionHash: set.bundle[0]!.txHash,
      blockHash,
      blockNumber: 101,
      transactionIndex: 0,
      feeWei: '21000',
    },
    { blockHash, blockNumber: 101, nonce: 5, balanceWei: '679000' },
  )
  await coins.recordMined(
    { account: source, nonce: 5 },
    { block: 105, successor: { valueWei: 400000n } },
  )
  await coins.prune(106)
  expect(coins.get(source, 5)).toBeUndefined()
  new EvmTransactionSetPreparer(options)
  expect(coins.get(source, 5)).toBeUndefined()
  expect(coins.get(source, 6)?.valueWei).toBe(400000n)
})

it('uses destination-aware reviewed gas and the shared durable change allocator outside source selection', async () => {
  const target = kdf(0).toLowerCase()
  const { options, coins } = await setup([1000000n], {
    ...policy,
    paymentGasLimit: (_data, destination) =>
      destination === target ? 60000n : 21000n,
    paymentFeeIsExact: destination => destination !== target,
  })
  let next = 20
  const reserveChange = jest.fn(
    async (_operationId: string, minimumIndex: number) => {
      expect(coins.all().some(coin => coin.state === 'spend_pending')).toBe(
        true,
      )
      const index = Math.max(next++, minimumIndex)
      return options.deriveChange(index)
    },
  )
  const preparer = new EvmTransactionSetPreparer({ ...options, reserveChange })
  const result = await preparer.constructTransactionSet({
    operationId: 'allocator',
    amountWei: 100000n,
    kdf,
  })
  expect(result.bundle[0]!.gasLimit).toBe(60000n)
  expect(reserveChange).toHaveBeenCalledTimes(result.otherTransactions.length)
  expect(
    preparer
      .getOperation('allocator')!
      .members.some(member => member.transactionSet?.refundPending),
  ).toBe(true)
  expect(
    preparer
      .getOperation('allocator')!
      .members.filter(member => member.transactionSet?.role === 'change')
      .every(member => member.transactionSet!.changeIndex! >= 20),
  ).toBe(true)
})

it('keeps the final below-reserve drain private and requires a confirmed predecessor quiet window', async () => {
  const { preparer } = await setup([1000000n], {
    ...policy,
    spendRule: { belowWei: 100000n, waitBlocks: 3 },
  })
  const set = await preparer.constructTransactionSet({
    operationId: 'quiet-final',
    amountWei: 100000n,
    kdf,
  })
  expect(set.otherTransactions.length).toBeGreaterThan(1)
  const row = preparer.getOperation('quiet-final')!,
    last = row.members.at(-1)!
  expect(last.transactionSet?.role).toBe('change')
  expect(last.transactionSet?.predecessorWaitBlocks).toBe(3)
  expect(set.bundle[0]!.nonce).toBeLessThan(
    Transaction.from(last.unsignedTransaction).nonce,
  )
  await expect(
    preparer.markExposed('quiet-final', row.members.length - 1),
  ).rejects.toThrow()
})

it('uses cached last-spend eligibility only for initial below-reserve moves', async () => {
  const snapshot = {
    ...policy,
    head: 100,
    spendRule: { belowWei: 2000000n, waitBlocks: 3 },
  }
  const { preparer, coins } = await setup([1000000n], snapshot)
  const coin = coins.all()[0]!
  await coins.put({ ...coin, lastSpentInBlock: 98 })
  await expect(
    preparer.constructTransactionSet({
      operationId: 'too-soon',
      amountWei: 300000n,
      kdf,
    }),
  ).rejects.toThrow('Insufficient available')
  expect(coins.all()[0]!.state).toBe('unspent')
  snapshot.head = 101
  const later = await preparer.constructTransactionSet({
    operationId: 'quiet-now',
    amountWei: 300000n,
    kdf,
  })
  expect(later.bundle[0]!.valueWei).toBe(300000n)
  const highSnapshot = {
    ...policy,
    head: 100,
    spendRule: { belowWei: 100000n, waitBlocks: 3 },
  }
  const high = await setup([1000000n], highSnapshot)
  await high.coins.put({ ...high.coins.all()[0]!, lastSpentInBlock: 99 })
  const allowed = await high.preparer.constructTransactionSet({
    operationId: 'high-balance',
    amountWei: 100000n,
    kdf,
  })
  expect(allowed.bundle[0]!.valueWei).toBe(100000n)
})

it.each(['included-revert', 'missing'] as const)(
  'reopens terminal %s history after its successor is consumed and all old keys are pruned',
  async state => {
    const directory = await mkdtemp(
      join(tmpdir(), 'frank-terminal-reconciliation-'),
    )
    let store = await LevelRecordStore.open<
      import('./evm-coin-list').StoredEvmListCoin
    >(directory, 'coins')
    let coins = await EvmCoinList.open(store)
    const binding = {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'terminal-reconciliation',
    }
    let journal = new EvmNativeOperationJournal({
      location: directory,
      binding,
    })
    await journal.Open()
    const deriveChange = (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    })
    try {
      await coins.put({
        account: signer(1).address,
        privateKey: signer(1).privateKey,
        nonce: 4,
        valueWei: 121000n,
        origin: 'stealth',
        lastSpentInBlock: 50,
      })
      const preparer = new EvmTransactionSetPreparer({
        coins,
        journal,
        policy: () => policy,
        deriveChange,
      })
      const set = await preparer.constructTransactionSet({
        operationId: 'terminal',
        amountWei: 100000n,
        kdf,
      })
      const blockHash = '0x' + '11'.repeat(32),
        source = set.bundle[0]!.sourceAccount
      await preparer.recordObservation(
        'terminal',
        0,
        state === 'included-revert'
          ? {
              state,
              transactionHash: set.bundle[0]!.txHash,
              blockHash,
              blockNumber: 101,
              transactionIndex: 0,
              feeWei: '21000',
            }
          : { state },
        { blockHash, blockNumber: 101, nonce: 5, balanceWei: '100000' },
      )
      expect(coins.get(source, 5)?.valueWei).toBe(100000n)
      await coins.recordMined({ account: source, nonce: 5 }, { block: 110 })
      await coins.prune(111)
      expect(coins.all()).toHaveLength(0)
      await journal.Close()
      await store.close()
      store = await LevelRecordStore.open(directory, 'coins')
      coins = await EvmCoinList.open(store)
      journal = new EvmNativeOperationJournal({ location: directory, binding })
      await journal.Open()
      expect(
        () =>
          new EvmTransactionSetPreparer({
            coins,
            journal,
            policy: () => policy,
            deriveChange,
          }),
      ).not.toThrow()
      const restored = journal.list()[0]!.members[0]!
      expect(restored.transactionSet?.inventoryApplied).toBe(true)
      expect(restored.syncApplied).toBe(false)
      expect(restored.observation.state).toBe(state)
      expect(restored.signed!.rawTransaction).toBe(
        set.bundle[0]!.rawTransaction,
      )
      const reopened = new EvmTransactionSetPreparer({
        coins,
        journal,
        policy: () => policy,
        deriveChange,
      })
      await expect(
        reopened.recordObservation(
          'terminal',
          0,
          restored.observation,
          restored.account,
        ),
      ).resolves.toBe(true)
      expect(coins.all()).toHaveLength(0)
    } finally {
      await journal.Close()
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it('keeps an unapplied terminal balance recoverable when its inventory write fails', async () => {
  const { preparer, coins, store } = await setup([121000n])
  const set = await preparer.constructTransactionSet({
    operationId: 'failed-apply',
    amountWei: 100000n,
    kdf,
  })
  const blockHash = '0x' + '11'.repeat(32),
    source = set.bundle[0]!.sourceAccount
  const observation = {
    state: 'included-revert' as const,
    transactionHash: set.bundle[0]!.txHash,
    blockHash,
    blockNumber: 101,
    transactionIndex: 0,
    feeWei: '21000',
  }
  const account = {
    blockHash,
    blockNumber: 101,
    nonce: 5,
    balanceWei: '100000',
  }
  const originalPut = store.put.bind(store)
  let fail = true
  jest.spyOn(store, 'put').mockImplementation(async (key, row) => {
    if (row.nonce === 5 && fail) {
      fail = false
      throw new Error('inventory write failed')
    }
    await originalPut(key, row)
  })
  await expect(
    preparer.recordObservation('failed-apply', 0, observation, account),
  ).rejects.toThrow('inventory write failed')
  expect(
    preparer.getOperation('failed-apply')!.members[0]!.transactionSet
      ?.inventoryApplied,
  ).not.toBe(true)
  expect(await coins.prune(102)).toBe(0)
  await preparer.recordObservation('failed-apply', 0, observation, account)
  expect(
    preparer.getOperation('failed-apply')!.members[0]!.transactionSet
      ?.inventoryApplied,
  ).toBe(true)
  expect(coins.get(source, 5)?.valueWei).toBe(100000n)
})

it.each(['put', 'delete'] as const)(
  'serializes one account across preparers and recovers a failed %s after newer evidence',
  async failure => {
    const directory = await mkdtemp(join(tmpdir(), 'frank-projection-race-'))
    let store = await LevelRecordStore.open<
      import('./evm-coin-list').StoredEvmListCoin
    >(directory, 'coins')
    let coins = await EvmCoinList.open(store)
    const binding = {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'projection-race',
    }
    let journal = new EvmNativeOperationJournal({
      location: directory,
      binding,
    })
    await journal.Open()
    const gate = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const aStored = gate(),
      releaseA = gate(),
      bFailedWrite = gate(),
      releaseB = gate()
    const source = signer(1).address.toLowerCase()
    const deriveChange = (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    })
    const originalPut = store.put.bind(store),
      originalDelete = store.delete.bind(store)
    let armed = true,
      bStarted = false
    try {
      for (const index of [1, 2])
        await coins.put({
          account: signer(index).address,
          privateKey: signer(index).privateKey,
          nonce: 4,
          valueWei: 121000n,
          origin: 'stealth',
          lastSpentInBlock: 50,
        })
      const options = { coins, journal, policy: () => policy, deriveChange }
      const first = new EvmTransactionSetPreparer(options),
        second = new EvmTransactionSetPreparer(options)
      const payment = await first.constructTransactionSet({
        operationId: 'race',
        amountWei: 100000n,
        kdf,
      })
      const unrelated = await first.constructTransactionSet({
        operationId: 'unrelated-race',
        amountWei: 100000n,
        kdf,
      })
      jest.spyOn(store, 'put').mockImplementation(async (key, row) => {
        if (row.account === source && row.nonce === 6) {
          bStarted = true
          if (failure === 'put' && armed) {
            bFailedWrite.resolve()
            await releaseB.promise
            armed = false
            throw new Error('newer durable put failed')
          }
        }
        await originalPut(key, row)
        if (row.account === source && row.nonce === 5) {
          aStored.resolve()
          await releaseA.promise
        }
      })
      jest.spyOn(store, 'delete').mockImplementation(async key => {
        if (key === source + ':5' && failure === 'delete' && armed) {
          bFailedWrite.resolve()
          await releaseB.promise
          armed = false
          throw new Error('newer durable delete failed')
        }
        await originalDelete(key)
      })
      const blockHash = '0x' + '11'.repeat(32)
      const observation = {
        state: 'included-revert' as const,
        transactionHash: payment.bundle[0]!.txHash,
        blockHash,
        blockNumber: 101,
        transactionIndex: 0,
        feeWei: '21000',
      }
      const accountA = {
        blockHash,
        blockNumber: 101,
        nonce: 5,
        balanceWei: '100000',
      }
      const accountB = {
        blockHash,
        blockNumber: 102,
        nonce: 6,
        balanceWei: '777',
      }
      const a = first.recordObservation('race', 0, observation, accountA)
      await aStored.promise
      const b = second.recordObservation('race', 0, observation, accountB).then(
        () => null,
        error => error as Error,
      )
      // A paused local write must not prevent a distinct source's complete reconciliation.
      await second.recordObservation(
        'unrelated-race',
        0,
        { ...observation, transactionHash: unrelated.bundle[0]!.txHash },
        accountA,
      )
      const bStartedBeforeACompleted = bStarted
      releaseA.resolve()
      await a
      await bFailedWrite.promise
      releaseB.resolve()
      expect(await b).toBeInstanceOf(Error)
      expect(
        first.getOperation('race')!.members[0]!.transactionSet
          ?.inventoryApplied,
      ).not.toBe(true)
      expect(coins.get(source, 6)).toBeUndefined()
      expect(
        coins.reserveTransactionSetSources({
          holder: 'unsafe-during-failure',
          amountWei: 1n,
          feeWei: 21000n,
          head: 200,
          sourceOrder: policy.sourceOrder,
          canSelect: coin => coin.account === source,
        }),
      ).toBeUndefined()
      await journal.Close()
      await store.close()
      store = await LevelRecordStore.open(directory, 'coins')
      coins = await EvmCoinList.open(store)
      journal = new EvmNativeOperationJournal({ location: directory, binding })
      await journal.Open()
      const recoverer = new EvmTransactionSetPreparer({
        coins,
        journal,
        policy: () => policy,
        deriveChange,
      })
      expect(
        coins.reserveTransactionSetSources({
          holder: 'unsafe-after-reopen',
          amountWei: 1n,
          feeWei: 21000n,
          head: 200,
          sourceOrder: policy.sourceOrder,
          canSelect: coin => coin.account === source,
        }),
      ).toBeUndefined()
      await recoverer.recordObservation('race', 0, observation, accountB)
      await journal.Close()
      await store.close()
      store = await LevelRecordStore.open(directory, 'coins')
      coins = await EvmCoinList.open(store)
      journal = new EvmNativeOperationJournal({ location: directory, binding })
      await journal.Open()
      expect(
        journal
          .list()
          .find(row => row.preparationId === 'evm-transaction-set:race')!
          .members[0]!.transactionSet?.inventoryApplied,
      ).toBe(true)
      expect(coins.get(source, 6)?.valueWei).toBe(777n)
      expect(coins.get(source, 5)).toBeUndefined()
      expect(bStartedBeforeACompleted).toBe(false)
    } finally {
      releaseA.resolve()
      releaseB.resolve()
      jest.restoreAllMocks()
      await journal.Close()
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it('rejects a construction override that diverges from static network recovery rules before reserving funds', async () => {
  const { options, coins } = await setup([1000000n], {
    ...policy,
    spendRule: { belowWei: 100000n, waitBlocks: 3 },
  })
  const conflicting = new EvmTransactionSetPreparer({
    ...options,
    policy: () => ({
      ...options.policy(),
      spendRule: { belowWei: 100000n, waitBlocks: 4 },
    }),
  })
  await expect(
    conflicting.constructTransactionSet({
      operationId: 'conflicting-rule',
      amountWei: 100000n,
      kdf,
    }),
  ).rejects.toThrow('must match the static network recovery rule')
  expect(coins.all()[0]!.state).toBe('unspent')
})


it('appends a private stamp leg to the original signed operation and retains independent inputs', async () => {
  const f = await setup()
  const request = { operationId: 'composed', amountWei: 300000n, reserveForContinuationWei: 200000n, maxFeeWei: 600000n, kdf }
  const primary = await f.preparer.constructTransactionSet(request)
  const prefix = f.journal.list()[0]!.members.map(member => member.signed!.rawTransaction)
  const stampRequest = { operationId: 'composed', stageId: 'stamp-message', amountWei: 70000n, maxFeeWei: 600000n, kdf: (index: number) => signer(70 + index).address }
  const stamp = await f.preparer.appendTransactionSet(stampRequest)
  expect(f.journal.list()).toHaveLength(1)
  const row = f.journal.list()[0]!
  expect(row.intendedValueWei).toBe('300000')
  expect(row.members.slice(0, prefix.length).map(member => member.signed!.rawTransaction)).toEqual(prefix)
  expect(stamp.bundle.every(payment => primary.otherTransactions.some(change => change.destination === payment.sourceAccount))).toBe(true)
  expect(stamp.bundle.reduce((sum,payment) => sum + payment.valueWei, 0n)).toBeGreaterThanOrEqual(70000n)
  expect(await f.preparer.constructTransactionSet(request)).toEqual(primary)
  expect(await f.preparer.appendTransactionSet(stampRequest)).toEqual(stamp)
  await expect(f.preparer.appendTransactionSet({ ...stampRequest, kdf })).rejects.toThrow('conflicts')
  await expect(f.preparer.appendTransactionSet({ ...stampRequest, amountWei: 1n })).rejects.toThrow('conflicts')
  const independent = await f.preparer.constructTransactionSet({ operationId: 'independent', amountWei: 300000n, kdf })
  expect(independent.bundle[0]!.sourceAccount).not.toBe(primary.bundle[0]!.sourceAccount)
  expect(stamp.bundle.map(payment => payment.sourceAccount)).not.toContain(independent.bundle[0]!.sourceAccount)
})

it('recovers an ambiguously persisted append with identical bytes and rejects extension after exposure', async () => {
  const f = await setup([1000000n])
  await f.preparer.constructTransactionSet({ operationId: 'recover-stage', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
  const append = f.journal.appendTransactionSet.bind(f.journal)
  jest.spyOn(f.journal, 'appendTransactionSet').mockImplementationOnce(async (...args) => {
    await append(...args)
    throw new Error('reply lost after durable write')
  })
  const request = { operationId: 'recover-stage', stageId: 'stamp-recovered', amountWei: 70000n, kdf }
  await expect(f.preparer.appendTransactionSet(request)).rejects.toThrow('reply lost')
  const original = f.journal.list()[0]!.members.map(member => member.signed!.rawTransaction)
  const reopened = new EvmTransactionSetPreparer({ ...f.options, random: () => 0.99 })
  await reopened.appendTransactionSet(request)
  expect(f.journal.list()[0]!.members.map(member => member.signed!.rawTransaction)).toEqual(original)
  await reopened.markExposed('recover-stage', 0)
  await expect(reopened.appendTransactionSet({ ...request, stageId: 'different-stamp' })).rejects.toThrow('exposed')
  expect(await reopened.appendTransactionSet(request)).toBeDefined()
})

it('honors whole-operation fee caps and never gifts the continuation budget', async () => {
  const f = await setup([321000n])
  await expect(f.preparer.constructTransactionSet({ operationId: 'no-budget', amountWei: 300000n, reserveForContinuationWei: 1n, kdf })).rejects.toThrow('Insufficient')
  expect(f.journal.list()).toHaveLength(0)
  const g = await setup([1000000n])
  const primary = await g.preparer.constructTransactionSet({ operationId: 'bounded', amountWei: 300000n, reserveForContinuationWei: 200000n, maxFeeWei: 147000n, kdf })
  expect(primary.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(200000n)
  await expect(g.preparer.appendTransactionSet({ operationId: 'bounded', stageId: 'stamp', amountWei: 70000n, maxFeeWei: 999999n, kdf })).rejects.toThrow('fee exceeds')
})

it('constructs a single-recipient fan-in graph without exposing or selecting its private account', async () => {
  const f = await setup([350000n,350000n])
  const result = await f.preparer.constructLegacyTransactionSet({ operationId: 'one-recipient', amountWei: 600000n, kdf })
  expect(result.bundle).toHaveLength(1)
  const row = f.journal.list()[0]!, funding = row.members.filter(member => member.transactionSet!.role === 'funding')
  expect(funding).toHaveLength(2)
  const first = row.members.find(member => member.source.address === result.bundle[0]!.sourceAccount)!
  expect(first.dependencies).toEqual([0,1])
  expect(row.members.every(member => !member.exposed)).toBe(true)
  expect(result.otherTransactions).toHaveLength(row.members.length - 1)
  await expect(f.preparer.constructTransactionSet({ operationId: 'steal-private', amountWei: 1000n, kdf })).rejects.toThrow('Insufficient')
  expect(await f.preparer.constructLegacyTransactionSet({ operationId: 'one-recipient', amountWei: 600000n, kdf })).toEqual(result)
})

it('requires every fan-in inclusion and the incoming-funds delay before recipient exposure', async () => {
  const { EvmTransactionSetLifecycle } = await import('./evm-transaction-set-lifecycle')
  const current = { ...policy, head: 100, spendRule: { belowWei: 1_000_000n, waitBlocks: 2 } }
  const f = await setup([350000n,350000n], current)
  const result = await f.preparer.constructLegacyTransactionSet({ operationId: 'funded-call', amountWei: 600000n, kdf })
  const broadcast = jest.fn(async (raw: string) => ({ hash: Transaction.from(raw).hash! }))
  const lifecycle = new EvmTransactionSetLifecycle({ authority: f.preparer, provider: { getTransaction: async () => null, broadcastTransaction: broadcast }, head: () => current.head })
  expect(lifecycle.canSubmitPayments('funded-call')).toBe(false)
  await lifecycle.replay('funded-call', { payments: false })
  expect(broadcast).toHaveBeenCalledTimes(2)
  const row = f.journal.list()[0]!
  const include = async (index: number, blockNumber: number) => {
    const member = row.members[index]!, tx = Transaction.from(member.signed!.rawTransaction)
    await f.journal.recordObservation(f.journal.beginCapture(row.operationId, index), {
      state: 'included-success', transactionHash: tx.hash!, blockHash: '0x' + 'ab'.repeat(32), blockNumber, transactionIndex: index, feeWei: '21000',
    }, { nonce: tx.nonce + 1, balanceWei: '0', blockNumber, blockHash: '0x' + 'ab'.repeat(32) })
  }
  await include(0, 100)
  current.head = 1000
  expect(lifecycle.canSubmitPayments('funded-call')).toBe(false)
  await include(1, 1000)
  current.head = 1002
  expect(lifecycle.canSubmitPayments('funded-call')).toBe(false)
  await expect(f.preparer.markExposed('funded-call', 2)).rejects.toThrow('maturity')
  current.head = 1003
  await lifecycle.replay('funded-call', { payments: false })
  expect(lifecycle.canSubmitPayments('funded-call')).toBe(true)
  await lifecycle.replay('funded-call', { payments: true })
  expect(broadcast.mock.calls.some(([raw]) => raw === result.bundle[0]!.rawTransaction)).toBe(true)
})

it('replays original recipient dependencies for a stamp while withholding the stamp itself', async () => {
  const { EvmTransactionSetLifecycle } = await import('./evm-transaction-set-lifecycle')
  const f = await setup([1000000n])
  await f.preparer.constructTransactionSet({ operationId: 'envelope', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
  const stamp = await f.preparer.appendTransactionSet({ operationId: 'envelope', stageId: 'stamp-message', amountWei: 70000n, kdf })
  const broadcast = jest.fn(async (raw: string) => ({ hash: Transaction.from(raw).hash! }))
  const lifecycle = new EvmTransactionSetLifecycle({ authority: f.preparer, provider: { getTransaction: async () => null, broadcastTransaction: broadcast }, head: () => 100 })
  await lifecycle.replayDependencies('envelope', 'stamp-message')
  expect(broadcast.mock.calls.length).toBeGreaterThan(0)
  expect(broadcast.mock.calls.some(([raw]) => stamp.bundle.some(payment => payment.rawTransaction === raw))).toBe(false)
  expect(lifecycle.canSubmitPayments('envelope', 'stamp-message')).toBe(false)
  for (const [index, member] of f.journal.list()[0]!.members.entries()) {
    if (!member.exposed) continue
    const tx = Transaction.from(member.signed!.rawTransaction), row = f.journal.list()[0]!
    await f.journal.recordObservation(f.journal.beginCapture(row.operationId, index), {
      state: 'included-success', transactionHash: tx.hash!, blockHash: '0x' + 'ab'.repeat(32), blockNumber: 90, transactionIndex: index, feeWei: '21000',
    }, { nonce: tx.nonce + 1, balanceWei: member.transactionSet!.balanceAfterWei, blockNumber: 90, blockHash: '0x' + 'ab'.repeat(32) })
  }
  await lifecycle.replayDependencies('envelope', 'stamp-message')
  expect(lifecycle.canSubmitPayments('envelope', 'stamp-message')).toBe(true)
  expect(broadcast.mock.calls.some(([raw]) => stamp.bundle.some(payment => payment.rawTransaction === raw))).toBe(false)
})

it('restores an appended graph after durable write but interrupted inventory checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transaction-graph-reopen-'))
  const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'graph-reopen' }
  let store = await LevelRecordStore.open<import('./evm-coin-list').StoredEvmListCoin>(directory, 'coins')
  let coins = await EvmCoinList.open(store)
  let journal = new EvmNativeOperationJournal({ location: directory, binding })
  await journal.Open()
  const deriveChange = (index: number) => ({ account: signer(100 + index).address.toLowerCase(), privateKey: signer(100 + index).privateKey, changeIndex: index })
  const primary = { operationId: 'durable-graph', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf }
  const stamp = { operationId: 'durable-graph', stageId: 'stamp', amountWei: 70000n, kdf }
  try {
    await coins.put({ account: signer(1).address, privateKey: signer(1).privateKey, nonce: 0, valueWei: 1000000n, origin: 'root' })
    let preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange, random: () => 0.01 })
    const recipient = await preparer.constructTransactionSet(primary)
    jest.spyOn(coins, 'checkpointTransactionSetReservations').mockRejectedValueOnce(new Error('checkpoint interrupted'))
    await expect(preparer.appendTransactionSet(stamp)).rejects.toThrow('checkpoint interrupted')
    const original = journal.list()[0]!.members.map(member => member.signed!.rawTransaction)
    const wrapper = preparer.getTransactionSet('durable-graph')
    expect([...wrapper.bundle, ...wrapper.otherTransactions].map(member => member.rawTransaction).sort()).toEqual([...original].sort())
    const stalePrimary = [...recipient.bundle, ...recipient.otherTransactions].map(member => member.rawTransaction)
    await expect(preparer.authorizeSubmission('durable-graph', stalePrimary)).rejects.toThrow('conflict')
    expect(journal.list()[0]!.submissionAuthorized).toBeUndefined()
    await preparer.authorizeSubmission('durable-graph', original)
    expect(journal.list()[0]!.submissionAuthorized).toBe(true)
    expect(journal.list()[0]!.members.every(member => !member.exposed)).toBe(true)
    await journal.Close(); await store.close()
    store = await LevelRecordStore.open(directory, 'coins')
    coins = await EvmCoinList.open(store)
    journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
    preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => { throw new Error('cold policy must not sign again') }, deriveChange })
    expect(await preparer.constructTransactionSet(primary)).toEqual(recipient)
    const restored = await preparer.appendTransactionSet(stamp)
    expect(restored.bundle.length).toBeGreaterThan(0)
    expect(journal.list()).toHaveLength(1)
    expect(journal.list()[0]!.submissionAuthorized).toBe(true)
    await expect(preparer.appendTransactionSet({ ...stamp, stageId: 'after-authorization' })).rejects.toThrow('exposed or unavailable')
    expect(await preparer.releaseUnexposed('durable-graph')).toBe(false)
    await expect(journal.discardUnexposed(journal.list()[0]!.operationId)).rejects.toThrow('conflict')
    expect(preparer.getTransactionSet('durable-graph')).toEqual(wrapper)
    expect(journal.list()[0]!.members.map(member => member.signed!.rawTransaction)).toEqual(original)
    expect(restored.bundle.every(payment => coins.get(payment.sourceAccount, payment.nonce)?.holder === primary.operationId)).toBe(true)
  } finally {
    await journal.Close(); await store.close(); await rm(directory, { recursive: true, force: true })
  }
})

it.each(['missing-funder', 'invented-balance', 'cycle', 'wrong-stage-amount'] as const)('rejects a forged graph with %s before storing signed authority', async defect => {
  const f = await setup([350000n,350000n])
  await f.preparer.constructLegacyTransactionSet({ operationId: 'graph', amountWei: 600000n, kdf })
  const row = f.journal.list()[0]!, index = row.members.findIndex(member => member.source.address !== row.members[0]!.source.address && member.transactionSet!.role !== 'funding')
  const member = row.members[index]!
  if (defect === 'missing-funder') member.dependencies = [0]
  if (defect === 'invented-balance') { member.transactionSet!.balanceBeforeWei = (BigInt(member.transactionSet!.balanceBeforeWei) + 1n).toString(); member.transactionSet!.balanceAfterWei = (BigInt(member.transactionSet!.balanceAfterWei) + 1n).toString() }
  if (defect === 'cycle') row.members[0]!.dependencies = [index]
  if (defect === 'wrong-stage-amount') row.transactionSetStages![0]!.intendedValueWei = '1'
  const other = new EvmNativeOperationJournal({ testOnlyEphemeral: true, binding: row.binding }); await other.Open()
  await expect(other.prepare({ kind: row.kind, preparationId: row.preparationId, recipient: row.recipient, intendedValueWei: row.intendedValueWei,
    transactionSetStages: row.transactionSetStages,
    members: row.members.map(({ source, unsignedTransaction, dependencies, transactionSet }) => ({ source, unsignedTransaction, dependencies, transactionSet })),
  }, row.members.map(item => item.signed!.rawTransaction))).rejects.toThrow()
  expect(other.list()).toHaveLength(0)
})

it('broadcasts every delayed change with original bytes after recipient success and durable restart', async () => {
  const { EvmTransactionSetLifecycle } = await import('./evm-transaction-set-lifecycle')
  const directory = await mkdtemp(join(tmpdir(), 'delayed-change-restart-'))
  const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'delayed-change' }
  const selectedPolicy = { ...policy, head: 100, spendRule: { belowWei: 2000000n, waitBlocks: 3 } }
  let store = await LevelRecordStore.open<import('./evm-coin-list').StoredEvmListCoin>(directory, 'coins')
  let coins = await EvmCoinList.open(store)
  let journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
  const options = () => ({ coins, journal, policy: () => selectedPolicy, recoverySpendRule: selectedPolicy.spendRule,
    deriveChange: (index: number) => ({ account: signer(100 + index).address.toLowerCase(), privateKey: signer(100 + index).privateKey, changeIndex: index }), random: () => 0.01 })
  let preparer = new EvmTransactionSetPreparer(options())
  const broadcast = jest.fn(async (raw: string) => ({ hash: Transaction.from(raw).hash! }))
  const lifecycle = () => new EvmTransactionSetLifecycle({ authority: preparer, provider: { getTransaction: async () => null, broadcastTransaction: broadcast }, head: () => selectedPolicy.head })
  const include = async (index: number) => {
    const member = journal.list()[0]!.members[index]!, tx = Transaction.from(member.signed!.rawTransaction)
    await preparer.recordObservation('delayed-change', index, {
      state: 'included-success', transactionHash: tx.hash!, blockHash: '0x' + 'ab'.repeat(32), blockNumber: selectedPolicy.head, transactionIndex: index, feeWei: '21000',
    }, { nonce: tx.nonce + 1, balanceWei: member.transactionSet!.balanceAfterWei, blockNumber: selectedPolicy.head, blockHash: '0x' + 'ab'.repeat(32) })
  }
  try {
    await coins.put({ account: signer(1).address, privateKey: signer(1).privateKey, nonce: 0, valueWei: 1000000n, origin: 'root' })
    const set = await preparer.constructTransactionSet({ operationId: 'delayed-change', amountWei: 300000n, kdf })
    expect(set.otherTransactions.length).toBeGreaterThan(1)
    expect(journal.list()[0]!.members[0]!.transactionSet!.role).toBe('payment')
    await lifecycle().replay('delayed-change', { payments: true })
    expect(broadcast.mock.calls.map(([raw]) => raw)).toEqual([set.bundle[0]!.rawTransaction])
    await include(0)
    expect(coins.all().some(coin => coin.account === signer(1).address.toLowerCase() && coin.state === 'unspent')).toBe(false)
    await journal.Close(); await store.close()
    store = await LevelRecordStore.open(directory, 'coins'); coins = await EvmCoinList.open(store)
    journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
    preparer = new EvmTransactionSetPreparer(options())
    selectedPolicy.head = 102
    await lifecycle().replay('delayed-change', { payments: true })
    expect(broadcast).toHaveBeenCalledTimes(1)
    for (let index = 1; index < journal.list()[0]!.members.length; index++) {
      selectedPolicy.head = 100 + 3 * index
      await lifecycle().replay('delayed-change', { payments: true })
      expect(broadcast).toHaveBeenCalledTimes(index + 1)
      expect(broadcast.mock.calls[index]![0]).toBe(journal.list()[0]!.members[index]!.signed!.rawTransaction)
      await include(index)
    }
    expect(broadcast.mock.calls.slice(1).map(([raw]) => raw)).toEqual(set.otherTransactions.map(tx => tx.rawTransaction))
    await lifecycle().replay('delayed-change', { payments: true })
    expect(broadcast).toHaveBeenCalledTimes(set.otherTransactions.length + 1)
  } finally {
    await journal.Close(); await store.close(); await rm(directory, { recursive: true, force: true })
  }
})

it('does not use above-reserve partial capacity as permission for a full fan-in drain', async () => {
  const current = { ...policy, head: 100, spendRule: { belowWei: 2000000n, waitBlocks: 3 } }
  const f = await setup([3000000n,3000000n], current)
  for (const coin of f.coins.all()) await f.coins.put({ ...coin, lastSpentInBlock: 99 })
  const request = { operationId: 'mature-fan-in', amountWei: 1500000n, kdf }
  await expect(f.preparer.constructLegacyTransactionSet(request)).rejects.toThrow('Insufficient')
  expect(f.journal.list()).toHaveLength(0)
  expect(f.coins.heldBy(request.operationId)).toHaveLength(0)
  current.head = 102
  expect((await f.preparer.constructLegacyTransactionSet(request)).bundle).toHaveLength(1)
})

it('cancels both stages by logical ID without freeing future nonces or unrelated reservations', async () => {
  const f = await setup(), original = f.coins.all()
  await f.preparer.constructTransactionSet({ operationId: 'cancel-graph', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
  await f.preparer.appendTransactionSet({ operationId: 'cancel-graph', stageId: 'stamp', amountWei: 70000n, kdf })
  await f.preparer.constructTransactionSet({ operationId: 'independent', amountWei: 100000n, kdf })
  const independent = f.coins.heldBy('independent')
  expect(f.coins.heldBy('cancel-graph').length).toBeGreaterThan(2)
  expect(await f.preparer.releaseUnexposed('cancel-graph')).toBe(true)
  expect(f.preparer.getOperation('cancel-graph')!.cancelled).toBe(true)
  expect(f.coins.heldBy('cancel-graph')).toEqual([])
  expect(f.coins.heldBy('independent')).toEqual(independent)
  expect(f.coins.all().filter(coin => coin.account === original[0]!.account)).toEqual([original[0]])
  expect(f.coins.all().filter(coin => coin.origin === 'change')).toEqual([])
  await f.preparer.constructTransactionSet({ operationId: 'replacement', amountWei: 200000n, kdf })
  const replacement = f.coins.heldBy('replacement')
  expect(await f.preparer.releaseUnexposed('cancel-graph')).toBe(true)
  expect(f.coins.heldBy('replacement')).toEqual(replacement)
  expect(f.coins.heldBy('independent')).toEqual(independent)
})

it('reopens interrupted durable cancellation with only original inputs and retains change derivation ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transaction-cancellation-'))
  const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'cancellation' }
  let store = await LevelRecordStore.open<import('./evm-coin-list').StoredEvmListCoin>(directory, 'coins')
  let coins = await EvmCoinList.open(store)
  let journal = new EvmNativeOperationJournal({ location: directory, binding })
  await journal.Open()
  const deriveChange = (index: number) => ({ account: signer(100 + index).address.toLowerCase(), privateKey: signer(100 + index).privateKey, changeIndex: index })
  try {
    for (const index of [1, 2]) await coins.put({ account: signer(index).address, privateKey: signer(index).privateKey, nonce: 4, valueWei: index === 1 ? 1000000n : 900000n, origin: 'stealth' })
    const originals = coins.all()
    let preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange, random: () => 0.01 })
    await preparer.constructTransactionSet({ operationId: 'interrupted-cancel', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
    await preparer.appendTransactionSet({ operationId: 'interrupted-cancel', stageId: 'stamp', amountWei: 70000n, kdf })
    const targets = preparer.getTransactionSet('interrupted-cancel').otherTransactions.map(tx => Transaction.from(tx.rawTransaction).to)
    jest.spyOn(store, 'delete').mockRejectedValueOnce(new Error('cleanup interrupted'))
    await expect(preparer.releaseUnexposed('interrupted-cancel')).rejects.toThrow('cleanup interrupted')
    expect(preparer.getOperation('interrupted-cancel')!.cancelled).toBe(true)
    expect(coins.select({ holder: 'must-wait', amountWei: 1n, feeReserveWei: 21000n, filter: coin => coin.account === signer(1).address.toLowerCase() })).toBeUndefined()
    await journal.Close(); await store.close()
    store = await LevelRecordStore.open(directory, 'coins'); coins = await EvmCoinList.open(store)
    journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
    preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange, random: () => 0.01 })
    expect(coins.all().sort((a,b) => a.account.localeCompare(b.account))).toEqual(originals.sort((a,b) => a.account.localeCompare(b.account)))
    expect(await preparer.releaseUnexposed('interrupted-cancel')).toBe(true)
    expect(store.all()).toHaveLength(2)
    const next = await preparer.constructTransactionSet({ operationId: 'next', amountWei: 300000n, kdf })
    expect(next.otherTransactions.every(tx => !targets.includes(Transaction.from(tx.rawTransaction).to))).toBe(true)
    expect(next.bundle[0]!.sourceAccount).toBe(signer(1).address.toLowerCase())
  } finally { await journal.Close(); await store.close(); await rm(directory, { recursive: true, force: true }) }
})

it('refuses to cancel exposed bytes and serializes cancellation behind an in-flight append', async () => {
  const f = await setup()
  await f.preparer.constructTransactionSet({ operationId: 'serialized-cancel', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
  const append = f.preparer.appendTransactionSet({ operationId: 'serialized-cancel', stageId: 'stamp', amountWei: 70000n, kdf })
  const cancel = f.preparer.releaseUnexposed('serialized-cancel')
  await append
  expect(await cancel).toBe(true)
  expect(f.coins.all().map(coin => coin.nonce)).toEqual([4, 4])
  await f.preparer.constructTransactionSet({ operationId: 'exposed', amountWei: 300000n, kdf })
  await f.preparer.markExposed('exposed', 0)
  const before = f.coins.all(), graph = f.preparer.getTransactionSet('exposed')
  expect(await f.preparer.releaseUnexposed('exposed')).toBe(false)
  expect(f.coins.all()).toEqual(before)
  expect(f.preparer.getTransactionSet('exposed')).toEqual(graph)
  expect(await f.preparer.releaseUnexposed('unknown')).toBe(false)
})

it.each([0n, 70000n, 800000n])('releases only uncommitted stage reservations after a journal precommit failure (append amount=%s)', async appendAmount => {
  const append = appendAmount > 0n
  const f = await setup(), operationId = 'precommit-fault'
  if (append) await f.preparer.constructTransactionSet({ operationId, amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
  const prior = f.preparer.getOperation(operationId), before = f.coins.all()
  const request = { operationId, amountWei: appendAmount || 300000n, kdf }
  if (append) jest.spyOn(f.journal, 'appendTransactionSet').mockRejectedValueOnce(new Error('precommit failure'))
  else jest.spyOn(f.journal, 'prepare').mockRejectedValueOnce(new Error('precommit failure'))
  const construct = () => append ? f.preparer.appendTransactionSet({ ...request, stageId: 'stamp' }) : f.preparer.constructTransactionSet(request)
  await expect(construct()).rejects.toThrow('precommit failure')
  expect(f.coins.all()).toEqual(before)
  expect(f.preparer.getOperation(operationId)).toEqual(prior)
  const allocation = f.coins.nextChangeIndex()
  expect(allocation).toBeGreaterThan(0)
  const result = await construct()
  expect(result.bundle.length).toBeGreaterThan(0)
  expect(f.coins.nextChangeIndex()).toBeGreaterThan(allocation)
  if (prior) expect(f.preparer.getOperation(operationId)!.members.slice(0, prior.members.length)).toEqual(prior.members)
})

it.each([false, true])('retains uncertain durable stage writes until reopen and restores their original signed bytes (append=%s)', async append => {
  const directory = await mkdtemp(join(tmpdir(), 'transaction-uncertain-stage-'))
  const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'uncertain-stage' }
  let store = await LevelRecordStore.open<import('./evm-coin-list').StoredEvmListCoin>(directory, 'coins')
  let coins = await EvmCoinList.open(store)
  let journal = new EvmNativeOperationJournal({ location: directory, binding })
  await journal.Open()
  const deriveChange = (index: number) => ({ account: signer(100 + index).address.toLowerCase(), privateKey: signer(100 + index).privateKey, changeIndex: index })
  try {
    await coins.put({ account: signer(1).address, privateKey: signer(1).privateKey, nonce: 0, valueWei: 1000000n, origin: 'stealth' })
    let preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange, random: () => 0.01 })
    if (append) await preparer.constructTransactionSet({ operationId: 'uncertain', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
    let signed: readonly string[] = []
    if (append) {
      const original = journal.appendTransactionSet.bind(journal)
      jest.spyOn(journal, 'appendTransactionSet').mockImplementationOnce(async (...args) => { signed = args[3]; return original(...args) })
      const put = durability.durablePut
      jest.spyOn(durability, 'durablePut').mockImplementationOnce(async (...args) => { await put(...args); throw new Error('write result uncertain') })
    } else {
      const original = journal.prepare.bind(journal)
      jest.spyOn(journal, 'prepare').mockImplementationOnce(async (...args) => { signed = args[1]!; return original(...args) })
      const batch = durability.durableBatch
      jest.spyOn(durability, 'durableBatch').mockImplementationOnce(async (...args) => { await batch(...args); throw new Error('write result uncertain') })
    }
    const request = { operationId: 'uncertain', amountWei: append ? 70000n : 300000n, kdf }
    const construct = () => append ? preparer.appendTransactionSet({ ...request, stageId: 'stamp' }) : preparer.constructTransactionSet(request)
    await expect(construct()).rejects.toThrow('write result uncertain')
    expect(() => journal.list()).toThrow('uncertain')
    expect(coins.heldBy('uncertain').some(coin => coin.state === 'spend_pending')).toBe(true)
    await expect(construct()).rejects.toThrow('uncertain')
    jest.restoreAllMocks()
    await journal.Close(); await store.close()
    store = await LevelRecordStore.open(directory, 'coins'); coins = await EvmCoinList.open(store)
    journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
    preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => { throw new Error('recovery must not sign') }, deriveChange })
    const recovered = await construct()
    expect([...recovered.bundle, ...recovered.otherTransactions].map(tx => tx.rawTransaction).sort()).toEqual([...signed].sort())
    expect(coins.heldBy('uncertain').every(coin => coin.state !== 'spend_pending')).toBe(true)
    expect(journal.list()).toHaveLength(1)
  } finally { jest.restoreAllMocks(); await journal.Close(); await store.close(); await rm(directory, { recursive: true, force: true }) }
})

it.each([1100000n, 1121000n, 1142000n])('funds the actual continuation reserve after change fees from %s and a second source', async first => {
  const f = await setup([first, 1000000n], { ...policy, dustWei: 210000n })
  const request = { operationId: 'fee-funded-reserve', amountWei: 300000n, reserveForContinuationWei: 800000n, maxFeeWei: 600000n, kdf }
  const primary = await f.preparer.constructTransactionSet(request)
  expect(primary.bundle.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBe(300000n)
  expect(primary.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(800000n)
  expect(new Set([...primary.bundle, ...primary.otherTransactions].map(tx => tx.sourceAccount)).size).toBe(2)
  expect([...primary.bundle, ...primary.otherTransactions].reduce((sum, tx) => sum + tx.valueWei + tx.gasLimit, 0n)).toBe(first + 1000000n)
  const original = f.journal.list()[0]!.members.map(member => member.signed!.rawTransaction)
  const stamp = await f.preparer.appendTransactionSet({ operationId: request.operationId, stageId: 'stamp', amountWei: 600000n, maxFeeWei: 600000n, kdf: index => signer(70 + index).address })
  expect(stamp.bundle.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(600000n)
  expect(stamp.bundle.every(tx => primary.otherTransactions.some(change => change.destination === tx.sourceAccount))).toBe(true)
  expect(f.journal.list()).toHaveLength(1)
  expect(f.journal.list()[0]!.members.slice(0, original.length).map(member => member.signed!.rawTransaction)).toEqual(original)
  expect(await f.preparer.constructTransactionSet(request)).toEqual(primary)
})

it.each([{ maxPaymentParts: 1 }, { maxFeeWei: 21000n }])('rolls back all continuation inputs when the authorized bound %p prevents construction', async bound => {
  const f = await setup([1121000n, 1000000n], { ...policy, dustWei: 210000n })
  await expect(f.preparer.constructTransactionSet({ operationId: 'bounded-reserve', amountWei: 300000n, reserveForContinuationWei: 800000n, kdf, ...bound })).rejects.toThrow()
  expect(f.journal.list()).toHaveLength(0)
  expect(f.coins.all().every(coin => coin.state === 'unspent' && coin.holder === undefined)).toBe(true)
})

it.each([1100000n, 1121004n])('adds only owned transfers when a calldata payment needs more continuation funding from %s', async first => {
  const f = await setup([first, 1000000n], { ...policy, dustWei: 210000n, paymentGasLimit: () => 21004n })
  const primary = await f.preparer.constructTransactionSet({ operationId: 'calldata-reserve', amountWei: 300000n, reserveForContinuationWei: 800000n, calldata: '0x00', kdf })
  expect(primary.bundle).toHaveLength(1)
  expect(Transaction.from(primary.bundle[0]!.rawTransaction).data).toBe('0x00')
  expect(primary.otherTransactions.every(tx => Transaction.from(tx.rawTransaction).data === '0x')).toBe(true)
  expect(primary.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(800000n)
})

it('retains a sub-threshold continuation residual instead of gifting it while adding another source', async () => {
  const f = await setup([321001n, 1000000n], { ...policy, dustWei: 210000n })
  const root = f.coins.all().find(coin => coin.account === signer(2).address.toLowerCase())!
  await f.coins.put({ ...root, origin: 'root' })
  const prepared = await f.preparer.constructTransactionSet({ operationId: 'retain-residual', amountWei: 300000n, reserveForContinuationWei: 1n, kdf })
  expect(prepared.bundle).toHaveLength(1)
  expect(prepared.bundle[0]!.valueWei).toBe(300000n)
  expect(prepared.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(1n)
  const source = f.journal.list()[0]!.members.find(member => member.source.address === signer(1).address.toLowerCase())!
  expect(source.transactionSet!.balanceAfterWei).toBe('1')
  await f.preparer.recordObservation('retain-residual', 0, { state: 'included-success', transactionHash: source.signed!.transactionHash, blockNumber: 101, blockHash: '0x' + '11'.repeat(32), transactionIndex: 0, feeWei: '21000' }, { blockNumber: 101, blockHash: '0x' + '11'.repeat(32), nonce: 5, balanceWei: '1' })
  expect(f.coins.get(signer(1).address, 5)?.valueWei).toBe(1n)
})


it('executes a genuine zero-value calldata call once when several inputs fund its continuation', async () => {
  const f = await setup([600000n, 600000n], { ...policy, dustWei: 210000n, paymentGasLimit: () => 21004n })
  const prepared = await f.preparer.constructTransactionSet({ operationId: 'zero-call-reserve', amountWei: 0n, reserveForContinuationWei: 800000n, calldata: '0x00', kdf })
  expect(prepared.bundle).toHaveLength(1)
  expect(prepared.bundle[0]!.valueWei).toBe(0n)
  expect(Transaction.from(prepared.bundle[0]!.rawTransaction).data).toBe('0x00')
  expect(prepared.otherTransactions.every(tx => Transaction.from(tx.rawTransaction).data === '0x')).toBe(true)
  expect(prepared.otherTransactions.reduce((sum, tx) => sum + tx.valueWei, 0n)).toBeGreaterThanOrEqual(800000n)
})

it('keeps single-recipient fan-in funding and its actual continuation inside the total fee cap', async () => {
  const f = await setup([350000n, 350000n, 100000n])
  const request = { operationId: 'fanin-reserve', amountWei: 600000n, reserveForContinuationWei: 50000n, maxFeeWei: 200000n, kdf }
  const result = await f.preparer.constructLegacyTransactionSet(request)
  const row = f.journal.list()[0]!
  expect(result.bundle).toHaveLength(1)
  expect(result.bundle[0]!.valueWei).toBe(600000n)
  expect(row.members.filter(member => member.transactionSet!.role === 'funding')).toHaveLength(3)
  expect(row.members.filter(member => member.transactionSet!.role === 'change').reduce((sum, member) => sum + Transaction.from(member.unsignedTransaction).value, 0n)).toBeGreaterThanOrEqual(50000n)
  expect(BigInt(row.maximumFeeWei)).toBeLessThanOrEqual(200000n)
  expect(await f.preparer.constructLegacyTransactionSet(request)).toEqual(result)
})


describe('captured per-recipient stamp minimum', () => {
  it('skips a subminimum source for the last-resort root without reserving it', async () => {
    const f = await setup([51000n])
    const root = signer(9)
    await f.coins.put({ account: root.address, privateKey: root.privateKey, nonce: 0, valueWei: 100000n, origin: 'root' })
    const set = await f.preparer.constructTransactionSet({ operationId: 'minimum-root', amountWei: 50000n, minimumPaymentWei: 42000n, kdf })
    expect(set.bundle).toHaveLength(1)
    expect(set.bundle[0]!.sourceAccount).toBe(root.address.toLowerCase())
    expect(set.bundle[0]!.valueWei >= 50000n).toBe(true)
    expect(f.coins.latestOf(signer(1).address)!.state).toBe('unspent')
  })

  it('redistributes a small final tail while preserving intended total and replay bytes', async () => {
    const f = await setup([81000n, 81000n])
    const request = { operationId: 'minimum-tail', amountWei: 100000n, minimumPaymentWei: 42000n, kdf }
    const set = await f.preparer.constructTransactionSet(request)
    expect(set.bundle).toHaveLength(2)
    expect(set.bundle.every(tx => tx.valueWei >= 42000n)).toBe(true)
    const row = f.preparer.getOperation(request.operationId)!
    expect(row.transactionSetStages![0]!.minimumPaymentWei).toBe('42000')
    expect(row.members.reduce((sum, member) => sum + BigInt(member.transactionSet!.intendedValueWei ?? '0'), 0n)).toBe(100000n)
    const reopened = new EvmTransactionSetPreparer({ ...f.options, policy: () => { throw new Error('live fees unavailable') } })
    expect(await reopened.constructTransactionSet(request)).toEqual(set)
    await expect(reopened.constructTransactionSet({ ...request, minimumPaymentWei: 43000n })).rejects.toThrow('conflicts')
  })

  it('refuses an impossible partition without leaking reservations', async () => {
    const f = await setup([71000n, 71000n, 71000n])
    await expect(f.preparer.constructTransactionSet({ operationId: 'minimum-impossible', amountWei: 110000n, minimumPaymentWei: 42000n, kdf })).rejects.toThrow('Insufficient')
    expect(f.coins.all().every(coin => coin.state === 'unspent' && !coin.holder)).toBe(true)
    expect(f.journal.list()).toHaveLength(0)
  })

  it('captures and enforces the minimum on an appended stamp stage', async () => {
    const f = await setup()
    await f.preparer.constructTransactionSet({ operationId: 'minimum-stage', amountWei: 300000n, reserveForContinuationWei: 200000n, kdf })
    const request = { operationId: 'minimum-stage', stageId: 'stamp', amountWei: 100000n, minimumPaymentWei: 42000n, kdf }
    const stamp = await f.preparer.appendTransactionSet(request)
    expect(stamp.bundle.every(tx => tx.valueWei >= 42000n)).toBe(true)
    expect(f.preparer.getOperation(request.operationId)!.transactionSetStages![1]!.minimumPaymentWei).toBe('42000')
    expect(await new EvmTransactionSetPreparer(f.options).appendTransactionSet(request)).toEqual(stamp)
  })
})


it('reopens completed history and returns original bytes without restoring stale inventory or signing again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-completed-retry-'))
  const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'history-retry' }
  let store = await LevelRecordStore.open<import('./evm-coin-list').StoredEvmListCoin>(directory, 'coins')
  let journal = new EvmNativeOperationJournal({ location: directory, binding })
  try {
    await journal.Open()
    let coins = await EvmCoinList.open(store)
    await coins.put({ account: signer(1).address, privateKey: signer(1).privateKey, nonce: 4, valueWei: 1000000n, origin: 'stealth' })
    const deriveChange = (index: number) => ({ account: signer(100 + index).address.toLowerCase(), privateKey: signer(100 + index).privateKey, changeIndex: index })
    let preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange })
    const request = { operationId: 'completed-retry', amountWei: 979000n, kdf }
    const signed = await preparer.constructTransactionSet(request)
    const original = preparer.getOperation(request.operationId)!
    expect(original.members).toHaveLength(1)
    const blockHash = '0x' + 'ab'.repeat(32)
    await preparer.recordObservation(request.operationId, 0, {
      state: 'included-success', transactionHash: original.members[0]!.signed!.transactionHash,
      blockHash, blockNumber: 101, transactionIndex: 0, feeWei: '21000',
    }, { blockHash, blockNumber: 101, nonce: 5, balanceWei: '0' })
    const completed = preparer.getOperation(request.operationId)!
    await journal.archiveCompleted(completed.operationId, {
      expectedOperationHash: evmNativeOperationDigest(completed), ownerReference: 'test:completed-retry',
      sync: 'not-required', delivery: 'not-required', dependencies: 'complete',
    })
    const inventory = coins.all()
    expect(journal.list()).toEqual([])
    await journal.Close(); await store.close()
    store = await LevelRecordStore.open(directory, 'coins')
    journal = new EvmNativeOperationJournal({ location: directory, binding }); await journal.Open()
    coins = await EvmCoinList.open(store)
    preparer = new EvmTransactionSetPreparer({ coins, journal, policy: () => policy, deriveChange })
    const prepare = jest.spyOn(journal, 'prepare')
    expect(await preparer.readOperation(request.operationId)).toEqual(completed)
    expect(await preparer.readTransactionSet(request.operationId)).toEqual(signed)
    expect(await preparer.constructTransactionSet(request)).toEqual(signed)
    expect(coins.all()).toEqual(inventory)
    expect(prepare).not.toHaveBeenCalled()
    expect(journal.list()).toEqual([])
    await expect(preparer.constructTransactionSet({ ...request, amountWei: 978000n })).rejects.toThrow('conflicts with original intent')
  } finally {
    await journal.Close(); await store.close(); await rm(directory, { recursive: true, force: true })
  }
})
