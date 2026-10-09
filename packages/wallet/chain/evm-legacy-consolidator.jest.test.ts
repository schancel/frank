import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet, keccak256, type Provider } from 'ethers'
import {
  EvmLegacyConsolidator,
  EvmNativeOperationPendingError,
} from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import {
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'

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
      builder?: NativeEvmTransactionBuilder
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
    const second = owner(state, { sources: [] })
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
    await expect(
      current.executor.resumeOperation(row.operationId),
    ).rejects.toBeInstanceOf(EvmNativeOperationPendingError)
    expect(journal.get(row.operationId).members[0]!.observation.state).toBe(
      'included-revert',
    )
    expect(journal.canSelect(row.members[0]!.source.address, 0)).toBe(false)
    expect(state.balances.get(recipient)).toBeUndefined()
  })
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
    const current = owner(state)
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
})
