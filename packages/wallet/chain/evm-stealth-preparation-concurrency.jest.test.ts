import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import level from 'level'
import {
  getBytes,
  SigningKey,
  Transaction,
  Wallet,
  type Provider,
} from 'ethers'
import { LevelRecordStore } from '../storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  type EvmNativePlan,
} from '../storage/evm-native-operation-journal'
import { EvmCoinList, type StoredEvmListCoin } from '../evm-coin-list'
import { MemoryRecordStore } from '../storage/evm-coin-store'
import { EvmTransactionSetPreparer } from '../evm-transaction-set'
import { EvmTransactionSetLifecycle } from '../evm-transaction-set-lifecycle'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '../evm-transaction-set-types'
import {
  createEvmStealthPayments,
  evmStealthTransactionSetOperationId,
  EVM_STEALTH_PREPARATION_NAMESPACE,
  type EvmStealthPreparation,
} from './evm-stealth-payments'

jest.mock('level', () => jest.fn(jest.requireActual<typeof level>('level')))
const a = new Wallet('0x' + '41'.repeat(32))
const b = new Wallet('0x' + '42'.repeat(32))
const destination = new Wallet('0x' + '43'.repeat(32))
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'stable preparation concurrency',
}
const source = (wallet: Wallet) => ({
  kind: 'coin' as const,
  address: wallet.address.toLowerCase(),
})
const intent = (operationId: string) => ({
  operationId,
  chainIdentifier: binding.chainIdentifier,
  asset: { kind: 'native' as const },
  recipientSpendPublicKey: getBytes(destination.signingKey.compressedPublicKey),
  amountAtomic: 1000n,
  maxNativeFeeAtomic: 100000n,
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const policy = {
  sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 1n,
  radix: 2,
  jitterBps: 0,
  maxChangeOutputs: 16,
  head: 1,
}
async function inventory(valueWei: bigint) {
  const coins = await EvmCoinList.open(
    new MemoryRecordStore<StoredEvmListCoin>()
  )
  for (const wallet of [a, b])
    await coins.put({
      account: wallet.address,
      privateKey: wallet.privateKey,
      nonce: 0,
      valueWei,
      origin: 'stealth',
      lastSpentInBlock: 0,
    })
  return coins
}
function runtime(
  journal: EvmNativeOperationJournal,
  coins: EvmCoinList,
  provider: Provider
) {
  const preparer = new EvmTransactionSetPreparer({
    journal,
    coins,
    policy: () => policy,
    deriveChange: (index) => {
      const wallet = new Wallet(
        '0x' + (100 + index).toString(16).padStart(64, '0')
      )
      return {
        account: wallet.address,
        privateKey: wallet.privateKey,
        changeIndex: index,
      }
    },
  })
  const lifecycle = new EvmTransactionSetLifecycle({
    authority: preparer,
    provider,
    head: () => 1,
  })
  const operationId = (id: string) =>
    journal.get(id).preparationId!.slice('evm-transaction-set:'.length)
  return {
    constructNativePayment: async (
      request: Parameters<typeof preparer.constructTransactionSet>[0]
    ) => {
      await preparer.constructTransactionSet(request)
      return preparer.getOperation(request.operationId)!
    },
    submit: (id: string) =>
      lifecycle.replay(operationId(id), { payments: true }),
    observe: (id: string) => lifecycle.observe(operationId(id), provider),
    release: (id: string) => preparer.releaseUnexposed(id),
    signIndependentPayment: async () => {
      throw new Error('Native payment entered token executor')
    },
    quote: async () => {
      throw new Error('Native payment entered token quote')
    },
    quoteNative: async () => {
      const balance = coins
        .all()
        .filter((c) => c.state === 'unspent')
        .reduce((n, c) => n + c.valueWei, 0n)
      return {
        nativeBalanceAtomic: balance,
        assetBalanceAtomic: balance,
        estimatedNativeFeeAtomic: 42000n,
      }
    },
  }
}

test('two stale Level capabilities share one business preparation while another operation continues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wallet-stable-preparation-'))
  const actual: typeof level = jest.requireActual<typeof level>('level')
  const databases = new Map<string, ReturnType<typeof level>>()
  jest.mocked(level).mockImplementation((location) => {
    let database = databases.get(String(location))
    if (!database) {
      database = actual(location)
      databases.set(String(location), database)
    }
    return database
  })
  // Node permits one physical Level opener. Independent wrappers/caches share real bytes here;
  // this verifies the owner seams, rather than claiming a live cross-tab browser test.
  const journals = [
    new EvmNativeOperationJournal({ location: root, binding }),
    new EvmNativeOperationJournal({ location: root, binding }),
  ]
  const stores: LevelRecordStore<EvmStealthPreparation>[] = []
  const reached = deferred(),
    resume = deferred()
  const signing = jest.spyOn(SigningKey.prototype, 'sign')
  const coins = await inventory(22000n)
  const provider = {
    getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), number: 1 }),
    getBalance: async () => 1000000n,
    getTransactionCount: async () => 0,
    estimateGas: async () => 21000n,
    getFeeData: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 2n,
    }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    broadcastTransaction: jest.fn(),
  } as unknown as Provider
  try {
    for (const journal of journals) await journal.Open()
    for (let i = 0; i < 2; i++)
      stores.push(
        await LevelRecordStore.open(root, EVM_STEALTH_PREPARATION_NAMESPACE)
      )
    const capabilities = journals.map((journal, i) => {
      if (i === 0) {
        const prepare = journal.prepare.bind(journal)
        jest
          .spyOn(journal, 'prepare')
          .mockImplementationOnce(async (...args) => {
            reached.resolve()
            await resume.promise
            return prepare(...args)
          })
      }
      return createEvmStealthPayments({
        chainIdentifier: binding.chainIdentifier,
        nativeChainId: 10143n,
        coordinationKey: JSON.stringify(binding),
        store: stores[i]!,
        assertActive: () => undefined,
        refreshJournal: async (id) => {
          await journal.refreshPreparation(id)
        },
        derive: () => ({
          stealthAddress: destination.address.toLowerCase(),
          ephemeralPubKey: getBytes(destination.signingKey.compressedPublicKey),
        }),
        operations: () => journal.list(),
        ...runtime(journal, coins, provider),
        tokenBalance: async () => 0n,
        tokenReceipt: async () => undefined,
      })
    })
    const first = capabilities[0]!.prepare(intent('same-payment'))
    await reached.promise
    const duplicate = capabilities[1]!.prepare(intent('same-payment'))
    const unrelated = await capabilities[1]!.prepare(intent('other-payment'))
    expect(
      Transaction.from(unrelated.members[0]!.rawTransaction).from?.toLowerCase()
    ).toBe(b.address.toLowerCase())
    expect(signing).toHaveBeenCalledTimes(2)
    resume.resolve()
    const [one, two] = await Promise.all([first, duplicate])
    expect(two).toEqual(one)
    expect(signing).toHaveBeenCalledTimes(2)
    await journals[1]!.refreshPreparation(
      `evm-transaction-set:${evmStealthTransactionSetOperationId(
        'same-payment'
      )}`
    )
    expect(journals[1]!.list()).toHaveLength(2)
    expect(
      journals[1]!
        .list()
        .filter(
          (row) =>
            row.preparationId ===
            `evm-transaction-set:${evmStealthTransactionSetOperationId(
              'same-payment'
            )}`
        )
    ).toHaveLength(1)
    await expect(
      capabilities[1]!.prepare({
        ...intent('same-payment'),
        maxNativeFeeAtomic: 99999n,
      })
    ).rejects.toThrow(/conflict/i)
    expect(provider.broadcastTransaction).not.toHaveBeenCalled()
    await capabilities[0]!.release('same-payment')
    await expect(
      capabilities[1]!.prepare(intent('same-payment'))
    ).rejects.toThrow(/released/i)
    expect(signing).toHaveBeenCalledTimes(2)

    await capabilities[1]!.release('other-payment')

    // The journal itself must reject competing plans even without the business coordinator.
    const base: EvmNativePlan = {
      kind: 'native',
      preparationId: 'stealth-payment:journal-only',
      recipient: destination.address.toLowerCase(),
      intendedValueWei: '1000',
      members: [
        {
          source: source(a),
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143,
            nonce: 0,
            to: destination.address,
            value: 1000n,
            gasLimit: 21000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    }
    const conflicting = {
      ...base,
      members: [{ ...base.members[0]!, source: source(b) }],
    }
    const results = await Promise.allSettled([
      journals[0]!.prepare(base),
      journals[1]!.prepare(conflicting),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    const winner = results.find((result) => result.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('missing winner')
    await journals[0]!.refreshPreparation(base.preparationId!)
    expect(
      journals[0]!
        .list()
        .filter((row) => row.preparationId === base.preparationId)
    ).toHaveLength(1)
    expect(await journals[0]!.prepare(base)).toEqual(winner.value)
    await journals[0]!.cancelUnsigned(winner.value.operationId)
    await expect(journals[1]!.prepare(base)).rejects.toThrow(/conflict/i)
  } finally {
    resume.resolve()
    signing.mockRestore()
    await Promise.all(journals.map((journal) => journal.Close()))
    await Promise.all(stores.map((store) => store.close()))
    jest
      .mocked(level)
      .mockImplementation(jest.requireActual<typeof level>('level'))
    await rm(root, { recursive: true, force: true })
  }
})

test('a shared multi-source preparation recovers its original signed set through failed linking, exposure and ambiguous restart', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'wallet-multi-preparation-recovery-')
  )
  let journal = new EvmNativeOperationJournal({ location: root, binding })
  let store = await LevelRecordStore.open<EvmStealthPreparation>(
    root,
    EVM_STEALTH_PREPARATION_NAMESPACE
  )
  await journal.Open()
  const signing = jest.spyOn(SigningKey.prototype, 'sign')
  let coinStore = await LevelRecordStore.open<StoredEvmListCoin>(
    root,
    'test-native-inventory'
  )
  let coins = await EvmCoinList.open(coinStore)
  for (const wallet of [a, b])
    await coins.put({
      account: wallet.address,
      privateKey: wallet.privateKey,
      nonce: 0,
      valueWei: 21500n,
      origin: 'stealth',
      lastSpentInBlock: 0,
    })
  const broadcasts: string[] = []
  const provider = {
    getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), number: 1 }),
    getBalance: async () => 1000000n,
    getTransactionCount: async () => 0,
    estimateGas: async () => 21000n,
    getFeeData: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 2n,
    }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async (raw: string) => {
      broadcasts.push(raw)
      throw new Error('ambiguous transport')
    },
  } as unknown as Provider
  const quote = jest.fn(async () => ({
    nativeBalanceAtomic: 43000n,
    assetBalanceAtomic: 43000n,
    estimatedNativeFeeAtomic: 42000n,
  }))
  const capability = () => {
    return createEvmStealthPayments({
      chainIdentifier: binding.chainIdentifier,
      nativeChainId: 10143n,
      coordinationKey: root,
      store,
      assertActive: () => undefined,
      refreshJournal: async (id) => {
        await journal.refreshPreparation(id)
      },
      derive: () => ({
        stealthAddress: destination.address.toLowerCase(),
        ephemeralPubKey: getBytes(destination.signingKey.compressedPublicKey),
      }),
      operations: () => journal.list(),
      ...runtime(journal, coins, provider),
      quoteNative: quote,
      tokenBalance: async () => 0n,
      tokenReceipt: async () => undefined,
    })
  }
  try {
    const request = intent('multi-original')
    let payment = capability()
    const observed = await payment.quote!(request)
    expect(observed.sources).toEqual([])
    expect(observed.nativeBalanceAtomic).toBe(43000n)
    expect(observed.estimatedNativeFeeAtomic).toBe(42000n)
    expect(journal.list()).toEqual([])
    expect(signing).not.toHaveBeenCalled()
    await expect(
      payment.prepare({ ...request, maxNativeFeeAtomic: 41999n })
    ).rejects.toThrow(/fee/i)
    expect(journal.list()).toEqual([])
    expect(broadcasts).toEqual([])
    signing.mockClear()
    // The failed fee authorization is immutable: releasing it permits no later payment under that id.
    await payment.release(request.operationId)
    request.operationId = 'multi-recovery'
    await payment.quote!(request)
    const compare = store.compareAndPut.bind(store)
    const interrupted = jest
      .spyOn(store, 'compareAndPut')
      .mockImplementation(async (key, expected, row) => {
        if (row.journalOperationId)
          throw new Error('link persistence interrupted')
        return compare(key, expected, row)
      })
    await expect(payment.prepare(request)).rejects.toThrow(
      'link persistence interrupted'
    )
    const originalOperationId = journal
      .list()
      .filter((row) => !row.cancelled)[0]!.operationId
    const originals = journal
      .list()
      .filter((row) => !row.cancelled)[0]!
      .members.map((member) => member.signed!.rawTransaction)
    expect(signing).toHaveBeenCalledTimes(2)
    expect(originals.map((raw) => Transaction.from(raw).value)).toEqual([
      500n,
      500n,
    ])
    expect(
      new Set(originals.map((raw) => Transaction.from(raw).from?.toLowerCase()))
    ).toEqual(new Set([a.address.toLowerCase(), b.address.toLowerCase()]))
    interrupted.mockRestore()
    await store.close()
    await journal.Close()
    await coinStore.close()
    coinStore = await LevelRecordStore.open(root, 'test-native-inventory')
    coins = await EvmCoinList.open(coinStore)
    store = await LevelRecordStore.open(root, EVM_STEALTH_PREPARATION_NAMESPACE)
    journal = new EvmNativeOperationJournal({ location: root, binding })
    await journal.Open()
    payment = capability()
    const prepared = await payment.prepare(request)
    expect(prepared.members.map((member) => member.rawTransaction)).toEqual(
      originals
    )
    expect(signing).toHaveBeenCalledTimes(2)
    await expect(payment.submit(request.operationId)).rejects.toThrow(
      'exposure'
    )
    expect(broadcasts).toEqual([])
    await payment.expose({
      operationId: request.operationId,
      payloadDigest: 'ab'.repeat(32),
    })
    expect(await payment.release(request.operationId)).toBe(false)
    await expect(payment.submit(request.operationId)).rejects.toThrow(
      'ambiguous transport'
    )
    expect((await payment.reconcile(request.operationId)).status).toBe(
      'pending'
    )
    expect(broadcasts).toEqual(originals)
    await store.close()
    await journal.Close()
    await coinStore.close()
    coinStore = await LevelRecordStore.open(root, 'test-native-inventory')
    coins = await EvmCoinList.open(coinStore)
    store = await LevelRecordStore.open(root, EVM_STEALTH_PREPARATION_NAMESPACE)
    journal = new EvmNativeOperationJournal({ location: root, binding })
    await journal.Open()
    payment = capability()
    expect(await payment.list()).toContainEqual({
      operationId: request.operationId,
      payloadDigest: 'ab'.repeat(32),
    })
    expect((await payment.reconcile(request.operationId)).status).toBe(
      'pending'
    )
    expect(broadcasts).toEqual(originals)
    await expect(payment.submit(request.operationId)).rejects.toThrow(
      'ambiguous transport'
    )
    expect(broadcasts).toEqual([...originals, ...originals])
    expect(signing).toHaveBeenCalledTimes(2)
    expect(
      journal
        .list()
        .filter((row) => !row.cancelled)
        .map((row) => row.operationId)
    ).toEqual([originalOperationId])
    expect(coins.isAccountReserved(a.address)).toBe(true)
    expect(coins.isAccountReserved(b.address)).toBe(true)
    expect(journal.canSelect(a.address.toLowerCase(), 0)).toBe(false)
    expect(journal.canSelect(b.address.toLowerCase(), 0)).toBe(false)
    expect(quote).toHaveBeenCalledTimes(2)
  } finally {
    signing.mockRestore()
    await coinStore.close()
    await store.close()
    await journal.Close()
    await rm(root, { recursive: true, force: true })
  }
})
