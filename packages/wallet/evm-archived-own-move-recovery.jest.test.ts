/** Genuine baseline history from lifecycle-created exposure; no fabricated exposure in setup. */
import { readFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import level from 'level'
import { Transaction, Wallet } from 'ethers'
import {
  EvmNativeOperationJournal,
  evmNativeOperationDigest,
  type EvmNativeOperation,
} from './storage/evm-native-operation-journal'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelRecordStore } from './storage/evm-coin-store'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  type EvmTransactionSetPreparerOptions,
} from './evm-transaction-set-types'
import { transactionSetFinancialCompletionReceipt } from './evm-operation-completion'
const saved = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/archived-own-move/baseline-lifecycle.json'),
    'utf8'
  )
)
const original = saved.originalOperation as EvmNativeOperation
let location: string
let journal: EvmNativeOperationJournal
let store: LevelRecordStore<StoredEvmListCoin>
const input = {
  operationId: original.operationId,
  expectedOriginalOperationHash: saved.originalCompletion.expectedOperationHash,
}
async function open(
  observeOwnedRecoveryTarget?: EvmTransactionSetPreparerOptions['observeOwnedRecoveryTarget']
) {
  journal = new EvmNativeOperationJournal({
    location,
    binding: original.binding,
  })
  await journal.Open()
  store = await LevelRecordStore.open(location, 'inventory')
  const coins = await EvmCoinList.open(store)
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    observeOwnedRecoveryTarget,
    policy: () => ({
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: 1000000000n,
      paymentGasLimit: () => 21000n,
      changeGasLimit: 21000n,
      paymentFeeIsExact: true,
      dustWei: 1000n,
      radix: 2,
      jitterBps: 0,
      maxChangeOutputs: 1,
      head: 100,
    }),
    deriveChange: (index) => {
      const signer = new Wallet(
        '0x' + (400 + index).toString(16).padStart(64, '0')
      )
      return {
        account: signer.address.toLowerCase(),
        privateKey: signer.privateKey,
        changeIndex: index,
      }
    },
  })
  return { coins, preparer }
}
beforeEach(async () => {
  location = await mkdtemp(join(tmpdir(), 'archived-current-'))
  const db = level(join(location, 'evm-native-operations-v1'))
  await db.batch([
    {
      type: 'put',
      key: 'manifest',
      value: JSON.stringify({
        version: 1,
        binding: original.binding,
        nextSequence: 2,
        archivedCount: 1,
        revision: 1,
      }),
    },
    {
      type: 'put',
      key: `history:${original.operationId}`,
      value: JSON.stringify(original),
    },
    {
      type: 'put',
      key: `completion:${original.operationId}`,
      value: JSON.stringify(saved.originalCompletion),
    },
    {
      type: 'put',
      key: `preparation:${original.preparationId}`,
      value: original.operationId,
    },
    ...original.members
      .filter((m) => m.observation.state !== 'abandoned')
      .map((m) => ({
        type: 'put' as const,
        key: `consumed:${m.source.address}:${
          Transaction.from(m.unsignedTransaction).nonce
        }`,
        value: original.operationId,
      })),
  ])
  await db.close()
})
afterEach(async () => {
  await journal?.Close()
  await store?.close()
  await rm(location, { recursive: true, force: true })
})

