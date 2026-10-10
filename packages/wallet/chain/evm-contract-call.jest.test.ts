/**
 * The contract-call entry of the native operation owner: one call with calldata from the main
 * account, journaled and recovered like a native send. The provider here is a stub at the
 * JSON-RPC seam; the same path against the real network is `swap/swap-real.livecheck.ts`.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet, keccak256, type Provider } from 'ethers'
import {
  EvmLegacyConsolidator,
  EvmNativeOperationPendingError,
} from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { getEvmDexDeployment } from './dex-deployments'
import { fetchSwapQuote, planSwap } from '../swap/evm-swap'
import { executeSwap } from '../swap/swap-execution'
import { cannedNode } from '../swap/swap-reader.testutil'
import { findToken, poolId, routesFor } from '../swap/uniswap-v4'
import {
  EvmNativeJournalError,
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from '../storage/evm-native-operation-journal'

const main = new Wallet('0x' + '01'.padStart(64, '0'))
const spend = new Wallet('0x' + '02'.padStart(64, '0'))
const router = '0x1b7bfcd2870329b987191910d85c22c7287f3c22'
const calldata = '0x3593564c' + '00'.repeat(32)
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'contract-call-test',
}
const sources: EvmNativeSource[] = [
  { kind: 'main', address: main.address.toLowerCase() },
  { kind: 'spend', index: 0, address: spend.address.toLowerCase() },
]

function node(initial: { main: bigint; spend?: bigint }) {
  const balances = new Map([
    [main.address.toLowerCase(), initial.main],
    [spend.address.toLowerCase(), initial.spend ?? 0n],
  ])
  const nonces = new Map<string, number>()
  const transactions = new Map<string, object>()
  const receipts = new Map<string, object>()
  const raws: string[] = []
  const blockHash = '0x' + 'ab'.repeat(32)
  let mode: 'mine' | 'lost' | 'lost-once' | 'revert' | 'mempool' = 'mine'
  let down = false
  const mine = (raw: string, status = 1) => {
    const tx = Transaction.from(raw)
    const from = tx.from!.toLowerCase()
    if (receipts.has(tx.hash!)) return
    nonces.set(from, tx.nonce + 1)
    const gas = tx.gasLimit * tx.maxFeePerGas!
    balances.set(
      from,
      (balances.get(from) ?? 0n) - gas - (status === 1 ? tx.value : 0n),
    )
    const to = tx.to!.toLowerCase()
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
      gasUsed: tx.gasLimit,
      gasPrice: tx.maxFeePerGas,
      logs: [],
    })
  }
  const provider = {
    getBlock: async () => ({ hash: blockHash, number: 1 }),
    getBalance: async (address: string) =>
      balances.get(address.toLowerCase()) ?? 0n,
    getTransactionCount: async (address: string) =>
      nonces.get(address.toLowerCase()) ?? 0,
    getFeeData: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 2n,
    }),
    estimateGas: jest.fn(async () => 100_000n),
    getTransaction: async (hash: string) => {
      if (down) throw new Error('rate limited')
      return transactions.get(hash) ?? null
    },
    getTransactionReceipt: async (hash: string) => {
      if (down) throw new Error('rate limited')
      return receipts.get(hash) ?? null
    },
    broadcastTransaction: async (raw: string) => {
      raws.push(raw)
      if (mode === 'lost') throw new Error('lost response')
      if (mode === 'mempool') {
        // Accepted and held, not yet in a block.
        const tx = Transaction.from(raw)
        transactions.set(tx.hash!, tx)
        return { hash: keccak256(raw) }
      }
      if (mode === 'lost-once') {
        mode = 'mine'
        throw new Error('lost response')
      }
      mine(raw, mode === 'revert' ? 0 : 1)
      return { hash: keccak256(raw) }
    },
  }
  return {
    provider: provider as unknown as Provider,
    estimateGas: provider.estimateGas,
    balances,
    raws,
    mine,
    setMode: (value: typeof mode) => {
      mode = value
    },
    forget: (hash: string) => transactions.delete(hash),
    setDown: (value: boolean) => {
      down = value
    },
  }
}

describe('contract calls through the native operation journal', () => {
  let location: string
  let journal: EvmNativeOperationJournal
  const open = async () => {
    journal = new EvmNativeOperationJournal({ location, binding })
    await journal.Open()
  }
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-contract-call-'))
    await open()
  })
  afterEach(async () => {
    await journal.Close()
    await rm(location, { recursive: true, force: true })
  })
  const owner = (
    state: ReturnType<typeof node>,
    available: EvmNativeSource[] = sources,
  ) => {
    const sign = jest.fn(async (source: EvmNativeSource, raw: string) =>
      (source.address === main.address.toLowerCase()
        ? main
        : spend
      ).signTransaction(Transaction.from(raw)),
    )
    return {
      sign,
      executor: new EvmLegacyConsolidator({
        journal,
        provider: state.provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        getSources: async () => available,
        sign,
      }),
    }
  }
  const call = { to: { raw: router }, data: calldata, value: 1_000n }

  it('journals the call before signing and the signed bytes before broadcast', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    let seenBeforeBroadcast = false
    const result = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
      onSigned: async signed => {
        const row = journal.get(signed.operationId)
        expect(row.members[0]!.signed!.transactionHash).toBe(signed.txHash)
        expect(row.members[0]!.exposed).toBe(false)
        expect(state.raws).toEqual([])
        seenBeforeBroadcast = true
      },
    })
    expect(seenBeforeBroadcast).toBe(true)
    const row = journal.get(result.operationId)
    expect(row).toMatchObject({
      kind: 'contract',
      recipient: router,
      intendedValueWei: '1000',
    })
    expect(row.members).toHaveLength(1)
    expect(row.members[0]!.source).toEqual(sources[0])
    const sent = Transaction.from(state.raws[0]!)
    expect(sent.hash).toBe(result.txHash)
    expect(sent).toMatchObject({
      to: expect.stringMatching(new RegExp(router, 'i')),
      data: calldata,
      value: 1_000n,
      gasLimit: 250_000n,
      nonce: 0,
    })
    expect(sent.from).toBe(main.address)
    expect(state.raws).toHaveLength(1)
  })

  it('estimates gas with headroom when the caller gives no limit', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    await executor.sendContractCall(call)
    expect(Transaction.from(state.raws[0]!).gasLimit).toBe(115_000n)
    expect(state.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({
        from: main.address.toLowerCase(),
        to: router,
        data: calldata,
        value: 1_000n,
      }),
    )
  })

  it('allows a call that carries no value (an approval, a token-in swap)', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    const result = await executor.sendContractCall({ ...call, value: 0n })
    expect(journal.get(result.operationId).intendedValueWei).toBe('0')
    expect(Transaction.from(state.raws[0]!).value).toBe(0n)
  })

  it('after a lost broadcast, resends the same bytes and refuses a second call', async () => {
    const state = node({ main: 10_000_000n })
    const { executor, sign } = owner(state)
    state.setMode('lost')
    const failure = await executor
      .sendContractCall({ ...call, gasLimit: 250_000n })
      .catch(error => error)
    expect(failure).toBeInstanceOf(EvmNativeOperationPendingError)
    const operationId = failure.operation.operationId as string
    expect(failure.transaction.txHash).toBe(keccak256(state.raws[0]!))

    // The outcome is unknown, so the account's next transaction must not be built over it.
    await expect(
      executor.sendContractCall({ ...call, gasLimit: 250_000n }),
    ).rejects.toThrow(/Insufficient unreserved native funds/)
    expect(state.raws).toHaveLength(1)
    expect((await executor.contractCallFunds()).mainBusy).toBe(true)

    state.setMode('mine')
    await executor.resumeOperation(operationId)
    expect(state.raws).toHaveLength(2)
    expect(state.raws[1]).toBe(state.raws[0])
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it('recovers a signed call after a restart without signing again', async () => {
    const state = node({ main: 10_000_000n })
    state.setMode('lost')
    const first = owner(state)
    const failure = await first.executor
      .sendContractCall({ ...call, gasLimit: 250_000n })
      .catch(error => error)
    const operationId = failure.operation.operationId as string
    await journal.Close()
    await open()

    const second = owner(state)
    state.setMode('mine')
    await second.executor.resumeOperation(operationId)
    expect(second.sign).not.toHaveBeenCalled()
    expect(state.raws[1]).toBe(state.raws[0])
    await second.executor.observe(operationId, 0)
    expect(journal.get(operationId).members[0]!.observation.state).toBe(
      'included-success',
    )
  })

  it('frees the account after a reverted call: the nonce is spent, nothing is pending', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    state.setMode('revert')
    const reverted = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
    })
    await executor.observe(reverted.operationId, 0)
    expect(
      journal.get(reverted.operationId).members[0]!.observation.state,
    ).toBe('included-revert')
    expect((await executor.contractCallFunds()).mainBusy).toBe(false)
    state.setMode('mine')
    await executor.sendContractCall({ ...call, gasLimit: 250_000n })
    expect(Transaction.from(state.raws[1]!).nonce).toBe(1)
  })

  it('refuses a call without calldata or beyond the main balance, and writes nothing', async () => {
    const state = node({ main: 400_000n, spend: 10_000_000n })
    const { executor } = owner(state)
    await expect(
      executor.sendContractCall({ ...call, data: '0x' }),
    ).rejects.toThrow(/calldata/)
    // 1,000 value + 250,000 gas at a fee cap of 2 = 501,000 > 400,000. The spend account's
    // balance does not count: a contract call is paid by the main account alone.
    await expect(
      executor.sendContractCall({ ...call, gasLimit: 250_000n }),
    ).rejects.toThrow(RangeError)
    expect(journal.list()).toEqual([])
    expect(state.raws).toEqual([])
  })

  it('reports what the main account holds and what could be moved into it', async () => {
    const state = node({ main: 400_000n, spend: 9_000_000n })
    const { executor } = owner(state)
    expect(await executor.contractCallFunds()).toEqual({
      mainAddress: main.address.toLowerCase(),
      mainBalance: 400_000n,
      otherBalance: 9_000_000n,
      mainBusy: false,
    })
  })

  it('funds the main account from the wallet’s other accounts, never from itself', async () => {
    const state = node({ main: 5_000_000n, spend: 9_000_000n })
    const { executor } = owner(state)
    const funded = await executor.fundMainAccount({ value: 3_000_000n })
    const row = journal.list()[0]!
    expect(row).toMatchObject({
      kind: 'legacy',
      recipient: main.address.toLowerCase(),
      intendedValueWei: '3000000',
    })
    expect(row.members.map(member => member.source.kind)).toEqual(['spend'])
    expect(funded.txHash).toBe(row.members[0]!.signed!.transactionHash)
    expect(state.balances.get(main.address.toLowerCase())).toBe(8_000_000n)

    const alone = node({ main: 5_000_000n })
    await journal.Close()
    await rm(location, { recursive: true, force: true })
    location = await mkdtemp(join(tmpdir(), 'frank-contract-call-'))
    await open()
    await expect(
      owner(alone).executor.fundMainAccount({ value: 1_000n }),
    ).rejects.toThrow(RangeError)
    expect(alone.raws).toEqual([])
  })

  it('the journal accepts a contract call only from the main account and only with calldata', async () => {
    const unsigned = (data: string) =>
      Transaction.from({
        type: 2,
        to: router,
        chainId: 10143n,
        nonce: 0,
        value: 0n,
        data,
        gasLimit: 100_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      }).unsignedSerialized
    const plan = (source: EvmNativeSource, data: string) =>
      journal.prepare({
        kind: 'contract',
        recipient: router,
        intendedValueWei: '0',
        members: [
          { source, unsignedTransaction: unsigned(data), dependencies: [] },
        ],
      })
    await expect(plan(sources[1]!, calldata)).rejects.toBeInstanceOf(
      EvmNativeJournalError,
    )
    await expect(plan(sources[0]!, '0x')).rejects.toBeInstanceOf(
      EvmNativeJournalError,
    )
    const row = await plan(sources[0]!, calldata)
    expect(summarizeEvmNativeOperation(row)).toMatchObject({
      kind: 'contract',
      recipient: router,
      intendedValueWei: '0',
      payment: 'unknown',
    })
  })

  it('a read that fails never takes back what the chain was seen to say', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    const sent = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
    })
    await executor.observe(sent.operationId, 0)
    const included = journal.get(sent.operationId).members[0]!
    expect(included.observation.state).toBe('included-success')
    state.setDown(true)
    await executor.observe(sent.operationId, 0)
    expect(journal.get(sent.operationId).members[0]).toEqual(included)
    // So the account is still free: an exhausted RPC quota cannot freeze it.
    state.setDown(false)
    expect((await executor.contractCallFunds()).mainBusy).toBe(false)

    state.setMode('lost')
    const lost = await executor
      .sendContractCall({ ...call, gasLimit: 250_000n })
      .catch(error => error)
    const id = lost.operation.operationId as string
    expect(journal.get(id).members[0]!.observation.state).toBe('missing')
    state.setDown(true)
    await executor.observe(id, 0)
    expect(journal.get(id).members[0]!.observation.state).toBe('missing')
  })

  it('hands a lost contract call back to the network on a backoff, the same bytes, until it lands', async () => {
    const state = node({ main: 10_000_000n })
    let clock = 1_000_000
    const sign = async (_source: EvmNativeSource, raw: string) =>
      main.signTransaction(Transaction.from(raw))
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: state.provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      getSources: async () => sources,
      sign,
      now: () => clock,
    })
    state.setMode('lost')
    const lost = await executor
      .sendContractCall({ ...call, gasLimit: 250_000n })
      .catch(error => error)
    const id = lost.operation.operationId as string
    expect(executor.unresolvedContractCalls()).toEqual([
      { operationId: id, txHash: lost.transaction.txHash },
    ])
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(2)
    // Not again until the wait has passed, and then twice as long.
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(2)
    clock += 15_000
    state.setMode('mine')
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(3)
    expect(new Set(state.raws).size).toBe(1)
    // Once it is seen in a block nothing more is sent.
    await executor.observe(id, 0)
    clock += 600_000
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(3)
    expect(executor.unresolvedContractCalls()).toEqual([])
  })

  it('a swap whose first approval was lost in broadcast: the approval is re-sent, lands, the swap goes on, and the account can send afterwards', async () => {
    const state = node({ main: 10n ** 18n })
    const { executor, sign } = owner(state)
    const deployment = getEvmDexDeployment('monad-testnet')!
    const USDC = findToken(deployment, 'USDC')!
    const MON = findToken(deployment, 'MON')!
    const canned = cannedNode(deployment)
    canned.node.pools.set(
      poolId(routesFor(deployment, MON, USDC)[0]!.key).toLowerCase(),
      {
        sqrtPriceX96: 2n ** 96n,
        liquidity: 10n ** 18n,
        lpFee: 500,
        quote: amountIn => amountIn,
      },
    )
    const reader = {
      ...canned.reader,
      getFeeData: () => state.provider.getFeeData(),
      getTransactionReceipt: (hash: string) =>
        state.provider.getTransactionReceipt(hash) as never,
      getTransaction: (hash: string) => state.provider.getTransaction(hash),
    }
    const plan = await planSwap(canned.reader, deployment, {
      quote: await fetchSwapQuote(canned.reader, deployment, {
        tokenIn: USDC,
        tokenOut: MON,
        amountIn: 15_000n,
      }),
      slippageBps: 100,
      account: main.address,
    })
    expect(plan.approvals).toHaveLength(2)
    state.setMode('lost-once')
    const stages: string[] = []
    const result = await executeSwap({
      reader,
      wallet: {
        sendContractCall: params => executor.sendContractCall(params),
        getContractCallFunds: () => executor.contractCallFunds(),
        resumeNativeOperation: id => executor.resumeOperation(id),
        getUnresolvedContractCalls: () => executor.unresolvedContractCalls(),
      },
      deployment,
      plan,
      account: main.address,
      timing: {
        inclusionTimeoutMs: 0,
        pollMs: 1,
        sleep: async () => undefined,
      },
      onProgress: progress => stages.push(progress.stage),
    })
    expect(result.status).toBe('confirmed')
    // Four broadcasts for three transactions: the first approval twice, byte for byte.
    expect(state.raws).toHaveLength(4)
    expect(state.raws[1]).toBe(state.raws[0])
    expect(sign).toHaveBeenCalledTimes(3)
    expect(state.raws.map(raw => Transaction.from(raw).nonce)).toEqual([
      0, 0, 1, 2,
    ])
    expect(Transaction.from(state.raws[3]!).data).toBe(plan.swap.data)
    // Once the wallet has looked at the chain, every call is recorded as included.
    expect((await executor.contractCallFunds()).mainBusy).toBe(false)
    expect(executor.unresolvedContractCalls()).toEqual([])

    // Nothing is left holding the main account: an ordinary send goes out from it.
    const transfer = await executor.sendNative({
      recipient: { raw: spend.address },
      value: 1_000n,
    })
    const sent = Transaction.from(state.raws[4]!)
    expect(sent.hash).toBe(transfer.txHash)
    expect(sent.from).toBe(main.address)
    expect(sent.nonce).toBe(3)
  })

  it('a call that could not be recorded is not broadcast, then or later, and a quick retry sends exactly one', async () => {
    const state = node({ main: 10_000_000n })
    const { executor, sign } = owner(state)
    await expect(
      executor.sendContractCall({
        ...call,
        gasLimit: 250_000n,
        onSigned: async () => {
          throw new Error('QuotaExceededError')
        },
      }),
    ).rejects.toThrow('QuotaExceededError')
    expect(state.raws).toEqual([])
    const ended = journal.list()[0]!
    expect(ended.cancelled).toBe(true)
    expect(ended.members[0]!.signed).toBeNull()
    // Nothing is left to resume or re-send, on any path.
    expect(executor.unresolvedContractCalls()).toEqual([])
    await executor.resendMissingContractCalls()
    await expect(executor.resumeOperation(ended.operationId)).rejects.toThrow()
    expect(state.raws).toEqual([])

    // The user tries again at once: one swap goes out, at the nonce the first never used.
    expect((await executor.contractCallFunds()).mainBusy).toBe(false)
    const second = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
    })
    expect(state.raws).toHaveLength(1)
    const sent = Transaction.from(state.raws[0]!)
    expect(sent.hash).toBe(second.txHash)
    expect(sent.nonce).toBe(0)
    expect(sign).toHaveBeenCalledTimes(2)
  })

  it('at wallet open, ends a contract call that was signed and never handed to the network', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    // A crash between the signature and the broadcast leaves exactly this row.
    const row = await journal.prepare({
      kind: 'contract',
      recipient: router,
      intendedValueWei: '0',
      members: [
        {
          source: sources[0]!,
          unsignedTransaction: Transaction.from({
            type: 2,
            to: router,
            chainId: 10143n,
            nonce: 0,
            value: 0n,
            data: calldata,
            gasLimit: 100_000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
          dependencies: [],
        },
      ],
    })
    await journal.checkpointSigned(
      row.operationId,
      0,
      await main.signTransaction(
        Transaction.from(row.members[0]!.unsignedTransaction),
      ),
    )
    expect((await executor.contractCallFunds()).mainBusy).toBe(true)
    await executor.cancelUnsignedOperations()
    expect(journal.get(row.operationId)).toMatchObject({ cancelled: true })
    expect(journal.get(row.operationId).members[0]!.signed).toBeNull()
    expect((await executor.contractCallFunds()).mainBusy).toBe(false)
    expect(state.raws).toEqual([])
  })

  it('never ends a call that was handed to the network', async () => {
    const state = node({ main: 10_000_000n })
    const { executor } = owner(state)
    state.setMode('lost')
    const lost = await executor
      .sendContractCall({ ...call, gasLimit: 250_000n })
      .catch(error => error)
    await executor.cancelUnsignedOperations()
    const row = journal.get(lost.operation.operationId)
    expect(row.cancelled).toBe(false)
    expect(row.members[0]!.signed).not.toBeNull()
    await expect(journal.discardUnexposed(row.operationId)).rejects.toThrow()
  })

  it('the poll learns that the node has dropped a call it was holding, and hands it back', async () => {
    const state = node({ main: 10_000_000n })
    let clock = 1_000_000
    const executor = new EvmLegacyConsolidator({
      journal,
      provider: state.provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      getSources: async () => sources,
      sign: async (_source, raw) => main.signTransaction(Transaction.from(raw)),
      now: () => clock,
    })
    state.setMode('mempool')
    const sent = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
    })
    await executor.observe(sent.operationId, 0)
    expect(journal.get(sent.operationId).members[0]!.observation.state).toBe(
      'pending',
    )
    // While the node holds it, the poll looks and sends nothing.
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(1)
    // The node drops it. The next due poll records that and re-sends the same bytes.
    state.forget(sent.txHash)
    state.setMode('mine')
    clock += 15_000
    await executor.resendMissingContractCalls()
    expect(state.raws).toHaveLength(2)
    expect(state.raws[1]).toBe(state.raws[0])
    clock += 30_000
    await executor.resendMissingContractCalls()
    expect(journal.get(sent.operationId).members[0]!.observation.state).toBe(
      'included-success',
    )
    expect(state.raws).toHaveLength(2)
  })

  it('keeps a contract call’s record in the journal row, and refuses one anywhere else or malformed', async () => {
    const state = node({ main: 10_000_000n, spend: 10_000_000n })
    const { executor } = owner(state)
    const record = {
      kind: 'swap' as const,
      venueId: 'uniswap-v4',
      account: main.address,
      assetIn: { symbol: 'MON', address: null, decimals: 18 },
      amountIn: '1000',
      assetOut: { symbol: 'USDC', address: router, decimals: 6 },
      quotedAmountOut: '999',
      minimumAmountOut: '989',
      interfaceFeeAmount: '0',
      networkFeeWei: '500000',
      route: { zeroForOne: true },
    }
    const sent = await executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
      record,
    })
    expect(journal.get(sent.operationId).record).toEqual(record)
    await journal.Close()
    await open()
    expect(journal.get(sent.operationId).record).toEqual(record)
    // A call with no record has none; a transfer can never carry one.
    const plain = await owner(state).executor.sendContractCall({
      ...call,
      gasLimit: 250_000n,
    })
    expect(journal.get(plain.operationId).record).toBeNull()
    const transfer = (extra: object) =>
      journal.prepare({
        kind: 'native',
        recipient: router,
        intendedValueWei: '1',
        members: [
          {
            source: sources[1]!,
            unsignedTransaction: Transaction.from({
              type: 2,
              to: router,
              chainId: 10143n,
              nonce: 0,
              value: 1n,
              gasLimit: 21_000n,
              maxFeePerGas: 2n,
              maxPriorityFeePerGas: 1n,
            }).unsignedSerialized,
            dependencies: [],
          },
        ],
        ...extra,
      })
    await expect(transfer({ record })).rejects.toBeInstanceOf(
      EvmNativeJournalError,
    )
    await expect(
      owner(state).executor.sendContractCall({
        ...call,
        gasLimit: 250_000n,
        record: { ...record, amountIn: '1.5' },
      }),
    ).rejects.toBeInstanceOf(EvmNativeJournalError)
  })
})
