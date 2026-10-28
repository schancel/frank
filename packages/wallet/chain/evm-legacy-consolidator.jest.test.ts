import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  HDNodeWallet,
  Transaction,
  Wallet,
  keccak256,
  type Provider,
} from 'ethers'
import {
  EvmLegacyConsolidator,
  EvmNativeOperationPendingError,
} from './evm-legacy-consolidator'
import {
  NativeEvmTransactionBuilder,
  type EvmTransactionBuilder,
} from './evm-transaction-builder'
import {
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'
import {
  createEvmInputAdmission,
  nativeJournalReader,
  type WalletOperationLifetime,
} from '../evm-input-admission'
import { MonadHdKeyring } from '../secp256k1-hd-keyring'
import { MonadChangeKeyring } from '../secp256k1-hd-keyring'
import { MonadSubAccountPool } from '../evm-account-pool'
import { MonadChangePool } from '../evm-change-pool'
import { SubAccountLeaseManager } from '../evm-account-lease'
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
import { InMemoryChangePoolStore } from '../storage/change-pool-storage'
import { InMemoryTopicOperationJournal } from '../storage/topic-operation-journal'
import { validateMonadWalletState } from '../storage/evm-wallet-state-validator'
import * as durability from '../storage/level-durability'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { EvmCoinList } from '../evm-coin-list'
import { MemoryRecordStore } from '../storage/evm-coin-store'
import { EvmTransactionSetPreparer } from '../evm-transaction-set'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '../evm-transaction-set-types'

const recipient = new Wallet('0x' + '11'.repeat(32)).address.toLowerCase()
const wallets = [1, 2, 3].map(
  n => new Wallet('0x' + n.toString(16).padStart(64, '0')),
)
const fee = 21000n
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'test-owned-public-branches',
}

function chain(initial: bigint[]) {
  const balances = new Map(
    wallets.map((w, i) => [w.address.toLowerCase(), initial[i] ?? 0n]),
  )
  const nonces = new Map<string, number>()
  const transactions = new Map<
    string,
    ReturnType<typeof Transaction.from> & {
      blockHash: string
      blockNumber: number
      index: number
    }
  >()
  const receipts = new Map<string, object>()
  const raws: string[] = []
  const blockHash = '0x' + 'ab'.repeat(32)
  let mode: 'mine' | 'lost' | 'retained' = 'mine'
  const mine = (raw: string, status = 1) => {
    const tx = Transaction.from(raw)
    const from = tx.from!.toLowerCase()
    const to = tx.to!.toLowerCase()
    if (receipts.has(tx.hash!)) return
    nonces.set(from, tx.nonce + 1)
    balances.set(
      from,
      (balances.get(from) ?? 0n) - fee - (status === 1 ? tx.value : 0n),
    )
    if (status === 1) balances.set(to, (balances.get(to) ?? 0n) + tx.value)
    transactions.set(
      tx.hash!,
      Object.assign(tx, { blockHash, blockNumber: 1, index: 0 }),
    )
    receipts.set(tx.hash!, {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      status,
      blockHash,
      blockNumber: 1,
      index: 0,
      gasUsed: 21000n,
      gasPrice: 1n,
    })
  }
  const provider = {
    getBlock: jest.fn(async () => ({ hash: blockHash, number: 1 })),
    getBalance: jest.fn(
      async (address: string) => balances.get(address.toLowerCase()) ?? 0n,
    ),
    getTransactionCount: jest.fn(
      async (address: string) => nonces.get(address.toLowerCase()) ?? 0,
    ),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 1n,
    })),
    estimateGas: jest.fn(async () => 21000n),
    call: jest.fn(async () => '0x'),
    getTransaction: jest.fn(
      async (hash: string) => transactions.get(hash) ?? null,
    ),
    getTransactionReceipt: jest.fn(
      async (hash: string) => receipts.get(hash) ?? null,
    ),
    broadcastTransaction: jest.fn(async (raw: string) => {
      raws.push(raw)
      if (mode === 'lost') throw new Error('lost response')
      if (mode === 'mine') mine(raw)
      return { hash: keccak256(raw) }
    }),
  }
  return {
    provider,
    balances,
    nonces,
    receipts,
    transactions,
    raws,
    mine,
    setMode: (value: typeof mode) => {
      mode = value
    },
  }
}