test('same-ID sparse current facts reopen without copying or rewriting immutable signing history', async () => {
  let w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  const result = await w.preparer.recoverArchivedOwnMoves(input)
  expect(result.status).toBe('active')
  expect(journal.list()).toHaveLength(1)
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBeUndefined()
  expect(journal.canSelect(original.members[1]!.source.address, 1)).toBe(false)
  const capture = journal.beginCapture(original.operationId, 1)
  const evidence = saved.laterCanonicalEvidence
  expect(
    await journal.recordObservation(
      capture,
      evidence.observation,
      evidence.account,
      undefined,
      journal.get(original.operationId).members[1]
    )
  ).toBe(true)
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    original
  )
  await journal.Close()
  await store.close()
  w = await open()
  expect(journal.list()).toHaveLength(1)
  expect(journal.get(original.operationId).members[1]!.observation.state).toBe(
    'included-success'
  )
  expect((await journal.historyPage({ limit: 100 })).operations).toEqual([
    original,
  ])
  const current = journal.get(original.operationId)
  await expect(
    journal.checkpointSigned(
      original.operationId,
      1,
      original.members[0]!.signed!.rawTransaction
    )
  ).rejects.toThrow()
  expect(journal.get(original.operationId)).toEqual(current)
  await journal.markTransactionSetInventoryApplied(original.operationId, 1)
  await journal.markSyncApplied(original.operationId, 1)
  const completed = journal.get(original.operationId)
  await journal.archiveCompleted(
    original.operationId,
    transactionSetFinancialCompletionReceipt(completed)!
  )
  expect(journal.list()).toEqual([])
  expect(
    evmNativeOperationDigest(
      (await journal.readArchivedOperation(original.operationId))!
    )
  ).toBe(input.expectedOriginalOperationHash)
  expect(
    (await journal.readOperation(original.operationId))!.members[1]!.observation
      .state
  ).toBe('included-success')
  await journal.Close()
  await store.close()
  await open()
  expect(journal.list()).toEqual([])
  expect(
    (await journal.readOperation(original.operationId))!.members[1]!.observation
      .state
  ).toBe('included-success')
})

test('missing source custody is observable and installs no current authority', async () => {
  const w = await open()
  expect(await w.preparer.recoverArchivedOwnMoves(input)).toEqual({
    status: 'blocked',
    operationId: original.operationId,
    reason: 'custody-unavailable',
  })
  expect(journal.list()).toEqual([])
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    original
  )
})

test('newer native reservation blocks replay acquisition, and observe-only facts do not steal its inventory', async () => {
  const w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  const source = original.members[1]!.source.address
  const key = saved.retainedInventory.find(
    (coin: { account: string }) => coin.account === source
  ).privateKey
  await w.coins.put({
    account: source,
    privateKey: key,
    nonce: 1,
    valueWei: 10n ** 19n,
    origin: 'stealth',
    listedInBlock: 1,
  })
  await w.preparer.constructTransactionSet({
    operationId: 'newer',
    amountWei: 10n ** 15n,
    maxFeeWei: 21000n * 1000000000n,
    kdf: () => new Wallet('0x' + '01'.padStart(64, '0')).address,
    sourceAccounts: [source],
  })
  const newer = w.preparer.getOperation('newer')!,
    before = structuredClone(w.coins.all())
  expect(await w.preparer.recoverArchivedOwnMoves(input)).toEqual({
    status: 'blocked',
    operationId: original.operationId,
    reason: 'reservation-conflict',
  })
  expect(w.coins.all()).toEqual(before)
  const evidence = saved.laterCanonicalEvidence
  await journal.activateArchivedOwnMoves({
    ...input,
    terminalEvidence: [evidence],
  })
  expect(journal.archivedRecoveryAuthority(original.operationId)).toBe(
    'observe-only'
  )
  await expect(
    w.preparer.recordObservation(
      original.preparationId!.slice('evm-transaction-set:'.length),
      1,
      evidence.observation,
      evidence.account
    )
  ).rejects.toThrow('conflict')
  expect(w.coins.all()).toEqual(before)
  expect(w.preparer.getOperation('newer')).toEqual(newer)
  const current = journal.get(original.operationId)
  await expect(
    journal.recordObservation(
      journal.beginCapture(original.operationId, 1),
      { state: 'pending' },
      evidence.account,
      undefined,
      journal.get(original.operationId).members[1]
    )
  ).rejects.toThrow()
  expect(journal.get(original.operationId)).toEqual(current)
  await journal.Close()
  await store.close()
  await open()
  expect(journal.archivedRecoveryAuthority(original.operationId)).toBe(
    'observe-only'
  )
  expect(journal.get(newer.operationId)).toEqual(newer)
})

