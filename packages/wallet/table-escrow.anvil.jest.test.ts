/**
 * INTEGRATION: the player's side of a game table's buy-in (`joinTableWithBuyIn`,
 * `refundTableBuyInAndWait`) with real wallets, against GenericHTLC v2 deployed from its
 * compiled artifact on a real EVM node (`anvil`, chain ID 10143), reached by the wallet through
 * its chain configuration (`contracts.htlc`).
 *
 * - Funding: a main account short of the buy-in is topped up by the wallet's own move from its
 *   other accounts (`fundMainAccount`), and a move that was interrupted after signing is
 *   continued after a restart, never sent twice.
 * - A lock that reverted locked nothing: joining again sends a new lock.
 * - A lock whose nonce another device of the account took (superseded) can never land: joining
 *   again sends a new lock instead of waiting on it.
 * - A lock (or a refund) not in a block within the timeout is reported pending; asking again
 *   continues the same transaction.
 *
 * Real: the node, the contract, signing, the wallet's provider, native journal, coin list and
 * Level stores. The funding cases put money on the wallet's other accounts the way a wallet
 * gets it there, by paying message stamps (which leaves change on fresh accounts); their
 * delivery is the wallet-level stand-in of `chain/canonical-two-wallets.testutil`, as in
 * `chain/evm-parallel-send.anvil.jest.test.ts`. Only the RPC URL is redirected (to the node).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { ContractFactory, JsonRpcProvider, Wallet, hexlify, randomBytes } from 'ethers'
import { toHex } from '@frank/codec'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import type { EvmChainWalletHandle } from './evm-wallet-handle'
import { InMemoryNativeTransactionAttemptStore } from './chain/chain-wallet'
import {
  createEvmChain,
  installCanonicalDirectory,
  tableJoinSignerOf,
  type EvmChainConfig,
} from './chain/evm-chain'
import { fixture, mailboxes, offlineChain, roots, type Fixture } from './chain/canonical-two-wallets.testutil'
import { LegacyTransactionSetPendingError } from './chain/evm-legacy-transaction-set'
import { fixedStampDefault } from './oracle/stamp-policy.testutil'
import { nativeMemberSuperseded } from './storage/evm-native-operation-journal'
import { readHtlcLock } from './swap-escrow'
import {
  TABLE_LOCK_GAS_ALLOWANCE,
  joinTableWithBuyIn,
  lockTableBuyIn,
  refundTableBuyInAndWait,
  tableBuyInLockId,
  type TableEscrowTerms,
  type TableEscrowTiming,
} from './table-escrow'
import { anvilBinary, findAnvil, nodeSuiteReady } from './node-binaries.testutil'

const mockNode = { url: '' }
jest.mock('./evm-provider', () => {
  const actual = jest.requireActual('./evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./chain/canonical-two-wallets.testutil').offlineMailboxModule(),
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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const STAMP = 10n ** 15n
const FAST: TableEscrowTiming = {
  pollMs: 50,
  inclusionTimeoutMs: 20_000,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}
/** Gives up on inclusion almost at once: a step not mined yet is reported pending. */
const IMPATIENT: TableEscrowTiming = { ...FAST, inclusionTimeoutMs: 300 }
const messageId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const anvilBin = findAnvil()
const suite = nodeSuiteReady('table-escrow.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

suite("a player's table buy-in from its own wallet, on a real EVM node (anvil)", () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let htlc: string
  let directory: string
  const opened: EvmChainWalletHandle[] = []
  let f: Fixture | undefined

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--base-fee', '0', '--gas-price', '1000000000', '--silent'],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, { staticNetwork: true, cacheTimeout: -1 })
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
    const deployed = await new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev).deploy()
    await deployed.waitForDeployment()
    htlc = await deployed.getAddress()
    directory = mkdtempSync(join(tmpdir(), 'frank-table-escrow-'))
  })
  afterEach(async () => {
    await chain.send('evm_setAutomine', [true]).catch(() => undefined)
    for (const wallet of opened.splice(0)) await wallet.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    f = undefined
    chain?.destroy()
    node?.kill()
    rmSync(directory, { recursive: true, force: true })
  })

  const automine = (on: boolean) => chain.send('evm_setAutomine', [on])
  const mine = () => chain.send('evm_mine', [])

  /** A device of the test account (`roots(0)`) with its own storage. */
  async function device(name: string): Promise<EvmChainWalletHandle> {
    const config: EvmChainConfig = {
      networkId: 'monad-testnet',
      rpcChain: 'monad-testnet',
      localNodeWithoutSpendRule: true,
      chainId: 10143,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      relayBaseUrl: 'http://127.0.0.1:1',
      networkTag: 'MONT',
      contracts: { htlc },
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      resolveDefaultStamp: fixedStampDefault(STAMP),
      defaultTopicVoteValueWei: 1_000n,
      subAccountPoolSize: 0,
      walletStorageLocation: join(directory, name),
    }
    const wallet = (await createEvmChain(config).createWallet(roots(0))) as EvmChainWalletHandle
    opened.push(wallet)
    return wallet
  }
  const mainOf = async (wallet: EvmChainWalletHandle) => (await wallet.getContractCallFunds!()).mainAddress

  async function tableTerms(buyInWei: bigint): Promise<{ tableId: string; terms: TableEscrowTerms }> {
    const head = (await chain.getBlock('latest'))!
    return {
      tableId: toHex(randomBytes(16)),
      terms: {
        arbiter: Wallet.createRandom().address,
        hashLock: hexlify(randomBytes(32)),
        buyInWei,
        expiresAt: BigInt(head.timestamp + 24 * 60 * 60),
      },
    }
  }
  const join_ = (
    wallet: EvmChainWalletHandle,
    table: { tableId: string; terms: TableEscrowTerms },
    timing: TableEscrowTiming = FAST,
  ) =>
    joinTableWithBuyIn({
      wallet,
      reader: chain,
      signer: tableJoinSignerOf(wallet)!,
      joiner: wallet.identity.address.raw,
      contract: htlc,
      game: 'poker',
      tableId: table.tableId,
      table: table.terms,
      timing,
    })
  const refund_ = (wallet: EvmChainWalletHandle, table: { tableId: string }, lockId: string, timing = FAST) =>
    refundTableBuyInAndWait({ wallet, reader: chain, contract: htlc, game: 'poker', tableId: table.tableId, lockId, timing })
  const tableRows = (wallet: EvmChainWalletHandle, action: 'lock' | 'refund', lockId: string) =>
    wallet.getNativeOperations!().filter(
      row => row.kind === 'contract' && row.record?.kind === 'table-htlc' && row.record.action === action && row.record.lockIds[0] === lockId.toLowerCase(),
    )
  const fundingRows = (wallet: EvmChainWalletHandle, main: string) =>
    wallet.getNativeOperations!().filter(row => row.kind === 'transaction-set' && row.recipient.toLowerCase() === main.toLowerCase())

  /** The fixture's wallet after paying two stamps from a funded main account: most of its money
   * is now change on other accounts. */
  async function walletWithChange(): Promise<{ wallet: EvmChainWalletHandle; main: string }> {
    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mailboxes.clear()
    f = await fixture({ transactionSetPolicy: undefined, contracts: { htlc } })
    const bobMailbox: never[] = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    const main = await mainOf(f.alice)
    await (await dev.sendTransaction({ to: main, value: 10n ** 17n })).wait()
    const digests: string[] = []
    for (const n of [0, 1]) {
      const sent = await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: `message ${n}` }],
        stampValue: STAMP,
        messageId: messageId(n),
      })
      digests.push(sent.payloadDigest)
    }
    for (let pass = 0; ; pass++) {
      await f.chain.directMessages.reconcileAttempts({ wallet: f.alice, payloadDigests: digests })
      const states = digests.flatMap(
        digest => f!.chain.directMessages.paymentsOf?.({ wallet: f!.alice, payloadDigest: digest }) ?? ['pending'],
      )
      if (states.every(state => state === 'spent')) break
      if (pass > 200) throw new Error('stamps did not settle')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return { wallet: f.alice, main }
  }
  /** A buy-in the main account alone cannot pay (with the lock's fee allowance), and that the
   * main account and half of the other accounts can. */
  async function buyInNeedingFunds(wallet: EvmChainWalletHandle) {
    const funds = await wallet.getContractCallFunds!()
    expect(funds.otherBalance).toBeGreaterThan(0n)
    const fee = await chain.getFeeData()
    const allowance = TABLE_LOCK_GAS_ALLOWANCE * (fee.maxFeePerGas ?? fee.gasPrice)!
    const buyIn = funds.mainBalance! + funds.otherBalance! / 2n - allowance
    expect(buyIn).toBeGreaterThan(0n)
    return { buyIn, shortfall: buyIn + allowance - funds.mainBalance! }
  }

  it('moves the shortfall into the main account from the other accounts, then locks the buy-in', async () => {
    const { wallet, main } = await walletWithChange()
    const { buyIn } = await buyInNeedingFunds(wallet)
    const table = await tableTerms(buyIn)
    const mainNonce = await chain.getTransactionCount(main, 'latest')
    const joined = await join_(wallet, table)
    expect(joined.lockId).toBe(tableBuyInLockId(table.terms, main))
    const lock = await readHtlcLock(chain, htlc, joined.lockId)
    expect(lock).toMatchObject({ state: 'open', amount: buyIn })
    // One move into main, through the coin list (main signs none of it), then the lock.
    const moves = fundingRows(wallet, main)
    expect(moves).toHaveLength(1)
    for (const member of moves[0]!.members) {
      expect(member.source.address).not.toBe(main.toLowerCase())
      expect((await chain.getTransactionReceipt(member.signed!.transactionHash))!.status).toBe(1)
    }
    expect(await chain.getTransactionCount(main, 'latest')).toBe(mainNonce + 1)
  })

  it('an earlier join whose move into main was interrupted after signing is continued after a restart: one move, then the lock', async () => {
    const { wallet, main } = await walletWithChange()
    const { buyIn, shortfall } = await buyInNeedingFunds(wallet)
    const table = await tableTerms(buyIn)
    // The earlier join's move, stopped once signed.
    await automine(false)
    const interrupted = await wallet
      .fundMainAccount!({
        value: shortfall,
        onSigned: async () => {
          throw new Error('the app stopped here')
        },
      })
      .catch((error: unknown) => error)
    expect(interrupted).toBeInstanceOf(LegacyTransactionSetPendingError)
    const [pending] = wallet.getUnresolvedLegacySend!()
    expect(pending!.recipient.toLowerCase()).toBe(main.toLowerCase())
    await wallet.close()
    await automine(true)
    const reopened = (await f!.chain.createWallet(roots(0))) as EvmChainWalletHandle
    opened.push(reopened)
    const joined = await join_(reopened, table)
    expect(await readHtlcLock(chain, htlc, joined.lockId)).toMatchObject({ state: 'open', amount: buyIn })
    // The same move finished, not a second one.
    expect(fundingRows(reopened, main).map(row => row.operationId)).toEqual([pending!.operationId])
    expect(reopened.getUnresolvedLegacySend!()).toEqual([])
  })

  it('a lock that reverted locked nothing: joining again sends a new lock', async () => {
    const wallet = await device('phone')
    const main = await mainOf(wallet)
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    const table = await tableTerms(10n ** 16n)
    // Too little gas: the lock is mined and reverts.
    const reverted = await lockTableBuyIn({
      wallet,
      signer: tableJoinSignerOf(wallet)!,
      joiner: wallet.identity.address.raw,
      contract: htlc,
      game: 'poker',
      tableId: table.tableId,
      table: table.terms,
      gasLimit: 40_000n,
    })
    await mine()
    expect((await chain.getTransactionReceipt(reverted.call.txHash))!.status).toBe(0)
    await wallet.reobserveNativeOperations?.()
    const joined = await join_(wallet, table)
    expect(joined.txHash).toBeDefined()
    expect(joined.txHash).not.toBe(reverted.call.txHash)
    expect((await readHtlcLock(chain, htlc, joined.lockId))!.state).toBe('open')
    expect(tableRows(wallet, 'lock', joined.lockId)).toHaveLength(2)
  })

  it("a lock whose nonce another device took can never land: joining again sends a new lock without waiting on it", async () => {
    const phone = await device('phone')
    const main = await mainOf(phone)
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    const table = await tableTerms(10n ** 16n)
    // The phone signs its lock and hands it out, but the node never gets it.
    const send = JsonRpcProvider.prototype.send
    const spy = jest.spyOn(JsonRpcProvider.prototype, 'send').mockImplementation(async function (this: JsonRpcProvider, method, params) {
      if (method === 'eth_sendRawTransaction') throw new Error('the process stopped mid-send')
      return send.call(this, method, params)
    })
    const stranded = await join_(phone, table, IMPATIENT).catch((error: unknown) => error)
    spy.mockRestore()
    expect(stranded).toBeInstanceOf(Error)
    const lockId = tableBuyInLockId(table.terms, main)
    const [row] = tableRows(phone, 'lock', lockId)
    expect(row!.members[0]!.signed).toBeDefined()
    const strandedHash = row!.members[0]!.signed!.transactionHash
    await phone.close()
    // The laptop (same account, its own storage) sends a lock at another table on that nonce.
    const laptop = await device('laptop')
    const other = await tableTerms(10n ** 16n)
    const elsewhere = await join_(laptop, other)
    expect((await readHtlcLock(chain, htlc, elsewhere.lockId))!.state).toBe('open')
    await laptop.close()
    // The phone again: its stranded lock is found superseded, and a new one is sent.
    const phoneAgain = await device('phone')
    const started = Date.now()
    const joined = await join_(phoneAgain, table)
    expect(Date.now() - started).toBeLessThan(FAST.inclusionTimeoutMs)
    expect(joined.lockId).toBe(lockId)
    expect(joined.txHash).not.toBe(strandedHash)
    expect((await readHtlcLock(chain, htlc, lockId))!.state).toBe('open')
    expect(await chain.getTransaction(strandedHash)).toBeNull()
    // Two locks were signed: the stranded one, which the journal shows superseded, and the new.
    const rows = tableRows(phoneAgain, 'lock', lockId)
    expect(rows).toHaveLength(2)
    expect(nativeMemberSuperseded(rows[0]!.members[0]!) || rows[0]!.members[0]!.observation.state === 'abandoned').toBe(true)
  })

  it('a lock not mined yet is pending; joining again continues the same lock, and so does a pending refund', async () => {
    const wallet = await device('phone')
    const main = await mainOf(wallet)
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    const table = await tableTerms(10n ** 16n)
    await automine(false)
    const pending = await join_(wallet, table, IMPATIENT).catch((error: unknown) => error)
    expect(pending).toMatchObject({ reason: 'lock-pending', txHash: expect.any(String) })
    const lockTx = (pending as { txHash: string }).txHash
    await automine(true)
    await mine()
    const joined = await join_(wallet, table)
    // Already open by then: nothing new is sent, and one lock was ever signed.
    expect(joined.txHash === undefined || joined.txHash === lockTx).toBe(true)
    expect(tableRows(wallet, 'lock', joined.lockId)).toHaveLength(1)
    expect((await chain.getTransactionReceipt(lockTx))!.status).toBe(1)

    // After the deadline, the refund, sent and not mined yet: pending, then continued.
    await chain.send('evm_increaseTime', [24 * 60 * 60 + 60])
    await mine()
    await automine(false)
    const refundPending = await refund_(wallet, table, joined.lockId, IMPATIENT).catch((error: unknown) => error)
    expect(refundPending).toMatchObject({ reason: 'refund-pending', txHash: expect.any(String) })
    const refundTx = (refundPending as { txHash: string }).txHash
    await automine(true)
    const refunded = await refund_(wallet, table, joined.lockId)
    expect(refunded.txHash).toBe(refundTx)
    expect((await readHtlcLock(chain, htlc, joined.lockId))!.state).toBe('refunded')
    expect(tableRows(wallet, 'refund', joined.lockId)).toHaveLength(1)
  })
})
