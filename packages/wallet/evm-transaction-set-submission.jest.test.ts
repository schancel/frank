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
import { EvmNativeOperationJournal, type EvmNativeMember } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { createEvmTransactionSetSubmission } from './evm-transaction-set-submission'
import { evmTransactionSetCapability } from './evm-transaction-set-public'
import { MAX_SIGNINGS, REFUSALS_BEFORE_RESIGN, RESIGN_AFTER_MS } from './chain/evm-refused-resign'
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
  // Bytes this node refuses, as a Monad node goes on refusing a transaction it has refused
  // ("Signer had insufficient balance", docs/protocol/chains/monad-reserve-balance.md).
  const refused = new Set<string>()
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
      if (refused.has(raw))
        throw Object.assign(new Error('could not coalesce error'), {
          code: 'UNKNOWN_ERROR',
          error: { code: -32603, message: 'Signer had insufficient balance' },
        })
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
    refuse: (raw: string, enabled = true) => {
      if (enabled) refused.add(raw)
      else refused.delete(raw)
    },
  }
}
async function fixture(
  location: string,
  chain: ReturnType<typeof node>,
  delayed = false,
  gasPriceWei = 1n,
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
      gasPriceWei,
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

test('a fresh set is never recorded missing: a member not yet sent is not missing, one awaiting its block is pending', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  try {
    const prepared = await f.construct('fresh')
    const members = [...prepared.bundle, ...prepared.otherTransactions]
    expect(members.length).toBeGreaterThan(1)
    // Broadcast and not yet in a block when the wallet looks: they all land together later.
    chain.automine(false)
    const recorded: string[] = []
    const record = f.preparer.recordObservation.bind(f.preparer)
    jest
      .spyOn(f.preparer, 'recordObservation')
      .mockImplementation((id, index, observation, account) => {
        recorded.push(observation.state)
        return record(id, index, observation, account)
      })
    const result = await f.submission.sendTransaction(prepared)
    expect(result.status).toBe('pending')
    expect(recorded).not.toContain('missing')
    expect(f.preparer.getOperation('fresh')!.members.map(member => member.observation.state)).toEqual(
      members.map(() => 'pending'),
    )
    // They land in one block; the next look sees every one of them included.
    for (const raw of chain.raws) chain.mine(raw)
    await f.submission.reconcileAuthorized()
    expect(f.preparer.getOperation('fresh')!.members.map(member => member.observation.state)).toEqual(
      members.map(() => 'included-success'),
    )
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

test('host ticks faster than a recovery pass join the in-flight attempt instead of stacking passes', async () => {
  const chain = node(),
    f = await fixture(location, chain)
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    const prepared = await f.construct()
    const originalBroadcast =
      chain.provider.broadcastTransaction.getMockImplementation()!
    let reached!: () => void
    const entered = new Promise<void>(resolve => {
      reached = resolve
    })
    chain.provider.broadcastTransaction.mockImplementation(async raw => {
      reached()
      await held
      return originalBroadcast(raw)
    })
    const observe = jest.spyOn(f.lifecycle, 'observe')
    const replay = jest.spyOn(f.lifecycle, 'replay')
    const sending = f.submission.sendTransaction(prepared)
    await entered
    // A slow node holds the explicit submission; the host poll keeps ticking meanwhile.
    const ticks = Array.from({ length: 20 }, () =>
      f.submission.reconcileAuthorized(),
    )
    const observesWhileHeld = observe.mock.calls.length
    release()
    const sent = await sending
    expect(sent.status).toBe('confirmed')
    for (const reports of await Promise.all(ticks))
      expect(reports).toEqual([sent])
    expect(observesWhileHeld).toBe(1)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(replay).toHaveBeenCalledTimes(1)
    // A finished attempt is not cached: the next tick sees completion and starts nothing.
    expect(await f.submission.reconcileAuthorized()).toEqual([])
    expect(replay).toHaveBeenCalledTimes(1)
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

describe('a member the node keeps refusing (Send to Address)', () => {
  const GAS_PRICE = 4n
  let resignAfterMs: number
  beforeEach(() => {
    resignAfterMs = RESIGN_AFTER_MS.value
    RESIGN_AFTER_MS.value = 0
  })
  afterEach(() => {
    RESIGN_AFTER_MS.value = resignAfterMs
  })
  const constructLegacy = (f: Awaited<ReturnType<typeof fixture>>, operationId = 'legacy-refused') =>
    f.preparer.constructLegacyTransactionSet({
      operationId,
      amountWei: 100000n,
      kdf: () => key(50).address,
    })
  /** The set's one payment member (owned change comes first). */
  const paymentOf = (row: { members: { transactionSet?: { role: string } }[] }) =>
    row.members.find(member => member.transactionSet?.role === 'payment')! as EvmNativeMember
  /** Everything the node was handed or mined at one account's nonce. */
  const atNonce = (chain: ReturnType<typeof node>, raw: string) => {
    const tx = Transaction.from(raw)
    return (other: string) => {
      const candidate = Transaction.from(other)
      return candidate.from === tx.from && candidate.nonce === tx.nonce
    }
  }

  test('is signed again at its nonce after the shared threshold, the new bytes land once, the old ones stay tracked', async () => {
    const chain = node(),
      f = await fixture(location, chain, false, GAS_PRICE)
    try {
      const prepared = await constructLegacy(f)
      const payment = prepared.bundle[0]!
      const original = Transaction.from(payment.rawTransaction)
      chain.refuse(payment.rawTransaction)
      const first = await f.submission.sendTransaction(prepared)
      expect(first.status).toBe('pending')
      // Refused fewer times than the threshold: nothing is signed again yet.
      expect(REFUSALS_BEFORE_RESIGN).toBe(2)
      expect(paymentOf(f.preparer.getOperation('legacy-refused')!).earlierSignings).toBeUndefined()
      const result = (await f.submission.reconcileAuthorized())[0]!
      const member = paymentOf(f.preparer.getOperation('legacy-refused')!)
      expect(member.earlierSignings).toEqual([
        { rawTransaction: payment.rawTransaction, transactionHash: payment.txHash },
      ])
      const again = Transaction.from(member.signed!.rawTransaction)
      expect(again.hash).not.toBe(original.hash)
      // The same transaction: account, nonce, recipient, value, data, gas limit and the most
      // it can cost per gas. Only the tip is one wei lower.
      expect(again.from).toBe(original.from)
      expect(again.chainId).toBe(original.chainId)
      expect(again.nonce).toBe(original.nonce)
      expect(again.to).toBe(original.to)
      expect(again.value).toBe(original.value)
      expect(again.data).toBe(original.data)
      expect(again.gasLimit).toBe(original.gasLimit)
      expect(again.maxFeePerGas).toBe(original.gasPrice)
      expect(again.maxPriorityFeePerGas).toBe(original.gasPrice! - 1n)
      // Recorded durably before the node was handed it.
      expect(member.observation).toMatchObject({ state: 'included-success', transactionHash: again.hash })
      expect(result.status).toBe('confirmed')
      // The old bytes were offered twice, the new once; one transaction at that nonce was mined.
      const sameNonce = chain.raws.filter(atNonce(chain, payment.rawTransaction))
      expect(sameNonce).toEqual([payment.rawTransaction, payment.rawTransaction, again.serialized])
      expect(
        await Promise.all(
          [original.hash!, again.hash!].map(hash => chain.provider.getTransactionReceipt(hash)),
        ).then(receipts => receipts.filter(Boolean).length),
      ).toBe(1)
      // Nothing more is handed to the node.
      const handed = chain.raws.length
      await f.submission.reconcileAuthorized()
      expect(chain.raws).toHaveLength(handed)
    } finally {
      await f.close()
    }
  })

  test('an earlier signing the node takes after all is recognized as the payment; nothing is paid again', async () => {
    const chain = node(),
      f = await fixture(location, chain, false, GAS_PRICE)
    try {
      const prepared = await constructLegacy(f)
      const payment = prepared.bundle[0]!
      chain.refuse(payment.rawTransaction)
      await f.submission.sendTransaction(prepared)
      // The new signing is taken but not mined; the node then mines the OLD bytes.
      chain.automine(false)
      await f.submission.reconcileAuthorized()
      const member = paymentOf(f.preparer.getOperation('legacy-refused')!)
      expect(member.earlierSignings).toHaveLength(1)
      chain.mine(payment.rawTransaction)
      const result = (await f.submission.reconcileAuthorized())[0]!
      expect(result.status).toBe('confirmed')
      const settled = paymentOf(
        f.preparer.getOperation('legacy-refused') ?? (await f.preparer.readOperation('legacy-refused'))!,
      )
      expect(settled.observation).toMatchObject({ state: 'included-success', transactionHash: payment.txHash })
      expect(settled.signed!.transactionHash).not.toBe(payment.txHash)
    } finally {
      await f.close()
    }
  })

  test('a restart between recording the new signing and its broadcast hands over the new bytes', async () => {
    const chain = node()
    let f = await fixture(location, chain, false, GAS_PRICE)
    try {
      const prepared = await constructLegacy(f)
      const payment = prepared.bundle[0]!
      chain.refuse(payment.rawTransaction)
      await f.submission.sendTransaction(prepared)
      // The new signing is recorded, then the node does not answer and the wallet closes.
      chain.fail(true)
      await f.submission.reconcileAuthorized()
      const recorded = paymentOf(f.preparer.getOperation('legacy-refused')!)
      expect(recorded.earlierSignings).toHaveLength(1)
      expect(recorded.observation.state).not.toBe('included-success')
      await f.close()
      chain.fail(false)
      f = await fixture(location, chain, false, GAS_PRICE)
      const reopened = paymentOf(f.preparer.getOperation('legacy-refused')!)
      expect(reopened.signed).toEqual(recorded.signed)
      expect(reopened.earlierSignings).toEqual(recorded.earlierSignings)
      const result = (await f.submission.reconcileAuthorized())[0]!
      expect(result.status).toBe('confirmed')
      // After the restart the newest signing is what the node is handed; it is not signed a third time.
      const sameNonce = chain.raws.filter(atNonce(chain, payment.rawTransaction))
      expect(sameNonce.at(-1)).toBe(recorded.signed!.rawTransaction)
      expect(new Set(sameNonce)).toEqual(new Set([payment.rawTransaction, recorded.signed!.rawTransaction]))
    } finally {
      await f.close()
    }
  })

  test('is signed at most the shared number of times in all', async () => {
    const chain = node(),
      f = await fixture(location, chain, false, GAS_PRICE)
    try {
      // The node refuses every signing of the payment.
      chain.beforeBroadcast(raw => {
        const tx = Transaction.from(raw)
        if (tx.to?.toLowerCase() === key(50).address.toLowerCase()) chain.refuse(raw)
      })
      const prepared = await constructLegacy(f)
      await f.submission.sendTransaction(prepared)
      for (let pass = 0; pass < 3 * MAX_SIGNINGS; pass++) await f.submission.reconcileAuthorized()
      const member = paymentOf(f.preparer.getOperation('legacy-refused')!)
      expect(member.earlierSignings).toHaveLength(MAX_SIGNINGS - 1)
      expect(member.observation.state).not.toBe('included-success')
      expect(new Set(chain.raws.filter(atNonce(chain, prepared.bundle[0]!.rawTransaction))).size).toBe(MAX_SIGNINGS)
    } finally {
      await f.close()
    }
  })

  test('a set that is not a Send to Address is never signed again', async () => {
    const chain = node(),
      f = await fixture(location, chain, false, GAS_PRICE)
    try {
      const prepared = await f.construct('one')
      const payment = prepared.bundle[0]!
      chain.refuse(payment.rawTransaction)
      await f.submission.sendTransaction(prepared)
      for (let pass = 0; pass < 3; pass++) await f.submission.reconcileAuthorized()
      expect(f.preparer.getOperation('one')!.members.every(member => member.earlierSignings === undefined)).toBe(true)
      expect(new Set(chain.raws.filter(atNonce(chain, payment.rawTransaction)))).toEqual(new Set([payment.rawTransaction]))
    } finally {
      await f.close()
    }
  })

  test('the journal refuses a "new signing" that changes anything but the tip', async () => {
    const chain = node(),
      f = await fixture(location, chain, false, GAS_PRICE)
    try {
      const prepared = await constructLegacy(f)
      const payment = prepared.bundle[0]!
      chain.refuse(payment.rawTransaction)
      await f.submission.sendTransaction(prepared)
      const row = f.preparer.getOperation('legacy-refused')!
      const index = row.members.indexOf(paymentOf(row))
      const original = Transaction.from(payment.rawTransaction)
      const signer = new SigningKey(key(1).address === original.from ? key(1).privateKey : key(2).privateKey)
      const variant = (change: Record<string, unknown>) => {
        const tx = Transaction.from({
          type: 2, chainId: original.chainId, nonce: original.nonce, to: original.to, value: original.value,
          data: original.data, gasLimit: original.gasLimit, maxFeePerGas: original.gasPrice,
          maxPriorityFeePerGas: original.gasPrice! - 1n, ...change,
        })
        tx.signature = signer.sign(tx.unsignedHash)
        return tx.serialized
      }
      for (const change of [
        { value: original.value + 1n },
        { to: key(60).address },
        { nonce: original.nonce + 1 },
        { gasLimit: original.gasLimit + 1n },
        { maxFeePerGas: original.gasPrice! + 1n },
        { maxPriorityFeePerGas: original.gasPrice! },
      ])
        await expect(f.journal.recordResigned(row.operationId, index, variant(change))).rejects.toThrow()
      expect(paymentOf(f.preparer.getOperation('legacy-refused')!).earlierSignings).toBeUndefined()
      // The rule's own signing is accepted.
      await f.journal.recordResigned(row.operationId, index, variant({}))
      expect(f.journal.get(row.operationId).members[index]!.earlierSignings).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
})