test('stale restoration loses to a newer inclusion and noneligible historical facts cannot be rewritten', async () => {
  const w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  await w.preparer.recoverArchivedOwnMoves(input)
  const expected = journal.get(original.operationId).members[1]!,
    evidence = saved.laterCanonicalEvidence
  const capture = journal.beginCapture(original.operationId, 1)
  expect(
    await journal.recordObservation(
      capture,
      evidence.observation,
      evidence.account,
      undefined,
      expected
    )
  ).toBe(true)
  const included = journal.get(original.operationId)
  expect(
    await journal.recordObservation(
      capture,
      { state: 'pending' },
      evidence.account,
      undefined,
      expected
    )
  ).toBe(false)
  expect(journal.get(original.operationId)).toEqual(included)
  await expect(
    journal.recordObservation(
      journal.beginCapture(original.operationId, 0),
      {
        ...evidence.observation,
        transactionHash: original.members[0]!.signed!.transactionHash,
      },
      evidence.account,
      undefined,
      journal.get(original.operationId).members[0]
    )
  ).rejects.toThrow('conflict')
  expect(journal.get(original.operationId)).toEqual(included)
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    original
  )
})

test('a committed activation interrupted before inventory checkpoint reopens with the same original claim', async () => {
  let w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  const checkpoint = jest
    .spyOn(w.coins, 'checkpointTransactionSetReservations')
    .mockRejectedValueOnce(new Error('interrupted after sparse commit'))
  await expect(w.preparer.recoverArchivedOwnMoves(input)).rejects.toThrow(
    'interrupted'
  )
  checkpoint.mockRestore()
  expect(journal.list().map((row) => row.operationId)).toEqual([
    original.operationId,
  ])
  await journal.Close()
  await store.close()
  w = await open()
  expect(w.preparer.isSourceReserved(original.members[1]!.source.address)).toBe(
    true
  )
  const before = await journal.readArchivedOperation(original.operationId)
  expect((await w.preparer.recoverArchivedOwnMoves(input)).status).toBe(
    'active'
  )
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    before
  )
})

test('soft background member limits continue every immutable page without skipping or duplicating IDs', async () => {
  const { transactionSetCancellationReceipt } = await import(
    './evm-operation-completion'
  )
  const w = await open()
  for (let n = 2; n <= 5; n++) {
    const key = new Wallet('0x' + (600 + n).toString(16).padStart(64, '0'))
    await w.coins.put({
      account: key.address,
      privateKey: key.privateKey,
      nonce: 0,
      valueWei: 10n ** 19n,
      origin: 'stealth',
    })
    const logicalId = `page-${n.toString().padStart(11, '0')}`
    await w.preparer.constructTransactionSet({
      operationId: logicalId,
      amountWei: 10n ** 15n,
      maxFeeWei: 21000n * 1000000000n,
      kdf: () => key.address,
      sourceAccounts: [key.address],
    })
    expect(await w.preparer.releaseRefusedBeforeBroadcast(logicalId)).toBe(true)
    const row = w.preparer.getOperation(logicalId)!
    await journal.archiveCompleted(
      row.operationId,
      transactionSetCancellationReceipt(row)
    )
  }
  const ids: string[] = []
  let after: string | undefined
  do {
    const page = await journal.historyPage({
      limit: 16,
      background: true,
      memberBudget: 1,
      ...(after ? { after } : {}),
    })
    expect(page.operations.length).toBeLessThanOrEqual(1)
    ids.push(...page.operations.map((row) => row.operationId))
    after = page.next
  } while (after)
  expect(ids).toEqual(
    Array.from(
      { length: 5 },
      (_, n) => `evm-native-v1:${(n + 1).toString(16).padStart(16, '0')}`
    )
  )
  expect(journal.list()).toEqual([])
})