describe('wallet-lifetime EVM native operations', () => {
  let location: string
  let journal: EvmNativeOperationJournal
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-native-owner-'))
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  })
  afterEach(async () => {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  })
  const sources = (): EvmNativeSource[] =>
    wallets.map((w, index) => ({
      kind: 'spend',
      index,
      address: w.address.toLowerCase(),
    }))
  function owner(
    state: ReturnType<typeof chain>,
    options: {
      sources?: EvmNativeSource[]
      builder?: EvmTransactionBuilder
    } = {},
  ) {
    const sign = jest.fn(async (source: EvmNativeSource, raw: string) => {
      const wallet = wallets.find(
        w => w.address.toLowerCase() === source.address,
      )!
      return wallet.signTransaction(Transaction.from(raw))
    })
    const sync = jest.fn(async (): Promise<void> => undefined)
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: state.provider as unknown as Provider,
      transactionBuilder: options.builder ?? new NativeEvmTransactionBuilder(),
      mainSource: { kind: 'main', address: wallets[0]!.address.toLowerCase() },
      ownedSource: address =>
        (options.sources ?? sources()).find(
          source => source.address === address.toLowerCase(),
        ),
      sign,
      onSyncTransaction: sync,
    })
    return { executor, sign, sync }
  }
  async function reopen() {
    await journal.Close()
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  /** A fresh, empty journal and storage location inside one test. */
  async function reset() {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
    location = await mkdtemp(join(tmpdir(), 'frank-native-owner-'))
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  const independent = (preparationId = 'independent-test') => ({
    kind: 'native' as const,
    preparationId: 'stealth-payment:' + preparationId,
    recipient: { raw: recipient },
    maxNativeFeeWei: fee * 2n,
    members: sources()
      .slice(0, 2)
      .map(source => ({ sourceAddress: source.address, value: 1000n })),
  })
  let payments = 0
  /** One native transfer of `value` from one named account, the way a token or stealth payment
   * is made now: an independent payment of one member, signed, then handed to the network. */
  async function pay(
    executor: EvmLegacyConsolidator,
    options: {
      source?: number | string
      value?: bigint
      lifetime?: WalletOperationLifetime
      to?: string
    } = {},
  ) {
    const sourceAddress =
      typeof options.source === 'string'
        ? options.source
        : wallets[options.source ?? 0]!.address.toLowerCase()
    const row = await executor.signIndependentPayment(
      {
        kind: 'native',
        preparationId: `stealth-payment:pay-${++payments}`,
        recipient: { raw: options.to ?? recipient },
        maxNativeFeeWei: fee * 10n,
        members: [{ sourceAddress, value: options.value ?? 1000n }],
      },
      options.lifetime,
    )
    return executor.resumeOperation(row.operationId, options.lifetime)
  }
  it('reserves the entire independent set before signing and reopens original bytes', async () => {
    const state = chain([50000n, 50000n]),
      { executor, sign } = owner(state)
    sign.mockImplementationOnce(async (source, raw) => {
      expect(
        sources()
          .slice(0, 2)
          .every(source => !journal.canSelect(source.address, 0)),
      ).toBe(true)
      return wallets
        .find(wallet => wallet.address.toLowerCase() === source.address)!
        .signTransaction(Transaction.from(raw))
    })
    sign.mockRejectedValueOnce(new Error('interrupt second signature'))
    await expect(
      executor.signIndependentPayment(independent()),
    ).rejects.toThrow('interrupt second')
    expect(journal.list()).toHaveLength(1)
    const original = journal.list()[0]!
    expect(original.members[0]!.signed).not.toBeNull()
    expect(original.members[1]!.signed).toBeNull()
    expect(original.members.every(member => !member.exposed)).toBe(true)
    expect(state.raws).toHaveLength(0)
    await reopen()
    const resumed = await owner(state).executor.signIndependentPayment(
      independent(),
    )
    expect(resumed.operationId).toBe(original.operationId)
    expect(resumed.members[0]!.signed).toEqual(original.members[0]!.signed)
    expect(
      resumed.members.every(member => member.signed && !member.exposed),
    ).toBe(true)
    await expect(
      owner(state).executor.signIndependentPayment({
        ...independent(),
        members: [...independent().members].reverse(),
      }),
    ).rejects.toThrow('conflicts')
  })
  it('applies one total fee ceiling and rejects duplicate or unowned sources without claims', async () => {
    const state = chain([50000n, 50000n]),
      { executor, sign } = owner(state)
    await expect(
      executor.signIndependentPayment({
        ...independent(),
        maxNativeFeeWei: fee,
      }),
    ).rejects.toThrow('total fee')
    expect(journal.list()).toHaveLength(0)
    expect(sign).not.toHaveBeenCalled()
    expect(() =>
      executor.signIndependentPayment({
        ...independent(),
        members: [independent().members[0]!, independent().members[0]!],
      }),
    ).toThrow('Duplicate')
    await expect(
      executor.signIndependentPayment({
        ...independent(),
        members: [
          independent().members[0]!,
          { sourceAddress: recipient, value: 1000n },
        ],
      }),
    ).rejects.toThrow('not owned')
    expect(journal.list()).toHaveLength(0)
    expect(journal.canSelect(sources()[0]!.address, 0)).toBe(true)
  })
  it('does not leak an earlier source when a later member conflicts atomically', async () => {
    const state = chain([50000n, 50000n]),
      { executor } = owner(state)
    await executor.signIndependentPayment({
      ...independent('held-second'),
      members: [independent().members[1]!],
    })
    await expect(
      executor.signIndependentPayment(independent()),
    ).rejects.toThrow('reserved')
    expect(journal.canSelect(sources()[0]!.address, 0)).toBe(true)
    expect(journal.list()).toHaveLength(1)
  })
  it('coordinates same preparation across owner instances without duplicate signatures or rows', async () => {
    const state = chain([50000n, 50000n]),
      first = owner(state),
      second = owner(state)
    const [a, b] = await Promise.all([
      first.executor.signIndependentPayment(independent()),
      second.executor.signIndependentPayment(independent()),
    ])
    expect(a.operationId).toBe(b.operationId)
    expect(journal.list()).toHaveLength(1)
    expect(first.sign.mock.calls.length + second.sign.mock.calls.length).toBe(2)
  })
  it('tries every independent original after an uncertain sibling and preserves individual retirement', async () => {
    const state = chain([50000n, 50000n]),
      { executor } = owner(state)
    const row = await executor.signIndependentPayment(independent())
    state.provider.broadcastTransaction.mockImplementationOnce(async raw => {
      state.raws.push(raw)
      throw new Error('ambiguous first')
    })
    await expect(
      executor.resumeOperation(row.operationId),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    expect(state.raws).toEqual(
      row.members.map(member => member.signed!.rawTransaction),
    )
    await executor.observe(row.operationId, 1)
    expect(
      summarizeEvmNativeOperation(journal.get(row.operationId)).payment,
    ).toBe('partial')
    expect(journal.canSelect(sources()[0]!.address, 0)).toBe(false)
    expect(journal.canSelect(sources()[1]!.address, 1)).toBe(true)
    await reopen()
    await owner(state).executor.resumeOperation(row.operationId)
    expect(state.raws[2]).toBe(row.members[0]!.signed!.rawTransaction)
    expect(state.raws).toHaveLength(3)
  })
  it('invalidates orphaned independent inclusion after reopen and retries only that original member', async () => {
    const state = chain([50000n, 50000n])
    const row = await owner(state).executor.signIndependentPayment(
      independent(),
    )
    await owner(state).executor.resumeOperation(row.operationId)
    await owner(state).executor.observe(row.operationId, 0)
    await owner(state).executor.observe(row.operationId, 1)
    expect(
      summarizeEvmNativeOperation(journal.get(row.operationId)).payment,
    ).toBe('included')
    await reopen()
    const first = row.members[0]!
    state.receipts.delete(first.signed!.transactionHash)
    state.transactions.delete(first.signed!.transactionHash)
    state.nonces.set(first.source.address, 0)
    state.balances.set(first.source.address, 50000n)
    state.provider.getBlock.mockImplementationOnce(async () => ({
      hash: '0x' + 'cd'.repeat(32),
      number: 1,
    }))
    await owner(state).executor.observe(row.operationId, 0)
    const invalidated = journal.get(row.operationId)
    expect(invalidated.members[0]!.observation.state).toBe('missing')
    expect(invalidated.members[0]!.signed).toEqual(first.signed)
    expect(invalidated.members[0]!.exposed).toBe(true)
    expect(journal.canSelect(first.source.address, 0)).toBe(false)
    expect(summarizeEvmNativeOperation(invalidated).payment).toBe('partial')
    await owner(state).executor.resumeOperation(row.operationId)
    expect(state.raws).toEqual([
      ...row.members.map(member => member.signed!.rawTransaction),
      first.signed!.rawTransaction,
    ])
  })
  it('does not stop siblings when the first original reverted', async () => {
    const state = chain([50000n, 50000n]),
      { executor } = owner(state)
    const row = await executor.signIndependentPayment(independent())
    state.mine(row.members[0]!.signed!.rawTransaction, 0)
    await expect(
      executor.resumeOperation(row.operationId),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    expect(state.raws).toEqual([row.members[1]!.signed!.rawTransaction])
    await executor.observe(row.operationId, 1)
    expect(
      summarizeEvmNativeOperation(journal.get(row.operationId)).payment,
    ).toBe('partial')
  })
  it('allows an unrelated source to sign while another operation waits for RPC', async () => {
    const state = chain([50000n, 50000n, 50000n]),
      { executor } = owner(state)
    let unblock!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => {
      unblock = resolve
    })
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    state.provider.getBalance.mockImplementationOnce(async () => {
      entered()
      await blocked
      return 50000n
    })
    const slow = executor.signIndependentPayment(independent())
    await started
    const fast = await executor.signIndependentPayment({
      ...independent('unrelated'),
      members: [{ sourceAddress: sources()[2]!.address, value: 1000n }],
    })
    expect(fast.members[0]!.signed).not.toBeNull()
    unblock()
    await slow
  })
  it('quotes gasless owned token sources truthfully without signing or reserving', async () => {
    const state = chain([0n, 50000n]),
      { executor, sign } = owner(state)
    const terms = {
      ...independent(),
      kind: 'contract' as const,
      members: independent().members.map(member => ({
        ...member,
        value: 0n,
        data: '0xa9059cbb',
        gasLimit: 21000n,
      })),
    }
    const quote = await executor.quoteIndependentPayment(terms)
    expect(quote.sources[0]!.nativeBalanceAtomic).toBe(0n)
    expect(quote.estimatedNativeFeeAtomic).toBe(fee * 2n)
    await expect(executor.signIndependentPayment(terms)).rejects.toThrow(
      'Insufficient',
    )
    expect(sign).not.toHaveBeenCalled()
    expect(journal.list()).toHaveLength(0)
  })
  it('atomically admits only one of concurrent overlapping complete source sets', async () => {
    const state = chain([50000n, 50000n, 50000n])
    const a = independent('overlap-a'),
      b = {
        ...independent('overlap-b'),
        members: sources()
          .slice(1)
          .map(source => ({ sourceAddress: source.address, value: 1000n })),
      }
    const results = await Promise.allSettled([
      owner(state).executor.signIndependentPayment(a),
      owner(state).executor.signIndependentPayment(b),
    ])
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(journal.list()).toHaveLength(1)
    const held = new Set(
      journal.list()[0]!.members.map(member => member.source.address),
    )
    for (const source of sources())
      expect(journal.canSelect(source.address, 0)).toBe(
        !held.has(source.address),
      )
  })
  it('background contract recovery probes each exposed member and leaves private siblings untouched', async () => {
    const state = chain([50000n, 50000n]),
      { executor } = owner(state)
    state.setMode('retained')
    const terms = {
      ...independent('contract-background'),
      kind: 'contract' as const,
      members: independent().members.map(member => ({
        ...member,
        value: 0n,
        data: '0xa9059cbb',
        gasLimit: 21000n,
      })),
    }
    const row = await executor.signIndependentPayment(terms)
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(0)
    await journal.markExposed(row.operationId, 1)
    expect(executor.unresolvedContractCalls()).toEqual([
      {
        operationId: row.operationId,
        txHash: row.members[1]!.signed!.transactionHash,
      },
    ])
    await executor.resendMissingContractCalls()
    expect(state.raws).toEqual([row.members[1]!.signed!.rawTransaction])
    expect(journal.get(row.operationId).members[0]!.exposed).toBe(false)
  })
  it('does not expose a contract call before its recovery checkpoint and callback; a call that was never exposed is ended', async () => {
    const state = chain([200000n])
    const { executor } = owner(state)
    await expect(
      executor.sendContractCall({
        to: { raw: recipient },
        data: '0x12345678',
        value: 0n,
        gasLimit: 21000n,
        onSigned: async transaction => {
          const record = journal.list()[0]!
          expect(record.members[0]!.signed!.transactionHash).toBe(
            transaction.txHash,
          )
          expect(record.members[0]!.exposed).toBe(false)
          throw new Error('caller checkpoint failed')
        },
      }),
    ).rejects.toThrow('caller checkpoint failed')
    expect(state.provider.broadcastTransaction.mock.calls.length).toBe(0)
    // Without its caller's record the call may never be sent later: it is ended, and the main
    // account is free for the next call.
    await reopen()
    expect(journal.list()[0]!.cancelled).toBe(true)
    expect(journal.canSelect(wallets[0]!.address.toLowerCase(), 0)).toBe(true)
  })
  it('replays direct lost-response bytes after Level reopen without a fresh payment', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const first = owner(state)
    await expect(
      pay(first.executor, { value: 100000n }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const original = journal.list()[0]!
    expect(original.members[0]!.exposed).toBe(true)
    await reopen()
    const second = owner(state, { sources: [] })
    state.setMode('mine')
    await second.executor.resumeOperation(original.operationId)
    await second.executor.lookAtOperation(original.operationId)
    await second.executor.resumeOperation(original.operationId)
    await second.executor.flushSync()
    await second.executor.flushSync()
    expect(state.raws).toEqual([
      original.members[0]!.signed!.rawTransaction,
      original.members[0]!.signed!.rawTransaction,
    ])
    expect(second.sign).not.toHaveBeenCalled()
    expect(second.sync).toHaveBeenCalledTimes(1)
    expect(state.balances.get(recipient)).toBe(100000n)
    expect(journal.list()).toHaveLength(1)
    expect(journal.canSelect(wallets[0]!.address.toLowerCase(), 0)).toBe(false)
  })
  it('permits observed residual at next nonce but never reuses the retained old pair', async () => {
    const state = chain([300000n])
    const current = owner(state)
    const first = await pay(current.executor, { value: 100000n })
    // Seen included: the account's next nonce is free for the next payment.
    await current.executor.lookAtOperation(first.operationId)
    await pay(current.executor, { value: 50000n })
    expect(state.raws.map(raw => Transaction.from(raw).nonce)).toEqual([0, 1])
    expect(state.balances.get(wallets[0]!.address.toLowerCase())).toBe(108000n)
    state.nonces.set(wallets[0]!.address.toLowerCase(), 0)
    await expect(pay(current.executor)).rejects.toThrow('reserved')
    expect(journal.list()).toHaveLength(2)
  })
  it('deduplicates concurrent resume and retains reverted evidence without releasing claims', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const current = owner(state)
    await expect(pay(current.executor, { value: 100000n })).rejects.toThrow()
    const row = journal.list()[0]!
    state.mine(row.members[0]!.signed!.rawTransaction, 0)
    const first = current.executor.resumeOperation(row.operationId)
    const second = current.executor.resumeOperation(row.operationId)
    expect(second).toBe(first)
    const resumed = await Promise.allSettled([first, second])
    for (const result of resumed) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(EvmNativeOperationPendingError)
    }
    expect(current.sign).toHaveBeenCalledTimes(1)
    expect(state.raws).toHaveLength(1)
    expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
      'included-revert',
    )
    expect(journal.canSelect(row.members[0]!.source.address, 0)).toBe(false)
    expect(state.balances.get(recipient)).toBeUndefined()
  })
  it.each(['queue', 'fee'] as const)(
    'snapshots independent payment authorization before the %s await',
    async boundary => {
      const state = chain([1000000n])
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      if (boundary === 'fee')
        state.provider.getFeeData.mockImplementationOnce(async () => {
          entered()
          await wait
          return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: 1n }
        })
      const current = owner(state)
      const params = {
        kind: 'native' as const,
        preparationId: 'stealth-payment:snapshot',
        recipient: { raw: recipient },
        maxNativeFeeWei: fee * 2n,
        members: [{ sourceAddress: sources()[0]!.address, value: 100000n }],
      }
      const send = current.executor.signIndependentPayment(params)
      if (boundary !== 'queue') await started
      params.recipient.raw = wallets[2]!.address
      params.members[0]!.value = 150000n
      release?.()
      await send
      const row = journal.list()[journal.list().length - 1]!
      expect(row.recipient).toBe(recipient)
      expect(row.intendedValueWei).toBe('100000')
      expect(
        Transaction.from(row.members[0]!.signed!.rawTransaction).value,
      ).toBe(100000n)
    },
  )
  it('does not broadcast when the durable exposure barrier fails', async () => {
    const state = chain([200000n])
    const current = owner(state)
    jest
      .spyOn(journal, 'markExposed')
      .mockRejectedValueOnce(new Error('storage barrier unavailable'))
    await expect(pay(current.executor)).rejects.toThrow(
      'storage barrier unavailable',
    )
    expect(state.raws).toEqual([])
    expect(journal.list()[0]!.members[0]!.signed).not.toBeNull()
    expect(journal.list()[0]!.members[0]!.exposed).toBe(false)
  })
  it('refuses capacity before custody signs any member', async () => {
    await journal.Close()
    journal = new EvmNativeOperationJournal({ location, binding, maxBytes: 1 })
    await journal.Open()
    const state = chain([200000n])
    const current = owner(state)
    await expect(pay(current.executor)).rejects.toMatchObject({
      code: 'capacity',
    })
    expect(current.sign).not.toHaveBeenCalled()
    expect(state.raws).toEqual([])
  })
  it('a failed sync transport fails nothing: the member stays unmarked and a later flush sends it, without another payment', async () => {
    const state = chain([200000n])
    const current = owner(state)
    const sent = await pay(current.executor)
    await current.executor.lookAtOperation(sent.operationId)
    const row = journal.list()[0]!
    expect(row.members[0]!.observation.state).toBe('included-success')
    current.sync.mockRejectedValueOnce(new Error('sync transport unavailable'))
    await current.executor.flushSync(row.operationId)
    expect(journal.get(row.operationId).members[0]!.syncApplied).toBe(false)
    expect(current.executor.syncTransportFailed(row.operationId)).toBe(true)
    await current.executor.resumeOperation(row.operationId)
    // Not waited for: the flush that starts a transport resolves before it has settled.
    let release!: () => void
    current.sync.mockImplementationOnce(
      () => new Promise<void>(resolve => (release = resolve)),
    )
    const started = await current.executor.startSync(row.operationId)
    expect(journal.get(row.operationId).members[0]!.syncApplied).toBe(false)
    // A flush while it is under way does not send it a second time.
    const again = current.executor.flushSync(row.operationId)
    release()
    await started.transported
    await again
    expect(journal.get(row.operationId).members[0]!.syncApplied).toBe(true)
    expect(current.executor.syncTransportFailed(row.operationId)).toBe(false)
    await current.executor.flushSync(row.operationId)
    expect(current.sync).toHaveBeenCalledTimes(2)
    expect(state.raws).toHaveLength(1)
    expect(state.balances.get(recipient)).toBe(1000n)
  })
  it('discards delayed provider responses after a newer observation completes', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const current = owner(state)
    await expect(pay(current.executor)).rejects.toThrow()
    const row = journal.list()[0]!
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const wait = new Promise<void>(resolve => {
      release = resolve
    })
    state.provider.getTransaction.mockImplementationOnce(async () => {
      entered()
      await wait
      return null
    })
    const delayed = current.executor.observe(row.operationId, 0)
    await started
    state.mine(row.members[0]!.signed!.rawTransaction)
    await current.executor.observe(row.operationId, 0)
    release()
    await delayed
    expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
      'included-success',
    )
  })
  // ---------------------------------------------------------------------------------------
  // The executor wired the way composition wires it: a reader journal and the real input
  // admission over a real Level pool store. Its pool rows are created by `ensureSize` and
  // funded only in the simulated chain. The journal holds the source accounts of its
  // operations; nothing here records a spend on a pool row.
  // ---------------------------------------------------------------------------------------
  const mnemonic = 'test test test test test test test test test test test junk'
  const stores: LevelSubAccountPoolStore[] = []
  afterEach(async () => {
    jest.restoreAllMocks()
    for (const store of stores.splice(0)) await store.Close().catch(() => {})
  })
  async function composed(
    state: ReturnType<typeof chain>,
    balances: bigint[],
  ) {
    const keyring = MonadHdKeyring.fromMnemonic(mnemonic),
      changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
    const store = new LevelSubAccountPoolStore(location)
    await store.Open()
    stores.push(store)
    const pool = new MonadSubAccountPool({ keyring, store })
    pool.ensureSize(balances.length)
    await pool.flush()
    const change = new MonadChangePool({
      keyring: changeKeyring,
      store: new InMemoryChangePoolStore(),
    })
    const lifetime: WalletOperationLifetime = Object.freeze({
      walletBindingId: location,
    })
    let projected = 0
    const admission = createEvmInputAdmission({
      binding,
      native: journal,
      pool,
      change,
      topic: new InMemoryTopicOperationJournal(),
      leases: new SubAccountLeaseManager(pool),
      // The admission validates its owners exactly once per projection: this counts projections.
      validate: () => {
        projected++
        validateMonadWalletState({
          pool,
          changePool: change,
          subKeyring: keyring,
          changeKeyring,
        })
      },
      assertLifetime: token => {
        if (token !== lifetime) throw new Error('foreign lifetime')
      },
    })
    const address = (index: number) =>
      keyring.deriveSubAccount(index).address.toLowerCase()
    const source = (index: number): EvmNativeSource => ({
      kind: 'spend',
      index,
      address: address(index),
    })
    // The main account, which makes contract calls; it is no pool account.
    const main = wallets[2]!
    const mainAddress = main.address.toLowerCase()
    state.balances.set(mainAddress, 200000n)
    balances.forEach((value, index) =>
      state.balances.set(address(index), value),
    )
    const sign = jest.fn(async (source: EvmNativeSource, raw: string) => {
      if (source.kind === 'main' && source.address === mainAddress)
        return main.signTransaction(Transaction.from(raw))
      if (source.kind !== 'spend') throw new Error('fixture custody')
      return new Wallet(
        keyring.deriveSubAccount(source.index).privateKey,
      ).signTransaction(Transaction.from(raw))
    })
    const sync = jest.fn(async (_item: unknown) => undefined)
    const executor = (
      extra: Partial<
        ConstructorParameters<typeof EvmLegacyConsolidator>[0]
      > = {},
    ) =>
      new EvmLegacyConsolidator({
        journal: nativeJournalReader(journal),
        inputAdmission: admission,
        runLifetime: operation => operation(lifetime),
        provider: state.provider as unknown as Provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        mainSource: { kind: 'main', address: mainAddress },
        ownedSource: (owned: string) =>
          balances
            .map((_, index) => source(index))
            .find(candidate => candidate.address === owned.toLowerCase()),
        sign,
        onSyncTransaction: sync,
        ...extra,
      })
    const inspect = () => admission.inspect(lifetime)
    return {
      executor: executor(),
      another: executor,
      admission,
      pool,
      lifetime,
      sign,
      sync,
      address,
      main: mainAddress,
      inspect,
      projections: () => projected,
    }
  }
  const to = { raw: recipient }
  /** The node knows the transaction and has no receipt for it: observed as `pending`. */
  const announce = (state: ReturnType<typeof chain>, raw: string) => {
    const tx = Transaction.from(raw)
    state.transactions.set(
      tx.hash!,
      Object.assign(tx, {
        blockHash: '0x' + 'ab'.repeat(32),
        blockNumber: 1,
        index: 0,
      }),
    )
    return { hash: tx.hash! }
  }
  const providerCalls = (state: ReturnType<typeof chain>) =>
    Object.values(state.provider).reduce(
      (total, method) => total + method.mock.calls.length,
      0,
    )

  /** One native transfer from pool account `index` of a composed session, observed once more
   * after its broadcast so a transfer the node mined is recorded included. */
  const cpay = async (
    c: Awaited<ReturnType<typeof composed>>,
    options: {
      index?: number
      value?: bigint
      executor?: EvmLegacyConsolidator
      look?: boolean
    } = {},
  ) => {
    const executor = options.executor ?? c.executor
    const row = await pay(executor, {
      source: c.address(options.index ?? 0),
      value: options.value ?? 1000n,
      lifetime: c.lifetime,
    })
    if (options.look !== false) await executor.lookAtOperation(row.operationId)
    return journal.get(row.operationId)
  }
  /** One contract call from the composed session's main account. */
  const call = (
    c: Awaited<ReturnType<typeof composed>>,
    executor: EvmLegacyConsolidator = c.executor,
    onSigned?: () => Promise<void>,
  ) =>
    executor.sendContractCall(
      {
        to,
        data: '0x12345678',
        value: 0n,
        gasLimit: 21000n,
        ...(onSigned ? { onSigned } : {}),
      },
      c.lifetime,
    )
  it('retries completion after a durable sync checkpoint without transporting the note again', async () => {
    const c = await composed(chain([]), [200000n])
    let failCompletion = true
    const checkpoint = jest.fn(async () => {
      if (journal.list().some(row => row.members.some(member => member.syncApplied)) && failCompletion)
        throw new Error('completion storage unavailable')
    })
    const executor = c.another({ onSyncCheckpoint: checkpoint })
    const row = await cpay(c, { value: 100000n, executor })
    expect(row.members[0]!.observation.state).toBe('included-success')
    await executor.flushSync(row.operationId)
    expect(journal.get(row.operationId).members[0]!.syncApplied).toBe(true)
    expect(executor.syncTransportFailed(row.operationId)).toBe(true)
    expect(c.sync).toHaveBeenCalledTimes(1)
    await expect(executor.flushSync(row.operationId)).rejects.toThrow('completion storage unavailable')
    failCompletion = false
    await executor.flushSync(row.operationId)
    expect(executor.syncTransportFailed(row.operationId)).toBe(false)
    expect(c.sync).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalled()
  })










  // ---------------------------------------------------------------------------------------
  // Stage C of #1235: a plan that never signed is cancelled; held members are not re-projected.
  // Each test names what it reproduces on main e8d87c2d, or says it is a pin.
  // ---------------------------------------------------------------------------------------
  /** An unsigned plan from pool row `index`, written the way a crash between the journal write and
   * the first signature leaves it: through the journal, with no send. */
  const crashedPlan = (
    c: Awaited<ReturnType<typeof composed>>,
    index: number,
  ) =>
    journal.prepare({
      kind: 'legacy',
      recipient,
      intendedValueWei: '1000',
      members: [
        {
          source: { kind: 'spend', index, address: c.address(index) },
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143n,
            nonce: 0,
            to: recipient,
            value: 1000n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    })

  // On main e8d87c2d the plan stays unsigned and uncancelled, its account is frozen by
  // `canSelect`, and the second send fails: "Insufficient unreserved native funds".
  it('a contract call whose signing fails is cancelled by that call: its own error is thrown, the row is retained, the account is released and calls again', async () => {
    const state = chain([])
    const c = await composed(state, [200000n])
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
    await expect(call(c)).rejects.toThrow('fixture: custody refused')
    // The state the failing call left, read before anything else runs.
    const [failed] = journal.list()
    const afterFailure = {
      selectable: journal.canSelect(c.main, 0),
      admission: c.inspect(),
      broadcasts: state.raws.length,
    }
    const sent = await call(c)
    expect(failed).toMatchObject({
      kind: 'contract',
      cancelled: true,
      members: [{ signed: null, exposed: false, source: { kind: 'main' } }],
    })
    expect(afterFailure).toMatchObject({
      selectable: true,
      admission: { status: 'ready', obligations: [] },
      broadcasts: 0,
    })
    const rows = journal.list()
    expect(rows).toHaveLength(2)
    // Retained, not deleted, and not touched by the call that followed it.
    expect(rows[0]).toEqual(failed)
    expect(sent.txHash).toBe(rows[1]!.members[0]!.signed!.transactionHash)
    expect(Transaction.from(state.raws[0]!).nonce).toBe(0)
    await reopen()
    expect(journal.list()[0]).toEqual(failed)
  })

  // Pin of the limit. `cancelUnsignedOperations` does not exist on main e8d87c2d.
  it('pin: an independent payment with one member signed and the next unsigned is never cancelled, by the failed signing or by the open-time cancel', async () => {
    const state = chain([])
    const c = await composed(state, [100000n, 50000n, 45000n])
    c.sign.mockImplementationOnce(c.sign.getMockImplementation()!)
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
    await expect(
      c.executor.signIndependentPayment(
        {
          kind: 'native',
          preparationId: 'stealth-payment:partial',
          recipient: to,
          maxNativeFeeWei: fee * 3n,
          members: [0, 1, 2].map(index => ({
            sourceAddress: c.address(index),
            value: 1000n,
          })),
        },
        c.lifetime,
      ),
    ).rejects.toThrow('fixture: custody refused')
    const partial = journal.list()[0]!
    expect(partial.members.map(m => m.signed !== null)).toEqual([
      true,
      false,
      false,
    ])
    expect(partial.cancelled).toBe(false)
    const cancel = jest.spyOn(journal, 'cancelUnsigned')
    await c.executor.cancelUnsignedOperations(c.lifetime)
    // Not even asked: the consolidator reads the row first, and the journal would refuse.
    expect(cancel).not.toHaveBeenCalled()
    await expect(journal.cancelUnsigned(partial.operationId)).rejects.toThrow(
      'conflict',
    )
    expect(journal.list()).toEqual([partial])
    // Every member's account stays claimed, the unsigned ones included.
    for (const index of [0, 1, 2]) {
      expect(journal.canSelect(c.address(index), 0)).toBe(false)
      expect(journal.referencesSpendIndex(index)).toBe(true)
    }
    expect(state.raws).toEqual([])
  })

  // On main e8d87c2d nothing cancels the crashed plan: the method does not exist.
  it('the open-time cancel releases every never-signed plan and ends every unexposed contract call, and nothing else, with no provider call and no signature; a second run writes nothing', async () => {
    const state = chain([])
    const c = await composed(state, [200000n, 150000n, 100000n, 50000n])
    await cpay(c, { index: 1, value: 100000n }) // row 0: included
    const unexposed = await c.executor.signIndependentPayment(
      {
        kind: 'native',
        preparationId: 'stealth-payment:unexposed',
        recipient: to,
        maxNativeFeeWei: fee,
        members: [{ sourceAddress: c.address(0), value: 1000n }],
      },
      c.lifetime,
    ) // row 1: signed, never exposed, kept for its own resume
    await crashedPlan(c, 2)
    await crashedPlan(c, 3)
    const before = journal.list()
    expect(before.map(r => r.cancelled)).toEqual([false, false, false, false])
    expect(before[1]!.operationId).toBe(unexposed.operationId)
    const provider = providerCalls(state)
    const signatures = c.sign.mock.calls.length
    const cancel = jest.spyOn(journal, 'cancelUnsigned')
    await c.executor.cancelUnsignedOperations(c.lifetime)
    expect(journal.list()).toEqual([
      before[0],
      before[1],
      { ...before[2], cancelled: true },
      { ...before[3], cancelled: true },
    ])
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(providerCalls(state)).toBe(provider)
    expect(c.sign.mock.calls.length).toBe(signatures)
    expect(state.raws).toHaveLength(1)
    expect(journal.canSelect(c.address(2), 0)).toBe(true)
    expect(journal.referencesSpendIndex(3)).toBe(false)
    expect(journal.canSelect(c.address(0), 0)).toBe(false)
    await c.executor.cancelUnsignedOperations(c.lifetime)
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  // On main e8d87c2d a failed resume of a never-signed plan leaves it standing.
  it('a cancel that fails changes nothing the caller sees: the send still throws its own error, the open-time cancel does not throw, and a later failed resume cancels the plan', async () => {
    const state = chain([])
    const c = await composed(state, [200000n])
    const cancel = jest
      .spyOn(journal, 'cancelUnsigned')
      .mockRejectedValueOnce(new Error('fixture: cancel failed'))
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
    await expect(call(c)).rejects.toThrow('fixture: custody refused')
    expect(cancel).toHaveBeenCalledTimes(1)
    const id = journal.list()[0]!.operationId
    expect(journal.list()[0]!.cancelled).toBe(false)
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    // The open-time cancel never throws: not when the cancel is refused, not when the journal
    // cannot be read.
    cancel.mockRejectedValueOnce(new Error('fixture: cancel failed'))
    await expect(
      c.executor.cancelUnsignedOperations(c.lifetime),
    ).resolves.toBeUndefined()
    const list = jest.spyOn(journal, 'list').mockImplementationOnce(() => {
      throw new Error('fixture: journal unreadable')
    })
    await expect(
      c.executor.cancelUnsignedOperations(c.lifetime),
    ).resolves.toBeUndefined()
    list.mockRestore()
    expect(journal.list()[0]!.cancelled).toBe(false)
    // Resuming it, with custody still refusing: the resume's own error, and the plan is cancelled.
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused again'))
    await expect(c.executor.resumeOperation(id, c.lifetime)).rejects.toThrow(
      'fixture: custody refused again',
    )
    expect(journal.list()[0]!.cancelled).toBe(true)
    await expect(c.executor.resumeOperation(id, c.lifetime)).rejects.toThrow(
      'Native operation was cancelled',
    )
    expect(state.raws).toEqual([])
  })









  // ---------------------------------------------------------------------------------------
  // Stage 3 of #1235: bounded re-observation of broadcast members nothing has seen confirm.
  //
  // On main dce4bedf `reobservePending` and `stopReobservation` do not exist, so every test here
  // fails there at its first tick. What main does instead is pinned by the Stage 2 tests above
  // and in `monad-domain-wallet`: a pending member is looked up only by a later native send.
  // Time is the executor's injected clock; nothing here sleeps.
  // ---------------------------------------------------------------------------------------
  const SECOND = 1000
  type Composed = Awaited<ReturnType<typeof composed>>
  /** A session with its own clock, whose local pass is called the way composition calls it. */
  const reobserver = (
    c: Composed,
    extra: Partial<ConstructorParameters<typeof EvmLegacyConsolidator>[0]> = {},
  ) => {
    let now = 1_700_000_000_000
    const executor = c.another({ now: () => now, ...extra })
    return {
      executor,
      advance: (ms: number) => void (now += ms),
      tick: () => executor.reobservePending(),
    }
  }
  /** The first pool account of the session that no journal row has spent from. */
  const freeIndex = (c: Composed) => {
    const used = new Set(
      journal.list().flatMap(row => row.members.map(m => m.source.address)),
    )
    for (let index = 0; ; index++)
      if (!used.has(c.address(index))) return index
  }
  /** One send the node keeps without a receipt. Native: returned as soon as it is broadcast. */
  const broadcastNative = async (
    c: Composed,
    state: ReturnType<typeof chain>,
    executor = c.executor,
  ) => {
    state.provider.broadcastTransaction.mockImplementationOnce(async raw =>
      announce(state, raw),
    )
    return cpay(c, { index: freeIndex(c), executor, look: false })
  }
  /** One legacy send the node keeps without a receipt: observed `pending` in its own call. */
  const broadcastLegacy = async (
    c: Composed,
    state: ReturnType<typeof chain>,
    value: bigint,
    executor = c.executor,
    index = freeIndex(c),
  ) => {
    state.provider.broadcastTransaction.mockImplementationOnce(async raw =>
      announce(state, raw),
    )
    const sent = await cpay(c, { index, value, executor })
    const row = journal.get(sent.operationId)
    expect(row.members[0]).toMatchObject({
      exposed: true,
      observation: { state: 'pending' },
    })
    return row
  }
  const probed = (state: ReturnType<typeof chain>) =>
    state.provider.getTransactionReceipt.mock.calls.map(([hash]) => hash)
  const hashOf = (row: {
    members: { signed: { transactionHash: string } | null }[]
  }) => row.members[0]!.signed!.transactionHash
  const settle = () => new Promise(resolve => setImmediate(resolve))

  it('nothing to look up means no request at all: an empty journal, then unsigned, cancelled, signed-but-unexposed, included and reverted members, over many ticks; one broadcast member then costs exactly one receipt request', async () => {
    const state = chain([])
    const c = await composed(
      state,
      Array.from({ length: 6 }, () => 121000n),
    )
    const r = reobserver(c)
    const ticks = async (count: number) => {
      for (let i = 0; i < count; i++) {
        r.advance(15 * SECOND)
        await r.tick()
      }
    }
    const untouched = providerCalls(state)
    await ticks(50)
    expect(providerCalls(state)).toBe(untouched)

    // Included, and seen so by the look after its broadcast.
    await cpay(c, { index: freeIndex(c), value: 100000n })
    // Broadcast, then reverted, and recorded so by one look at it.
    const reverted = await broadcastLegacy(c, state, 50000n)
    state.mine(reverted.members[0]!.signed!.rawTransaction, 0)
    await c.executor.lookAtOperation(reverted.operationId)
    // Signed, and never exposed: signed and not yet handed to the network.
    await c.executor.signIndependentPayment(
      {
        kind: 'native',
        preparationId: 'stealth-payment:signed-only',
        recipient: to,
        maxNativeFeeWei: fee,
        members: [{ sourceAddress: c.address(freeIndex(c)), value: 1000n }],
      },
      c.lifetime,
    )
    // Two plans that never signed, on rows no send used; the first is cancelled.
    const used = new Set(
      journal
        .list()
        .flatMap(row =>
          row.members.map(m => (m.source as { index: number }).index),
        ),
    )
    const free = [0, 1, 2, 3, 4, 5].filter(index => !used.has(index))
    await crashedPlan(c, free[0]!)
    await c.executor.cancelUnsignedOperations(c.lifetime)
    await crashedPlan(c, free[1]!)
    const shape = () =>
      journal.list().flatMap(row =>
        row.members.map(m => ({
          cancelled: row.cancelled,
          signed: m.signed !== null,
          exposed: m.exposed,
          state: m.observation.state,
        })),
      )
    const settledShape = [
      {
        cancelled: false,
        signed: true,
        exposed: true,
        state: 'included-success',
      },
      {
        cancelled: false,
        signed: true,
        exposed: true,
        state: 'included-revert',
      },
      { cancelled: false, signed: true, exposed: false, state: 'unknown' },
      { cancelled: true, signed: false, exposed: false, state: 'unknown' },
      { cancelled: false, signed: false, exposed: false, state: 'unknown' },
    ]
    expect(shape()).toEqual(settledShape)
    const recorded = journal.list()
    const before = providerCalls(state)
    await ticks(50)
    await Promise.all(Array.from({ length: 20 }, () => r.tick()))
    expect(providerCalls(state)).toBe(before)
    expect(journal.list()).toEqual(recorded)

    // The positive control: the same counter moves, by one, for one broadcast member.
    const live = await broadcastNative(c, state)
    expect(live.members[0]).toMatchObject({
      exposed: true,
      observation: { state: 'missing' },
    })
    const control = providerCalls(state)
    const receipts = probed(state).length
    const signatures = c.sign.mock.calls.length
    const broadcasts = state.provider.broadcastTransaction.mock.calls.length
    await ticks(1)
    expect(providerCalls(state)).toBe(control + 1)
    expect(probed(state).slice(receipts)).toEqual([hashOf(live)])
    // The signed, unexposed member is still not a candidate: the one request above was not
    // for it.
    expect(shape()).toEqual([
      ...settledShape,
      { cancelled: false, signed: true, exposed: true, state: 'missing' },
    ])
    expect(c.sign.mock.calls.length).toBe(signatures)
    expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(
      broadcasts,
    )
  })

  it.each(['no receipt', 'request rejects', 'request throws'] as const)(
    'one broadcast member, %s: each probe is exactly one receipt request, nothing is written and `pending` is not downgraded; the wait doubles from 15 s to 10 min, and at that ceiling the member costs 6 requests an hour',
    async mode => {
      const state = chain([])
      const c = await composed(state, [121000n])
      const r = reobserver(c)
      const row = await broadcastLegacy(c, state, 100000n)
      if (mode === 'request rejects')
        state.provider.getTransactionReceipt.mockRejectedValue(
          new Error('fixture: node unavailable'),
        )
      if (mode === 'request throws')
        state.provider.getTransactionReceipt.mockImplementation(() => {
          throw new Error('fixture: provider destroyed')
        })
      const recorded = journal.list()
      const capture = jest.spyOn(journal, 'beginCapture')
      const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
      const before = providerCalls(state)
      const receipts = probed(state).length
      // A caller ticking every 5 s for two hours.
      const at: number[] = []
      for (let t = 0; t <= 7200; t += 5) {
        const seen = probed(state).length
        await expect(r.tick()).resolves.toBeUndefined()
        if (probed(state).length > seen) at.push(t)
        r.advance(5 * SECOND)
      }
      expect(at).toEqual([
        0, 15, 45, 105, 225, 465, 945, 1545, 2145, 2745, 3345, 3945, 4545, 5145,
        5745, 6345, 6945,
      ])
      expect(at.filter(t => t > 3600)).toHaveLength(6)
      // Every request was the one receipt probe for this member, and nothing else was asked.
      expect(providerCalls(state) - before).toBe(at.length)
      expect(probed(state).slice(receipts)).toEqual(at.map(() => hashOf(row)))
      expect(journal.list()).toEqual(recorded)
      expect(journal.list()[0]!.members[0]!.observation.state).toBe('pending')
      expect(capture).not.toHaveBeenCalled()
      expect(putMany).not.toHaveBeenCalled()
      expect(c.pool.getRecord(0)!.status).not.toBe('spent')
      expect(c.sign).toHaveBeenCalledTimes(1)
      expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(1)
      expect(c.sync).not.toHaveBeenCalled()
    },
  )

  it('the receipt appears: the next due probe runs the existing observation (one probe and seven reads) and records the inclusion; no pool row is written, nothing is signed, broadcast or transported, and later ticks cost nothing', async () => {
    const state = chain([])
    const c = await composed(state, [121000n, 50000n])
    const r = reobserver(c)
    const row = await broadcastLegacy(c, state, 100000n)
    const raw = row.members[0]!.signed!.rawTransaction
    await r.tick()
    expect(journal.list()[0]!.members[0]!.observation.state).toBe('pending')
    state.mine(raw)
    // Not yet due: the floor and the member's own wait.
    let before = providerCalls(state)
    r.advance(15 * SECOND - 1)
    await r.tick()
    expect(providerCalls(state)).toBe(before)
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    r.advance(1)
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    await r.tick()
    expect(providerCalls(state) - before).toBe(8)
    expect(journal.list()[0]!.members[0]!.observation).toMatchObject({
      state: 'included-success',
      transactionHash: hashOf(row),
      feeWei: '21000',
    })
    // The journal holds the account until the coin list reads it again; the pool row is not
    // a second record of this spend.
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    expect(putMany).not.toHaveBeenCalled()
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    // Terminal: never looked up again.
    before = providerCalls(state)
    for (let i = 0; i < 50; i++) {
      r.advance(600 * SECOND)
      await r.tick()
    }
    expect(providerCalls(state)).toBe(before)
    expect(putMany).not.toHaveBeenCalled()
    expect(c.sign).toHaveBeenCalledTimes(1)
    expect(state.provider.broadcastTransaction.mock.calls).toEqual([[raw]])
    expect(c.sync).not.toHaveBeenCalled()
    expect(journal.list()[0]!.members[0]!.syncApplied).toBe(false)
  })

  it('a reverted receipt is recorded as the existing observation records it, the pool row is left exactly as it was, and the member is never looked up again', async () => {
    const state = chain([])
    const c = await composed(state, [121000n])
    const r = reobserver(c)
    const row = await broadcastLegacy(c, state, 100000n)
    const rowBefore = c.pool.getRecord(0)
    state.mine(row.members[0]!.signed!.rawTransaction, 0)
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    await r.tick()
    expect(journal.list()[0]!.members[0]!.observation).toMatchObject({
      state: 'included-revert',
      transactionHash: hashOf(row),
    })
    expect(c.pool.getRecord(0)).toEqual(rowBefore)
    expect(putMany).not.toHaveBeenCalled()
    const before = providerCalls(state)
    for (let i = 0; i < 20; i++) {
      r.advance(600 * SECOND)
      await r.tick()
    }
    expect(providerCalls(state)).toBe(before)
    expect(c.sign).toHaveBeenCalledTimes(1)
    expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(1)
  })

  it('20 broadcast members: a pass probes at most 8, oldest first, the next pass continues after the last one probed so all 20 are reached, and concurrent callers do not add a request', async () => {
    const state = chain([])
    const c = await composed(
      state,
      Array.from({ length: 20 }, () => 100000n),
    )
    const r = reobserver(c)
    for (let i = 0; i < 20; i++) await broadcastNative(c, state)
    const hashes = journal.list().map(hashOf)
    expect(new Set(hashes).size).toBe(20)
    const recorded = journal.list()
    const pass = async () => {
      const calls = providerCalls(state)
      const seen = probed(state).length
      await Promise.all(Array.from({ length: 25 }, () => r.tick()))
      await r.tick()
      // Receipt probes only: with nothing landed a pass asks nothing else.
      expect(providerCalls(state) - calls).toBe(probed(state).length - seen)
      return probed(state).slice(seen)
    }
    expect(await pass()).toEqual(hashes.slice(0, 8))
    r.advance(15 * SECOND)
    expect(await pass()).toEqual(hashes.slice(8, 16))
    r.advance(15 * SECOND)
    expect(await pass()).toEqual([...hashes.slice(16), ...hashes.slice(0, 4)])
    r.advance(15 * SECOND)
    expect(await pass()).toEqual(hashes.slice(4, 12))
    // One landed member among them: recorded when its turn comes, without starving the rest.
    state.mine(recorded[12]!.members[0]!.signed!.rawTransaction)
    r.advance(15 * SECOND)
    const calls = providerCalls(state)
    const seen = probed(state).length
    await r.tick()
    // Eight probes, plus the observation's seven reads (one of them a receipt) for the one.
    expect(providerCalls(state) - calls).toBe(8 + 7)
    expect(new Set(probed(state).slice(seen))).toEqual(
      new Set(hashes.slice(12, 20)),
    )
    expect(
      journal.list().map(row => row.members[0]!.observation.state),
    ).toEqual(
      recorded.map((row, i) =>
        i === 12 ? 'included-success' : row.members[0]!.observation.state,
      ),
    )
    expect(c.sign).toHaveBeenCalledTimes(20)
    expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(20)
  }, 60_000)

  it('a probe the node never answers: ticks while it is in flight start nothing, a native send from another account completes meanwhile, and the 15 s floor counts from the end of the pass', async () => {
    const state = chain([])
    const c = await composed(state, [100000n, 100000n])
    const r = reobserver(c)
    const first = await broadcastNative(c, state, r.executor)
    let answer!: (receipt: null) => void
    state.provider.getTransactionReceipt.mockImplementationOnce(
      () =>
        new Promise<null>(resolve => {
          answer = resolve
        }),
    )
    let seen = probed(state).length
    let returned = false
    const hanging = r.tick().then(() => {
      returned = true
    })
    await settle()
    expect(probed(state).slice(seen)).toEqual([hashOf(first)])
    seen = probed(state).length
    // However long it hangs and however many callers arrive: no second pass.
    r.advance(3600 * SECOND)
    await Promise.all(Array.from({ length: 10 }, () => r.tick()))
    expect(probed(state).length).toBe(seen)
    expect(returned).toBe(false)
    // The same executor sends from the other account while the probe is still unanswered.
    const second = await broadcastNative(c, state, r.executor)
    expect(second.operationId).not.toBe(first.operationId)
    expect(second.members[0]).toMatchObject({ exposed: true })
    expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(2)
    expect(returned).toBe(false)
    answer(null)
    await hanging
    // The floor is measured from the end of that pass.
    seen = probed(state).length
    r.advance(15 * SECOND - 1)
    await r.tick()
    expect(probed(state).length).toBe(seen)
    r.advance(1)
    await r.tick()
    // Both are due; the pass starts after the member probed last.
    expect(probed(state).slice(seen)).toEqual([hashOf(second), hashOf(first)])
  })

  it.each([
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    2_147_483_648,
    null as unknown as number,
  ])(
    'rejects an invalid lookup budget %s before provider effects',
    async timeout => {
      const state = chain([])
      const c = await composed(state, [121000n])
      const before = providerCalls(state)
      expect(() =>
        reobserver(c, { reobservationLookupTimeoutMs: timeout }),
      ).toThrow('Invalid re-observation lookup timeout')
      expect(providerCalls(state)).toBe(before)
    },
  )

  it.each([
    'probe',
    'transaction',
    'receipt',
    'account',
    'balance',
    'nonce',
    'inclusion',
  ] as const)(
    'expires a hung %s within the whole lookup budget, preserves claims, and permits other members and later valid inclusion',
    async during => {
      const state = chain([])
      const c = await composed(state, [121000n, 121000n])
      const r = reobserver(c, { reobservationLookupTimeoutMs: 100 })
      const first = await broadcastNative(c, state, r.executor)
      const second = await broadcastNative(c, state, r.executor)
      state.mine(first.members[0]!.signed!.rawTransaction)
      let answer!: () => void
      const held = new Promise<void>(resolve => {
        answer = resolve
      })
      const holdNext = <A extends unknown[], T>(
        mock: jest.Mock<Promise<T>, A>,
      ) => {
        const original = mock.getMockImplementation()!
        mock.mockImplementationOnce(async (...args: A) => {
          await held
          return original(...args)
        })
      }
      if (during === 'probe') holdNext(state.provider.getTransactionReceipt)
      if (during === 'transaction') holdNext(state.provider.getTransaction)
      if (during === 'receipt') {
        const original =
          state.provider.getTransactionReceipt.getMockImplementation()!
        state.provider.getTransactionReceipt.mockImplementationOnce(original)
        holdNext(state.provider.getTransactionReceipt)
      }
      if (during === 'account') holdNext(state.provider.getBlock)
      if (during === 'balance') holdNext(state.provider.getBalance)
      if (during === 'nonce') holdNext(state.provider.getTransactionCount)
      if (during === 'inclusion') {
        const original = state.provider.getBlock.getMockImplementation()!
        state.provider.getBlock
          .mockImplementationOnce(original)
          .mockImplementationOnce(original)
        holdNext(state.provider.getBlock)
      }
      const recorded = journal.list()
      const record = jest.spyOn(journal, 'recordObservation')
      const signatures = c.sign.mock.calls.length
      const broadcasts = state.provider.broadcastTransaction.mock.calls.length
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      try {
        let returned = false
        const tick = r.tick().then(() => {
          returned = true
        })
        await settle()
        await jest.advanceTimersByTimeAsync(99)
        expect(returned).toBe(false)
        await Promise.all(Array.from({ length: 10 }, () => r.tick()))
        await jest.advanceTimersByTimeAsync(1)
        await tick
        expect(returned).toBe(true)
        expect(probed(state)).toContain(hashOf(second))
        expect(journal.list()).toEqual(recorded)
        expect(record).not.toHaveBeenCalled()
        expect(journal.canSelect(first.members[0]!.source.address, 0)).toBe(
          false,
        )
        const before = probed(state).filter(
          hash => hash === hashOf(first),
        ).length
        r.advance(600_000)
        await r.tick()
        expect(
          probed(state).filter(hash => hash === hashOf(first)),
        ).toHaveLength(before)
        const calls = providerCalls(state)
        answer()
        await settle()
        await settle()
        expect(providerCalls(state)).toBe(calls)
        expect(record).not.toHaveBeenCalled()
        expect(journal.list()).toEqual(recorded)
        r.advance(600_000)
        await r.tick()
        expect(
          journal.get(first.operationId).members[0]!.observation.state,
        ).toBe('included-success')
        r.advance(600_000)
        await r.tick()
        expect(c.sign).toHaveBeenCalledTimes(signatures)
        expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(
          broadcasts,
        )
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        jest.useRealTimers()
      }
    },
  )

  it.each(['transaction rejects', 'receipt throws', 'balance throws'] as const)(
    'retains physical single-flight when a sibling %s while another read hangs',
    async failure => {
      const state = chain([])
      const c = await composed(state, [121000n])
      const r = reobserver(c, { reobservationLookupTimeoutMs: 100 })
      const row = await broadcastLegacy(c, state, 100000n)
      state.mine(row.members[0]!.signed!.rawTransaction)
      const recorded = journal.list()
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const receipt =
        state.provider.getTransactionReceipt.getMockImplementation()!
      const transaction = state.provider.getTransaction.getMockImplementation()!
      if (failure === 'transaction rejects') {
        state.provider.getTransaction.mockRejectedValueOnce(
          new Error('unavailable transaction'),
        )
        state.provider.getTransactionReceipt
          .mockImplementationOnce(receipt)
          .mockImplementationOnce(async hash => {
            await held
            return receipt(hash)
          })
      } else if (failure === 'receipt throws') {
        state.provider.getTransaction.mockImplementationOnce(async hash => {
          await held
          return transaction(hash)
        })
        state.provider.getTransactionReceipt
          .mockImplementationOnce(receipt)
          .mockImplementationOnce(() => {
            throw new Error('provider destroyed')
          })
      } else {
        state.provider.getBalance.mockImplementationOnce(() => {
          throw new Error('balance unavailable')
        })
        state.provider.getTransactionCount.mockImplementationOnce(async () => {
          await held
          return 1
        })
      }
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      try {
        const tick = r.tick()
        await settle()
        await jest.advanceTimersByTimeAsync(100)
        await tick
        const before = providerCalls(state)
        r.advance(600_000)
        await r.tick()
        expect(providerCalls(state)).toBe(before)
        release()
        await settle()
        await settle()
        expect(journal.list()).toEqual(recorded)
        expect(providerCalls(state)).toBe(before)
        r.advance(600_000)
        await r.tick()
        expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
          'included-success',
        )
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        release()
        jest.useRealTimers()
      }
    },
  )

  it('shares one lookup budget across probe and observation instead of resetting it for each RPC', async () => {
    const state = chain([])
    const c = await composed(state, [121000n])
    const r = reobserver(c, { reobservationLookupTimeoutMs: 100 })
    const row = await broadcastLegacy(c, state, 100000n)
    state.mine(row.members[0]!.signed!.rawTransaction)
    const recorded = journal.list()
    const receipt =
      state.provider.getTransactionReceipt.getMockImplementation()!
    const transaction = state.provider.getTransaction.getMockImplementation()!
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    try {
      state.provider.getTransactionReceipt.mockImplementationOnce(
        async hash => {
          await new Promise(resolve => setTimeout(resolve, 60))
          return receipt(hash)
        },
      )
      state.provider.getTransaction.mockImplementationOnce(async hash => {
        await new Promise(resolve => setTimeout(resolve, 60))
        return transaction(hash)
      })
      let returned = false
      const tick = r.tick().then(() => {
        returned = true
      })
      await jest.advanceTimersByTimeAsync(60)
      expect(state.provider.getTransaction).toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(39)
      expect(returned).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      await tick
      expect(returned).toBe(true)
      const before = providerCalls(state)
      await jest.advanceTimersByTimeAsync(20)
      expect(providerCalls(state)).toBe(before)
      expect(journal.list()).toEqual(recorded)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(['deadline', 'close'] as const)(
    'uses the default 30 s operational budget and cleans the timer on %s',
    async end => {
      const state = chain([])
      const c = await composed(state, [121000n])
      const r = reobserver(c)
      await broadcastLegacy(c, state, 100000n)
      let answer!: (receipt: null) => void
      state.provider.getTransactionReceipt.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            answer = resolve
          }),
      )
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      try {
        let returned = false
        const tick = r.tick().then(() => {
          returned = true
        })
        await jest.advanceTimersByTimeAsync(29_999)
        expect(returned).toBe(false)
        if (end === 'close') await r.executor.stopReobservation()
        else await jest.advanceTimersByTimeAsync(1)
        await tick
        expect(jest.getTimerCount()).toBe(0)
        const recorded = journal.list()
        answer(null)
        await settle()
        expect(journal.list()).toEqual(recorded)
      } finally {
        jest.useRealTimers()
      }
    },
  )

  it.each(['complete', 'superseded', 'closed'] as const)(
    'an admitted durable inclusion completing after timeout preserves capture ordering (%s)',
    async mode => {
      const close = mode === 'closed'
      const state = chain([])
      const c = await composed(state, [121000n])
      const r = reobserver(c, { reobservationLookupTimeoutMs: 100 })
      const row = await broadcastLegacy(c, state, 100000n)
      state.mine(row.members[0]!.signed!.rawTransaction)
      const observed = jest.spyOn(journal, 'recordObservation')
      // The journal commits a mutation's row and manifest in one batch.
      const put = durability.durableBatch
      let release!: () => void
      let entered!: () => void
      const admitted = new Promise<void>(resolve => {
        entered = resolve
      })
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const write = jest
        .spyOn(durability, 'durableBatch')
        .mockImplementationOnce(async (...args) => {
          entered()
          await held
          return put(...args)
        })
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      try {
        const tick = r.tick()
        await admitted
        await jest.advanceTimersByTimeAsync(100)
        await tick
        expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
          'pending',
        )
        // A newer capture does not cancel already admitted durability. Its own queued write
        // wins afterwards, and the old completion must not invent a different final result.
        const newer =
          mode === 'superseded'
            ? journal.recordObservation(
                journal.beginCapture(row.operationId, 0),
                { state: 'pending' },
                null,
              )
            : Promise.resolve()
        if (close) await r.executor.stopReobservation()
        release()
        await observed.mock.results[0]!.value
        await newer
        await settle()
        await settle()
        expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
          mode === 'superseded' ? 'pending' : 'included-success',
        )
        const before = providerCalls(state)
        r.advance(600_000)
        await r.tick()
        if (close) {
          expect(c.pool.getRecord(0)!.status).not.toBe('spent')
        } else {
          expect(
            journal.get(row.operationId).members[0]!.observation.state,
          ).toBe('included-success')
          if (mode === 'complete') expect(providerCalls(state)).toBe(before)
        }
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        release()
        write.mockRestore()
        jest.useRealTimers()
      }
    },
  )

  it('timeout and late rejection survive Level reopen without losing the exact signed original or its reservation', async () => {
    const state = chain([])
    const c = await composed(state, [121000n])
    const r = reobserver(c, { reobservationLookupTimeoutMs: 100 })
    const row = await broadcastLegacy(c, state, 100000n)
    const recorded = journal.list()
    let reject!: (error: Error) => void
    state.provider.getTransactionReceipt.mockImplementationOnce(
      () =>
        new Promise((_resolve, failure) => {
          reject = failure
        }),
    )
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    try {
      const tick = r.tick()
      await settle()
      await jest.advanceTimersByTimeAsync(100)
      await tick
      await r.executor.stopReobservation()
      expect(jest.getTimerCount()).toBe(0)
      await reopen()
      reject(new Error('late provider rejection'))
      await settle()
      expect(journal.list()).toEqual(recorded)
      expect(journal.canSelect(row.members[0]!.source.address, 0)).toBe(false)
      expect(state.provider.broadcastTransaction).toHaveBeenCalledTimes(1)
      expect(c.sign).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('stopped mid-pass, as wallet close does: the pass returns without the node answering, an answer that arrives afterwards records nothing (during the probe and during the observation), later ticks do nothing, and nothing rejects unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      for (const during of ['probe', 'observation', 'probe rejects'] as const) {
        const state = chain([])
        const c = await composed(state, [121000n])
        const r = reobserver(c)
        const row = await broadcastLegacy(c, state, 100000n)
        const raw = row.members[0]!.signed!.rawTransaction
        state.mine(raw)
        let answer!: () => void
        const held = new Promise<void>(resolve => {
          answer = resolve
        })
        const receipt =
          state.provider.getTransactionReceipt.getMockImplementation()!
        const transaction =
          state.provider.getTransaction.getMockImplementation()!
        if (during === 'observation')
          state.provider.getTransaction.mockImplementationOnce(async hash => {
            await held
            return transaction(hash)
          })
        else
          state.provider.getTransactionReceipt.mockImplementationOnce(
            async hash => {
              await held
              if (during === 'probe rejects')
                throw new Error('fixture: provider destroyed')
              return receipt(hash)
            },
          )
        const record = jest.spyOn(journal, 'recordObservation')
        const tick = r.tick()
        await settle()
        const recorded = journal.list()
        await r.executor.stopReobservation()
        await tick
        answer()
        await settle()
        await settle()
        // The journal was not asked to record anything, so nothing can still be on its way.
        expect(record).not.toHaveBeenCalled()
        expect(journal.list()).toEqual(recorded)
        expect(journal.list()[0]!.members[0]!.observation.state).toBe('pending')
        expect(c.pool.getRecord(0)!.status).not.toBe('spent')
        const before = providerCalls(state)
        r.advance(3600 * SECOND)
        await r.tick()
        expect(providerCalls(state)).toBe(before)
        expect(journal.list()).toEqual(recorded)
        // This fixture's journal and pool store are per test: release them for the next round.
        await stores.pop()!.Close()
        await reset()
      }
      await settle()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })


  it('a look that observes the same member while a re-observation is mid-observation: the later observer records, the earlier one is discarded, and no pool row is written', async () => {
    const state = chain([])
    const c = await composed(state, [121000n, 50000n])
    const r = reobserver(c)
    const row = await broadcastLegacy(c, state, 100000n, r.executor)
    const raw = row.members[0]!.signed!.rawTransaction
    state.mine(raw)
    let answer!: () => void
    const held = new Promise<void>(resolve => {
      answer = resolve
    })
    const transaction = state.provider.getTransaction.getMockImplementation()!
    state.provider.getTransaction.mockImplementationOnce(async hash => {
      await held
      return transaction(hash)
    })
    const putMany = jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
    const record = jest.spyOn(journal, 'recordObservation')
    const tick = r.tick()
    await settle()
    // A look at the operation observes the member included.
    await r.executor.lookAtOperation(row.operationId)
    expect(journal.list()[0]!.members[0]!.observation.state).toBe(
      'included-success',
    )
    const recorded = journal.list()
    answer()
    await tick
    // The re-observation's own result was discarded by the journal's capture rule.
    expect(await record.mock.results.slice(-1)[0]!.value).toBe(false)
    expect(journal.list()).toEqual(recorded)
    expect(putMany).not.toHaveBeenCalled()
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })

  it("while a send is on the executor queue a landed member is probed but not observed, so the send's own observations are never discarded; the next pass records it", async () => {
    const state = chain([])
    const c = await composed(state, [121000n, 50000n])
    const r = reobserver(c)
    const row = await broadcastLegacy(c, state, 100000n, r.executor)
    const raw = row.members[0]!.signed!.rawTransaction
    // An unanswered member already has a 60 s backoff. Skipping a landed member for a queued
    // send must not increase that wait or move its starting time.
    for (const wait of [15, 30, 60]) {
      await r.tick()
      r.advance(wait * SECOND)
    }
    // A contract call on the executor queue that has read its account and now waits for a
    // fee quote.
    let quote!: () => void
    const held = new Promise<void>(resolve => {
      quote = resolve
    })
    let asked!: () => void
    const waiting = new Promise<void>(resolve => {
      asked = resolve
    })
    const fees = state.provider.getFeeData.getMockImplementation()!
    state.provider.getFeeData.mockImplementationOnce(async () => {
      asked()
      await held
      return fees()
    })
    const sending = call(c, r.executor)
    await waiting
    state.mine(raw)
    const capture = jest.spyOn(journal, 'beginCapture')
    const before = providerCalls(state)
    await r.tick()
    // The one probe, which found the receipt, and nothing after it.
    expect(providerCalls(state) - before).toBe(1)
    expect(probed(state).slice(-1)).toEqual([hashOf(row)])
    expect(capture).not.toHaveBeenCalled()
    expect(journal.list()[0]!.members[0]!.observation.state).toBe('pending')
    quote()
    await sending
    expect(journal.list()[0]!.members[0]!.observation.state).toBe('pending')
    // Not counted as an empty probe: due again as soon as the floor allows.
    r.advance(15 * SECOND)
    await r.tick()
    expect(journal.list()[0]!.members[0]!.observation.state).toBe(
      'included-success',
    )
  })

  // Review of 09d2624a. There the pass checked the member before the probe only, so after a
  // slow probe it observed a member a send had recorded included meanwhile, and one failed read
  // wrote `unknown` over `included-success` and cleared `syncApplied`. Fails on 09d2624a.
  it('a look records the member included and it is transported while the probe is unanswered: when the probe then returns a receipt the pass does not observe it, so a failing read cannot overwrite the record or clear syncApplied', async () => {
    const state = chain([])
    const c = await composed(state, [121000n, 50000n])
    const r = reobserver(c)
    const row = await broadcastLegacy(c, state, 100000n, r.executor)
    const raw = row.members[0]!.signed!.rawTransaction
    const landed = state.provider.getTransactionReceipt.getMockImplementation()!
    let answer!: () => void
    const held = new Promise<void>(resolve => {
      answer = resolve
    })
    state.provider.getTransactionReceipt.mockImplementationOnce(async hash => {
      await held
      return landed(hash)
    })
    const tick = r.tick()
    await settle()
    expect(probed(state).slice(-1)).toEqual([hashOf(row)])
    // Meanwhile: the transaction lands, a look observes it, the item is transported, and a
    // payment from the other account is broadcast (and mined, unobserved).
    state.mine(raw)
    await r.executor.lookAtOperation(row.operationId)
    await cpay(c, { index: 1, executor: r.executor, look: false })
    await r.executor.flushSync(row.operationId)
    const recorded = journal.list()
    expect(recorded[0]!.members[0]).toMatchObject({
      observation: { state: 'included-success' },
      syncApplied: true,
    })
    const rowRecord = c.pool.getRecord(0)
    // The next transaction read fails, once: what an observation begun now would hit.
    state.provider.getTransaction.mockRejectedValueOnce(
      new Error('fixture: one flaky read'),
    )
    const observe = jest.spyOn(r.executor, 'observe')
    const capture = jest.spyOn(journal, 'beginCapture')
    const before = providerCalls(state)
    answer()
    await tick
    expect(observe).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(providerCalls(state)).toBe(before)
    expect(journal.list()).toEqual(recorded)
    expect(c.pool.getRecord(0)).toEqual(rowRecord)
    // It is terminal: never looked up again. (The payment above left its own member
    // unconfirmed; that one is looked up, and it is the one that meets the failing read.)
    const seen = probed(state).length
    r.advance(3600 * SECOND)
    await r.tick()
    expect(probed(state).slice(seen)).not.toContain(hashOf(row))
    expect(observe.mock.calls.map(([id]) => id)).toEqual([
      recorded[1]!.operationId,
    ])
    expect(journal.list()[0]).toEqual(recorded[0])
    expect(c.pool.getRecord(0)).toEqual(rowRecord)
  })


  it('an unreadable journal or a wallet lifetime that has ended: no request, nothing thrown', async () => {
    const state = chain([])
    const c = await composed(state, [100000n])
    await broadcastNative(c, state)
    const before = providerCalls(state)
    const unreadable = reobserver(c)
    jest.spyOn(journal, 'list').mockImplementationOnce(() => {
      throw new Error('fixture: journal unreadable')
    })
    await expect(unreadable.tick()).resolves.toBeUndefined()
    const ended = reobserver(c, {
      runLifetime: async () => {
        throw new Error('Monad wallet bundle is closing or closed')
      },
    })
    await expect(ended.tick()).resolves.toBeUndefined()
    expect(providerCalls(state)).toBe(before)
  })

  // ---------------------------------------------------------------------------------------
  // A transfer handed to the network is looked at again until the chain shows it.
  // ---------------------------------------------------------------------------------------
  /** As a node holds a transaction it has not mined: known by its hash, in no block. */
  const inMempool = (state: ReturnType<typeof chain>, raw: string) => {
    const tx = Transaction.from(raw)
    state.transactions.set(
      tx.hash!,
      Object.assign(tx, {
        blockHash: null,
        blockNumber: null,
        index: 0,
      }) as never,
    )
  }
  it('after the payment was handed over and the wallet was reopened: one look at the operation records the mined transfer; a transfer the node does not know is "missing", never "unknown", and is offered again on the second such look', async () => {
    const state = chain([200000n])
    state.setMode('retained')
    const first = owner(state)
    await pay(first.executor, { value: 100000n })
    const id = journal.list()[0]!.operationId
    const raw = journal.list()[0]!.members[0]!.signed!.rawTransaction
    // The node answers and has never heard of it.
    expect(summarizeEvmNativeOperation(journal.get(id)).payment).toBe('missing')
    await reopen()
    const second = owner(state, { sources: [] })
    await second.executor.lookAtOperation(id)
    expect(summarizeEvmNativeOperation(journal.get(id)).payment).toBe('missing')
    expect(state.raws).toEqual([raw])
    // Missing twice running: the same bytes go back to the node. Never a new transaction.
    await second.executor.lookAtOperation(id)
    expect(state.raws).toEqual([raw, raw])
    expect(second.sign).not.toHaveBeenCalled()
    inMempool(state, raw)
    await second.executor.lookAtOperation(id)
    expect(summarizeEvmNativeOperation(journal.get(id)).payment).toBe('pending')
    state.mine(raw)
    await second.executor.lookAtOperation(id)
    expect(summarizeEvmNativeOperation(journal.get(id))).toMatchObject({
      payment: 'included',
      observedFeeWei: '21000',
      members: [{ state: 'included-success', blockNumber: 1 }],
    })
    // Final: further looks ask the node nothing.
    const asked = state.provider.getTransactionReceipt.mock.calls.length
    await second.executor.lookAtOperation(id)
    expect(state.provider.getTransactionReceipt.mock.calls.length).toBe(asked)
    // A reverted transfer is a state the chain shows too.
    expect(state.balances.get(recipient)).toBe(100000n)
  })
  it('a transfer mined between two reads of one look (read unmined by its hash, mined by its receipt) is recorded mined, not "unknown"', async () => {
    const state = chain([200000n])
    state.setMode('retained')
    const { executor } = owner(state)
    await pay(executor, { value: 100000n })
    const row = journal.list()[0]!
    const raw = row.members[0]!.signed!.rawTransaction
    state.mine(raw)
    const mined = state.transactions.get(Transaction.from(raw).hash!)!
    // The read by hash was answered before the block; the receipt after it.
    state.provider.getTransaction.mockImplementationOnce(
      async () =>
        Object.assign(Transaction.from(raw), {
          blockHash: null,
          blockNumber: null,
          index: 0,
        }) as never,
    )
    await executor.observe(row.operationId, 0)
    expect(mined.blockNumber).toBe(1)
    expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
      'included-success',
    )
  })

  // Rule: Monad charges the gas LIMIT, and a transfer to an address with code needs more than
  // 21,000 (measured: 49,413 for a small contract; sent with 21,000 it was mined, reverted, and
  // charged in full). The recipient of a native send is whatever the user typed.
  it("a transfer to the address the user entered carries the node's gas estimate for that address", async () => {
    const state = chain([200000n])
    state.provider.estimateGas.mockImplementation(async () => 49413n)
    const { executor } = owner(state)
    await pay(executor, { value: 40000n })
    const [toRecipient] = journal
      .list()[0]!
      .members.map(member => Transaction.from(member.unsignedTransaction))
    expect(toRecipient!.to!.toLowerCase()).toBe(recipient)
    expect(toRecipient!.gasLimit).toBe(49413n)
    expect(toRecipient!.type).toBe(2)
    expect(state.provider.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ to: recipient, value: 40000n }),
    )
  })
  it('a recipient that refuses the transfer (the estimate fails) is not sent to: nothing is planned or signed', async () => {
    const state = chain([200000n])
    state.provider.estimateGas.mockRejectedValue(
      new Error('execution reverted'),
    )
    const { executor, sign } = owner(state)
    await expect(pay(executor, { value: 100000n })).rejects.toThrow(
      'execution reverted',
    )
    expect(sign).not.toHaveBeenCalled()
    expect(journal.list()).toHaveLength(0)
    expect(state.raws).toHaveLength(0)
  })

  // Seen in Chrome on Monad testnet: a send that needed more than one account never completed.
  // The transfer funding the paying account was mined; the payment out of it, offered to the
  // node at once, was refused (the node admits a transaction against the balance of a few
  // blocks ago) and was never sent: "unknown to the node" eight minutes later.
  it('a payment out of an account that was just funded is handed to the network only once that funding is old enough for the node to count it', async () => {
    const state = chain([200000n])
    let head = 10
    // The paying account was funded at block 10; before that it held 80,000.
    const fundedAt = 10
    const payer = wallets[0]!.address.toLowerCase()
    const offeredAt: number[] = []
    const provider = state.provider as unknown as Record<string, unknown>
    provider.getBlockNumber = jest.fn(async () => head)
    state.provider.getBlock.mockImplementation((async () => ({
      hash: '0x' + 'ab'.repeat(32),
      number: head,
    })) as never)
    const latest = state.provider.getBalance.getMockImplementation()!
    state.provider.getBalance.mockImplementation((async (
      address: string,
      block?: number,
    ) =>
      block !== undefined && block < fundedAt && address.toLowerCase() === payer
        ? 80000n
        : latest(address)) as never)
    const broadcast =
      state.provider.broadcastTransaction.getMockImplementation()!
    state.provider.broadcastTransaction.mockImplementation(
      async (raw: string) => {
        offeredAt.push(head)
        return broadcast(raw)
      },
    )
    const nextLook = jest.fn(async () => void head++)
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: state.provider as unknown as Provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      mainSource: sources()[0]!,
      ownedSource: address =>
        sources().find(source => source.address === address.toLowerCase()),
      sign: async (source, raw) =>
        wallets
          .find(w => w.address.toLowerCase() === source.address)!
          .signTransaction(Transaction.from(raw)),
      nextLook,
      fundsSettleBlocks: 4,
    })
    await pay(executor, { value: 100000n })
    // It waited until block fundedAt + 4.
    expect(offeredAt).toEqual([14])
    expect(state.balances.get(recipient)).toBe(100000n)
    expect(state.raws).toHaveLength(1)
  })

  // A node whose finalized block stopped moving (seen on solonet), or money that is still not
  // shown settled after the last look: handing the signed transfer over would only get those
  // bytes refused, and the node keeps refusing them for 15 minutes.
  for (const [name, node] of [
    ["the node stops reporting final blocks", "frozen"],
    ["the money is not shown settled after the last look", "unsettled"],
  ] as const)
    it(`a transfer whose funds the node cannot show settled is kept signed and not handed over: ${name}`, async () => {
      const state = chain([200000n]);
      let head = 10;
      const payer = wallets[0]!.address.toLowerCase();
      // 'unsettled': the money always arrived in the last three blocks.
      let fundedAt = () => (node === "unsettled" ? head - 3 : 10);
      let finalized = () => (node === "frozen" ? 10 : head);
      const provider = state.provider as unknown as Record<string, unknown>;
      let ahead = node === "frozen" ? 100 : 0;
      provider.getBlockNumber = jest.fn(async () => head + ahead);
      state.provider.getBlock.mockImplementation((async (tag: unknown) => ({
        hash: "0x" + "ab".repeat(32),
        number: tag === "finalized" ? finalized() : head,
      })) as never);
      const latest = state.provider.getBalance.getMockImplementation()!;
      state.provider.getBalance.mockImplementation((async (
        address: string,
        block?: number
      ) =>
        block !== undefined &&
        block < fundedAt() &&
        address.toLowerCase() === payer
          ? 80000n
          : latest(address)) as never);
      const executor = new EvmLegacyConsolidator({
        journal,
        provider: state.provider as unknown as Provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        mainSource: sources()[0]!,
        ownedSource: (address) =>
          sources().find((source) => source.address === address.toLowerCase()),
        sign: async (source, raw) =>
          wallets
            .find((w) => w.address.toLowerCase() === source.address)!
            .signTransaction(Transaction.from(raw)),
        nextLook: async () => void head++,
        fundsSettleBlocks: 4,
        spendRuleHead: "finalized",
      });
      const refused = await pay(executor, { value: 100000n }).catch(
        (error) => error
      );
      expect(refused).toBeInstanceOf(EvmNativeOperationPendingError);
      expect(state.provider.broadcastTransaction).not.toHaveBeenCalled();
      const row = journal.list().find((r) => !r.cancelled)!;
      expect(row.members[0]!.signed).toBeDefined();
      expect(row.members[0]!.exposed).toBeFalsy();
      // Once the node can show it, the same signed bytes go out.
      fundedAt = () => 10;
      finalized = () => head;
      ahead = 0;
      const done = await executor.resumeOperation(row.operationId);
      expect(state.raws).toEqual([row.members[0]!.signed!.rawTransaction]);
      expect(done.members[0]!.signed!.transactionHash).toBe(
        row.members[0]!.signed!.transactionHash
      );
    });

  // Seen on a local Monad chain: a send failed "Native account block changed" before it
  // signed anything. Monad's newest block is only proposed and is often
  // replaced a moment later.
  it('the newest block being replaced between two reads is read again, not an error; a chain that never settles still ends in the error', async () => {
    const state = chain([200000n])
    const { executor } = owner(state)
    const settled = { hash: '0x' + 'ab'.repeat(32), number: 1 }
    const replaced = { hash: '0x' + 'cd'.repeat(32), number: 1 }
    // The first look at "latest" sees a block that is gone when it is read again by number.
    state.provider.getBlock
      .mockResolvedValueOnce(replaced as never)
      .mockResolvedValue(settled as never)
    await pay(executor, { value: 100000n })
    expect(state.balances.get(recipient)).toBe(100000n)
    expect(state.raws).toHaveLength(1)
    // Never the same block twice: the read gives up, having signed nothing more.
    let n = 0
    state.provider.getBlock.mockImplementation((async () => ({
      hash: '0x' + (n++).toString(16).padStart(64, '0'),
      number: 1,
    })) as never)
    await expect(pay(executor, { source: 1 })).rejects.toThrow(
      'Native account block changed',
    )
    expect(state.raws).toHaveLength(1)
  })




  // ---------------------------------------------------------------------------------------
  // The transport gate. A contract call or token payment has no local record to wait for: once
  // included it is transported. A transaction set is transported only after its own inventory
  // projection has applied the member.
  // ---------------------------------------------------------------------------------------
  it('a contract call is transported once it is included, with no local callback, and only once', async () => {
    const state = chain([200000n])
    const current = owner(state)
    const result = await current.executor.sendContractCall({
      to: { raw: recipient },
      data: '0x12345678',
      value: 0n,
      gasLimit: 21000n,
    })
    // Handed to the network, not yet seen in a block: nothing to transport.
    await current.executor.flushSync(result.operationId)
    expect(current.sync).not.toHaveBeenCalled()
    await current.executor.lookAtOperation(result.operationId)
    expect(
      journal.get(result.operationId).members[0]!.observation.state,
    ).toBe('included-success')
    await current.executor.flushSync(result.operationId)
    await current.executor.flushSync()
    expect(current.sync).toHaveBeenCalledTimes(1)
    expect((current.sync.mock.calls[0] as unknown[])[0]).toMatchObject({
      type: 'wallet-sync',
      direction: 'out',
      chainIdentifier: binding.chainIdentifier,
      txHash: result.txHash,
      // No preparation identity: the operation is named by its first transaction, which no
      // other device's operation shares (the journal's own ID is this device's sequence).
      operation: {
        id: `tx-${journal.get(result.operationId).members[0]!.signed!.transactionHash.toLowerCase()}`,
      },
    })
    expect(journal.get(result.operationId).members[0]!.syncApplied).toBe(true)
  })

  it('a transaction set is not transported until its inventory projection has applied each included member; then each is transported once', async () => {
    const state = chain([1000000n])
    const current = owner(state)
    const coins = await EvmCoinList.open(new MemoryRecordStore())
    const source = wallets[0]!
    await coins.put({
      account: source.address,
      privateKey: source.privateKey,
      nonce: 0,
      valueWei: 1000000n,
      origin: 'root',
    })
    const change = HDNodeWallet.fromSeed('0x' + '03'.repeat(32))
    const deriveChange = (index: number) => {
      const key = change.deriveChild(index)
      return { account: key.address, privateKey: key.privateKey, changeIndex: index }
    }
    const preparer = new EvmTransactionSetPreparer({
      coins,
      journal,
      random: () => 0.5,
      deriveChange,
      reserveChange: async (_operation, index) => deriveChange(index),
      policy: () => ({
        sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
        gasPriceWei: 1n,
        paymentGasLimit: () => 21000n,
        changeGasLimit: 21000n,
        paymentFeeIsExact: true,
        dustWei: 1000n,
        radix: 2,
        jitterBps: 1500,
        maxChangeOutputs: 4,
        head: 1,
      }),
    })
    await preparer.constructTransactionSet({
      operationId: 'gate',
      amountWei: 100000n,
      kdf: () => recipient,
    })
    const set = journal.list().find(row => row.kind === 'transaction-set')!
    await journal.authorizeTransactionSet(set.operationId)
    for (let i = 0; i < set.members.length; i++) {
      // A member that spends a change output of this same set is mined after its parent.
      state.balances.set(
        Transaction.from(set.members[i]!.signed!.rawTransaction).from!.toLowerCase(),
        10n ** 18n,
      )
      await journal.markExposed(set.operationId, i)
      state.mine(set.members[i]!.signed!.rawTransaction)
      await current.executor.observe(set.operationId, i)
    }
    expect(
      journal
        .get(set.operationId)
        .members.every(m => m.observation.state === 'included-success'),
    ).toBe(true)
    // Included, but not yet applied to the coin list: held, and the error names the set.
    await expect(current.executor.flushSync(set.operationId)).rejects.toMatchObject({
      operation: { operationId: set.operationId },
    })
    expect(current.sync).not.toHaveBeenCalled()
    for (let i = 0; i < set.members.length; i++)
      await journal.markTransactionSetInventoryApplied(set.operationId, i)
    await current.executor.flushSync(set.operationId)
    await current.executor.flushSync(set.operationId)
    expect(current.sync).toHaveBeenCalledTimes(set.members.length)
    // Every member's note names the set by its preparation identity: the account's other
    // devices show its transactions as the one send they are, named as this device names it.
    for (const call of current.sync.mock.calls as unknown[][])
      expect(call[0]).toMatchObject({
        operation: { id: 'evm-transaction-set:gate' },
      })
    expect(
      journal.get(set.operationId).members.every(m => m.syncApplied),
    ).toBe(true)
  })
})
