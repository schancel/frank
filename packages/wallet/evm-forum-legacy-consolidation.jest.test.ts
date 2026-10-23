/** Fragmented Forum funding keeps one burn and one durable operation across network waits/reopen. */
import axios from 'axios'
import level from 'level'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Wallet, Transaction, getBytes, type Provider } from 'ethers'
import {
  encodeForumPost,
  topicBurnCommitment,
  validateFrame,
  TYPE_TOPIC_POST_SUBMISSION,
} from '@frank/codec'
import { createInMemoryMonadWalletBundle } from './storage/evm-wallet-bundle'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { LevelRecordStore } from './storage/evm-coin-store'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelTopicOperationJournal } from './storage/topic-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetLifecycle } from './evm-transaction-set-lifecycle'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from './evm-transaction-set-types'
import {
  submitForumOperation,
  reconcileForumOperations,
} from './evm-forum-operation'
import type { EvmWalletHandle } from './evm-wallet-handle'
import {
  createLegacyTransactionSetPayments,
  LegacyTransactionSetFailedError,
} from './chain/evm-legacy-transaction-set'
import { EvmNativeOperationPendingError } from './chain/evm-legacy-consolidator'

jest.mock('axios')
const http = axios as unknown as jest.MockedFunction<typeof axios.request>
const key = (n: number) => new Wallet('0x' + n.toString(16).padStart(64, '0'))
const burn = '0x000000000000000000000000000000000000dEaD'
const blockHash = '0x' + 'ab'.repeat(32)
function network() {
  let head = 10
  const mined = new Map<
    string,
    { tx: Transaction; block: number; index: number; status: number }
  >()
  const broadcasts: string[] = []
  const provider = {
    getNetwork: async () => ({ chainId: 10143n }),
    getBlock: async (block: number) => ({
      hash: blockHash,
      number: typeof block === 'number' ? block : head,
    }),
    getBlockNumber: async () => head,
    getTransactionReceipt: async (hash: string) => {
      const item = mined.get(hash)
      return item
        ? {
            hash,
            from: item.tx.from,
            to: item.tx.to,
            status: item.status,
            blockHash,
            blockNumber: item.block,
            index: item.index,
            fee: item.tx.gasLimit,
          }
        : null
    },
    getTransaction: async (hash: string) => {
      const item = mined.get(hash)
      return item
        ? {
            hash,
            from: item.tx.from,
            to: item.tx.to,
            chainId: 10143n,
            value: item.tx.value,
            data: item.tx.data,
            blockNumber: item.block,
            index: item.index,
          }
        : null
    },
    getTransactionCount: async (address: string) =>
      [...mined.values()]
        .filter(item => item.tx.from!.toLowerCase() === address.toLowerCase())
        .reduce((nonce, item) => Math.max(nonce, item.tx.nonce + 1), 0),
    getBalance: async () => 0n,
    broadcastTransaction: jest.fn(async (raw: string) => {
      broadcasts.push(raw)
      return { hash: Transaction.from(raw).hash! }
    }),
  }
  return {
    provider: provider as unknown as Provider,
    broadcasts,
    head: () => head,
    advance: (next: number) => {
      head = next
    },
    mine: (raw: string, status = 1) => {
      const tx = Transaction.from(raw)
      mined.set(tx.hash!, { tx, block: head, index: mined.size, status })
    },
  }
}
async function fixture(
  location: string,
  chain: ReturnType<typeof network>,
  fragmented = true,
) {
  const bundle = createInMemoryMonadWalletBundle({
    mnemonic: 'test test test test test test test test test test test junk',
  })
  const store = await LevelRecordStore.open<StoredEvmListCoin>(
    location,
    'inventory',
  )
  const coins = await EvmCoinList.open(store)
  if (!coins.all().length)
    for (const n of fragmented ? [1, 2] : [1])
      await coins.put({
        account: key(n).address,
        privateKey: key(n).privateKey,
        nonce: 0,
        valueWei: fragmented ? 400000n : 900000n,
        origin: 'stealth',
      })
  const journal = new EvmNativeOperationJournal({
    location,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'forum-consolidation-test',
    },
  })
  await journal.Open()
  const db = level(join(location, 'forum-host'))
  const topicJournal = new LevelTopicOperationJournal(db, () => undefined)
  await topicJournal.Open()
  const rule = { belowWei: 1000000n, waitBlocks: 2 }
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    recoverySpendRule: rule,
    policy: () => ({
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: 1n,
      paymentGasLimit: data => (data === '0x' ? 21000n : 60000n),
      changeGasLimit: 21000n,
      paymentFeeIsExact: true,
      dustWei: 1000n,
      radix: 2,
      jitterBps: 0,
      maxChangeOutputs: 8,
      head: chain.head(),
      spendRule: rule,
    }),
    deriveChange: index => ({
      account: key(100 + index).address,
      privateKey: key(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  const lifecycle = new EvmTransactionSetLifecycle({
    authority: preparer,
    provider: chain.provider,
    head: chain.head,
  })
  const wallet: EvmWalletHandle = {
    pool: bundle.pool,
    leaseManager: bundle.leaseManager,
    walletState: { ...bundle, topicOperationJournal: topicJournal },
    topicOperationJournal: topicJournal,
    provider: chain.provider,
    httpClient: {
      submitRawTransaction: async () => '',
    } as unknown as EvmWalletHandle['httpClient'],
    relayBaseUrl: 'http://localhost',
    cborNetwork: 'monad-testnet',
    forumBurnAddress: burn,
    forumChainId: 10143n,
    transactionSetPreparer: preparer,
    transactionSetLifecycle: lifecycle,
    forumOperationMutation: task => task(),
  }
  const legacy = createLegacyTransactionSetPayments({
    preparer,
    lifecycle,
    provider: chain.provider,
    refresh: async () => undefined,
    operations: () => journal.list(),
    getCoins: () =>
      coins.all().filter(coin => journal.canSelect(coin.account, coin.nonce)),
  })
  return {
    wallet,
    preparer,
    lifecycle,
    journal,
    coins,
    topicJournal,
    legacy,
    close: async () => {
      await bundle.close()
      await db.close()
      await journal.Close()
      await store.close()
    },
  }
}
const postFrame = encodeForumPost({
  network: 'monad-testnet',
  topic: 'test',
  authored: { seconds: 0n, nanoseconds: 0 },
  entries: [{ message: 'one funded burn' }],
})
const request = {
  kind: 'post' as const,
  operationId: 'fragmented-forum',
  target: topicBurnCommitment(postFrame).hash,
  direction: 'up' as const,
  burnAddress: burn,
  value: 600000n,
  postFrame,
}
afterEach(() => jest.clearAllMocks())

test('all funding must confirm and mature before one Forum burn leaves the wallet; reopen preserves original bytes', async () => {
  const location = await mkdtemp(join(tmpdir(), 'forum-fragmented-'))
  const chain = network()
  let f = await fixture(location, chain)
  try {
    await expect(submitForumOperation(f.wallet, request)).rejects.toThrow(
      /funding.*pending/i,
    )
    expect(http).not.toHaveBeenCalled()
    const original = f.preparer.getOperation(request.operationId)!
    const bytes = original.members.map(member => member.signed!.rawTransaction)
    const funding = original.members.filter(
      member => member.transactionSet?.role === 'funding',
    )
    expect(funding.length).toBeGreaterThan(1)
    const payment = original.members.filter(
      member => member.transactionSet?.role === 'payment',
    )
    expect(payment).toHaveLength(1)
    const retained = f.topicJournal.getAll()[0]!
    const parsed = validateFrame(Uint8Array.from(retained.requestBytes))
    expect(parsed.kind).toBe('parsed')
    if (
      parsed.kind !== 'parsed' ||
      parsed.typed?.type !== TYPE_TOPIC_POST_SUBMISSION
    )
      throw new Error('Expected unchanged Forum post submission')
    expect(getBytes(payment[0]!.signed!.rawTransaction)).toEqual(
      parsed.typed.burnTx,
    )
    const withheldSource = funding.at(-1)!.source.address
    const ordered = [...original.members].sort(
      (a, b) =>
        a.source.address.localeCompare(b.source.address) ||
        Transaction.from(a.signed!.rawTransaction).nonce -
          Transaction.from(b.signed!.rawTransaction).nonce,
    )
    for (const member of ordered.filter(
      member =>
        member.source.address !== withheldSource &&
        member.source.address !== payment[0]!.source.address,
    ))
      chain.mine(member.signed!.rawTransaction)
    chain.advance(20)
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow(
      /funding.*pending/i,
    )
    expect(http).not.toHaveBeenCalled()
    for (const member of ordered.filter(
      member => member.source.address === withheldSource,
    ))
      chain.mine(member.signed!.rawTransaction)
    await f.close()
    f = await fixture(location, chain)
    chain.advance(22)
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow(
      /funding.*pending/i,
    )
    expect(http).not.toHaveBeenCalled()
    chain.advance(23)
    http.mockRejectedValue(new Error('ambiguous relay response'))
    await expect(reconcileForumOperations(f.wallet, 'post')).rejects.toThrow(
      'ambiguous relay response',
    )
    expect(http).toHaveBeenCalled()
    const submitted = http.mock.calls.map(
      call => new Uint8Array(call[0]!.data as Uint8Array),
    )
    for (const body of submitted)
      expect(body).toEqual(Uint8Array.from(retained.requestBytes))
    expect(
      f.preparer
        .getOperation(request.operationId)!
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(bytes)
    expect(f.journal.list()).toHaveLength(1)
    expect(chain.broadcasts).not.toContain(payment[0]!.signed!.rawTransaction)
    expect(f.coins.isAccountReserved(payment[0]!.source.address)).toBe(true)
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('a sufficient account bypasses funding and quotes conservatively without signing', async () => {
  const location = await mkdtemp(join(tmpdir(), 'legacy-sufficient-'))
  const chain = network()
  const f = await fixture(location, chain, false)
  try {
    const quote = await f.legacy.estimateLegacyFee({
      recipient: { raw: key(50).address },
      value: 600000n,
    })
    expect(quote.inputCount).toBe(1)
    expect(f.journal.list()).toEqual([])
    expect(chain.broadcasts).toEqual([])
    let captured: EvmNativeOperationPendingError | undefined
    try {
      await f.legacy.sendLegacy({
        recipient: { raw: key(50).address },
        value: 600000n,
      })
    } catch (error) {
      if (!(error instanceof EvmNativeOperationPendingError)) throw error
      captured = error
    }
    expect(captured).toBeDefined()
    const row = f.legacy.getUnresolvedLegacySend()[0]!
    expect(
      row.members.filter(member => member.transactionSet?.role === 'funding'),
    ).toEqual([])
    expect(BigInt(row.maximumFeeWei)).toBeLessThanOrEqual(quote.totalFee)
    const bytes = row.members.map(member => member.signed!.rawTransaction)
    for (const raw of [...bytes].sort(
      (a, b) => Transaction.from(a).nonce - Transaction.from(b).nonce,
    ))
      chain.mine(raw)
    const result = await f.legacy.resumeLegacySend(row.operationId)
    expect(result.totalValueSent).toBeGreaterThanOrEqual(600000n)
    expect(f.legacy.getUnresolvedLegacySend()).toEqual([])
    expect(
      f.journal
        .get(row.operationId)
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(bytes)
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('a confirmed recipient revert is reported as failure without a replacement payment', async () => {
  const location = await mkdtemp(join(tmpdir(), 'legacy-confirmed-revert-'))
  const chain = network()
  const f = await fixture(location, chain, false)
  try {
    await expect(
      f.legacy.sendLegacy({
        recipient: { raw: key(50).address },
        value: 600000n,
      }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const original = f.legacy.getUnresolvedLegacySend()[0]!
    const bytes = original.members.map(member => member.signed!.rawTransaction)
    for (const member of [...original.members].sort(
      (a, b) =>
        Transaction.from(a.signed!.rawTransaction).nonce -
        Transaction.from(b.signed!.rawTransaction).nonce,
    ))
      chain.mine(
        member.signed!.rawTransaction,
        member.transactionSet?.role === 'payment' ? 0 : 1,
      )
    chain.advance(100)
    const broadcastsBefore = [...chain.broadcasts]
    await expect(
      f.legacy.resumeLegacySend(original.operationId),
    ).rejects.toBeInstanceOf(LegacyTransactionSetFailedError)
    expect(chain.broadcasts).toEqual(broadcastsBefore)
    expect(f.journal.list()).toHaveLength(1)
    expect(
      f.journal
        .get(original.operationId)
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(bytes)
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('a requested fragmented legacy send resumes the original graph and sends one recipient transaction after funding matures', async () => {
  const location = await mkdtemp(join(tmpdir(), 'legacy-fragmented-restart-'))
  const chain = network()
  let f = await fixture(location, chain)
  try {
    const destination = key(50).address
    await expect(
      f.legacy.sendLegacy({ recipient: { raw: destination }, value: 600000n }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const original = f.legacy.getUnresolvedLegacySend()[0]!
    const bytes = original.members.map(member => member.signed!.rawTransaction)
    const recipient = original.members.filter(
      member => member.transactionSet?.role === 'payment',
    )
    expect(recipient).toHaveLength(1)
    expect(Transaction.from(recipient[0]!.signed!.rawTransaction).to).toBe(
      destination,
    )
    expect(
      original.members.filter(
        member => member.transactionSet?.role === 'funding',
      ).length,
    ).toBeGreaterThan(1)
    expect(chain.broadcasts).not.toContain(recipient[0]!.signed!.rawTransaction)
    const ordered = [...original.members].sort(
      (a, b) =>
        a.source.address.localeCompare(b.source.address) ||
        Transaction.from(a.signed!.rawTransaction).nonce -
          Transaction.from(b.signed!.rawTransaction).nonce,
    )
    for (const member of ordered.filter(
      member => member.source.address !== recipient[0]!.source.address,
    ))
      chain.mine(member.signed!.rawTransaction)
    await f.close()
    f = await fixture(location, chain)
    chain.advance(12)
    await expect(
      f.legacy.resumeLegacySend(original.operationId),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    expect(chain.broadcasts).not.toContain(recipient[0]!.signed!.rawTransaction)
    chain.advance(13)
    await expect(
      f.legacy.resumeLegacySend(original.operationId),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    expect(chain.broadcasts).toContain(recipient[0]!.signed!.rawTransaction)
    for (const member of ordered.filter(
      member => member.source.address === recipient[0]!.source.address,
    ))
      chain.mine(member.signed!.rawTransaction)
    const result = await f.legacy.resumeLegacySend(original.operationId)
    expect(result.txHash).toBe(recipient[0]!.signed!.transactionHash)
    expect(result.totalValueSent).toBeGreaterThanOrEqual(600000n)
    expect(f.journal.list()).toHaveLength(1)
    expect(
      f.journal
        .get(original.operationId)
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(bytes)
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})

test('recipient inclusion does not discard delayed owned change; host ticks after reopen broadcast the same change bytes', async () => {
  const location = await mkdtemp(join(tmpdir(), 'legacy-pending-change-'))
  const chain = network()
  let f = await fixture(location, chain, false)
  try {
    await expect(
      f.legacy.sendLegacy({
        recipient: { raw: key(50).address },
        value: 600000n,
      }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const original = f.legacy.getUnresolvedLegacySend()[0]!
    const payment = original.members.find(
      member => member.transactionSet?.role === 'payment',
    )!
    const changes = original.members
      .filter(member => member.transactionSet?.role === 'change')
      .sort(
        (a, b) =>
          Transaction.from(a.signed!.rawTransaction).nonce -
          Transaction.from(b.signed!.rawTransaction).nonce,
      )
    expect(changes.length).toBeGreaterThan(0)
    expect(Transaction.from(payment.signed!.rawTransaction).nonce).toBe(0)
    chain.mine(payment.signed!.rawTransaction)
    chain.advance(11)
    await f.legacy.reconcileLegacySends()
    expect(
      f.legacy.getUnresolvedLegacySend().map(row => row.operationId),
    ).toEqual([original.operationId])
    expect(
      f.journal
        .get(original.operationId)
        .members.find(member => member.transactionSet?.role === 'payment')!
        .observation.state,
    ).toBe('included-success')
    for (const change of changes)
      expect(chain.broadcasts).not.toContain(change.signed!.rawTransaction)
    await f.close()
    f = await fixture(location, chain, false)
    for (const [index, change] of changes.entries()) {
      chain.advance(12 + index * 2)
      await f.legacy.reconcileLegacySends()
      expect(chain.broadcasts).toContain(change.signed!.rawTransaction)
      chain.mine(change.signed!.rawTransaction)
    }
    await f.legacy.reconcileLegacySends()
    expect(f.legacy.getUnresolvedLegacySend()).toEqual([])
    expect(
      f.journal
        .get(original.operationId)
        .members.map(member => member.signed!.rawTransaction),
    ).toEqual(original.members.map(member => member.signed!.rawTransaction))
  } finally {
    await f.close()
    await rm(location, { recursive: true, force: true })
  }
})