test('background history validation uses the existing active-input backoff', async () => {
  const { isUserActivelyTyping } = await import('./chain/event-loop-yield')
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    listeners = new Map<string, () => void>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (name: string, callback: () => void) =>
        listeners.set(name, callback),
    },
  })
  const originalTimer = globalThis.setTimeout,
    delays: number[] = []
  const timerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'setTimeout'
  )!
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(delay ?? 0)
      return originalTimer(callback, delay, ...args)
    },
  })
  try {
    isUserActivelyTyping()
    listeners.get('keydown')!()
    await open()
    await journal.historyPage({ limit: 1, background: true, memberBudget: 32 })
    expect(delays).toContain(60)
  } finally {
    Object.defineProperty(globalThis, 'setTimeout', timerDescriptor)
    if (old) Object.defineProperty(globalThis, 'window', old)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('missing target observer leaves durable projection debt; retry after an inventory cut preserves actual newer target nonce', async () => {
  let w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  await w.preparer.recoverArchivedOwnMoves(input)
  const logical = original.preparationId!.slice('evm-transaction-set:'.length),
    evidence = saved.laterCanonicalEvidence
  const destination = Transaction.from(
    original.members[1]!.unsignedTransaction
  ).to!.toLowerCase()
  await expect(
    w.preparer.recordObservation(
      logical,
      1,
      evidence.observation,
      evidence.account,
      journal.get(original.operationId).members[1]
    )
  ).rejects.toThrow('Archived target observation capability required')
  expect(w.coins.all().filter((coin) => coin.account === destination)).toEqual(
    []
  )
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBeUndefined()
  await journal.Close()
  await store.close()
  const observe: NonNullable<
    EvmTransactionSetPreparerOptions['observeOwnedRecoveryTarget']
  > = async (target, minimum) => {
    expect(minimum).toBe(evidence.observation.blockNumber)
    await w.coins.put({
      account: target.account,
      privateKey: target.privateKey,
      changeIndex: target.changeIndex,
      nonce: 3,
      valueWei: 765432n,
      origin: 'change',
      listedInBlock: minimum + 1,
    })
  }
  w = await open(observe)
  const checkpoint = jest
    .spyOn(journal, 'markTransactionSetInventoryApplied')
    .mockRejectedValueOnce(
      new Error('interrupted after actual target inventory')
    )
  await expect(
    w.preparer.recordObservation(
      logical,
      1,
      evidence.observation,
      evidence.account,
      journal.get(original.operationId).members[1]
    )
  ).rejects.toThrow('interrupted')
  checkpoint.mockRestore()
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBeUndefined()
  await journal.Close()
  await store.close()
  w = await open(observe)
  await w.preparer.recordObservation(
    logical,
    1,
    evidence.observation,
    evidence.account,
    journal.get(original.operationId).members[1]
  )
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBe(true)
  expect(
    w.coins.liveUnspent().filter((coin) => coin.account === destination)
  ).toEqual([expect.objectContaining({ nonce: 3, valueWei: 765432n })])
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    original
  )
})

test('held target RPC owns no source lock or send queue and newer source evidence invalidates the old checkpoint', async () => {
  let reached!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
      reached = resolve
    }),
    held = new Promise<void>((resolve) => {
      release = resolve
    })
  let w: Awaited<ReturnType<typeof open>>
  w = await open(async (target) => {
    reached()
    await held
    await w.coins.put({
      account: target.account,
      privateKey: target.privateKey,
      changeIndex: target.changeIndex,
      nonce: 2,
      valueWei: 765432n,
      origin: 'change',
      listedInBlock: 99,
    })
  })
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  await w.preparer.recoverArchivedOwnMoves(input)
  const logical = original.preparationId!.slice('evm-transaction-set:'.length),
    evidence = saved.laterCanonicalEvidence
  const pending = w.preparer.recordObservation(
    logical,
    1,
    evidence.observation,
    evidence.account,
    journal.get(original.operationId).members[1]
  )
  await started
  const spare = new Wallet('0x' + (888).toString(16).padStart(64, '0'))
  await w.coins.put({
    account: spare.address,
    privateKey: spare.privateKey,
    nonce: 0,
    valueWei: 10n ** 19n,
    origin: 'stealth',
  })
  await w.preparer.constructTransactionSet({
    operationId: 'disjoint-during-target',
    amountWei: 10n ** 15n,
    maxFeeWei: 21000n * 1000000000n,
    kdf: () => spare.address,
    sourceAccounts: [spare.address],
  })
  const newerAccount = {
    ...evidence.account,
    nonce: 3,
    balanceWei: '9876',
    blockNumber: evidence.account.blockNumber + 1,
  }
  await journal.recordObservation(
    journal.beginCapture(original.operationId, 1),
    evidence.observation,
    newerAccount,
    undefined,
    journal.get(original.operationId).members[1]
  )
  release()
  await pending
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBeUndefined()
  expect(journal.get(original.operationId).members[1]!.account).toEqual(
    newerAccount
  )
  await w.preparer.recordObservation(
    logical,
    1,
    evidence.observation,
    newerAccount,
    journal.get(original.operationId).members[1]
  )
  expect(
    journal.get(original.operationId).members[1]!.transactionSet!
      .inventoryApplied
  ).toBe(true)
  expect(w.preparer.getOperation('disjoint-during-target')).toBeDefined()
})

