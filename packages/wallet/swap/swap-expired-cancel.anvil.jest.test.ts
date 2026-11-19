/**
 * INTEGRATION: a swap the wallet handed to the network and the chain had not included when its
 * deadline passed, on real chain software (`anvil`, chain ID 10143).
 *
 * Re-sending it would buy a certain revert at the full swap fee. Recovery (`reconcileSwap`)
 * instead cancels it: a transfer of nothing from the account to itself at the same nonce, at
 * replacement fees, recorded in the wallet's journal before it is broadcast. What the chain then
 * includes is what is reported, also when the swap itself lands first.
 *
 * Real: the node, block time, the mempool (automine off, `anvil_dropTransaction` for a lost
 * broadcast), the wallet's provider, signing, the native journal and its Level stores, and the
 * Universal Router calldata. Not real, and said so: the router contract (code that accepts any
 * call, set at the deployment's router address: there is no pool here, and what is under test
 * is which transaction takes the nonce, not a swap's execution) and the relay (offline stand-in).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  fixture,
  mailboxes,
  offlineChain,
  roots,
  type Fixture,
} from '../chain/canonical-two-wallets.testutil'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import { encodeSwap, findToken, routesFor } from './uniswap-v4'
import {
  reconcileSwap,
  swapDeadlineOf,
  type SwapExecutionReader,
  type SwapResult,
  type SwapTiming,
} from './swap-execution'
import { anvilBinary, findAnvil, nodeSuiteReady } from '../node-binaries.testutil'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: mockNode.url,
        chainId: options.chainId,
      }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('../chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** STOP: the stand-in router accepts every call and does nothing. */
const ACCEPTING_CODE = '0x00'
const GAS_PRICE = 10n ** 9n
const deployment = getEvmDexDeployment('monad-testnet')!
const MON = findToken(deployment, 'MON')!
const USDC = findToken(deployment, 'USDC')!
const route = routesFor(deployment, MON, USDC)[0]!

