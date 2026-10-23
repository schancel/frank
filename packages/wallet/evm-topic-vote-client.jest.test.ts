import { createEvmTopicOperations } from './evm-topic-operations'
/** Real wallet construction and codec; external node/relay observations are scripted. */
import axios from 'axios'
import { Wallet, Transaction, getBytes, hexlify, type Provider } from 'ethers'
import {
  encodeFrame,
  validateFrame,
  defaultContext,
  topicBurnCommitment,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/evm-wallet-bundle'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import type { EvmWalletHandle } from './evm-wallet-handle'
import { TopicVoteClient, TopicVoteAbandonedError } from './topic-vote-client'
function topicWallet(wallet: EvmWalletHandle) {
  return {
    chainIdentifier: wallet.cborNetwork!,
    topicOperations: createEvmTopicOperations(wallet),
  }
}
jest.mock('axios')
const http = axios as unknown as jest.MockedFunction<typeof axios.request>
const burn = '0x000000000000000000000000000000000000dEaD'
const key = (n: number) => new Wallet('0x' + n.toString(16).padStart(64, '0'))
const blockHash = '0x' + 'ab'.repeat(32)
async function fixture(valueWei = 1700000n) {
  const bundle = createInMemoryMonadWalletBundle({
    mnemonic: 'test test test test test test test test test test test junk',
  })
  const coins = await EvmCoinList.open(
    new MemoryRecordStore<StoredEvmListCoin>(),
  )
  for (const n of [1, 2])
    await coins.put({
      account: key(n).address,
      privateKey: key(n).privateKey,
      nonce: 0,
      valueWei,
      origin: 'stealth',
    })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'client fixture',
    },
  })
  await journal.Open()
  const policy = jest.fn(() => ({
    sourceOrder: [
      'stealth',
      'stamp',
      'change',
      'deterministic',
      'root',
      'identity',
    ] as const,
    gasPriceWei: 1n,
    paymentGasLimit: () => 60000n,
    changeGasLimit: 21000n,
    paymentFeeIsExact: true,
    dustWei: 1000n,
    radix: 2,
    jitterBps: 1500,
    maxChangeOutputs: 20,
    head: 100,
  }))
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy,
    random: () => 0.01,
    deriveChange: index => ({
      account: key(100 + index).address,
      privateKey: key(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  const construct = jest.spyOn(preparer, 'constructLegacyTransactionSet')
  const legacySigner = jest.spyOn(bundle.pool, 'getSigner')
  const included = new Map<string, { tx: Transaction; index: number }>()
  const provider = {
    getNetwork: jest.fn(async () => ({ chainId: 10143n })),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      const item = included.get(hash)
      return item
        ? {
            hash,
            from: item.tx.from,
            to: item.tx.to,
            status: 1,
            blockHash,
            blockNumber: 12,
            index: item.index,
            fee: item.tx.gasLimit,
          }
        : null
    }),
    getTransaction: jest.fn(async (hash: string) => {
      const item = included.get(hash)
      return item
        ? {
            hash,
            from: item.tx.from,
            to: item.tx.to,
            value: item.tx.value,
            data: item.tx.data,
            chainId: 10143n,
            blockNumber: 12,
            index: item.index,
          }
        : null
    }),
    getBlock: jest.fn(async () => ({ hash: blockHash, number: 12 })),
    getBlockNumber: jest.fn(async () => 100),
    getTransactionCount: jest.fn(async (address: string) =>
      [...included.values()]
        .filter(item => item.tx.from!.toLowerCase() === address.toLowerCase())
        .reduce((nonce, item) => Math.max(nonce, item.tx.nonce + 1), 0),
    ),
    getBalance: jest.fn(async () => 0n),
    getFeeData: jest.fn(async () => {
      throw new Error('unexpected construction fee RPC')
    }),
    estimateGas: jest.fn(async () => {
      throw new Error('unexpected construction gas RPC')
    }),
    broadcastTransaction: jest.fn(async (raw: string) => ({
      hash: Transaction.from(raw).hash!,
    })),
  }
  const lifecycle = new EvmTransactionSetLifecycle({
    authority: preparer,
    provider: provider as unknown as Provider,
    head: () => 100,
  })
  const wallet: EvmWalletHandle = {
    pool: bundle.pool,
    leaseManager: bundle.leaseManager,
    walletState: bundle,
    topicOperationJournal: bundle.topicOperationJournal,
    provider: provider as unknown as Provider,
    httpClient: {} as EvmWalletHandle['httpClient'],
    relayBaseUrl: 'http://localhost',
    cborNetwork: 'monad-testnet',
    forumBurnAddress: burn,
    forumChainId: 10143n,
    transactionSetPreparer: preparer,
    transactionSetLifecycle: lifecycle,
    forumOperationMutation: task => task(),
  }
  http.mockImplementation(async params => {
    const parsed = validateFrame(
      new Uint8Array(params.data as Uint8Array),
      defaultContext(),
    )
    if (
      parsed.kind !== 'parsed' ||
      (parsed.typed?.type !== 10 && parsed.typed?.type !== 11)
    )
      throw new Error('Bad fixture request')
    const typed = parsed.typed
    const rawTransactions = [hexlify(typed.burnTx)]
    const operation = bundle.topicOperationJournal
      .getAll()
      .find(
        row =>
          row.rawTransactions.length === rawTransactions.length &&
          row.rawTransactions.every(
            (raw, index) => raw === rawTransactions[index],
          ),
      )!
    const native = preparer.getOperation(operation.transactionSetOperationId)!
    for (const [index, member] of native.members.entries())
      included.set(member.signed!.transactionHash, {
        tx: Transaction.from(member.signed!.rawTransaction),
        index,
      })
    const transactions = rawTransactions.map(raw => Transaction.from(raw))
    const target =
      typed.type === 10
        ? topicBurnCommitment(typed.postFrame.frame).hash
        : typed.targetHash
    const lastIndex = Math.max(
      ...transactions.map(tx => included.get(tx.hash!)!.index),
    )
    const payload = new Map<number, unknown>([
      [0, 'monad-testnet'],
      [1, params.data],
      [2, target],
      [3, getBytes(operation.transactionSetHash)],
      [4, getBytes(operation.funders[0]!)],
      [5, operation.direction === 'up' ? 1 : 0],
      [6, BigInt(operation.valueWei)],
      [7, 2],
      [8, 12n],
      [9, BigInt(lastIndex)],
      [10, 1n],
      [11, new Uint8Array(16)],
    ])
    return {
      data: encodeFrame(
        { typeId: 15, schemaVersion: 1, minReaderVersion: 1 },
        payload as never,
      ),
      headers: { 'content-type': 'application/cbor' },
    } as never
  })
  return {
    bundle,
    wallet,
    coins,
    journal,
    preparer,
    construct,
    legacySigner,
    provider,
    policy,
    close: async () => {
      await journal.Close()
      await bundle.close()
    },
  }
}
afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