test('later consumption uses a separate evidence index only to preserve an existing newer archive owner', async () => {
  let w: Awaited<ReturnType<typeof open>>
  const observe: NonNullable<
    EvmTransactionSetPreparerOptions['observeOwnedRecoveryTarget']
  > = async (target) => {
    await w.coins.put({
      account: target.account,
      privateKey: target.privateKey,
      changeIndex: target.changeIndex,
      nonce: 3,
      valueWei: 765432n,
      origin: 'change',
      listedInBlock: 99,
    })
  }
  w = await open(observe)
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  const source = original.members[1]!.source.address
  const key = saved.retainedInventory.find(
    (coin: { account: string }) => coin.account === source
  ).privateKey
  await w.coins.put({
    account: source,
    privateKey: key,
    nonce: 1,
    valueWei: 10n ** 19n,
    origin: 'stealth',
  })
  await w.preparer.constructTransactionSet({
    operationId: 'newer-history-owner',
    amountWei: 10n ** 15n,
    maxFeeWei: 21000n * 1000000000n,
    kdf: () => new Wallet('0x' + '01'.padStart(64, '0')).address,
    sourceAccounts: [source],
  })
  const newer = w.preparer.getOperation('newer-history-owner')!,
    evidence = saved.laterCanonicalEvidence
  await journal.activateArchivedOwnMoves({
    ...input,
    terminalEvidence: [evidence],
  })
  // The original raw consumed nonce1; the newer signed attempt now cannot land. Its own
  // ordinary history is still pending archival and must retain its original owner index.
  await w.preparer.recordObservation(
    'newer-history-owner',
    0,
    { state: 'missing' },
    evidence.account
  )
  const logical = original.preparationId!.slice('evm-transaction-set:'.length)
  await w.preparer.recordObservation(
    logical,
    1,
    evidence.observation,
    evidence.account,
    journal.get(original.operationId).members[1]
  )
  await journal.markSyncApplied(original.operationId, 1)
  await journal.archiveCompleted(
    original.operationId,
    transactionSetFinancialCompletionReceipt(journal.get(original.operationId))!
  )
  await journal.Close()
  await store.close()
  const before = level(join(location, 'evm-native-operations-v1'))
  expect(await before.get(`recovery-consumed:${source}:1`)).toBe(
    original.operationId
  )
  await expect(before.get(`consumed:${source}:1`)).rejects.toMatchObject({
    notFound: true,
  })
  expect(await before.get(`history:${original.operationId}`)).toBe(
    JSON.stringify(original)
  )
  expect(await before.get(`completion:${original.operationId}`)).toBe(
    JSON.stringify(saved.originalCompletion)
  )
  await before.close()
  w = await open(observe)
  await journal.archiveCompleted(
    newer.operationId,
    transactionSetFinancialCompletionReceipt(journal.get(newer.operationId))!
  )
  expect(await journal.readArchivedOperation(original.operationId)).toEqual(
    original
  )
  expect(
    (await journal.readArchivedOperation(newer.operationId))!.members[0]!
      .observation.state
  ).toBe('missing')
  await expect(
    journal.prepare({
      kind: 'native',
      recipient: source,
      intendedValueWei: '1',
      members: [
        {
          source: { kind: 'coin', address: source },
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 0,
            chainId: 10143,
            nonce: 1,
            to: source,
            value: 1n,
            gasLimit: 21000n,
            gasPrice: 1000000000n,
          }).unsignedSerialized,
        },
      ],
    })
  ).rejects.toThrow('conflict')
})

