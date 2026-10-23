import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Wallet } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore, LevelRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
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
  expect(derive.mock.calls).toEqual([[0]])
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
  const neverDerive = jest.fn(() => {
    throw new Error('replay must not derive')
  })
  expect(
    await preparer.constructTransactionSet({
      operationId: 'one',
      amountWei: 300000n,
      kdf: neverDerive,
    }),
  ).toEqual(result)
  expect(neverDerive).not.toHaveBeenCalled()
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
