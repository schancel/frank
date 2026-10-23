import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  getBytes,
  hexlify,
  SigningKey,
  Transaction,
  Wallet,
  type Provider,
} from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { createEvmTransactionSetSubmission } from './evm-transaction-set-submission'
import { evmTransactionSetCapability } from './evm-transaction-set-public'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type PreparedEvmTransactionSet,
} from './evm-transaction-set-types'

const key = (n: number) => new Wallet('0x' + n.toString(16).padStart(64, '0'))
const blockHash = '0x' + 'ab'.repeat(32)
function node() {
  let head = 10
  let automine = true
  let fail = false
  let beforeBroadcast: ((raw: string) => void) | undefined
  const included = new Map<
    string,
    { tx: Transaction; block: number; index: number }
  >()
  const raws: string[] = []
  const mine = (raw: string) => {
    const tx = Transaction.from(raw)
    included.set(tx.hash!, { tx, block: head, index: included.size })
  }
  const provider = {
    getBlock: jest.fn(async (block: number) => ({
      hash: blockHash,
      number: typeof block === 'number' ? block : head,
    })),
    getBlockNumber: jest.fn(async () => head),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      const row = included.get(hash)
      return row
        ? {
            hash,
            from: row.tx.from,
            to: row.tx.to,
            status: 1,
            blockHash,
            blockNumber: row.block,
            index: row.index,
            fee: row.tx.gasLimit,
          }
        : null
    }),
    getTransaction: jest.fn(async (hash: string) => {
      const row = included.get(hash)
      return row
        ? {
            hash,
            from: row.tx.from,
            to: row.tx.to,
            chainId: 10143n,
            value: row.tx.value,
            data: row.tx.data,
            blockNumber: row.block,
            index: row.index,
          }
        : null
    }),
    getTransactionCount: jest.fn(async (address: string) =>
      [...included.values()]
        .filter(row => row.tx.from!.toLowerCase() === address.toLowerCase())
        .reduce((nonce, row) => Math.max(nonce, row.tx.nonce + 1), 0),
    ),
    getBalance: jest.fn(async () => 0n),
    broadcastTransaction: jest.fn(async (raw: string) => {
      beforeBroadcast?.(raw)
      raws.push(raw)
      if (fail) throw new Error('ambiguous node response')
      if (automine) mine(raw)
      return { hash: Transaction.from(raw).hash! }
    }),
  }
  return {
    provider,
    raws,
    mine,
    head: () => head,
    advance: (height: number) => {
      head = height
    },
    automine: (enabled: boolean) => {
      automine = enabled
    },
    fail: (enabled: boolean) => {
      fail = enabled
    },
    beforeBroadcast: (callback: (raw: string) => void) => {
      beforeBroadcast = callback
    },
  }
}
async function fixture(
  location: string,
  chain: ReturnType<typeof node>,
  delayed = false,
) {
  const store = await LevelRecordStore.open<StoredEvmListCoin>(
    location,
    'inventory',
  )
  const coins = await EvmCoinList.open(store)
  if (!coins.all().length)
    for (const n of [1, 2])
      await coins.put({
        account: key(n).address,
        privateKey: key(n).privateKey,
        nonce: 0,
        valueWei: 1000000n,
        origin: 'stealth',
      })
  const journal = new EvmNativeOperationJournal({
    location,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'submission-test',
    },
  })
  await journal.Open()
  const rule = delayed ? { belowWei: 1000000n, waitBlocks: 2 } : undefined
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    recoverySpendRule: rule,
    random: () => 0.01,
    policy: () => ({
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: 1n,
      paymentGasLimit: () => 21000n,
      changeGasLimit: 21000n,
      paymentFeeIsExact: true,
      dustWei: 1000n,
      radix: 2,
      jitterBps: 0,
      maxChangeOutputs: 8,
      head: chain.head(),
      ...(rule ? { spendRule: rule } : {}),
    }),
    deriveChange: index => ({
      account: key(100 + index).address,
      privateKey: key(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  const lifecycle = new EvmTransactionSetLifecycle({
    authority: preparer,
    provider: chain.provider as unknown as Provider,
    head: chain.head,
  })
  const submission = createEvmTransactionSetSubmission({
    preparer,
    lifecycle,
    provider: chain.provider as unknown as Provider,
    refresh: async () => undefined,
    operations: () => journal.list(),
  })
  return {
    coins,
    journal,
    preparer,
    lifecycle,
    submission,
    capability: evmTransactionSetCapability(preparer, prepared =>
      submission.sendTransaction(prepared),
    ),
    construct: (operationId = 'one') =>
      preparer.constructTransactionSet({
        operationId,
        amountWei: 100000n,
        kdf: () => key(50).address,
      }),
    close: async () => {
      await journal.Close()
      await store.close()
    },
  }
}
let location: string
beforeEach(async () => {
  location = await mkdtemp(join(tmpdir(), 'transaction-submission-'))
})
afterEach(async () => {
  jest.restoreAllMocks()
  await rm(location, { recursive: true, force: true })
})

test('the public wrapper alone submits recipient and all owned change after durable authorization', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  try {
    const prepared = await f.capability.constructTransactionSet({
      operationId: 'public',
      amountAtomic: 100000n,
      kdf: () => getBytes(key(50).address),
    })
    expect(prepared.otherTransactions.length).toBeGreaterThan(0)
    expect(chain.raws).toEqual([])
    chain.beforeBroadcast(() =>
      expect(f.preparer.getOperation('public')!.submissionAuthorized).toBe(
        true,
      ),
    )
    const result = await f.capability.sendTransaction(prepared)
    expect(result.status).toBe('confirmed')
    const expected = [...prepared.bundle, ...prepared.otherTransactions].map(
      member => Transaction.from(hexlify(member.rawTransaction)).serialized,
    )
    expect(new Set(chain.raws)).toEqual(new Set(expected))
    expect(chain.raws).toHaveLength(expected.length)
    expect(result.pendingTransactionIds).toEqual([])
    expect(result.failedTransactionIds).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([
  'missing-change',
  'duplicate-change',
  'changed-value',
  'changed-fee',
  'changed-destination',
  'changed-raw',
  'changed-hash',
  'wrong-chain',
  'wrong-order',
] as const)(
  'refuses %s wrapper before authorization or any effects',
  async change => {
    const chain = node(),
      f = await fixture(location, chain)
    try {
      const original = await f.construct()
      const prepared: PreparedEvmTransactionSet = {
        ...original,
        bundle: original.bundle.map(member => ({ ...member })),
        otherTransactions: original.otherTransactions.map(member => ({
          ...member,
        })),
      }
      let altered: PreparedEvmTransactionSet
      switch (change) {
        case 'missing-change':
          altered = {
            ...prepared,
            otherTransactions: prepared.otherTransactions.slice(1),
          }
          break
        case 'duplicate-change':
          altered = {
            ...prepared,
            otherTransactions: [
              ...prepared.otherTransactions,
              prepared.otherTransactions[0]!,
            ],
          }
          break
        case 'changed-value':
          altered = {
            ...prepared,
            bundle: [{ ...prepared.bundle[0]!, valueWei: 1n }],
          }
          break
        case 'changed-fee':
          altered = {
            ...prepared,
            bundle: [{ ...prepared.bundle[0]!, gasLimit: 1n }],
          }
          break
        case 'changed-destination':
          altered = {
            ...prepared,
            bundle: [{ ...prepared.bundle[0]!, destination: key(60).address }],
          }
          break
        case 'changed-raw':
          altered = {
            ...prepared,
            bundle: [
              {
                ...prepared.bundle[0]!,
                rawTransaction: prepared.otherTransactions[0]!.rawTransaction,
              },
            ],
          }
          break
        case 'changed-hash':
          altered = {
            ...prepared,
            bundle: [
              { ...prepared.bundle[0]!, txHash: '0x' + 'ff'.repeat(32) },
            ],
          }
          break
        case 'wrong-chain':
          altered = { ...prepared, chainIdentifier: 'ethereum-sepolia' }
          break
        case 'wrong-order':
          expect(prepared.otherTransactions.length).toBeGreaterThan(1)
          altered = {
            ...prepared,
            otherTransactions: [...prepared.otherTransactions].reverse(),
          }
          break
      }
      await expect(f.submission.sendTransaction(altered)).rejects.toThrow()
      expect(f.preparer.getOperation('one')!.submissionAuthorized).not.toBe(
        true,
      )
      expect(
        f.preparer
          .getOperation('one')!
          .members.every(member => !member.exposed),
      ).toBe(true)
      expect(chain.provider.getTransactionReceipt).not.toHaveBeenCalled()
      expect(chain.raws).toEqual([])
    } finally {
      await f.close()
    }
  },
)

test('a fabricated public recipient projection and omitted owned bytes never reach the trusted submission callback', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  try {
    const submit = jest.fn(prepared => f.submission.sendTransaction(prepared))
    const capability = evmTransactionSetCapability(f.preparer, submit)
    const original = await capability.constructTransactionSet({
      operationId: 'public',
      amountAtomic: 100000n,
      kdf: () => getBytes(key(50).address),
    })
    await expect(
      capability.sendTransaction({ ...original, otherTransactions: [] }),
    ).rejects.toThrow()
    await expect(
      capability.sendTransaction({
        ...original,
        bundle: [
          {
            ...original.bundle[0]!,
            recipientOutputs: [
              {
                outputIndex: 0,
                destination: getBytes(key(60).address),
                amountAtomic: 100000n,
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow()
    expect(submit).not.toHaveBeenCalled()
    expect(chain.raws).toEqual([])
  } finally {
    await f.close()
  }
})

test('a signed but unsubmitted operation is never replayed by recovery, including after restart', async () => {
  const chain = node()
  let f = await fixture(location, chain)
  try {
    await f.construct()
    expect(await f.submission.reconcileAuthorized()).toEqual([])
    await f.close()
    f = await fixture(location, chain)
    expect(await f.submission.reconcileAuthorized()).toEqual([])
    expect(chain.raws).toEqual([])
    expect(chain.provider.getTransactionReceipt).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('ambiguous submission and restart replay only the authorized original bytes, never sign again', async () => {
  const chain = node()
  let f = await fixture(location, chain)
  try {
    const prepared = await f.construct()
    const signing = jest.spyOn(SigningKey.prototype, 'sign')
    chain.fail(true)
    expect(await f.submission.sendTransaction(prepared)).toMatchObject({
      status: 'pending',
      pendingReason: 'submission-uncertain',
    })
    const expected = [...prepared.bundle, ...prepared.otherTransactions].map(
      member => member.rawTransaction,
    )
    await f.close()
    f = await fixture(location, chain)
    chain.fail(false)
    expect((await f.submission.reconcileAuthorized())[0]!.status).toBe(
      'confirmed',
    )
    expect(new Set(chain.raws)).toEqual(new Set(expected))
    expect(signing).not.toHaveBeenCalled()
    expect(f.journal.list()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('recipient success stays pending until delayed owned change is broadcast across reopen and host ticks', async () => {
  const chain = node()
  let f = await fixture(location, chain, true)
  try {
    const prepared = await f.construct()
    const result = await f.submission.sendTransaction(prepared)
    expect(result.status).toBe('pending')
    expect(chain.raws).toContain(prepared.bundle[0]!.rawTransaction)
    expect(result.pendingTransactionIds).toEqual(
      expect.arrayContaining(
        prepared.otherTransactions.map(member => member.txHash),
      ),
    )
    await f.close()
    f = await fixture(location, chain, true)
    for (let head = 12; head < 40; head += 2) {
      chain.advance(head)
      const progress = await f.submission.reconcileAuthorized()
      if (!progress.length || progress[0]!.status === 'confirmed') break
    }
    expect(await f.submission.reconcileAuthorized()).toEqual([])
    expect(new Set(chain.raws)).toEqual(
      new Set(
        [...prepared.bundle, ...prepared.otherTransactions].map(
          member => member.rawTransaction,
        ),
      ),
    )
    expect(
      f.preparer
        .getOperation('one')!
        .members.every(
          member => member.observation.state === 'included-success',
        ),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test('a pending operation does not hold a wallet queue against another operation', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const first = await f.construct('first'),
      second = await f.construct('second')
    const originalBroadcast =
      chain.provider.broadcastTransaction.getMockImplementation()!
    let reached!: () => void
    const entered = new Promise<void>(resolve => {
      reached = resolve
    })
    chain.provider.broadcastTransaction.mockImplementation(async raw => {
      if (
        Transaction.from(raw).from!.toLowerCase() ===
        first.bundle[0]!.sourceAccount
      ) {
        reached()
        await held
      }
      return originalBroadcast(raw)
    })
    const sending = f.submission.sendTransaction(first)
    await entered
    expect((await f.submission.sendTransaction(second)).status).toBe(
      'confirmed',
    )
    expect(f.preparer.getOperation('first')!.submissionAuthorized).toBe(true)
    release()
    expect((await sending).status).toBe('confirmed')
  } finally {
    release()
    await f.close()
  }
})

test('a source observation/submission failure does not suppress eligible transactions from another source', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  try {
    const prepared = await f.preparer.constructTransactionSet({
      operationId: 'many',
      amountWei: 1500000n,
      kdf: () => key(50).address,
    })
    expect(prepared.bundle).toHaveLength(2)
    const failedSource = prepared.bundle[0]!.sourceAccount
    const independent = [
      ...prepared.bundle,
      ...prepared.otherTransactions,
    ].filter(member => member.sourceAccount !== failedSource)
    const normalReceipt =
      chain.provider.getTransactionReceipt.getMockImplementation()!
    const failedHashes = new Set(
      [...prepared.bundle, ...prepared.otherTransactions]
        .filter(member => member.sourceAccount === failedSource)
        .map(member => member.txHash),
    )
    chain.provider.getTransactionReceipt.mockImplementation(async hash => {
      if (failedHashes.has(hash)) throw new Error('receipt unavailable')
      return normalReceipt(hash)
    })
    const normalBroadcast =
      chain.provider.broadcastTransaction.getMockImplementation()!
    chain.provider.broadcastTransaction.mockImplementation(async raw => {
      if (Transaction.from(raw).from!.toLowerCase() === failedSource)
        throw new Error('node response lost')
      return normalBroadcast(raw)
    })
    expect(await f.submission.sendTransaction(prepared)).toMatchObject({
      status: 'pending',
      pendingReason: 'submission-uncertain',
    })
    for (const member of independent)
      expect(chain.raws).toContain(member.rawTransaction)
    expect(f.preparer.getOperation('many')!.submissionAuthorized).toBe(true)
  } finally {
    await f.close()
  }
})

test('an append winning the validation-to-authorization race rejects the stale wrapper before exposure', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  try {
    const prepared = await f.construct()
    const authorize = f.preparer.authorizeSubmission.bind(f.preparer)
    jest
      .spyOn(f.preparer, 'authorizeSubmission')
      .mockImplementationOnce(async (...args) => {
        await f.preparer.appendTransactionSet({
          operationId: 'one',
          stageId: 'later',
          amountWei: 1000n,
          kdf: () => key(60).address,
        })
        return authorize(...args)
      })
    await expect(f.submission.sendTransaction(prepared)).rejects.toThrow(
      /conflict/i,
    )
    expect(
      f.preparer
        .getOperation('one')!
        .transactionSetStages!.some(stage => stage.stageId === 'later'),
    ).toBe(true)
    expect(f.preparer.getOperation('one')!.submissionAuthorized).not.toBe(true)
    expect(
      f.preparer.getOperation('one')!.members.every(member => !member.exposed),
    ).toBe(true)
    expect(chain.raws).toEqual([])
  } finally {
    await f.close()
  }
})

test.each([[false, false], [true, false], [false, true], [true, true]])('reconciles terminal chain state with unfinished inventory without rebroadcast (reopen=%s, projection=%s)', async (reopen, projection) => {
  const chain = node()
  let wallet = await fixture(location, chain)
  try {
    const prepared = await wallet.preparer.constructTransactionSet({ operationId: 'projection-fault', amountWei: 979000n, kdf: () => key(50).address })
    expect(prepared.bundle).toHaveLength(1)
    expect(prepared.otherTransactions).toHaveLength(0)
    if (projection) chain.beforeBroadcast(() => { jest.spyOn(wallet.coins, 'projectTransactionSetAccount').mockRejectedValueOnce(new Error('transient inventory projection failure')) })
    else jest.spyOn(wallet.journal, 'markTransactionSetInventoryApplied').mockRejectedValueOnce(new Error('transient inventory checkpoint failure'))
    const report = await wallet.submission.sendTransaction(prepared)
    expect(report.status).toBe('pending')
    expect(report.pendingTransactionIds).toEqual([prepared.bundle[0]!.txHash])
    expect(wallet.preparer.getOperation('projection-fault')!.members[0]!.transactionSet!.inventoryApplied).toBeUndefined()
    const broadcasts = [...chain.raws]
    if (reopen) { await wallet.close(); wallet = await fixture(location, chain) }
    const reports = await wallet.submission.reconcileAuthorized()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.status).toBe('confirmed')
    expect(wallet.preparer.getOperation('projection-fault')!.members[0]!.transactionSet!.inventoryApplied).toBe(true)
    expect(wallet.coins.isAccountReserved(prepared.bundle[0]!.sourceAccount)).toBe(false)
    expect(chain.raws).toEqual(broadcasts)
    expect(await wallet.submission.reconcileAuthorized()).toEqual([])
  } finally { await wallet.close() }
})

test('completed history validates exact wrappers and never replays inventory or broadcasts after reopen', async () => {
  const { transactionSetFinancialCompletionReceipt } = await import('./evm-operation-completion')
  const chain = node()
  let f = await fixture(location, chain)
  const prepared = await f.construct('retained')
  expect((await f.submission.sendTransaction(prepared)).status).toBe('confirmed')
  let row = (await f.preparer.readOperation('retained'))!
  expect(transactionSetFinancialCompletionReceipt(row)).toBeUndefined()
  for (let i = 0; i < row.members.length; i++) await f.journal.markSyncApplied(row.operationId, i)
  row = (await f.preparer.readOperation('retained'))!
  const receipt = transactionSetFinancialCompletionReceipt(row)!
  await f.journal.archiveCompleted(row.operationId, receipt)
  const bytes = JSON.stringify(row)
  await f.close()
  f = await fixture(location, chain)
  try {
    const broadcastCount = chain.provider.broadcastTransaction.mock.calls.length
    const observations = chain.provider.getTransactionReceipt.mock.calls.length
    const inventory = f.coins.all()
    expect(f.preparer.getOperation('retained')).toBeUndefined()
    expect(JSON.stringify(await f.preparer.readOperation('retained'))).toBe(bytes)
    expect(await f.preparer.readTransactionSet('retained')).toEqual(prepared)
    expect((await f.submission.sendTransaction(prepared)).status).toBe('confirmed')
    await f.lifecycle.observe('retained', chain.provider as unknown as Provider)
    await f.lifecycle.replay('retained', { payments: true })
    expect(chain.provider.broadcastTransaction.mock.calls.length).toBe(broadcastCount)
    expect(chain.provider.getTransactionReceipt.mock.calls.length).toBe(observations)
    expect(f.coins.all()).toEqual(inventory)
    await expect(f.submission.sendTransaction({ ...prepared, bundle: [] })).rejects.toThrow('complete wallet operation')
  } finally { await f.close() }
})
