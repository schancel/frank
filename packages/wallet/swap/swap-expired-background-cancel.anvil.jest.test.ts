/**
 * INTEGRATION: the wallet itself, with no swap screen running, never hands out a swap again once
 * the chain is past the deadline the swap carries; it cancels it instead. On real chain software
 * (`anvil`, chain ID 10143).
 *
 * The deadline is journaled with the call when it is sent (`ContractCallParams.deadline`). The
 * wallet's own background pass (`reobserveNativeOperations`, which a host's poll calls) and
 * every other place it re-sends an exposed call (a resume, its looks at the main account) make
 * one decision: past the deadline, the call is given up at its nonce (the cancellation of
 * `chain/evm-contract-cancel.ts`, recorded before it is broadcast); within it, a lost call is
 * handed out again, the same bytes.
 *
 * Real: the node, block time, the mempool (automine off, `anvil_dropTransaction` for a lost
 * broadcast), the wallet's provider, signing, the native journal and its Level stores, and the
 * Universal Router calldata. Not real, and said so: the router contract (code that accepts any
 * call, at the deployment's router address) and the relay (offline stand-in).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
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
import {
  EvmLegacyConsolidator,
  swapRecordItemOf,
} from '../chain/evm-legacy-consolidator'
import type { EvmContractCallRecord } from '../storage/evm-native-operation-journal'
import { encodeSwap, findToken, routesFor } from './uniswap-v4'
import { createEvmChain } from '../chain/evm-chain'
import { withDefaultMessageItems } from '../chain/message-items.testutil'
import type { DirectMessageReceived } from '../chain/active-chain'
import { consumeEvmSelfNotes } from '../evm-received-coin-manager'
import { evmWalletInternals } from '../evm-wallet'
import {
  EVM_CANCELLATION_STAGE,
  summarizeEvmNativeOperation,
} from '../chain/evm-native-operation-status'
import type { WalletSyncItem } from '@frank/cashweb/types/messages'

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

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil')
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}
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
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: swap-expired-background-cancel.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

suite('the wallet’s own background pass cancels a swap past its deadline instead of re-sending it (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let main: string
  /** Every raw transaction any provider here offered the node, the wallet's own included. */
  let offered: string[]
  let spy: jest.SpyInstance | undefined

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
    offered = []
  })
  afterEach(async () => {
    spy?.mockRestore()
    spy = undefined
    await chain?.send('evm_setAutomine', [true]).catch(() => undefined)
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  /** From here on, every `eth_sendRawTransaction` is remembered in `offered`. */
  const watchOffers = () => {
    const send = JsonRpcProvider.prototype.send
    spy = jest
      .spyOn(JsonRpcProvider.prototype, 'send')
      .mockImplementation(async function (this: JsonRpcProvider, method, params) {
        if (method === 'eth_sendRawTransaction')
          offered.push(((params as string[])[0]!).toLowerCase())
        return send.call(this, method, params)
      })
  }
  const latestTime = async () => (await chain.getBlock('latest'))!.timestamp
  /** One block whose time is past `deadline`, mined with nothing in it. */
  const passDeadline = async (deadline: number) => {
    await chain.send('evm_setNextBlockTimestamp', [deadline + 5])
    await chain.send('evm_mine', [])
    expect(await latestTime()).toBeGreaterThan(deadline)
  }
  const rowOf = (operationId: string) =>
    alice.getNativeOperations!().find(row => row.operationId === operationId)!
  const reopen = async () => {
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
  }

  /** A real Universal Router swap of 1,000 wei of MON with its record and deadline, sent
   * through the wallet as the swap flow sends it, then lost: the node no longer knows it. */
  async function submitLostSwap() {
    const deadline = (await latestTime()) + 60
    const call = encodeSwap({
      deployment,
      route,
      amountIn: 1_000n,
      minimumAmountOut: 1n,
      deadline,
    })
    const record: EvmContractCallRecord = {
      kind: 'swap',
      venueId: deployment.id,
      account: main,
      assetIn: { symbol: MON.symbol, address: null, decimals: MON.decimals },
      amountIn: '1000',
      assetOut: { symbol: USDC.symbol, address: USDC.address, decimals: USDC.decimals },
      quotedAmountOut: '2',
      minimumAmountOut: '1',
      interfaceFeeAmount: '0',
      networkFeeWei: '0',
      route: { zeroForOne: route.zeroForOne },
    }
    const nonce = await chain.getTransactionCount(main, 'latest')
    await chain.send('evm_setAutomine', [false])
    const handle = await alice.sendContractCall!({
      to: { raw: call.to },
      data: call.data,
      value: call.value,
      record,
      deadline,
    })
    const row = rowOf(handle.operationId)
    expect(row.deadline).toBe(deadline)
    const raw = Transaction.from(row.members[0]!.signed!.rawTransaction).serialized
    expect(Transaction.from(raw).nonce).toBe(nonce)
    await chain.send('anvil_dropTransaction', [handle.txHash])
    return { deadline, handle, nonce, raw: raw.toLowerCase() }
  }

  /** The account is free again and holds what the chain says, with nothing of the swap open. */
  async function expectFreed(nonce: number) {
    expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 1)
    // What the wallet shows comes from its own look at the chain.
    const funds = await alice.getContractCallFunds!()
    expect(alice.getUnresolvedContractCalls!()).toEqual([])
    expect(funds.mainBusy).toBe(false)
    expect(funds.mainBalance).toBe(await chain.getBalance(main))
  }

  it('a lost swap whose deadline passes with no swap screen running is cancelled by the background pass, never re-sent, and the account frees, also after restarts', async () => {
    const swap = await submitLostSwap()
    // The wallet closes (no swap flow, no page) and the deadline passes meanwhile.
    await alice.close()
    await passDeadline(swap.deadline)
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    watchOffers()
    const before = await chain.getBalance(main)

    // The host's poll: the wallet's own background pass, nothing of the swap's.
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation
    expect(cancellation).toBeDefined()
    expect(offered).toContain(cancellation!.rawTransaction.toLowerCase())
    expect(offered).not.toContain(swap.raw)

    await chain.send('evm_mine', [])
    const receipt = (await chain.getTransactionReceipt(cancellation!.transactionHash))!
    expect(receipt.status).toBe(1)
    const cancel = (await chain.getTransaction(cancellation!.transactionHash))!
    expect(cancel.from.toLowerCase()).toBe(main)
    expect(cancel.to!.toLowerCase()).toBe(main)
    expect(cancel.value).toBe(0n)
    expect(cancel.nonce).toBe(swap.nonce)
    expect(await chain.getTransactionReceipt(swap.handle.txHash)).toBeNull()
    // Nothing was swapped: the account paid the cancellation's fee, no more.
    expect(await chain.getBalance(main)).toBe(before - receipt.gasUsed * receipt.gasPrice)
    await expectFreed(swap.nonce)

    // Restarted with the cancellation landed: still nothing of the swap is offered again.
    await reopen()
    await chain.send('evm_setAutomine', [true])
    await alice.reobserveNativeOperations!()
    await alice.resumeNativeOperation!(swap.handle.operationId).catch(() => undefined)
    await expectFreed(swap.nonce)
    expect(offered).not.toContain(swap.raw)
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation?.transactionHash).toBe(
      cancellation!.transactionHash,
    )
  })

  it('a cancellation that lands is told to the account’s other device with its fee: both devices then show the same balance and the same fee', async () => {
    // Device A's notes to itself, as its composition hands them to the relay.
    const notes: WalletSyncItem[] = []
    f.config.emitWalletSync = async item => {
      notes.push(item)
    }
    // Device B: the same account with its own storage. One process holds one open handle of an
    // account, so the two devices take turns, as two machines would each run one.
    const deviceBChain = withDefaultMessageItems(
      createEvmChain({
        ...f.config,
        walletStorageLocation: join(f.root, 'device-b'),
        emitWalletSync: async () => undefined,
      }),
    )
    const openB = async () =>
      (await deviceBChain.createWallet(roots(0))) as EvmChainWalletHandle
    // Device B first sees the main account holding what it was funded with.
    await alice.close()
    let deviceB = await openB()
    expect((await deviceB.getReceiveAddress()).raw.toLowerCase()).toBe(main)
    const fundedB = await deviceB.getSpendableBalance!()
    await deviceB.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    // What device A shows before the swap: its coin list holds the main account's coin.
    await alice.getSpendableBalance!()

    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
    await chain.send('evm_mine', [])
    await chain.send('evm_setAutomine', [true])
    const receipt = (await chain.getTransactionReceipt(cancellation.transactionHash))!
    expect(receipt.status).toBe(1)
    const fee = receipt.gasUsed * receipt.gasPrice
    expect(fee).toBeGreaterThan(0n)

    // Device A sees its cancellation in a block and records the fee it charged.
    await expectFreed(swap.nonce)
    // Its coin list settles the cancellation from that receipt, as a payment's (#2075): the
    // coin at the swap's nonce is spent, and the next one holds what the chain shows, with no
    // read of the account and nothing left for a poll to do.
    const listA = evmWalletInternals(alice).coinList!
    expect(listA.get(main, swap.nonce)?.state).toBe('spent')
    expect(listA.latestOf(main)).toMatchObject({
      nonce: swap.nonce + 1,
      state: 'unspent',
      valueWei: await chain.getBalance(main),
    })
    expect(evmWalletInternals(alice).coinListSync!.isDirty(main)).toBe(false)
    expect(await alice.transactionSetPreparer!.spendableNowWei()).toBeGreaterThan(0n)
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation!.included?.feeWei).toBe(
      fee.toString(),
    )
    // What History reads of it on device A: a fee-only cancellation, the cancellation's hash
    // and fee on its member.
    const statusA = summarizeEvmNativeOperation(rowOf(swap.handle.operationId))
    expect(statusA.purpose).toBe('cancellation')
    expect(statusA.members[0]).toMatchObject({
      transactionHash: cancellation.transactionHash,
      feeWei: fee.toString(),
    })
    expect(statusA.feeCoverage).toBe('complete')
    expect(await alice.flushNativeSync!()).toEqual([])
    // A note for the cancellation: its signed bytes, and the fee in its debit, as an ordinary
    // send's note carries its fee.
    const note = notes.find(item => item.txHash === cancellation.transactionHash)
    expect(note).toMatchObject({
      type: 'wallet-sync',
      direction: 'out',
      rawTx: cancellation.rawTransaction,
      spentInputs: [{ address: main, nonce: swap.nonce, valueWei: fee.toString() }],
      createdOutputs: [{ valueWei: '0' }],
      operation: { id: `tx-${swap.handle.txHash.toLowerCase()}`, stage: EVM_CANCELLATION_STAGE },
    })
    expect(note!.createdOutputs![0]!.address.toLowerCase()).toBe(main)
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation!.syncApplied).toBe(true)
    // Delivered once: a later flush sends nothing again.
    const sent = notes.length
    await alice.flushNativeSync!()
    expect(notes).toHaveLength(sent)
    // Durable: after a restart the journal still holds the fee and the delivery, and nothing is
    // sent again.
    await reopen()
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation).toMatchObject({
      included: { feeWei: fee.toString(), blockHash: receipt.blockHash.toLowerCase() },
      syncApplied: true,
    })
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(notes).toHaveLength(sent)
    // The host's poll, as after any contract call: the main account's next coin is listed.
    await alice.reobserveNativeOperations!()
    const spendableA = await alice.getSpendableBalance!()
    const balanceA = await alice.getBalance()
    // The account was funded with 10^18 wei and paid nothing but the cancellation's fee.
    expect(balanceA).toBe(10n ** 18n - fee)
    expect(balanceA).toBe(await chain.getBalance(main))
    await alice.close()

    // Device B reads the note to itself, as its inbox does.
    deviceB = await openB()
    try {
      const own = deviceB.identity.address.raw
      const message = {
        senderAddress: { raw: own },
        recipientAddress: { raw: own },
        items: [note!],
        payloadDigest: 'ab'.repeat(32),
        stampValueWei: 0n,
        receivedTime: Date.now(),
      } as unknown as DirectMessageReceived
      expect(await consumeEvmSelfNotes(deviceB, message)).toMatchObject({ kind: 'consumed' })

      // The same fee recorded on both devices...
      const notedB = (await deviceB.getNotedSends!()).find(
        send => send.txHash === cancellation.transactionHash.toLowerCase(),
      )
      expect(notedB?.inclusion?.feeWei).toBe(fee.toString())
      expect(notedB?.state).toBe('included')
      // Named as device A names it, and History keeps it although it went to an own account.
      expect(notedB?.purpose).toBe('cancellation')
      expect(notedB?.toOwnAccount).toBe(true)
      // ...and the same balance: what the account holds after the fee.
      expect(await deviceB.getSpendableBalance!()).toBe(spendableA)
      expect(spendableA).toBeGreaterThan(0n)
      expect(spendableA).toBeLessThan(fundedB)
      expect(await deviceB.getBalance()).toBe(balanceA)
    } finally {
      await deviceB.close()
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    }
  })

  it('a cancellation whose receipt could not be read at first has its fee recorded by a later background pass', async () => {
    const notes: WalletSyncItem[] = []
    f.config.emitWalletSync = async item => {
      notes.push(item)
    }
    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
    await chain.send('evm_mine', [])
    await chain.send('evm_setAutomine', [true])
    // The node fails every read of the cancellation's receipt while the wallet first sees the
    // call's nonce taken.
    const send = JsonRpcProvider.prototype.send
    const failing = jest
      .spyOn(JsonRpcProvider.prototype, 'send')
      .mockImplementation(async function (this: JsonRpcProvider, method, params) {
        if (
          method === 'eth_getTransactionReceipt' &&
          ((params as string[])[0] ?? '').toLowerCase() === cancellation.transactionHash
        )
          throw new Error('node unavailable')
        return send.call(this, method, params)
      })
    try {
      await alice.getContractCallFunds!()
    } finally {
      failing.mockRestore()
    }
    const member = rowOf(swap.handle.operationId).members[0]!
    expect(member.observation.state).toBe('missing')
    expect(member.cancellation!.included).toBeUndefined()

    // The host's next poll, with no contract call made: the receipt is read again.
    await alice.reobserveNativeOperations!()
    const receipt = (await chain.getTransactionReceipt(cancellation.transactionHash))!
    const fee = receipt.gasUsed * receipt.gasPrice
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation!.included?.feeWei).toBe(
      fee.toString(),
    )
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(notes.find(item => item.txHash === cancellation.transactionHash)).toMatchObject({
      spentInputs: [{ address: main, nonce: swap.nonce, valueWei: fee.toString() }],
    })
  })

  it('a cancellation that never took the nonce (another transaction did) is read again only at a slowing pace, and never again once the chain is final past it', async () => {
    const notes: WalletSyncItem[] = []
    f.config.emitWalletSync = async item => {
      notes.push(item)
    }
    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
    // The cancellation is lost, and another transaction of the account (another device's)
    // takes the nonce.
    await chain.send('anvil_dropTransaction', [cancellation.transactionHash])
    await chain.send('anvil_impersonateAccount', [main])
    await chain.send('eth_sendTransaction', [
      {
        from: main,
        to: dev.address,
        value: '0x1',
        nonce: '0x' + swap.nonce.toString(16),
        gas: '0x5208',
        gasPrice: '0x' + (2n * GAS_PRICE).toString(16),
      },
    ])
    await chain.send('evm_mine', [])
    await chain.send('evm_setAutomine', [true])
    await alice.getContractCallFunds!()
    expect(rowOf(swap.handle.operationId).members[0]!.observation.state).toBe('missing')

    // Every read of the cancellation's receipt from here on is counted.
    let reads = 0
    const send = JsonRpcProvider.prototype.send
    const counting = jest
      .spyOn(JsonRpcProvider.prototype, 'send')
      .mockImplementation(async function (this: JsonRpcProvider, method, params) {
        if (
          method === 'eth_getTransactionReceipt' &&
          ((params as string[])[0] ?? '').toLowerCase() === cancellation.transactionHash
        )
          reads++
        return send.call(this, method, params)
      })
    const realNow = Date.now.bind(Date)
    let offset = 0
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      // The first background pass looks; one right after it waits its turn.
      await alice.reobserveNativeOperations!()
      expect(reads).toBe(1)
      await alice.reobserveNativeOperations!()
      expect(reads).toBe(1)
      // Blocks pass and so does the wait: it looks once more, with the head final past the
      // block that showed the nonce taken, and ends.
      for (let i = 0; i < 3; i++) await chain.send('evm_mine', [])
      offset += 60 * 60_000
      await alice.reobserveNativeOperations!()
      expect(reads).toBe(2)
      // Never again: no further read, however long it waits, so it holds no probe of a pass.
      for (const hours of [2, 4, 8]) {
        offset += hours * 60 * 60_000
        await alice.reobserveNativeOperations!()
      }
      expect(reads).toBe(2)
    } finally {
      clock.mockRestore()
      counting.mockRestore()
    }
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation!.included).toBeUndefined()
    expect(await alice.flushNativeSync!()).toEqual([])
    expect(notes.find(item => item.txHash === cancellation.transactionHash)).toBeUndefined()
  })

  it('a resume of an exposed swap past its deadline gives it up instead of re-sending it', async () => {
    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    watchOffers()
    await alice.resumeNativeOperation!(swap.handle.operationId)
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation
    expect(cancellation).toBeDefined()
    expect(offered).not.toContain(swap.raw)
    expect(offered).toContain(cancellation!.rawTransaction.toLowerCase())
    await chain.send('evm_mine', [])
    await expectFreed(swap.nonce)
  })

  it('a resume that began within the deadline, while a background pass gives the call up past it, hands out the cancellation, never the swap', async () => {
    const swap = await submitLostSwap()
    // The resume is held where it waits before handing the call out: the wait for the money a
    // transaction spends to show settled (`untilFundsSettled`, blocks on Monad), outside every
    // lock, so a background pass runs meanwhile as it would on a real network.
    let release!: () => void
    let reached!: () => void
    const atHandOut = new Promise<void>(resolve => (reached = resolve))
    const held = new Promise<void>(resolve => (release = resolve))
    type Waits = { untilFundsSettled(member: unknown): Promise<void> }
    const prototype = EvmLegacyConsolidator.prototype as unknown as Waits
    const untilFundsSettled = prototype.untilFundsSettled
    const hold = jest
      .spyOn(prototype, 'untilFundsSettled')
      .mockImplementation(async function (this: Waits, member) {
        reached()
        await held
        return untilFundsSettled.call(this, member)
      })
    try {
      watchOffers()
      const resumed = alice.resumeNativeOperation!(swap.handle.operationId).catch(
        () => undefined,
      )
      await atHandOut
      // Meanwhile a later block passes the deadline and the host's poll gives the call up.
      await passDeadline(swap.deadline)
      await alice.reobserveNativeOperations!()
      const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
      expect(cancellation).toBeDefined()
      release()
      await resumed
      expect(offered).not.toContain(swap.raw)
      expect(offered).toContain(cancellation.rawTransaction.toLowerCase())
      await chain.send('evm_mine', [])
      expect((await chain.getTransactionReceipt(cancellation.transactionHash))!.status).toBe(1)
      expect(await chain.getTransactionReceipt(swap.handle.txHash)).toBeNull()
      await expectFreed(swap.nonce)
    } finally {
      release()
      hold.mockRestore()
    }
  })

  it('a cancellation lost before any block is handed out again after a restart, the same bytes, never the swap', async () => {
    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    watchOffers()
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
    await chain.send('anvil_dropTransaction', [cancellation.transactionHash])

    await reopen()
    // Twice: the first look at a transaction the node does not know is not yet a lost one.
    await alice.watchNativeOperation!(swap.handle.operationId)
    await alice.watchNativeOperation!(swap.handle.operationId)
    expect(
      offered.filter(raw => raw === cancellation.rawTransaction.toLowerCase()).length,
    ).toBeGreaterThanOrEqual(2)
    expect(offered).not.toContain(swap.raw)
    // One cancellation only: nothing else was signed at the nonce.
    expect(
      new Set(offered.map(raw => Transaction.from(raw).hash)),
    ).toEqual(new Set([cancellation.transactionHash]))
    await chain.send('evm_mine', [])
    expect((await chain.getTransactionReceipt(cancellation.transactionHash))!.status).toBe(1)
    await expectFreed(swap.nonce)
  })

  it('a swap that landed before its deadline passed is reported as landed, and nothing is cancelled', async () => {
    const swap = await submitLostSwap()
    // Another copy of it reached the node after all and is mined.
    await chain.send('eth_sendRawTransaction', [swap.raw])
    await chain.send('evm_mine', [])
    await passDeadline(swap.deadline)
    watchOffers()
    await alice.reobserveNativeOperations!()
    await alice.getContractCallFunds!()
    const row = rowOf(swap.handle.operationId)
    expect(row.members[0]!.cancellation).toBeUndefined()
    expect(row.members[0]!.observation.state).toBe('included-success')
    expect(swapRecordItemOf(row)).toMatchObject({ txHash: swap.handle.txHash })
    expect(offered).toEqual([])
    await expectFreed(swap.nonce)
  })

  it('a swap that lands after its cancellation was recorded is reported as landed, the cancellation never landing', async () => {
    const swap = await submitLostSwap()
    await passDeadline(swap.deadline)
    await alice.reobserveNativeOperations!()
    const cancellation = rowOf(swap.handle.operationId).members[0]!.cancellation!
    // The cancellation is lost and another copy of the swap reaches a block first.
    await chain.send('anvil_dropTransaction', [cancellation.transactionHash])
    await chain.send('eth_sendRawTransaction', [swap.raw])
    await chain.send('evm_mine', [])
    await alice.getContractCallFunds!()
    const row = rowOf(swap.handle.operationId)
    expect(row.members[0]!.observation.state).toBe('included-success')
    expect(swapRecordItemOf(row)).toMatchObject({ txHash: swap.handle.txHash })
    expect(await chain.getTransactionReceipt(cancellation.transactionHash)).toBeNull()
    await expectFreed(swap.nonce)
  })

  it('a lost swap still within its deadline is handed out again by the background pass, not cancelled', async () => {
    const swap = await submitLostSwap()
    watchOffers()
    await alice.reobserveNativeOperations!()
    expect(offered).toContain(swap.raw)
    expect(rowOf(swap.handle.operationId).members[0]!.cancellation).toBeUndefined()
    await chain.send('evm_mine', [])
    expect((await chain.getTransactionReceipt(swap.handle.txHash))!.status).toBe(1)
    await expectFreed(swap.nonce)
  })

  it('a call past its deadline before it was ever handed out is not sent, and frees the account', async () => {
    const deadline = (await latestTime()) - 1
    const call = encodeSwap({
      deployment,
      route,
      amountIn: 1_000n,
      minimumAmountOut: 1n,
      deadline,
    })
    const nonce = await chain.getTransactionCount(main, 'latest')
    watchOffers()
    await expect(
      alice.sendContractCall!({
        to: { raw: call.to },
        data: call.data,
        value: call.value,
        deadline,
      }),
    ).rejects.toThrow(/deadline passed/)
    expect(offered).toEqual([])
    expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce)
    expect(alice.getUnresolvedContractCalls!()).toEqual([])
    expect((await alice.getContractCallFunds!()).mainBusy).toBe(false)
  })
})