test('a later pending RPC cannot replace current inclusion even with a newly acquired capture token', async () => {
  const w = await open()
  for (const coin of saved.retainedInventory)
    await w.coins.put({ ...coin, valueWei: BigInt(coin.valueWei) })
  await w.preparer.recoverArchivedOwnMoves(input)
  const first = journal.get(original.operationId).members[1]!,
    evidence = saved.laterCanonicalEvidence
  const pendingAccount = { ...evidence.account, nonce: 1, balanceWei: '1' }
  expect(
    await journal.recordObservation(
      journal.beginCapture(original.operationId, 1),
      { state: 'pending' },
      pendingAccount,
      undefined,
      first
    )
  ).toBe(true)
  const preRpc = journal.get(original.operationId).members[1]!
  expect(
    await journal.recordObservation(
      journal.beginCapture(original.operationId, 1),
      evidence.observation,
      evidence.account,
      undefined,
      preRpc
    )
  ).toBe(true)
  const included = journal.get(original.operationId)
  // The late observer acquires its mutation capture only now; the original pre-RPC member,
  // rather than that newly acquired token, must reject this older pending/account evidence.
  expect(
    await journal.recordObservation(
      journal.beginCapture(original.operationId, 1),
      { state: 'pending' },
      pendingAccount,
      undefined,
      preRpc
    )
  ).toBe(false)
  expect(journal.get(original.operationId)).toEqual(included)
})

test.each([false, true])(
  'held background history yield does not block disjoint prepare; close=%s rejects the captured read',
  async (closeRead) => {
    const { setEventLoopYieldForTesting } = await import(
      './chain/event-loop-yield'
    )
    const w = await open()
    let release!: () => void, reached!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    let first = true,
      clock = 0
    const now = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => (clock += 10))
    setEventLoopYieldForTesting(async () => {
      if (first) {
        first = false
        reached()
        await held
      }
    })
    let read: Promise<unknown> | undefined
    try {
      read = journal.historyPage({
        limit: 16,
        background: true,
        memberBudget: 32,
      })
      // Attach a rejection handler before Close can reject the suspended read.
      read.catch(() => undefined)
      await entered
      const key = new Wallet('0x' + (998).toString(16).padStart(64, '0'))
      await w.coins.put({
        account: key.address,
        privateKey: key.privateKey,
        nonce: 0,
        valueWei: 10n ** 19n,
        origin: 'stealth',
      })
      const prepare = w.preparer.constructTransactionSet({
        operationId: 'disjoint-history-prepare',
        amountWei: 10n ** 15n,
        maxFeeWei: 21000n * 1000000000n,
        kdf: () => key.address,
        sourceAccounts: [key.address],
      })
      await expect(
        Promise.race([
          prepare.then(() => 'prepared'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
        ])
      ).resolves.toBe('prepared')
      const closed = closeRead ? journal.Close() : undefined
      await Promise.resolve()
      release()
      if (closeRead) {
        await expect(read).rejects.toThrow()
        await closed
      } else
        expect(
          ((await read) as { operations: EvmNativeOperation[] }).operations.map(
            (row) => row.operationId
          )
        ).toEqual([original.operationId])
    } finally {
      release()
      await read?.catch(() => undefined)
      now.mockRestore()
      setEventLoopYieldForTesting(null)
    }
  }
)
