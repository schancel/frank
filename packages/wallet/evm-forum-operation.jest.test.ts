import { createEvmTopicOperations } from './evm-topic-operations'
import { TopicPostClient, TopicPostAbandonedError } from './topic-post-client'
import { createEvmTransactionSetSubmission } from './evm-transaction-set-submission'
/** Real shared preparation, signed authority and codec status matching; node/relay effects are scripted. */
import axios from 'axios'
import level from 'level'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Wallet, Transaction, getBytes, hexlify, type Provider } from 'ethers'
import {
  encodeForumPost,
  encodeFrame,
  topicBurnCommitment,
  validateFrame,
  TYPE_TOPIC_POST_SUBMISSION,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/evm-wallet-bundle'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { MemoryRecordStore, LevelRecordStore } from './storage/evm-coin-store'
import {
  EvmCoinList,
  EVM_COIN_LIST_NAMESPACE,
  type StoredEvmListCoin,
} from './evm-coin-list'
import { LevelTopicOperationJournal } from './storage/topic-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import {
  bindForumAuthority,
  reconcileForumOperations,
  submitForumOperation,
} from './evm-forum-operation'
import type { OutgoingTopicOperation } from './storage/topic-operation-journal'
import type { EvmWalletHandle } from './evm-wallet-handle'
jest.mock('axios')
const http = axios as unknown as jest.MockedFunction<typeof axios.request>
const burn = '0x000000000000000000000000000000000000dEaD'
const key = (n: number) => new Wallet('0x' + n.toString(16).padStart(64, '0'))
const blockHash = '0x' + 'ab'.repeat(32)
async function fixture(location?: string) {
  const bundle = createInMemoryMonadWalletBundle({
    mnemonic: 'test test test test test test test test test test test junk',
  })
  const coinStore = location
    ? await LevelRecordStore.open<StoredEvmListCoin>(
        location,
        EVM_COIN_LIST_NAMESPACE,
      )
    : new MemoryRecordStore<StoredEvmListCoin>()
  const coins = await EvmCoinList.open(coinStore)
  if (!coins.all().length)
    for (const n of [1, 2])
      await coins.put({
        account: key(n).address,
        privateKey: key(n).privateKey,
        nonce: 0,
        valueWei: 1700000n,
        origin: 'stealth',
      })
  const journal = new EvmNativeOperationJournal({
    ...(location ? { location } : { testOnlyEphemeral: true }),
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'forum shared',
    },
  })
  await journal.Open()
  const topicDatabase = location
    ? level(join(location, 'forum-host'))
    : undefined
  const topicJournal = topicDatabase
    ? new LevelTopicOperationJournal(topicDatabase, () => undefined)
    : bundle.topicOperationJournal
  if (topicJournal instanceof LevelTopicOperationJournal)
    await topicJournal.Open()
  const state = { ...bundle, topicOperationJournal: topicJournal }
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    random: () => 0.01,
    policy: () => ({
      sourceOrder: [
        'stealth',
        'stamp',
        'change',
        'deterministic',
        'root',
        'identity',
      ],
      gasPriceWei: 1n,
      paymentGasLimit: () => 60000n,
      changeGasLimit: 21000n,
      paymentFeeIsExact: true,
      dustWei: 1000n,
      radix: 2,
      jitterBps: 1500,
      maxChangeOutputs: 20,
      head: 100,
    }),
    deriveChange: index => ({
      account: key(100 + index).address,
      privateKey: key(100 + index).privateKey,
      changeIndex: index,
    }),
  })
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
            chainId: 10143n,
            value: item.tx.value,
            data: item.tx.data,
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
    walletState: state,
    topicOperationJournal: topicJournal,
    provider: provider as unknown as Provider,
    httpClient: {
      submitRawTransaction: async () => '',
    } as unknown as EvmWalletHandle['httpClient'],
    relayBaseUrl: 'http://localhost',
    cborNetwork: 'monad-testnet',
    forumBurnAddress: burn,
    forumChainId: 10143n,
    transactionSetPreparer: preparer,
    transactionSetLifecycle: lifecycle,
    transactionSetSubmission: submission,
    forumOperationMutation: task => task(),
  }
  const post = encodeForumPost({
    network: 'monad-testnet',
    topic: 'test',
    authored: { seconds: 0n, nanoseconds: 0 },
    entries: [{ message: 'hello' }],
  })
  const { hash } = topicBurnCommitment(post)
  const params = {
    kind: 'post' as const,
    operationId: 'forum-test',
    target: hash,
    direction: 'up' as const,
    burnAddress: burn,
    value: 1000000n,
    postFrame: post,
  }
  const retained = () => topicJournal.getAll()[0]!
  function status(
    operation = retained(),
    changes: readonly [number, unknown][] = [],
  ) {
    const row = preparer.getOperation(operation.transactionSetOperationId)!
    const last = Math.max(
      ...operation.rawTransactions.map(raw =>
        row.members.findIndex(member => member.signed!.rawTransaction === raw),
      ),
    )
    const fields = new Map<number, unknown>([
      [0, 'monad-testnet'],
      [1, Uint8Array.from(operation.requestBytes)],
      [2, hash],
      [3, getBytes(operation.transactionSetHash)],
      [4, getBytes(operation.funders[0]!)],
      [5, 1],
      [6, BigInt(operation.valueWei)],
      [7, 2],
      [8, 12n],
      [9, BigInt(last)],
      [10, 0n],
      [11, new Uint8Array(16)],
    ])
    for (const [key, value] of changes) fields.set(key, value)
    return encodeFrame(
      { typeId: 15, schemaVersion: 1, minReaderVersion: 1 },
      fields as never,
    )
  }
  function mine() {
    for (const [index, member] of preparer
      .getOperation('forum-test')!
      .members.entries())
      included.set(member.signed!.transactionHash, {
        tx: Transaction.from(member.signed!.rawTransaction),
        index,
      })
  }
  return {
    bundle: state,
    coins,
    journal,
    preparer,
    lifecycle,
    provider,
    wallet,
    params,
    post,
    hash,
    retained,
    status,
    mine,
    close: async () => {
      await bundle.close()
      await journal.Close()
      await coinStore.close()
      await topicDatabase?.close()
    },
  }
}
const response = (data: Uint8Array) => ({
  data,
  headers: { 'content-type': 'application/cbor' },
})
afterEach(() => jest.clearAllMocks())