const params = {
  targetPayloadHash: new Uint8Array(32).fill(4),
  direction: 'down' as const,
  amountAtomic: 1000000n,
}
test.each(['up', 'down'] as const)(
  'canonical type11 %s vote requires the confirmed scalar burn',
  async direction => {
    const f = await fixture()
    try {
      const result = await new TopicVoteClient(topicWallet(f.wallet)).castVote({
        ...params,
        direction,
      })
      expect(result.status.direction).toBe(direction === 'up' ? 1 : 0)
      expect(result.status.value).toBe(params.amountAtomic)
      expect(result.status.state).toBe(2)
      expect(result.transactionHashes[0]).toMatch(/^0x[0-9a-f]{64}$/)
      expect(http.mock.calls[0][0]).toMatchObject({
        method: 'put',
        url: 'http://localhost/message/monad/topics/vote',
        headers: {
          'Content-Type': 'application/cbor',
          Accept: 'application/cbor',
        },
      })
      expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
      expect(f.legacySigner).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  },
)
test.each([0n, -1n, 1n << 63n])(
  'invalid amount %s fails before effects',
  async value => {
    const f = await fixture()
    try {
      await expect(
        new TopicVoteClient(topicWallet(f.wallet)).castVote({
          ...params,
          amountAtomic: value,
        }),
      ).rejects.toThrow()
      expect(f.construct).not.toHaveBeenCalled()
      expect(http).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  },
)
test('204 shape-only success remains uncertain and replay preserves the full exact signed set', async () => {
  const f = await fixture()
  try {
    const normal = http.getMockImplementation()!
    http.mockResolvedValueOnce({
      data: new Uint8Array(),
      status: 204,
      headers: {},
    } as never)
    const client = new TopicVoteClient(topicWallet(f.wallet))
    await expect(client.castVote(params)).rejects.toBeInstanceOf(
      TopicVoteAbandonedError,
    )
    const retained = f.bundle.topicOperationJournal.getAll()[0]!
    expect(retained.version).toBe(2)
    expect(retained.writeFormat).toBe('forum-cbor')
    expect(retained.rawTransactions).toHaveLength(1)
    const original = f.journal
      .list()[0]!
      .members.map(member => member.signed!.rawTransaction)
    http.mockImplementation(normal)
    await client.resumePendingOperations()
    expect(http.mock.calls[1][0]).toMatchObject({
      data: Uint8Array.from(retained.requestBytes),
    })
    expect(f.construct).toHaveBeenCalledTimes(1)
    expect(
      f.journal.list()[0]!.members.map(member => member.signed!.rawTransaction),
    ).toEqual(original)
  } finally {
    await f.close()
  }
})
test('concurrent independent pending votes reserve disjoint coins instead of blocking the wallet', async () => {
  const f = await fixture()
  try {
    http.mockRejectedValue(new Error('offline'))
    const client = new TopicVoteClient(topicWallet(f.wallet))
    const results = await Promise.allSettled([
      client.castVote({
        ...params,
        amountAtomic: 500000n,
        operationId: 'vote-first',
      }),
      client.castVote({
        ...params,
        amountAtomic: 500000n,
        operationId: 'vote-second',
      }),
    ])
    expect(results.map(result => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    for (const result of results) {
      if (result.status !== 'rejected')
        throw new Error('Expected pending operation')
      expect(result.reason).toBeInstanceOf(TopicVoteAbandonedError)
    }
    expect(f.construct.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(http).toHaveBeenCalledTimes(2)
    expect(f.bundle.topicOperationJournal.getAll()).toHaveLength(2)
    const accounts = f.journal
      .list()
      .map(operation => operation.members[0]!.source.address)
    expect(new Set(accounts).size).toBe(2)
    expect(
      f.journal
        .list()
        .flatMap(row =>
          row.members.filter(
            member => member.transactionSet?.role === 'payment',
          ),
        )
        .every(member => f.preparer.isSourceReserved(member.source.address)),
    ).toBe(true)
  } finally {
    await f.close()
  }
})
test('HTTP rejection after exposure retains signed authority and input reservations', async () => {
  const f = await fixture()
  try {
    http.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: 'rejected' },
    })
    await expect(
      new TopicVoteClient(topicWallet(f.wallet)).castVote(params),
    ).rejects.toBeInstanceOf(TopicVoteAbandonedError)
    const rows = f.bundle.topicOperationJournal.getAll()
    expect(rows).toHaveLength(1)
    const authority = f.preparer.getOperation(
      rows[0]!.transactionSetOperationId,
    )!
    expect(
      authority.members
        .filter(member => member.transactionSet?.role === 'payment')
        .map(member => member.signed!.rawTransaction),
    ).toEqual(rows[0]!.rawTransactions)
    expect(authority.members.every(member => member.signed !== undefined)).toBe(
      true,
    )
    expect(
      f.journal
        .list()
        .flatMap(row =>
          row.members.filter(
            member => member.transactionSet?.role === 'payment',
          ),
        )
        .every(member => f.preparer.isSourceReserved(member.source.address)),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test('confirmed relay status with one missing burn receipt retains every original payment reservation', async () => {
  const f = await fixture()
  try {
    const originalReceipt =
      f.provider.getTransactionReceipt.getMockImplementation()!
    f.provider.getTransactionReceipt.mockImplementation(async hash => {
      const operation = f.journal.list()[0]!
      const firstPayment = operation.members.find(
        member => member.transactionSet?.role === 'payment',
      )!
      return hash === firstPayment.signed!.transactionHash
        ? null
        : originalReceipt(hash)
    })
    await expect(
      new TopicVoteClient(topicWallet(f.wallet)).castVote(params),
    ).rejects.toBeInstanceOf(TopicVoteAbandonedError)
    const retained = f.bundle.topicOperationJournal.getAll()[0]!
    expect(retained.rawTransactions).toHaveLength(1)
    expect(f.construct).toHaveBeenCalledTimes(1)
    expect(
      f.journal
        .list()
        .flatMap(row =>
          row.members.filter(
            member => member.transactionSet?.role === 'payment',
          ),
        )
        .every(member => f.preparer.isSourceReserved(member.source.address)),
    ).toBe(true)
    expect(
      f.preparer
        .getOperation(retained.transactionSetOperationId)!
        .members.filter(member => member.transactionSet?.role === 'payment')
        .map(member => member.signed!.rawTransaction),
    ).toEqual(retained.rawTransactions)
  } finally {
    await f.close()
  }
})
