import { createEvmTransactionSetSubmission } from './evm-transaction-set-submission'
import { createEvmTopicOperations } from './evm-topic-operations'
/** Real wallet construction and codec; external node/relay observations are scripted. */
import axios from 'axios'
import {
  Wallet,
  Transaction,
  getBytes,
  hexlify,
  getAddress,
  type Provider,
} from 'ethers'
import {
  encodeFrame,
  validateFrame,
  defaultContext,
  topicBurnCommitment,
  toHex,
  verifyTopicPostAuthor,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/evm-wallet-bundle'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { MonadIdentity } from './evm-identity'
import type { EvmWalletHandle } from './evm-wallet-handle'
import { TopicPostClient, TopicPostAbandonedError } from './topic-post-client'
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
  const submission = createEvmTransactionSetSubmission({
    preparer,
    lifecycle,
    provider: provider as unknown as Provider,
    refresh: async () => undefined,
    operations: () => journal.list(),
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
    transactionSetSubmission: submission,
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
  topic: 'test',
  entries: [{ kind: 'post' as const, title: 'hello', message: 'world' }],
  direction: 'up' as const,
  amountAtomic: 1000000n,
  timestampMs: -1,
}
test('public post writes schema2 type10 with all burns, parent and exact authored timestamp', async () => {
  const f = await fixture()
  try {
    const parent = new Uint8Array(32).fill(2)
    const result = await new TopicPostClient(
      topicWallet(f.wallet),
    ).submitTopicPost({
      ...params,
      parentPostHash: parent,
    })
    const parsed = validateFrame(result.postFrame, defaultContext())
    if (
      parsed.kind !== 'parsed' ||
      parsed.typed?.type !== 9 ||
      parsed.typed.schemaVersion !== 2
    )
      throw new Error('Expected canonical post')
    expect(parsed.typed.parentHash).toEqual(parent)
    expect(parsed.typed.content.authored).toEqual({
      seconds: -1n,
      nanoseconds: 999000000,
    })
    expect(result.status.state).toBe(2)
    expect(result.transactionHashes[0]).toMatch(/^0x[0-9a-f]{64}$/)
    expect(http.mock.calls[0][0]).toMatchObject({
      method: 'put',
      headers: {
        'Content-Type': 'application/cbor',
        Accept: 'application/cbor',
      },
    })
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  } finally {
    await f.close()
  }
})
test.each([0n, -1n, 1n << 63n])(
  'amount %s fails before preparation or send',
  async value => {
    const f = await fixture()
    try {
      await expect(
        new TopicPostClient(topicWallet(f.wallet)).submitTopicPost({
          ...params,
          amountAtomic: value,
        }),
      ).rejects.toThrow()
      expect(f.construct).not.toHaveBeenCalled()
      expect(http).not.toHaveBeenCalled()
      expect(f.journal.list()).toEqual([])
    } finally {
      await f.close()
    }
  },
)
test('down post and bad parent fail before shared preparation', async () => {
  const f = await fixture()
  try {
    const client = new TopicPostClient(topicWallet(f.wallet))
    await expect(
      client.submitTopicPost({ ...params, direction: 'down' }),
    ).rejects.toThrow()
    await expect(
      client.submitTopicPost({ ...params, parentPostHash: new Uint8Array(31) }),
    ).rejects.toThrow()
    expect(f.construct).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
test('transport loss retains the full original request and explicit resume does not construct again', async () => {
  const f = await fixture()
  try {
    const client = new TopicPostClient(topicWallet(f.wallet))
    const normal = http.getMockImplementation()!
    http.mockRejectedValueOnce(new Error('lost after send'))
    await expect(client.submitTopicPost(params)).rejects.toBeInstanceOf(
      TopicPostAbandonedError,
    )
    const pending = f.bundle.topicOperationJournal.getAll()[0]!
    expect(pending.version).toBe(2)
    expect(pending.writeFormat).toBe('forum-cbor')
    expect(pending.rawTransactions).toHaveLength(1)
    const authority = f.preparer.getOperation(
      pending.transactionSetOperationId,
    )!
    expect(
      authority.members
        .filter(member => member.transactionSet?.role === 'payment')
        .map(member => member.signed!.rawTransaction),
    ).toEqual(pending.rawTransactions)
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
    http.mockImplementation(normal)
    await client.resumePendingOperations()
    expect(http.mock.calls[1][0]).toMatchObject({
      method: 'post',
      data: Uint8Array.from(pending.requestBytes),
    })
    expect(f.construct).toHaveBeenCalledTimes(1)
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  } finally {
    await f.close()
  }
})
test('maximum admitted amount remains exact through signing and status', async () => {
  const value = (1n << 63n) - 1n
  const f = await fixture(value + 60000n)
  try {
    const result = await new TopicPostClient(
      topicWallet(f.wallet),
    ).submitTopicPost({
      ...params,
      amountAtomic: value,
    })
    expect(result.status.value).toBe(value)
    expect(
      f.journal
        .list()[0]!
        .members.filter(member => member.transactionSet?.role === 'payment')
        .reduce(
          (sum, member) =>
            sum + Transaction.from(member.signed!.rawTransaction).value,
          0n,
        ),
    ).toBe(value)
  } finally {
    await f.close()
  }
})
test('preparation interruption retains the host construction intent without a fabricated signed operation', async () => {
  const f = await fixture()
  try {
    f.construct.mockRejectedValueOnce(new Error('sign failed'))
    await expect(
      new TopicPostClient(topicWallet(f.wallet)).submitTopicPost(params),
    ).rejects.toThrow('sign failed')
    const pending = f.bundle.topicOperationJournal.getAll()[0]!
    expect(pending.construction?.postFrameHex).toBeTruthy()
    expect(pending.rawTransactions).toEqual([])
    expect(f.journal.list()).toEqual([])
    expect(
      f.coins.all().filter(coin => coin.state === 'unspent' && !coin.holder),
    ).toHaveLength(2)
    expect(http).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
test('signs the authored post with wallet.identity independently of transaction funders', async () => {
  const f = await fixture()
  try {
    const identity = MonadIdentity.generate()
    const result = await new TopicPostClient(
      topicWallet({
        ...f.wallet,
        identity,
      }),
    ).submitTopicPost(params)
    const parsed = validateFrame(result.postFrame, defaultContext())
    if (parsed.kind !== 'parsed' || parsed.typed?.type !== 9)
      throw new Error('Expected signed post')
    expect(parsed.typed.from).toEqual({
      keyType: 1,
      keyBytes: new Uint8Array(identity.compressedPubKey),
    })
    const verifiedAddress = verifyTopicPostAuthor(parsed.typed)
    expect(getAddress('0x' + toHex(verifiedAddress!))).toBe(
      identity.address.raw,
    )
    expect(
      f.journal
        .list()[0]!
        .members.some(member => member.source.address === identity.address.raw),
    ).toBe(false)
  } finally {
    await f.close()
  }
})
test('uses cached gas policy and the shared preparer without a probe-sign or fee estimation RPC', async () => {
  const f = await fixture()
  try {
    await new TopicPostClient(topicWallet(f.wallet)).submitTopicPost(params)
    expect(f.construct).toHaveBeenCalledTimes(1)
    expect(f.construct).toHaveBeenCalledWith(
      expect.objectContaining({
        amountWei: params.amountAtomic,
        kdf: expect.any(Function),
        calldata: expect.stringMatching(/^0x/),
      }),
    )
    const signed = f.journal
      .list()[0]!
      .members.map(member => Transaction.from(member.signed!.rawTransaction))
    expect(
      signed
        .filter(tx => tx.to === getAddress(burn))
        .every(tx => tx.gasLimit === 60000n && tx.gasPrice === 1n),
    ).toBe(true)
    expect(f.legacySigner).not.toHaveBeenCalled()
    expect(f.provider.estimateGas).not.toHaveBeenCalled()
    expect(f.provider.getFeeData).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
