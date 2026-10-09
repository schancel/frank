import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  Interface,
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
  Tip20TransactionBuilder,
  type EvmTransactionBuilder,
} from './evm-transaction-builder'
import {
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'
import {
  canonicalAdmissionPool,
  createEvmInputAdmission,
  EvmInputAdmissionError,
  nativeJournalReader,
  poolSpendAdmission,
  type WalletOperationLifetime,
} from '../evm-input-admission'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { MonadChangePool } from '../monad-change-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { LevelSubAccountPoolStore } from '../storage/level-sub-account-pool-store'
import { InMemoryChangePoolStore } from '../storage/change-pool-storage'
import { InMemoryTopicOperationJournal } from '../storage/topic-operation-journal'
import { validateMonadWalletState } from '../storage/monad-wallet-state-validator'

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
      /** This fixture has no pool. `true` says so the way composition would have to: a local
       * callback that reports every member as having no pool row. Without it the executor has
       * no local result for any member and transports nothing (the fail-closed default). */
      noPoolRows?: boolean
    } = {},
  ) {
    const sign = jest.fn(async (source: EvmNativeSource, raw: string) => {
      const wallet = wallets.find(
        w => w.address.toLowerCase() === source.address,
      )!
      return wallet.signTransaction(Transaction.from(raw))
    })
    const sync = jest.fn(async () => undefined)
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: state.provider as unknown as Provider,
      transactionBuilder: options.builder ?? new NativeEvmTransactionBuilder(),
      getSources: async () => options.sources ?? sources(),
      sign,
      ...(options.noPoolRows
        ? { applyLocalMember: async () => ({ kind: 'no-pool-row' as const }) }
        : {}),
      onSyncTransaction: sync,
    })
    return { executor, sign, sync }
  }
  async function reopen() {
    await journal.Close()
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  it('does not expose a direct payment before its recovery checkpoint and callback', async () => {
    const state = chain([200000n])
    const { executor } = owner(state)
    await expect(
      executor.sendLegacy({
        recipient: { raw: recipient },
        value: 100000n,
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
    await reopen()
    expect(journal.list()[0]!.members[0]!.signed).not.toBeNull()
  })
  it('replays direct lost-response bytes after Level reopen without a fresh payment', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const first = owner(state)
    await expect(
      first.executor.sendLegacy({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const original = journal.list()[0]!
    expect(original.members[0]!.exposed).toBe(true)
    await reopen()
    // #1235 Stage C changed this fixture on purpose. It used to configure neither local callback
    // and still expect `sync` to be called once: with no callback the executor recorded every
    // included member as locally applied, so transport ran, and the member was marked
    // sync-applied, with nothing having been recorded anywhere. That default now fails closed
    // (see "with neither local callback configured" below), so the fixture states what it
    // means: this executor's members have no pool row.
    const second = owner(state, { sources: [], noPoolRows: true })
    state.setMode('mine')
    const result = await second.executor.resumeLegacySend(original.operationId)
    await second.executor.resumeLegacySend(original.operationId)
    await second.executor.flushSync()
    await second.executor.flushSync()
    expect(result.totalValueSent).toBe(100000n)
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
  it('retains partial fan-in and finishes the exact original drain once after restart', async () => {
    const state = chain([80000n, 70000n])
    state.setMode('lost')
    await expect(
      owner(state).executor.sendLegacy({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const row = journal.list()[0]!
    expect(row.members).toHaveLength(2)
    expect(row.members.every(m => m.signed !== null)).toBe(true)
    state.mine(row.members[0]!.signed!.rawTransaction)
    await reopen()
    state.provider.getFeeData.mockResolvedValue({
      maxFeePerGas: 999n,
      maxPriorityFeePerGas: 999n,
      gasPrice: 999n,
    })
    state.setMode('mine')
    const recovered = owner(state, { sources: [] })
    const result = await recovered.executor.resumeLegacySend(row.operationId)
    await recovered.executor.resumeLegacySend(row.operationId)
    expect(result.totalValueSent).toBe(100000n)
    expect(state.raws).toEqual([
      row.members[0]!.signed!.rawTransaction,
      row.members[1]!.signed!.rawTransaction,
    ])
    expect(recovered.sign).not.toHaveBeenCalled()
    expect(state.balances.get(recipient)).toBe(100000n)
  })
  it.each(['missing', 'mismatched'] as const)(
    'holds provisional leader funds across foreign nonce advance with %s drain',
    async kind => {
      const state = chain([80000n, 70000n])
      state.setMode('lost')
      await expect(
        owner(state).executor.sendLegacy({
          recipient: { raw: recipient },
          value: 100000n,
        }),
      ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
      const row = journal.list()[0]!
      state.mine(row.members[0]!.signed!.rawTransaction)
      const leader = row.members[1]!.source.address
      state.nonces.set(leader, 1)
      if (kind === 'mismatched')
        state.receipts.set(row.members[1]!.signed!.transactionHash, {
          hash: '0x' + '00'.repeat(32),
          status: 1,
        })
      await reopen()
      const recovered = owner(state)
      await expect(
        recovered.executor.sendNative({
          recipient: { raw: recipient },
          value: 1000n,
        }),
      ).rejects.toThrow('Insufficient')
      expect(recovered.sign).not.toHaveBeenCalled()
      state.balances.set(wallets[2]!.address.toLowerCase(), 100000n)
      state.setMode('mine')
      await recovered.executor.sendNative({
        recipient: { raw: recipient },
        value: 1000n,
      })
      expect(
        recovered.sign.mock.calls.every(
          ([source]) => source.address === wallets[2]!.address.toLowerCase(),
        ),
      ).toBe(true)
    },
  )
  it('permits observed residual at next nonce but never reuses the retained old pair', async () => {
    const state = chain([300000n])
    const current = owner(state)
    await current.executor.sendLegacy({
      recipient: { raw: recipient },
      value: 100000n,
    })
    await current.executor.sendLegacy({
      recipient: { raw: recipient },
      value: 50000n,
    })
    expect(state.raws.map(raw => Transaction.from(raw).nonce)).toEqual([0, 1])
    expect(state.balances.get(wallets[0]!.address.toLowerCase())).toBe(108000n)
    state.nonces.set(wallets[0]!.address.toLowerCase(), 0)
    await expect(
      current.executor.sendLegacy({
        recipient: { raw: recipient },
        value: 1000n,
      }),
    ).rejects.toThrow('Insufficient')
    expect(journal.list()).toHaveLength(2)
  })
  it('keeps disjoint operations while serializing conflicting selection', async () => {
    const state = chain([200000n, 200000n])
    state.setMode('lost')
    const current = owner(state)
    await Promise.allSettled(
      [1, 2].map(() =>
        current.executor.sendNative({
          recipient: { raw: recipient },
          value: 100000n,
        }),
      ),
    )
    expect(journal.list()).toHaveLength(2)
    expect(
      new Set(journal.list().map(r => r.members[0]!.source.address)).size,
    ).toBe(2)
    await reopen()
    expect(journal.list()).toHaveLength(2)
  })
  it('freezes calldata builder semantics and rejects unsupported consolidation before signing', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const builder = new NativeEvmTransactionBuilder()
    Object.defineProperty(builder, 'supportsNativeConsolidation', {
      value: false,
    })
    const destination = wallets[2]!.address
    jest.spyOn(builder, 'buildTransfer').mockImplementation(async params => ({
      to: destination,
      data: '0x12345678',
      value: 0n,
      nonce: params.overrides!.nonce,
      gasLimit: 21000n,
    }))
    const current = owner(state, { builder })
    await expect(
      current.executor.sendLegacy({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).rejects.toThrow('does not support')
    expect(current.sign).not.toHaveBeenCalled()
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    const row = journal.list()[0]!
    const tx = Transaction.from(row.members[0]!.signed!.rawTransaction)
    expect(tx.to).toBe(destination)
    expect(tx.value).toBe(0n)
    expect(tx.data).toBe('0x12345678')
    expect(row.recipient).toBe(recipient)
    expect(row.intendedValueWei).toBe('100000')
    await reopen()
    state.setMode('mine')
    const recovered = owner(state, { builder, sources: [] })
    await recovered.executor.resumeOperation(row.operationId)
    expect(recovered.sign).not.toHaveBeenCalled()
    expect(state.raws[1]).toBe(state.raws[0])
  })
  it('deduplicates concurrent resume and retains reverted evidence without releasing claims', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const current = owner(state)
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).rejects.toThrow()
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
  it('sends a TIP-20 direct payment using token fee balance with zero native balance', async () => {
    const tempoJournal = {
      location: join(location, 'tempo'),
      binding: {
        ...binding,
        chainIdentifier: 'tempo-mainnet',
        nativeChainId: '4217',
      },
    }
    await journal.Close()
    await mkdir(tempoJournal.location)
    journal = new EvmNativeOperationJournal(tempoJournal)
    await journal.Open()
    const state = chain([0n])
    state.setMode('retained')
    const iface = new Interface([
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address,uint256) returns (bool)',
    ])
    state.provider.call.mockResolvedValue(
      iface.encodeFunctionResult('balanceOf', [165000n]),
    )
    const builder = new Tip20TransactionBuilder()
    const current = owner(state, { builder, sources: [sources()[0]!] })
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 100000n,
      }),
    ).resolves.toHaveProperty('txHash')
    const row = journal.list()[0]!
    const tx = Transaction.from(row.members[0]!.signed!.rawTransaction)
    expect(tx.chainId).toBe(4217n)
    expect(tx.to!.toLowerCase()).toBe(builder.tokenAddress.toLowerCase())
    expect(tx.value).toBe(0n)
    expect(tx.data).toBe(
      iface.encodeFunctionData('transfer', [recipient, 100000n]),
    )
    expect(row.intendedValueWei).toBe('100000')
    expect(row.maximumFeeWei).toBe('65000')
    await journal.Close()
    journal = new EvmNativeOperationJournal(tempoJournal)
    await journal.Open()
    const recovered = owner(state, { builder, sources: [] })
    await recovered.executor.resumeOperation(row.operationId)
    expect(recovered.sign).not.toHaveBeenCalled()
    expect(state.raws).toEqual([
      row.members[0]!.signed!.rawTransaction,
      row.members[0]!.signed!.rawTransaction,
    ])
  })
  it.each(['native', 'token'])(
    'refuses insufficient %s fee balance before signing',
    async asset => {
      const state = chain([asset === 'native' ? 120999n : 0n])
      const iface = new Interface([
        'function balanceOf(address) view returns (uint256)',
      ])
      state.provider.call.mockResolvedValue(
        iface.encodeFunctionResult('balanceOf', [164999n]),
      )
      const current = owner(state, {
        builder:
          asset === 'native'
            ? new NativeEvmTransactionBuilder()
            : new Tip20TransactionBuilder(),
        sources: [sources()[0]!],
      })
      await expect(
        current.executor.sendNative({
          recipient: { raw: recipient },
          value: 100000n,
        }),
      ).rejects.toThrow('Insufficient')
      expect(current.sign).not.toHaveBeenCalled()
      expect(journal.list()).toEqual([])
    },
  )
  it.each(
    (['sendNative', 'sendLegacy'] as const).flatMap(method =>
      ['queue', 'fee', 'builder'].map(boundary => ({ method, boundary })),
    ),
  )(
    'snapshots $method authorization before $boundary await',
    async ({ method, boundary }) => {
      const state = chain([1000000n])
      const builder = new NativeEvmTransactionBuilder()
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
      if (boundary === 'builder') {
        const build = builder.buildTransfer.bind(builder)
        jest
          .spyOn(builder, 'buildTransfer')
          .mockImplementationOnce(async params => {
            entered()
            await wait
            return build(params)
          })
      }
      const current = owner(state, { builder })
      const params = { recipient: { raw: recipient }, value: 100000n }
      const send = current.executor[method](params)
      if (boundary !== 'queue') await started
      params.recipient.raw = wallets[2]!.address
      params.value = 150000n
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
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 1000n,
      }),
    ).rejects.toThrow('storage barrier unavailable')
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
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 1000n,
      }),
    ).rejects.toMatchObject({ code: 'capacity' })
    expect(current.sign).not.toHaveBeenCalled()
    expect(state.raws).toEqual([])
  })
  it('keeps sync failure tied to the fulfilled original operation without another payment', async () => {
    const state = chain([200000n])
    // #1235 Stage C changed this fixture on purpose. With neither local callback configured the
    // test expected `sync` to be attempted twice and the member to end sync-applied: that held
    // only because the uncomposed default recorded the member as locally applied. The default
    // now fails closed, so the fixture supplies the local result it relied on implicitly.
    const current = owner(state, { noPoolRows: true })
    await current.executor.sendLegacy({
      recipient: { raw: recipient },
      value: 1000n,
    })
    const row = journal.list()[0]!
    current.sync.mockRejectedValueOnce(new Error('sync transport unavailable'))
    await expect(
      current.executor.flushSync(row.operationId),
    ).rejects.toMatchObject({ operation: { operationId: row.operationId } })
    expect(journal.get(row.operationId).members[0]!.syncApplied).toBe(false)
    await current.executor.resumeLegacySend(row.operationId)
    await current.executor.flushSync(row.operationId)
    await current.executor.flushSync(row.operationId)
    expect(current.sync).toHaveBeenCalledTimes(2)
    expect(state.raws).toHaveLength(1)
    expect(state.balances.get(recipient)).toBe(1000n)
  })
  it('discards delayed provider responses after a newer observation completes', async () => {
    const state = chain([200000n])
    state.setMode('lost')
    const current = owner(state)
    await expect(
      current.executor.sendNative({
        recipient: { raw: recipient },
        value: 1000n,
      }),
    ).rejects.toThrow()
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
  // Stage 1 of #1235: the local pass and the transport-only flush.
  //
  // `composed` wires the executor the way composition does: a reader journal, the real input
  // admission over a real Level pool store, and the two local callbacks going straight to
  // `poolSpendAdmission`. Its pool rows are created by `ensureSize` and funded only in the
  // simulated chain; the production-funded row is exercised in `monad-domain-wallet`.
  // Unless a test says it is a pin, it fails on main 72631f36 because no pass exists there:
  // the callbacks are never called and no row is ever marked.
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
    overrides: Partial<
      Pick<
        ConstructorParameters<typeof EvmLegacyConsolidator>[0],
        'applyLocalMember' | 'classifyLocalMember'
      >
    > = {},
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
    balances.forEach((value, index) => state.balances.set(address(index), value))
    const sign = jest.fn(async (source: EvmNativeSource, raw: string) => {
      if (source.kind !== 'spend') throw new Error('fixture custody')
      return new Wallet(
        keyring.deriveSubAccount(source.index).privateKey,
      ).signTransaction(Transaction.from(raw))
    })
    const sync = jest.fn(async (_item: unknown) => undefined)
    const apply = jest.fn(
      overrides.applyLocalMember ??
        ((id: string, i: number, token?: WalletOperationLifetime) =>
          poolSpendAdmission(admission, token!).applyMember(id, i)),
    )
    const classify = jest.fn(
      overrides.classifyLocalMember ??
        ((
          row: Parameters<
            ReturnType<typeof poolSpendAdmission>['classifyMember']
          >[0],
          i: number,
          token?: WalletOperationLifetime,
        ) => poolSpendAdmission(admission, token!).classifyMember(row, i)),
    )
    const executor = () =>
      new EvmLegacyConsolidator({
        journal: nativeJournalReader(journal),
        inputAdmission: admission,
        runLifetime: operation => operation(lifetime),
        provider: state.provider as unknown as Provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        getSources: async () =>
          balances.map((_, index) => ({
            kind: 'spend' as const,
            index,
            address: address(index),
          })),
        sign,
        applyLocalMember: apply,
        classifyLocalMember: classify,
        onSyncTransaction: sync,
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
      apply,
      classify,
      address,
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
  const pending = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a pending error')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(EvmNativeOperationPendingError)
        return error as EvmNativeOperationPendingError
      },
    )

  it('in-call inclusion: the pass records the row spent with the member checkpoint inside the send, with no signature and no provider call of its own', async () => {
    const state = chain([])
    const c = await composed(state, [200000n, 0n])
    const atBodyEnd = { provider: 0, sign: 0, status: '' }
    const result = await c.executor.sendLegacy(
      {
        recipient: to,
        value: 100000n,
        onProgress: progress => {
          if (progress.status.stage !== 'confirmed') return
          // The last thing the send body does: everything after this is the pass.
          atBodyEnd.provider = providerCalls(state)
          atBodyEnd.sign = c.sign.mock.calls.length
          atBodyEnd.status = c.pool.getRecord(0)!.status
        },
      },
      c.lifetime,
    )
    const row = journal.list()[0]!
    const raw = row.members[0]!.signed!.rawTransaction
    expect(atBodyEnd.status).not.toBe('spent')
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: {
        spend: { rawTx: raw, txHash: result.txHash, valueWei: '100000' },
      },
    })
    // A non-zero fee was observed, and it is not part of the checkpoint value.
    expect(result.totalFeePaid).toBe(21000n)
    expect(c.apply).toHaveBeenCalledTimes(1)
    expect(c.apply).toHaveBeenCalledWith(row.operationId, 0, c.lifetime)
    expect(providerCalls(state)).toBe(atBodyEnd.provider)
    expect(c.sign.mock.calls.length).toBe(atBodyEnd.sign)
    expect(c.sign).toHaveBeenCalledTimes(1)
    expect(state.raws).toEqual([raw])
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    // A later pass finds it applied from the snapshot alone.
    await c.executor.resumeLegacySend(row.operationId, c.lifetime)
    expect(c.apply).toHaveBeenCalledTimes(1)
    expect(c.classify).toHaveLastReturnedWith('applied')
  })

  // Pin: what a caller of the send sees is what it saw on main.
  it('pin: the result of sendLegacy and of sendNative, and the progress events, are the same with and without the local pass', async () => {
    const plain = chain([200000n])
    const base = owner(plain)
    const stages: string[] = []
    const legacy = await base.executor.sendLegacy({
      recipient: to,
      value: 100000n,
      onProgress: p => void stages.push(p.status.stage),
    })
    const native = await base.executor.sendNative({ recipient: to, value: 1000n })
    await journal.Close()
    await rm(location, { recursive: true, force: true })
    location = await mkdtemp(join(tmpdir(), 'frank-native-owner-'))
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
    const state = chain([])
    const c = await composed(state, [200000n])
    const composedStages: string[] = []
    const composedLegacy = await c.executor.sendLegacy(
      {
        recipient: to,
        value: 100000n,
        onProgress: p => void composedStages.push(p.status.stage),
      },
      c.lifetime,
    )
    const composedNative = await c.executor.sendNative(
      { recipient: to, value: 1000n },
      c.lifetime,
    )
    expect(Object.keys(composedLegacy).sort()).toEqual(
      Object.keys(legacy).sort(),
    )
    expect({ ...composedLegacy, txHash: '' }).toEqual({ ...legacy, txHash: '' })
    expect(composedLegacy).toEqual({
      txHash: journal.list()[0]!.members[0]!.signed!.transactionHash,
      intermediateTxHashes: [],
      totalValueSent: 100000n,
      totalFeePaid: 21000n,
    })
    expect(Object.keys(composedNative)).toEqual(Object.keys(native))
    expect(composedNative).toEqual({
      txHash: journal.list()[1]!.members[0]!.signed!.transactionHash,
    })
    expect(composedStages).toEqual(stages)
    expect(stages).toEqual(['planning', 'confirmed'])
  })

  it('path 2a: a member pending in its own call is applied by a LATER send, whose result names only the later operation', async () => {
    const state = chain([])
    const c = await composed(state, [200000n, 150000n])
    state.provider.broadcastTransaction.mockImplementationOnce(async raw =>
      announce(state, raw),
    )
    const first = await pending(
      c.executor.sendLegacy({ recipient: to, value: 100000n }, c.lifetime),
    )
    const earlier = first.operation
    expect(earlier.members[0]!.observation.state).toBe('pending')
    expect(earlier.members[0]!.source).toMatchObject({ index: 0 })
    expect(c.apply).not.toHaveBeenCalled()
    expect(c.classify).not.toHaveBeenCalled()
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    // The receipt appears; nothing observes it until the next send plans.
    state.mine(earlier.members[0]!.signed!.rawTransaction)
    const later = await c.executor.sendLegacy(
      { recipient: to, value: 120000n },
      c.lifetime,
    )
    const rows = journal.list()
    expect(rows).toHaveLength(2)
    expect(rows[1]!.members[0]!.source).toMatchObject({ index: 1 })
    expect(later).toEqual({
      txHash: rows[1]!.members[0]!.signed!.transactionHash,
      intermediateTxHashes: [],
      totalValueSent: 120000n,
      totalFeePaid: 21000n,
    })
    expect(c.pool.getRecord(0)!.lifecycle!.spend!.rawTx).toBe(
      earlier.members[0]!.signed!.rawTransaction,
    )
    expect(c.pool.getRecord(1)!.lifecycle!.spend!.rawTx).toBe(
      rows[1]!.members[0]!.signed!.rawTransaction,
    )
    expect(c.pool.getRecord(0)!.status).toBe('spent')
    expect(c.pool.getRecord(1)!.status).toBe('spent')
    expect(c.apply.mock.calls.map(([id]) => id)).toEqual([
      earlier.operationId,
      rows[1]!.operationId,
    ])
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })

  it('fan-in with two pool peers and a pool leader: the pass applies all three inside the send, the leader with the drain transaction, and transport carries each complete transaction', async () => {
    const state = chain([])
    const c = await composed(state, [100000n, 50000n, 45000n])
    const result = await c.executor.sendLegacy(
      { recipient: to, value: 110000n },
      c.lifetime,
    )
    const row = journal.list()[0]!
    expect(row.members.map(m => m.source)).toMatchObject([
      { index: 1 },
      { index: 2 },
      { index: 0 },
    ])
    expect(result.intermediateTxHashes).toHaveLength(2)
    for (const member of row.members) {
      if (member.source.kind !== 'spend') throw new Error('fixture')
      expect(c.pool.getRecord(member.source.index)).toMatchObject({
        status: 'spent',
        lifecycle: { spend: { rawTx: member.signed!.rawTransaction } },
      })
    }
    const drain = Transaction.from(c.pool.getRecord(0)!.lifecycle!.spend!.rawTx)
    expect(drain.to!.toLowerCase()).toBe(recipient)
    expect(drain.value).toBe(110000n)
    expect(c.apply).toHaveBeenCalledTimes(3)
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    expect(c.sync).not.toHaveBeenCalled()
    await c.executor.flushSync(row.operationId)
    expect(c.sync.mock.calls.map(([item]) => item)).toEqual(
      row.members.map(member => {
        const tx = Transaction.from(member.signed!.rawTransaction)
        return {
          type: 'wallet-sync',
          direction: 'out',
          chainIdentifier: 'monad-testnet',
          txHash: member.signed!.transactionHash,
          rawTx: member.signed!.rawTransaction,
          // SYNC-ITEM-DEBIT, unchanged: the input is value plus the fee paid.
          spentInputs: [
            {
              address: member.source.address,
              nonce: tx.nonce,
              valueWei: (tx.value + 21000n).toString(),
            },
          ],
          createdOutputs: [{ address: tx.to, valueWei: tx.value.toString() }],
          timestamp: expect.any(Number),
        }
      }),
    )
    expect(journal.list()[0]!.members.map(m => m.syncApplied)).toEqual([
      true,
      true,
      true,
    ])
  })

  it('fan-in with the peers included and the drain pending: only the included members are applied, and only they are transported', async () => {
    const state = chain([])
    const c = await composed(state, [100000n, 50000n, 45000n])
    const mined = state.provider.broadcastTransaction.getMockImplementation()!
    let broadcasts = 0
    state.provider.broadcastTransaction.mockImplementation(async raw =>
      ++broadcasts === 3 ? announce(state, raw) : mined(raw),
    )
    const error = await pending(
      c.executor.sendLegacy({ recipient: to, value: 110000n }, c.lifetime),
    )
    const row = journal.get(error.operation.operationId)
    expect(row.members.map(m => m.observation.state)).toEqual([
      'included-success',
      'included-success',
      'pending',
    ])
    expect(c.apply.mock.calls.map(([, i]) => i)).toEqual([0, 1])
    expect(c.pool.getRecord(1)!.status).toBe('spent')
    expect(c.pool.getRecord(2)!.status).toBe('spent')
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    expect(c.pool.getRecord(0)!.lifecycle?.spend).toBeUndefined()
    await c.executor.flushSync(row.operationId)
    expect(c.sync.mock.calls.map(([item]) => (item as { rawTx: string }).rawTx)).toEqual([
      row.members[0]!.signed!.rawTransaction,
      row.members[1]!.signed!.rawTransaction,
    ])
    expect(journal.list()[0]!.members.map(m => m.syncApplied)).toEqual([
      true,
      true,
      false,
    ])
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })

  it('transport is gated per member: a held member is never sent or marked, the other members are, and the error names the operation that holds', async () => {
    const state = chain([])
    const held = new Set<string>()
    let real!: (id: string, i: number) => Promise<unknown>
    const c = await composed(state, [0n, 0n, 0n, 30000n], {
      applyLocalMember: async (id, i) => {
        if (held.has(`${id}:${i}`)) throw new Error('fixture: held')
        return real(id, i) as never
      },
    })
    real = (id, i) =>
      poolSpendAdmission(c.admission, c.lifetime).applyMember(id, i)
    // Operation A: one member, held.
    held.add('evm-native-v1:0000000000000001:0')
    await c.executor.sendLegacy({ recipient: to, value: 5000n }, c.lifetime)
    const a = journal.list()[0]!
    expect(a.members[0]!.source).toMatchObject({ index: 3 })
    // Operation B: a three-member fan-in whose member 0 is held.
    for (const [index, value] of [100000n, 50000n, 45000n].entries())
      state.balances.set(c.address(index), value)
    held.add('evm-native-v1:0000000000000002:0')
    await c.executor.sendLegacy({ recipient: to, value: 110000n }, c.lifetime)
    const b = journal.list()[1]!
    expect(b.members).toHaveLength(3)
    const marked = jest.spyOn(journal, 'markSyncApplied')
    // All operations: continues past held A, transports B's applied members, names A.
    const all = await pending(c.executor.flushSync())
    expect(all.operation.operationId).toBe(a.operationId)
    expect(c.sync.mock.calls.map(([item]) => (item as { txHash: string }).txHash)).toEqual([
      b.members[1]!.signed!.transactionHash,
      b.members[2]!.signed!.transactionHash,
    ])
    expect(marked.mock.calls.map(([id, i]) => `${id}:${i}`)).toEqual([
      `${b.operationId}:1`,
      `${b.operationId}:2`,
    ])
    // One operation: only that operation is considered and named.
    const one = await pending(c.executor.flushSync(b.operationId))
    expect(one.operation.operationId).toBe(b.operationId)
    expect(c.sync).toHaveBeenCalledTimes(2)
    expect(journal.list().map(r => r.members.map(m => m.syncApplied))).toEqual([
      [false],
      [false, true, true],
    ])
    // Once the hold clears, the next pass applies and the member is transported.
    held.clear()
    await c.executor.resumeLegacySend(b.operationId, c.lifetime)
    await c.executor.flushSync()
    expect(c.sync).toHaveBeenCalledTimes(4)
    expect(journal.list().flatMap(r => r.members.map(m => m.syncApplied))).toEqual(
      [true, true, true, true],
    )
  })

  it('a member can never be marked sync-applied without this session local record: a fresh executor transports nothing until its own pass has run', async () => {
    const state = chain([])
    const c = await composed(state, [200000n])
    await c.executor.sendLegacy({ recipient: to, value: 100000n }, c.lifetime)
    const row = journal.list()[0]!
    // A new session's executor over the same journal: included member, no pass yet.
    const fresh = c.another()
    const marked = jest.spyOn(journal, 'markSyncApplied')
    const error = await pending(fresh.flushSync())
    expect(error.operation.operationId).toBe(row.operationId)
    expect(String(error.reason)).toContain('no local spend record')
    await pending(fresh.flushSync(row.operationId))
    expect(c.sync).not.toHaveBeenCalled()
    expect(marked).not.toHaveBeenCalled()
    expect(journal.list()[0]!.members[0]!.syncApplied).toBe(false)
    await fresh.resumeLegacySend(row.operationId, c.lifetime)
    await fresh.flushSync()
    expect(c.sync).toHaveBeenCalledTimes(1)
    expect(marked).toHaveBeenCalledTimes(1)
    expect(journal.list()[0]!.members[0]!.syncApplied).toBe(true)
  })

  it.each(['the callbacks throw', 'the journal is unreadable'] as const)(
    'the pass cannot replace the outcome when %s: a successful send returns its result and a failing send throws its own error',
    async fault => {
      const state = chain([])
      let unreadable = false
      const c = await composed(
        state,
        [200000n, 150000n],
        fault === 'the callbacks throw'
          ? {
              classifyLocalMember: () => {
                throw new Error('fixture: classify failed')
              },
              applyLocalMember: () => {
                throw new Error('fixture: apply failed')
              },
            }
          : {},
      )
      const list = journal.list.bind(journal)
      const listed = jest.spyOn(journal, 'list').mockImplementation(() => {
        if (unreadable) throw new Error('fixture: journal unreadable')
        return list()
      })
      const result = await c.executor.sendLegacy(
        {
          recipient: to,
          value: 100000n,
          onProgress: progress => {
            if (
              fault === 'the journal is unreadable' &&
              progress.status.stage === 'confirmed'
            )
              unreadable = true
          },
        },
        c.lifetime,
      )
      const passReads = listed.mock.results.filter(r => r.type === 'throw')
      unreadable = false
      expect(result).toEqual({
        txHash: journal.list()[0]!.members[0]!.signed!.transactionHash,
        intermediateTxHashes: [],
        totalValueSent: 100000n,
        totalFeePaid: 21000n,
      })
      if (fault === 'the callbacks throw')
        expect(c.classify).toHaveBeenCalledTimes(1)
      else expect(passReads).toHaveLength(1)
      // A failing send: the reply to its broadcast is lost.
      state.setMode('lost')
      const broadcast = state.provider.broadcastTransaction.getMockImplementation()!
      state.provider.broadcastTransaction.mockImplementation(async raw => {
        if (fault === 'the journal is unreadable') unreadable = true
        return broadcast(raw)
      })
      const error = await pending(
        c.executor.sendLegacy({ recipient: to, value: 120000n }, c.lifetime),
      )
      unreadable = false
      expect(String(error.reason)).toContain('lost response')
      expect(error.operation.operationId).toBe(journal.list()[1]!.operationId)
      if (fault === 'the callbacks throw')
        expect(c.classify).toHaveBeenCalledTimes(2)
      expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    },
  )

  it('eligibility: a member that is pending, missing, never observed, reverted, unsigned or cancelled gets no classification and no apply', async () => {
    const state = chain([])
    const c = await composed(state, [90000n, 80000n, 70000n, 60000n, 50000n, 40000n])
    const send = (value: bigint, onSigned?: () => Promise<void>) =>
      c.executor
        .sendLegacy({ recipient: to, value, onSigned }, c.lifetime)
        .catch(() => undefined)
    state.provider.broadcastTransaction.mockImplementationOnce(async raw =>
      announce(state, raw),
    )
    await send(60000n) // row 0: pending
    state.setMode('lost')
    await send(50000n) // row 1: looked for before the broadcast, missing
    await send(40000n) // row 2: will revert
    state.mine(journal.list()[2]!.members[0]!.signed!.rawTransaction, 0)
    await c.executor
      .resumeOperation(journal.list()[2]!.operationId, c.lifetime)
      .catch(() => undefined)
    // #1235 Stage C changed how rows 3 and 4 are built, not what is asserted. A send whose
    // signing fails is now cancelled by that send, so it can no longer leave an unsigned,
    // uncancelled plan behind; that state is what a crash between the journal write and the
    // first signature leaves, written here the way the crash leaves it.
    await journal.prepare({
      kind: 'legacy',
      recipient,
      intendedValueWei: '20000',
      members: [
        {
          source: { kind: 'spend', index: 3, address: c.address(3) },
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143n,
            nonce: 0,
            to: recipient,
            value: 20000n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    }) // row 3: unsigned
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
    await send(19000n) // row 4: never signed, cancelled by its own send
    // Last, because the next send's planning would observe it: signed, never looked for.
    await send(18000n, async () => {
      throw new Error('fixture: never exposed')
    })
    const states = journal
      .list()
      .map(r =>
        r.cancelled
          ? 'cancelled'
          : r.members[0]!.signed
          ? r.members[0]!.observation.state
          : 'unsigned',
      )
    expect(states).toEqual([
      'pending',
      'missing',
      'included-revert',
      'unsigned',
      'cancelled',
      'unknown',
    ])
    // Every one of those sends ran the pass; so does one more resume.
    await c.executor
      .resumeOperation(journal.list()[0]!.operationId, c.lifetime)
      .catch(() => undefined)
    expect(c.classify).not.toHaveBeenCalled()
    expect(c.apply).not.toHaveBeenCalled()
    expect(c.pool.records().every(r => r.status !== 'spent')).toBe(true)
  })

  it('native then native from one row: the first member is held while the second is pending, applies once it is included, and the second is then held-terminal without another apply', async () => {
    const state = chain([])
    const c = await composed(state, [300000n, 50000n])
    // sendNative returns after the broadcast: neither member is observed in its own call.
    await c.executor.sendNative({ recipient: to, value: 100000n }, c.lifetime)
    await c.executor.sendNative({ recipient: to, value: 50000n }, c.lifetime)
    const [first, second] = journal.list()
    expect([first!, second!].map(r => r.members[0]!.source)).toMatchObject([
      { index: 0 },
      { index: 0 },
    ])
    // The second send's planning saw the first included; its pass tried and was refused, because
    // the second member is pending on the same address (stricter than the projection).
    expect(c.apply.mock.calls).toEqual([[first!.operationId, 0, c.lifetime]])
    await expect(c.apply.mock.results[0]!.value).rejects.toMatchObject({
      reason: 'conflicting-authorization',
    })
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    // A third send, from another row, sees the second included: now the first applies.
    state.balances.set(c.address(1), 400000n)
    await c.executor.sendNative({ recipient: to, value: 350000n }, c.lifetime)
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: first!.members[0]!.signed!.rawTransaction } },
    })
    expect(c.apply.mock.calls.map(([id]) => id)).toEqual([
      first!.operationId,
      first!.operationId,
    ])
    expect(c.classify.mock.results.map(r => r.value)).toEqual([
      'needs-apply',
      'needs-apply',
      'held-terminal',
    ])
    // Every later pass: the first is applied, the second is held-terminal; neither is applied again.
    await c.executor.resumeOperation(second!.operationId, c.lifetime)
    expect(c.apply).toHaveBeenCalledTimes(2)
    const error = await pending(c.executor.flushSync(second!.operationId))
    expect(error.operation.operationId).toBe(second!.operationId)
    expect(c.sync).not.toHaveBeenCalled()
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })
  // ---------------------------------------------------------------------------------------
  // Stage C of #1235: a plan that never signed is cancelled; held members are not re-projected.
  // Each test names what it reproduces on main e8d87c2d, or says it is a pin.
  // ---------------------------------------------------------------------------------------
  /** An unsigned plan from pool row `index`, written the way a crash between the journal write and
   * the first signature leaves it: through the journal, with no send. */
  const crashedPlan = (c: Awaited<ReturnType<typeof composed>>, index: number) =>
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
  const calls = (c: Awaited<ReturnType<typeof composed>>) => ({
    classify: c.classify.mock.calls.length,
    apply: c.apply.mock.calls.length,
  })

  // On main e8d87c2d the plan stays unsigned and uncancelled, its account is frozen by
  // `canSelect`, and the second send fails: "Insufficient unreserved native funds".
  it.each(['sendNative', 'sendLegacy'] as const)(
    'a %s whose signing fails is cancelled by that send: its own error is thrown, the row is retained, the account is released and sends again',
    async method => {
      const state = chain([])
      const c = await composed(state, [200000n])
      c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
      await expect(
        c.executor[method]({ recipient: to, value: 1000n }, c.lifetime),
      ).rejects.toThrow('fixture: custody refused')
      // The state the failing call left, read before anything else runs.
      const [failed] = journal.list()
      const afterFailure = {
        selectable: journal.canSelect(c.address(0), 0),
        reserved: journal.referencesSpendIndex(0),
        admission: c.inspect(),
        broadcasts: state.raws.length,
      }
      // Asked first, so that main e8d87c2d fails here with its own refusal.
      const sent = await c.executor.sendNative(
        { recipient: to, value: 1000n },
        c.lifetime,
      )
      expect(failed).toMatchObject({
        cancelled: true,
        intendedValueWei: '1000',
        members: [{ signed: null, exposed: false, source: { index: 0 } }],
      })
      expect(afterFailure).toMatchObject({
        selectable: true,
        reserved: false,
        admission: { status: 'ready', obligations: [] },
        broadcasts: 0,
      })
      const rows = journal.list()
      expect(rows).toHaveLength(2)
      // Retained, not deleted, and not touched by the send that followed it.
      expect(rows[0]).toEqual(failed)
      expect(sent.txHash).toBe(rows[1]!.members[0]!.signed!.transactionHash)
      expect(Transaction.from(state.raws[0]!).nonce).toBe(0)
      await reopen()
      expect(journal.list()[0]).toEqual(failed)
    },
  )

  // Pin of the limit. `cancelUnsignedOperations` does not exist on main e8d87c2d.
  it('pin: a fan-in with one member signed and the next unsigned is never cancelled, by the failed send or by the open-time cancel', async () => {
    const state = chain([])
    const c = await composed(state, [100000n, 50000n, 45000n])
    c.sign.mockImplementationOnce(c.sign.getMockImplementation()!)
    c.sign.mockRejectedValueOnce(new Error('fixture: custody refused'))
    await expect(
      c.executor.sendLegacy({ recipient: to, value: 110000n }, c.lifetime),
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
  it('the open-time cancel releases every never-signed plan and nothing else, with no provider call, no signature and no local pass; a second run writes nothing', async () => {
    const state = chain([])
    const c = await composed(state, [200000n, 150000n, 100000n, 50000n])
    await c.executor.sendLegacy({ recipient: to, value: 100000n }, c.lifetime) // row 0: included
    await c.executor
      .sendLegacy(
        {
          recipient: to,
          value: 100000n,
          onSigned: async () => {
            throw new Error('fixture: never exposed')
          },
        },
        c.lifetime,
      )
      .catch(() => undefined) // row 1: signed, never exposed
    await crashedPlan(c, 2)
    await crashedPlan(c, 3)
    const before = journal.list()
    expect(before.map(r => r.cancelled)).toEqual([false, false, false, false])
    const provider = providerCalls(state)
    const signatures = c.sign.mock.calls.length
    const local = calls(c)
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
    expect(calls(c)).toEqual(local)
    expect(state.raws).toHaveLength(1)
    expect(journal.canSelect(c.address(2), 0)).toBe(true)
    expect(journal.referencesSpendIndex(3)).toBe(false)
    expect(journal.canSelect(c.address(1), 0)).toBe(false)
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
    await expect(
      c.executor.sendNative({ recipient: to, value: 1000n }, c.lifetime),
    ).rejects.toThrow('fixture: custody refused')
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

  // On main e8d87c2d an executor with neither local callback records the member as applied:
  // `sync` is called and the member is marked sync-applied with nothing recorded anywhere.
  it('with neither local callback configured a member has no local result: it is held, never transported and never marked', async () => {
    const state = chain([200000n])
    const current = owner(state)
    await current.executor.sendLegacy({ recipient: to, value: 1000n })
    const row = journal.list()[0]!
    expect(row.members[0]!.observation.state).toBe('included-success')
    const marked = jest.spyOn(journal, 'markSyncApplied')
    const one = await pending(current.executor.flushSync(row.operationId))
    expect(one.operation.operationId).toBe(row.operationId)
    expect(String(one.reason)).toContain('no local spend record')
    await current.executor.resumeLegacySend(row.operationId)
    await pending(current.executor.flushSync())
    expect(current.sync).not.toHaveBeenCalled()
    expect(marked).not.toHaveBeenCalled()
    expect(journal.list()[0]!.members[0]!.syncApplied).toBe(false)
  })

  // Coordinator item 1(a). On main e8d87c2d every pass classifies and applies the held member
  // again: `apply` is called once per resume below, each one a mutation section and two
  // projections.
  it('a member held behind a later member on its address costs nothing on later passes, and is applied by the first pass after that member resolves', async () => {
    const state = chain([])
    const c = await composed(state, [300000n, 50000n])
    // Both from row 0. The first is mined at its broadcast; the node then keeps the second's
    // broadcast without mining it. The second send's planning saw the first included, and its
    // pass was refused: the second member holds the address.
    await c.executor.sendNative({ recipient: to, value: 100000n }, c.lifetime)
    state.setMode('retained')
    await c.executor.sendNative({ recipient: to, value: 50000n }, c.lifetime)
    const [first, second] = journal.list()
    expect(c.apply.mock.calls).toEqual([[first!.operationId, 0, c.lifetime]])
    await expect(c.apply.mock.results[0]!.value).rejects.toMatchObject({
      reason: 'conflicting-authorization',
    })
    expect(journal.get(second!.operationId).members[0]!.observation.state).toBe(
      'missing',
    )
    // Repeated passes with nothing changed for that address: a resume of the second operation
    // looks for its transaction again and still does not find it. The pass reaches the admission
    // only through the two callbacks, so no call is no projection and no mutation section.
    for (let pass = 0; pass < 5; pass++) {
      await c.executor.resumeOperation(second!.operationId, c.lifetime)
      expect(calls(c)).toEqual({ classify: 1, apply: 1 })
    }
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    await pending(c.executor.flushSync(first!.operationId))
    // The blocker resolves: the second transaction is mined, and a send from another row
    // observes it. The journal state of row 0's address changed, so that same send's pass
    // applies the first member.
    state.mine(second!.members[0]!.signed!.rawTransaction)
    state.setMode('mine')
    state.balances.set(c.address(1), 400000n)
    await c.executor.sendNative({ recipient: to, value: 350000n }, c.lifetime)
    expect(journal.get(second!.operationId).members[0]!.observation.state).toBe(
      'included-success',
    )
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: first!.members[0]!.signed!.rawTransaction } },
    })
    expect(c.apply.mock.calls.map(([id]) => id)).toEqual([
      first!.operationId,
      first!.operationId,
    ])
    // The second member is now held for good, from the snapshot alone.
    expect(c.classify).toHaveLastReturnedWith('held-terminal')
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })

  // Coordinator item 1(b)/(c): a blocker the journal does not show. On main e8d87c2d `apply` is
  // called by every pass, and the member is applied by the first pass after the blocker clears.
  it('a refusal the journal cannot explain is remembered for 16 passes and then tried once: the hold outlives its cause by at most that, and is never remembered as applied', async () => {
    const state = chain([])
    let blocked = true
    let real!: (id: string, i: number) => Promise<unknown>
    const c = await composed(state, [200000n], {
      applyLocalMember: async (id, i) => {
        if (blocked) throw new EvmInputAdmissionError('conflicting-authorization')
        return real(id, i) as never
      },
    })
    real = (id, i) =>
      poolSpendAdmission(c.admission, c.lifetime).applyMember(id, i)
    await c.executor.sendLegacy({ recipient: to, value: 100000n }, c.lifetime)
    const row = journal.list()[0]!
    expect(calls(c)).toEqual({ classify: 1, apply: 1 })
    // The cause ends at once, in a way the consolidator cannot see.
    blocked = false
    for (let pass = 0; pass < 16; pass++) {
      await c.executor.resumeLegacySend(row.operationId, c.lifetime)
      expect(calls(c)).toEqual({ classify: 1, apply: 1 })
    }
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    // Still held, so still not transported.
    await pending(c.executor.flushSync(row.operationId))
    expect(c.sync).not.toHaveBeenCalled()
    await c.executor.resumeLegacySend(row.operationId, c.lifetime)
    expect(calls(c)).toEqual({ classify: 2, apply: 2 })
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: row.members[0]!.signed!.rawTransaction } },
    })
    await c.executor.flushSync(row.operationId)
    expect(c.sync).toHaveBeenCalledTimes(1)
  })

  // Coordinator item 1(d). On main e8d87c2d classification answers `needs-apply` under a
  // conflicting projection and every pass, also after a refused resume, enters the admission.
  it('hand-built: under an already-conflicting admission the pass does nothing and cannot replace the failing call\'s error; once the never-signed plan is cancelled the next pass applies the member', async () => {
    const state = chain([])
    let transient = true
    let real!: (id: string, i: number) => Promise<unknown>
    const c = await composed(state, [200000n, 150000n], {
      applyLocalMember: async (id, i) => {
        if (transient) {
          transient = false
          throw new Error('fixture: transient failure')
        }
        return real(id, i) as never
      },
    })
    real = (id, i) =>
      poolSpendAdmission(c.admission, c.lifetime).applyMember(id, i)
    // Included in its own call, and left unapplied by an unexplained failure (not remembered).
    const result = await c.executor.sendLegacy(
      { recipient: to, value: 100000n },
      c.lifetime,
    )
    const a = journal.list()[0]!
    expect(calls(c)).toEqual({ classify: 1, apply: 1 })
    // Hand-built conflict: a never-signed plan on row 1, whose row is then terminal with no
    // checkpoint.
    const plan = await crashedPlan(c, 1)
    c.pool.setStatus(1, 'in-use')
    c.pool.setStatus(1, 'spent')
    await c.pool.flush()
    expect(c.inspect()).toMatchObject({ reason: 'conflicting-authorization' })
    const refused = async () => {
      const before = c.projections()
      await expect(
        c.executor.resumeLegacySend(a.operationId, c.lifetime),
      ).rejects.toMatchObject({
        name: 'EvmInputAdmissionError',
        reason: 'conflicting-authorization',
      })
      return c.projections() - before
    }
    // The first pass asks once (one projection, in classification) and enters no section.
    const first = await refused()
    expect(c.classify).toHaveLastReturnedWith('not-eligible')
    expect(calls(c)).toEqual({ classify: 2, apply: 1 })
    // Every later pass: nothing. The resume's own refusal is its one projection.
    for (let pass = 0; pass < 5; pass++) {
      expect(await refused()).toBe(first - 1)
      expect(calls(c)).toEqual({ classify: 2, apply: 1 })
    }
    expect(first - 1).toBe(1)
    // A failed resume never cancels an operation that signed.
    expect(journal.get(a.operationId).cancelled).toBe(false)
    expect(c.pool.getRecord(0)!.status).not.toBe('spent')
    // What wallet open does. The journal changed, so the next pass looks again.
    await c.executor.cancelUnsignedOperations(c.lifetime)
    expect(journal.get(plan.operationId).cancelled).toBe(true)
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    expect(
      await c.executor.resumeLegacySend(a.operationId, c.lifetime),
    ).toEqual(result)
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: a.members[0]!.signed!.rawTransaction } },
    })
    expect(calls(c)).toEqual({ classify: 3, apply: 2 })
  })

  // Coordinator item 1(c). On main e8d87c2d classification answers `needs-apply` for the leased
  // row and every pass enters the admission, where the pool refuses (`held`).
  it('hand-built: a native member whose row is in-use under a live lease is not applied and costs nothing per pass; released unused, it is applied by the next native send', async () => {
    const state = chain([])
    let transient = true
    let real!: (id: string, i: number) => Promise<unknown>
    const c = await composed(state, [200000n, 150000n], {
      applyLocalMember: async (id, i) => {
        if (transient) {
          transient = false
          throw new Error('fixture: transient failure')
        }
        return real(id, i) as never
      },
    })
    real = (id, i) =>
      poolSpendAdmission(c.admission, c.lifetime).applyMember(id, i)
    // Hand-built: the row is made `available` so that a lease can be taken on it afterwards.
    c.pool.setStatus(0, 'available')
    await c.pool.flush()
    await c.executor.sendLegacy({ recipient: to, value: 100000n }, c.lifetime)
    const a = journal.list()[0]!
    expect(a.members[0]!.source).toMatchObject({ index: 0 })
    const leases = canonicalAdmissionPool(c.admission, c.lifetime)
    const lease = await leases.acquire(0)
    expect(c.pool.getRecord(0)!.status).toBe('in-use')
    const held = calls(c)
    for (let pass = 0; pass < 4; pass++) {
      await c.executor
        .resumeLegacySend(a.operationId, c.lifetime)
        .catch(() => undefined)
      // Asked once, by the first of these passes; never applied.
      expect(calls(c)).toEqual({ classify: held.classify + 1, apply: held.apply })
    }
    expect(c.classify).toHaveLastReturnedWith('not-eligible')
    expect(c.pool.getRecord(0)).toMatchObject({ status: 'in-use' })
    expect(c.pool.getRecord(0)!.lifecycle?.spend).toBeUndefined()
    await leases.release(lease, 'unused')
    expect(c.pool.getRecord(0)!.status).toBe('available')
    expect(c.inspect()).toMatchObject({ status: 'ready' })
    await c.executor.sendLegacy({ recipient: to, value: 120000n }, c.lifetime)
    expect(c.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: a.members[0]!.signed!.rawTransaction } },
    })
    expect(c.inspect()).toMatchObject({ status: 'ready' })
  })
})