const anvilBin = findAnvil()
const suite = nodeSuiteReady('swap-expired-cancel.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

suite('a swap past its deadline is cancelled, not sent again, on a real EVM node (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let main: string

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      [
        '--port', String(port),
        '--chain-id', '10143',
        '--base-fee', '0',
        '--gas-price', String(GAS_PRICE),
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (attempt > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    dev = new Wallet(DEV_KEY, chain)
    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mailboxes.clear()
    f = await fixture({ transactionSetPolicy: undefined })
    alice = f.alice
    main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await chain.send('anvil_setCode', [deployment.universalRouter, ACCEPTING_CODE])
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    for (let i = 0; i < 4; i++) await chain.send('evm_mine', [])
  })
  afterEach(async () => {
    await chain?.send('evm_setAutomine', [true]).catch(() => undefined)
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  const reader = () => chain as unknown as SwapExecutionReader
  const latestTime = async () => (await chain.getBlock('latest'))!.timestamp
  /** One block whose time is past `deadline`, mined with nothing in it. */
  const passDeadline = async (deadline: number) => {
    await chain.send('evm_setNextBlockTimestamp', [deadline + 5])
    await chain.send('evm_mine', [])
    expect(await latestTime()).toBeGreaterThan(deadline)
  }
  /** Each wait of the recovery's watch is one mined block (automine is off). */
  const minedTiming = (before?: (step: number) => Promise<void>): SwapTiming => {
    let step = 0
    return {
      inclusionTimeoutMs: 20,
      pollMs: 1,
      sleep: async () => {
        await before?.(step++)
        await chain.send('evm_mine', [])
      },
    }
  }
  /** A real Universal Router swap of 1,000 wei of MON, sent through the wallet; left unmined. */
  async function submitSwap() {
    const deadline = (await latestTime()) + 60
    const call = encodeSwap({
      deployment,
      route,
      amountIn: 1_000n,
      minimumAmountOut: 1n,
      deadline,
    })
    expect(swapDeadlineOf(call.data)).toBe(deadline)
    const nonce = await chain.getTransactionCount(main, 'latest')
    await chain.send('evm_setAutomine', [false])
    const handle = await alice.sendContractCall!({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
    })
    const signed = Transaction.from(
      alice.getNativeOperations!().find(row => row.operationId === handle.operationId)!
        .members[0]!.signed!.rawTransaction,
    )
    expect(signed.nonce).toBe(nonce)
    return { call, deadline, handle, nonce, raw: signed.serialized }
  }
  const reconcile = (
    swap: Awaited<ReturnType<typeof submitSwap>>,
    timing: SwapTiming,
  ): Promise<SwapResult> =>
    reconcileSwap({
      reader: reader(),
      wallet: alice,
      deployment,
      route,
      account: main,
      swap: swap.call,
      handle: swap.handle,
      timing,
    })
  const rowOf = (operationId: string) =>
    alice.getNativeOperations!().find(row => row.operationId === operationId)!

  /** The account is free again and holds what the chain says, with nothing of the swap open. */
  async function expectFreed(nonce: number) {
    await chain.send('evm_setAutomine', [true])
    await alice.reobserveNativeOperations!()
    expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 1)
    expect(alice.getUnresolvedContractCalls!()).toEqual([])
    const funds = await alice.getContractCallFunds!()
    expect(funds.mainBusy).toBe(false)
    expect(funds.mainBalance).toBe(await chain.getBalance(main))
  }

  it('a lost swap past its deadline is cancelled at its nonce, the account freed; after a restart nothing is sent again', async () => {
    const swap = await submitSwap()
    // The broadcast was lost: the node no longer knows the swap.
    await chain.send('anvil_dropTransaction', [swap.handle.txHash])
    await passDeadline(swap.deadline)
    const before = await chain.getBalance(main)
    const offered: string[] = []
    // Every provider here, the wallet's own included, sends through this.
    const send = JsonRpcProvider.prototype.send
    const spy = jest
      .spyOn(JsonRpcProvider.prototype, 'send')
      .mockImplementation(async function (this: JsonRpcProvider, method, params) {
        if (method === 'eth_sendRawTransaction') offered.push((params as string[])[0]!)
        return send.call(this, method, params)
      })
    let result: SwapResult
    try {
      result = await reconcile(swap, minedTiming())
    } finally {
      spy.mockRestore()
    }
    expect(result).toMatchObject({ status: 'cancelled', txHash: swap.handle.txHash })
    if (result.status !== 'cancelled') throw new Error('not cancelled')
    // The swap's own bytes were never offered again; only its cancellation was.
    expect(offered.map(raw => raw.toLowerCase())).not.toContain(swap.raw.toLowerCase())
    expect(offered.map(raw => Transaction.from(raw).hash)).toContain(result.cancelTxHash)
    const cancel = await chain.getTransaction(result.cancelTxHash!)
    const receipt = (await chain.getTransactionReceipt(result.cancelTxHash!))!
    expect(receipt.status).toBe(1)
    expect(cancel!.from.toLowerCase()).toBe(main)
    expect(cancel!.to!.toLowerCase()).toBe(main)
    expect(cancel!.value).toBe(0n)
    expect(cancel!.nonce).toBe(swap.nonce)
    expect(await chain.getTransactionReceipt(swap.handle.txHash)).toBeNull()
    // Nothing was swapped: the account paid the cancellation's fee, no more.
    expect(result.feeWei).toBe(receipt.gasUsed * receipt.gasPrice)
    expect(await chain.getBalance(main)).toBe(before - result.feeWei)
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation?.transactionHash).toBe(
      result.cancelTxHash,
    )
    await expectFreed(swap.nonce)

    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    const row = rowOf(swap.handle.operationId)
    expect(row.members[0]!.cancellation?.transactionHash).toBe(result.cancelTxHash)
    await alice.reobserveNativeOperations!()
    expect(alice.getUnresolvedContractCalls!()).toEqual([])
    expect((await alice.getContractCallFunds!()).mainBusy).toBe(false)
    expect(await chain.getTransactionCount(main, 'latest')).toBe(swap.nonce + 1)
  })

  it('a cancellation recorded but never seen by the node is sent again after a restart, the same bytes, never a second one', async () => {
    const swap = await submitSwap()
    await chain.send('anvil_dropTransaction', [swap.handle.txHash])
    await passDeadline(swap.deadline)
    // The cancellation is recorded and broadcast, then lost too; the page closes.
    let cancelHash: string | undefined
    const first = await reconcile(
      swap,
      minedTiming(async () => {
        cancelHash ??= rowOf(swap.handle.operationId).members[0]!.cancellation!.transactionHash
        await chain.send('anvil_dropTransaction', [cancelHash])
      }),
    )
    expect(first).toMatchObject({ status: 'pending' })
    expect(cancelHash).toBeDefined()
    expect(await chain.getTransactionReceipt(cancelHash!)).toBeNull()
    expect(await chain.getTransactionCount(main, 'latest')).toBe(swap.nonce)

    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    const result = await reconcile(swap, minedTiming())
    expect(result).toMatchObject({ status: 'cancelled', cancelTxHash: cancelHash })
    expect((await chain.getTransactionReceipt(cancelHash!))!.status).toBe(1)
    expect(await chain.getTransactionReceipt(swap.handle.txHash)).toBeNull()
    await expectFreed(swap.nonce)
  })

  it('a swap that lands before its cancellation is reported as what the chain did, and nothing more is sent', async () => {
    const swap = await submitSwap()
    await chain.send('anvil_dropTransaction', [swap.handle.txHash])
    await passDeadline(swap.deadline)
    // Another copy of the swap was still out there: it reaches a block first, and the
    // cancellation never does.
    const result = await reconcile(
      swap,
      minedTiming(async step => {
        if (step > 0) return
        const cancelHash = rowOf(swap.handle.operationId).members[0]!.cancellation!.transactionHash
        await chain.send('anvil_dropTransaction', [cancelHash])
        await chain.send('eth_sendRawTransaction', [swap.raw])
      }),
    )
    // The stand-in router has no deadline check: the swap succeeded. What is reported is the
    // swap's own receipt, never "cancelled".
    const receipt = (await chain.getTransactionReceipt(swap.handle.txHash))!
    expect(receipt.status).toBe(1)
    expect(result).toMatchObject({ status: 'confirmed', txHash: swap.handle.txHash })
    const cancelHash = rowOf(swap.handle.operationId).members[0]!.cancellation!.transactionHash
    expect(await chain.getTransactionReceipt(cancelHash)).toBeNull()
    await expectFreed(swap.nonce)
    expect(rowOf(swap.handle.operationId).members[0]!.observation.state).toBe('included-success')
  })

  it('a nonce another transaction took after the cancellation was recorded ends the swap, and the next look says so', async () => {
    const swap = await submitSwap()
    await chain.send('anvil_dropTransaction', [swap.handle.txHash])
    await passDeadline(swap.deadline)
    // The cancellation is recorded and lost; another transaction of the account (another
    // device, say) takes the nonce instead.
    const first = await reconcile(
      swap,
      minedTiming(async step => {
        if (step > 0) return
        const cancelHash = rowOf(swap.handle.operationId).members[0]!.cancellation!.transactionHash
        await chain.send('anvil_dropTransaction', [cancelHash])
        await chain.send('anvil_impersonateAccount', [main])
        await chain.send('eth_sendTransaction', [
          {
            from: main,
            to: dev.address,
            value: '0x1',
            nonce: '0x' + swap.nonce.toString(16),
            gas: '0x5208',
          },
        ])
        await chain.send('anvil_stopImpersonatingAccount', [main])
      }),
    )
    expect(first).toMatchObject({ status: 'pending' })
    expect(await chain.getTransactionCount(main, 'latest')).toBe(swap.nonce + 1)
    const cancelHash = rowOf(swap.handle.operationId).members[0]!.cancellation!.transactionHash
    expect(await chain.getTransactionReceipt(cancelHash)).toBeNull()
    expect(await chain.getTransactionReceipt(swap.handle.txHash)).toBeNull()
    // Looked at again: neither the swap nor its cancellation can land, and nothing was charged
    // for either.
    const result = await reconcile(swap, minedTiming())
    expect(result).toEqual({
      status: 'cancelled',
      ...swap.handle,
      feeWei: 0n,
      totalFeeWei: 0n,
    })
    await expectFreed(swap.nonce)
  })

  it('a swap still within its deadline is sent again as recorded, not cancelled', async () => {
    const swap = await submitSwap()
    await chain.send('anvil_dropTransaction', [swap.handle.txHash])
    const result = await reconcile(swap, minedTiming())
    expect(result).toMatchObject({ status: 'confirmed', txHash: swap.handle.txHash })
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation).toBeUndefined()
    await expectFreed(swap.nonce)
  })
})