test('actual Forum construction submits one scalar burn and excludes private change from relay authority', async () => {
  const f = await fixture()
  try {
    http.mockImplementation(async () => {
      f.mine()
      return response(f.status()) as never
    })
    const result = await submitForumOperation(f.wallet, f.params)
    expect(result.operation.rawTransactions).toHaveLength(1)
    const parsed = validateFrame(Uint8Array.from(result.operation.requestBytes))
    if (
      parsed.kind !== 'parsed' ||
      parsed.typed?.type !== TYPE_TOPIC_POST_SUBMISSION
    )
      throw new Error('expected post submission')
    expect([hexlify(parsed.typed.burnTx)]).toEqual(
      result.operation.rawTransactions,
    )
    const other = f.preparer
      .getOperation('forum-test')!
      .members.filter(member => member.transactionSet?.role === 'change')
    expect(other.length).toBeGreaterThan(1)
    for (const member of other)
      expect(result.operation.rawTransactions).not.toContain(
        member.signed!.rawTransaction,
      )
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  } finally {
    await f.close()
  }
})

test.each(['funder', 'raw', 'amount', 'network'] as const)(
  'rejects altered %s authority before relay or node effects',
  async field => {
    const f = await fixture()
    try {
      http.mockRejectedValue(new Error('lost relay response'))
      await expect(submitForumOperation(f.wallet, f.params)).rejects.toThrow(
        'retained pending',
      )
      const operation = f.retained()
      if (field === 'funder') operation.funders[0] = burn
      if (field === 'raw') operation.rawTransactions[0] = '0x1234'
      if (field === 'amount') operation.valueWei = '1'
      if (field === 'network') f.wallet.cborNetwork = 'monad-mainnet'
      const before = f.provider.getNetwork.mock.calls.length
      expect(() => bindForumAuthority(f.wallet, operation)).toThrow()
      expect(f.provider.getNetwork).toHaveBeenCalledTimes(before)
      expect(http).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  },
)

test('one missing member receipt prevents completion even when another signed burn succeeded', async () => {
  const f = await fixture()
  try {
    http.mockImplementation(async () => {
      f.mine()
      const original = f.provider.getTransactionReceipt.getMockImplementation()!
      f.provider.getTransactionReceipt.mockImplementation(async hash =>
        hash ===
        f.preparer
          .getOperation('forum-test')!
          .members.find(member => member.transactionSet?.role === 'payment')!
          .signed!.transactionHash
          ? null
          : original(hash),
      )
      return response(f.status()) as never
    })
    await expect(submitForumOperation(f.wallet, f.params)).rejects.toThrow(
      'retained pending',
    )
    expect(f.bundle.topicOperationJournal.getAll()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('failure between host intent and core retains the original complete post, then resumes its exact signed set', async () => {
  const f = await fixture()
  try {
    const prepare = jest
      .spyOn(f.preparer, 'constructLegacyTransactionSet')
      .mockRejectedValueOnce(new Error('interrupted before signing'))
    await expect(submitForumOperation(f.wallet, f.params)).rejects.toThrow(
      'interrupted',
    )
    const intent = f.retained()
    expect(intent.construction?.postFrameHex).toBe(hexlify(f.post).slice(2))
    expect(f.journal.list()).toEqual([])
    expect(http).not.toHaveBeenCalled()
    prepare.mockRestore()
    http.mockImplementation(async () => {
      f.mine()
      return response(f.status()) as never
    })
    await reconcileForumOperations(f.wallet, 'post')
    expect(f.journal.list()).toHaveLength(1)
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  } finally {
    await f.close()
  }
})

test('reopens the exact original post and signed set after interruption between core persistence and host completion', async () => {
  const location = await mkdtemp(join(tmpdir(), 'forum-host-interruption-'))
  let f = await fixture(location)
  try {
    const put = f.bundle.topicOperationJournal.put.bind(
      f.bundle.topicOperationJournal,
    )
    const failCompletion = jest
      .spyOn(f.bundle.topicOperationJournal, 'put')
      .mockImplementation(async operation => {
        if (!operation.construction)
          throw new Error('interrupted host completion')
        return put(operation)
      })
    await expect(submitForumOperation(f.wallet, f.params)).rejects.toThrow(
      'interrupted host completion',
    )
    const original = f.preparer
      .getOperation('forum-test')!
      .members.map(member => member.signed!.rawTransaction)
    expect(f.retained().construction?.postFrameHex).toBe(
      hexlify(f.post).slice(2),
    )
    expect(http).not.toHaveBeenCalled()
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled()
    failCompletion.mockRestore()
    await f.close()
    f = await fixture(location)
    http.mockImplementation(async () => {
      f.mine()
      return response(f.status()) as never
    })
    await reconcileForumOperations(f.wallet, 'post')
    expect(
      f.preparer
        .getOperation('forum-test')!
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(original)
    expect(f.journal.list()).toHaveLength(1)
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([])
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('an explicit operation retry reuses the original ready host envelope and payment set', async () => {
  const f = await fixture()
  try {
    http.mockRejectedValueOnce(new Error('relay response lost'))
    await expect(submitForumOperation(f.wallet, f.params)).rejects.toThrow(
      'retained pending',
    )
    const original = f.retained()
    http.mockImplementation(async () => {
      f.mine()
      return response(f.status()) as never
    })
    const retried = await submitForumOperation(f.wallet, f.params)
    expect(retried.operation.rawTransactions).toEqual(original.rawTransactions)
    expect(retried.operation.requestBytes).toEqual(original.requestBytes)
    expect(f.journal.list()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

const relayError = (
  status: number,
  data: unknown,
  contentType = 'application/json',
) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: { 'content-type': contentType } },
  })

// Exercise the production arraybuffer exchange, including retained authority on failure.
test.each(['arraybuffer', 'buffer', 'uint8array'] as const)(
  'Forum 503 JSON diagnostics survive %s responses without changing retained authority',
  async representation => {
    const f = await fixture()
    const bytes = Buffer.from(
      JSON.stringify({
        error: 'topic_burn_outcome_unknown',
        detail: 'ConfirmationTimedOut: receipt not observed',
      }),
    )
    const data =
      representation === 'arraybuffer'
        ? Uint8Array.from(bytes).buffer
        : representation === 'uint8array'
        ? Uint8Array.from(bytes)
        : bytes
    const original = relayError(503, data, 'application/json; charset=utf-8')
    http.mockRejectedValue(original)
    await submitForumOperation(f.wallet, f.params).catch(() => undefined)
    const before = f.bundle.topicOperationJournal.getAll()
    const construct = jest.spyOn(f.preparer, 'constructLegacyTransactionSet')
    const error = await reconcileForumOperations(f.wallet, 'post').catch(
      error => error,
    )
    expect(error.message).toContain('HTTP 503')
    expect(error.message).toContain('topic_burn_outcome_unknown')
    expect(error.message).toContain(
      'ConfirmationTimedOut: receipt not observed',
    )
    expect(error.message).toContain('pending')
    expect(error).toMatchObject({
      status: 503,
      code: 'topic_burn_outcome_unknown',
      detail: 'ConfirmationTimedOut: receipt not observed',
      cause: original,
    })
    expect(f.bundle.topicOperationJournal.getAll()).toEqual(before)
    expect(construct).not.toHaveBeenCalled()
    expect(
      f.coins.all().some(coin => coin.holder === f.params.operationId),
    ).toBe(true)
    await f.close()
  },
)

test.each([
  [
    400,
    Buffer.from('{"error":"invalid_forum_request","detail":"invalid burn"}'),
    'application/json',
    'invalid_forum_request',
  ],
  [503, Buffer.from('not JSON'), 'application/json', undefined],
  [503, Uint8Array.from([0xff]), 'application/json', undefined],
  [503, Buffer.from('null'), 'application/json', undefined],
  [
    503,
    Buffer.from('{"error":"unsafe code\\n","detail":"wait"}'),
    'application/json',
    undefined,
  ],
  [
    429,
    Buffer.from('{"error":"rate_limited","detail":"wait"}'),
    'text/html',
    undefined,
  ],
  [502, Buffer.alloc(4097, 32), 'application/json', undefined],
  [503, Buffer.from('{"error":[],"detail":{}}'), 'application/json', undefined],
  [
    503,
    Buffer.from(
      JSON.stringify({ error: 'forum_unavailable', detail: 'x'.repeat(1025) }),
    ),
    'application/json',
    undefined,
  ],
  [
    503,
    { error: 'forum_unavailable', detail: 'object is not a byte response' },
    'application/json',
    undefined,
  ],
] as const)(
  'Forum HTTP %s uses bounded diagnostics or a status-preserving fallback',
  async (status, data, media, code) => {
    const f = await fixture()
    const original = relayError(status, data, media)
    http.mockRejectedValue(original)
    await submitForumOperation(f.wallet, f.params).catch(() => undefined)
    const error = await reconcileForumOperations(f.wallet, 'post').catch(
      error => error,
    )
    expect(error.message).toContain(`HTTP ${status}`)
    expect(error.cause).toBe(original)
    expect(error.code).toBe(code)
    expect(error.message.length).toBeLessThan(1400)
    expect(error.message).not.toContain('payment failed')
    await f.close()
  },
)

test('Forum diagnostics redact upstream URLs and normalize control characters', async () => {
  const f = await fixture()
  http.mockRejectedValue(
    relayError(
      503,
      Buffer.from(
        JSON.stringify({
          error: 'topic_burn_outcome_unknown',
          detail:
            'RPC https://upstream.invalid/private-token failed\nreceipt pending',
        }),
      ),
    ),
  )
  await submitForumOperation(f.wallet, f.params).catch(() => undefined)
  const error = await reconcileForumOperations(f.wallet, 'post').catch(
    error => error,
  )
  expect(error.detail).toBe('RPC [URL redacted] failed receipt pending')
  expect(error.message).not.toContain('private-token')
  await f.close()
})

test('Forum JSON decoding respects a byte view offset and length', async () => {
  const f = await fixture()
  const payload = Buffer.from('{"error":"forum_unavailable","detail":"wait"}')
  const padded = Buffer.concat([
    Buffer.from('not JSON'),
    payload,
    Buffer.from('trailing'),
  ])
  http.mockRejectedValue(
    relayError(503, padded.subarray(8, 8 + payload.length)),
  )
  await submitForumOperation(f.wallet, f.params).catch(() => undefined)
  const error = await reconcileForumOperations(f.wallet, 'post').catch(
    error => error,
  )
  expect(error.code).toBe('forum_unavailable')
  expect(error.detail).toBe('wait')
  await f.close()
})

test('initial shared Forum submission retains diagnostic cause and the complete signed operation after HTTP 503', async () => {
  const f = await fixture()
  const original = relayError(
    503,
    Uint8Array.from(
      Buffer.from(
        JSON.stringify({
          error: 'topic_burn_outcome_unknown',
          detail: 'ConfirmationTimedOut',
        }),
      ),
    ).buffer,
  )
  http.mockRejectedValue(original)
  try {
    const error = await submitForumOperation(f.wallet, f.params).catch(
      error => error,
    )
    expect(error.message).toContain(
      'HTTP 503 (topic_burn_outcome_unknown): ConfirmationTimedOut',
    )
    expect(error.cause.cause).toBe(original)
    expect(http).toHaveBeenCalledTimes(1)
    const operation = f.retained()
    expect(operation.rawTransactions).toHaveLength(1)
    expect(
      f.preparer
        .getOperation(operation.transactionSetOperationId)
        ?.members.every(member => !!member.signed),
    ).toBe(true)
    expect(
      f.coins
        .all()
        .some(coin => coin.holder === operation.transactionSetOperationId),
    ).toBe(true)
  } finally {
    await f.close()
  }
})


test('insufficient funds after durable intent stays pending through the generic client and restart recovers only that burn', async () => {
  const location = await mkdtemp(join(tmpdir(), 'forum-intent-recovery-'))
  let f = await fixture(location)
  const clientFor = () => new TopicPostClient({
    chainIdentifier: 'monad-testnet', topicOperations: createEvmTopicOperations(f.wallet),
  })
  try {
    const originalCoins = f.coins.all()
    for (const coin of originalCoins) await f.coins.put({ ...coin, valueWei: 1n })
    const error = await clientFor().submitTopicPost({
      topic: 'test', entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up', amountAtomic: 1000000n, timestampMs: 0,
    }).catch(error => error)
    expect(error).toBeInstanceOf(TopicPostAbandonedError)
    expect(f.bundle.topicOperationJournal.getAll()).toHaveLength(1)
    const original = f.retained()
    expect(original.construction).toBeDefined()
    expect(error.payloadHashHex).toBe(original.kind === 'post' && original.payloadHashHex)
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
    for (const coin of originalCoins) await f.coins.put(coin)
    await f.close()
    f = await fixture(location)
    http.mockRejectedValue(new Error('relay offline'))
    await clientFor().resumePendingOperations().catch(() => undefined)
    const recovered = f.retained()
    expect(recovered.transactionSetOperationId).toBe(original.transactionSetOperationId)
    expect(recovered.construction).toBeUndefined()
    expect(recovered.rawTransactions).toHaveLength(1)
    expect(recovered.kind === 'post' && recovered.payloadHashHex)
      .toBe(original.kind === 'post' && original.payloadHashHex)
    const raw = recovered.rawTransactions[0]
    expect(Transaction.from(raw).to?.toLowerCase()).toBe(burn.toLowerCase())
    await clientFor().resumePendingOperations().catch(() => undefined)
    expect(f.bundle.topicOperationJournal.getAll()).toEqual([recovered])
    expect(f.preparer.getOperation(original.transactionSetOperationId)?.members
      .filter(member => member.transactionSet?.role === 'payment')
      .map(member => member.signed?.rawTransaction)).toEqual([raw])
    const burnBytes = f.provider.broadcastTransaction.mock.calls
      .map(([bytes]) => bytes).filter(bytes => Transaction.from(bytes).to?.toLowerCase() === burn.toLowerCase())
    expect(burnBytes.length).toBeGreaterThan(0)
    expect(new Set(burnBytes)).toEqual(new Set([raw]))
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('an intent write that commits then rejects is pending to the generic client', async () => {
  const f = await fixture()
  try {
    const put = f.bundle.topicOperationJournal.put.bind(f.bundle.topicOperationJournal)
    jest.spyOn(f.bundle.topicOperationJournal, 'put').mockImplementationOnce(async operation => {
      await put(operation)
      throw new Error('commit acknowledgement lost')
    })
    const client = new TopicPostClient({ chainIdentifier: 'monad-testnet',
      topicOperations: createEvmTopicOperations(f.wallet) })
    await expect(client.submitTopicPost({ topic: 'test', entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up', amountAtomic: 1000000n, timestampMs: 0 }))
      .rejects.toBeInstanceOf(TopicPostAbandonedError)
    expect(f.bundle.topicOperationJournal.getAll()).toHaveLength(1)
    expect(f.retained().construction).toBeDefined()
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled()
  } finally { await f.close() }
})
