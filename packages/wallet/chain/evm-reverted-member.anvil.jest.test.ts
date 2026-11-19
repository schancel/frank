/**
 * INTEGRATION: a transaction set some of whose members are mined and REVERTED, on real chain
 * software (`anvil`, chain ID 10143).
 *
 * What Monad testnet did to a consolidation whose paying account sent at consecutive nonces
 * without the spend-spacing rule: the later transfers were mined, charged their fee, consumed
 * their nonce and moved nothing. A local node has no reserve-balance rule, so here the member's
 * destination is given code that reverts on every call once the member is signed and before it
 * is broadcast: the same chain outcome (status 0, nonce consumed, fee paid, value not moved).
 *
 * Real: the node, the wallet's provider and JSON-RPC client, signing, the coin list, the native
 * journal and its Level stores. Not real, and said so: the relay (offline stand-in; the wallet
 * reaches the node directly).
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN, or fails
 * under FRANK_REQUIRE_NODES=1.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { LegacySendResult } from './chain-wallet'
import { fixture, mailboxes, offlineChain, roots, type Fixture } from './canonical-two-wallets.testutil'
import {
  LegacyTransactionSetFailedError,
  LegacyTransactionSetPendingError,
} from './evm-legacy-transaction-set'
import type { EvmNativeOperation } from '../storage/evm-native-operation-journal'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { anvilBinary, findAnvil, nodeSuiteReady } from '../node-binaries.testutil'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({ rpcUrl: mockNode.url, chainId: options.chainId }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
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

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** PUSH1 0 PUSH1 0 REVERT: every call to the account reverts. */
const REVERTING_CODE = '0x60006000fd'
const GAS_PRICE = 10n ** 9n

const anvilBin = findAnvil()
const suite = nodeSuiteReady('evm-reverted-member.anvil', [anvilBinary(anvilBin)]) ? describe : describe.skip

suite('a transaction set with members mined and reverted, on a real EVM node (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--base-fee', '0', '--gas-price', String(GAS_PRICE), '--silent'],
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
    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mailboxes.clear()
    f = await fixture({ transactionSetPolicy: undefined })
    alice = f.alice
  })
  afterEach(async () => {
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  const operationOf = (txHash: string): EvmNativeOperation =>
    alice.getNativeOperations!().find(row => row.members.some(member => member.signed?.transactionHash === txHash))!
  const targetOf = (member: EvmNativeOperation['members'][number]) =>
    Transaction.from(member.signed!.rawTransaction).to!
  /** Every account the coin list knows, and what the node says they hold together. */
  const coinAccounts = () => [...new Set(evmWalletInternals(alice).coinList!.all().map(coin => coin.account))]
  const held = async (accounts: readonly string[]) =>
    (await Promise.all(accounts.map(account => chain.getBalance(account)))).reduce((sum, value) => sum + value, 0n)
  /** What the app does: resume the same operation, and its reconciler observes it on every
   * poll, until the operation reports an outcome with nothing of it left to settle. */
  async function outcomeOf(transfer: Promise<LegacySendResult>): Promise<unknown> {
    let operationId: string
    let last: unknown
    try {
      last = await transfer
      return last
    } catch (error) {
      last = error
      if (!(error instanceof LegacyTransactionSetPendingError) && !(error instanceof LegacyTransactionSetFailedError)) return error
      operationId = error.operation.operationId
    }
    for (let pass = 0; pass < 100; pass++) {
      await chain.send('evm_mine', [])
      await alice.reobserveNativeOperations!().catch(() => undefined)
      try {
        last = await alice.resumeLegacySend!(operationId)
      } catch (error) {
        last = error
        if (!(error instanceof LegacyTransactionSetPendingError) && !(error instanceof LegacyTransactionSetFailedError)) return error
      }
      const row = (await alice.readNativeOperation!(operationId))!
      if (!(last instanceof LegacyTransactionSetPendingError) && row.members.every(member => member.transactionSet?.inventoryApplied)) return last
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return last
  }
  /** After the outcome: what a user sees and can spend must agree with the chain. */
  async function expectSettled(operationId: string) {
    // Nothing reconciles for ever: the set is not unresolved, its history row is not "sending",
    // no coin is held, and nothing it signed holds the main or identity account.
    expect(alice.getUnresolvedLegacySend!().map(row => row.operationId)).not.toContain(operationId)
    const row = (await alice.readNativeOperation!(operationId))!
    expect(row.members.every(member => member.transactionSet?.inventoryApplied)).toBe(true)
    expect((await alice.getBalanceParts!()).pendingOwnOperations ?? 0).toBe(0)
    expect(
      evmWalletInternals(alice)
        .coinList!.all()
        .filter(coin => coin.state === 'pending_receipt' || coin.state === 'spend_pending'),
    ).toEqual([])
    const internals = evmWalletInternals(alice)
    for (const address of [(await alice.getReceiveAddress()).raw, alice.identity.address.raw])
      expect(internals.nativeOperationOwner!.holdsSource(address)).toBe(false)
    // Send max offers everything the chain says the wallet's coins hold, less its fees.
    const max = await alice.estimateLegacyMax!({ recipient: { raw: Wallet.createRandom().address } })
    expect(max.value + max.totalFee).toBe(await held(coinAccounts()))
    // Swap funding can draw on every account but the main one, the identity account included.
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    const funds = await alice.getContractCallFunds!()
    expect(funds.mainBalance).toBe(await chain.getBalance(main))
    expect(funds.mainBusy).toBe(false)
    return funds
  }
  const fee = (member: EvmNativeOperation['members'][number]) =>
    BigInt('feeWei' in member.observation ? member.observation.feeWei : '0')

  it('a gathered Send whose change transfers revert: the payment is confirmed, the set closes, and the change stays spendable where it is', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const identity = alice.identity.address.raw
    await (await dev.sendTransaction({ to: main, value: 5n * 10n ** 16n })).wait()
    await (await dev.sendTransaction({ to: identity, value: 5n * 10n ** 16n })).wait()
    const recipient = Wallet.createRandom().address
    const value = 6n * 10n ** 16n
    let changeTargets: string[] = []
    const outcome = await outcomeOf(
      alice.sendLegacy!({
        recipient: { raw: recipient },
        value,
        // Signed and durable, not yet broadcast: the change destinations refuse every transfer.
        onSigned: async ({ txHash }) => {
          const row = operationOf(txHash)
          changeTargets = row.members.filter(member => member.transactionSet?.role === 'change').map(targetOf)
          for (const target of changeTargets) await chain.send('anvil_setCode', [target, REVERTING_CODE])
        },
      }),
    )
    expect(changeTargets.length).toBeGreaterThan(0)
    // The recipient was paid: that is the transfer's outcome, never a failure that invites
    // paying again.
    const result = outcome as LegacySendResult
    expect(result.totalValueSent).toBe(value)
    const operationId = operationOf(result.txHash).operationId
    const row = (await alice.readNativeOperation!(operationId))!
    const payment = row.members.find(member => member.transactionSet?.role === 'payment')!
    expect(result.txHash).toBe(payment.signed!.transactionHash)
    // Every fee the set paid, the reverted transfers' included.
    expect(result.totalFeePaid).toBe(row.members.reduce((sum, member) => sum + fee(member), 0n))
    // The chain's outcome: the recipient was paid, the change moved nothing and paid its fee.
    expect((await chain.getTransactionReceipt(payment.signed!.transactionHash))!.status).toBe(1)
    expect(await chain.getBalance(recipient)).toBe(value)
    for (const member of row.members.filter(member => member.transactionSet?.role === 'change')) {
      const receipt = (await chain.getTransactionReceipt(member.signed!.transactionHash))!
      expect(receipt.status).toBe(0)
      expect(member.observation.state).toBe('included-revert')
      expect(fee(member)).toBeGreaterThan(0n)
    }
    for (const target of changeTargets) expect(await chain.getBalance(target)).toBe(0n)
    expect(summarizeEvmNativeOperation(row).payment).toBe('included')
    await expectSettled(operationId)
    // The payer's residual is a coin at the nonce the chain shows, holding what the chain shows.
    const payer = payment.source.address.toLowerCase()
    const coin = evmWalletInternals(alice).coinList!.latestOf(payer)!
    expect(coin.state).toBe('unspent')
    expect(coin.nonce).toBe(await chain.getTransactionCount(payer, 'latest'))
    expect(coin.valueWei).toBe(await chain.getBalance(payer))
    expect(coin.valueWei).toBeGreaterThan(0n)
    // And a restart reads the same.
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    await expectSettled(operationId)
  })

  it('a Send whose payment reverts: the recipient gets nothing, the set closes failed, and every coin stays spendable', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const identity = alice.identity.address.raw
    await (await dev.sendTransaction({ to: main, value: 5n * 10n ** 16n })).wait()
    await (await dev.sendTransaction({ to: identity, value: 5n * 10n ** 16n })).wait()
    const recipient = Wallet.createRandom().address
    const value = 6n * 10n ** 16n
    const outcome = await outcomeOf(
      alice.sendLegacy!({
        recipient: { raw: recipient },
        value,
        onSigned: async () => {
          await chain.send('anvil_setCode', [recipient, REVERTING_CODE])
        },
      }),
    )
    expect(outcome).toBeInstanceOf(LegacyTransactionSetFailedError)
    const operationId = (outcome as LegacyTransactionSetFailedError).operation.operationId
    const row = (await alice.readNativeOperation!(operationId))!
    const payment = row.members.find(member => member.transactionSet?.role === 'payment')!
    expect((await chain.getTransactionReceipt(payment.signed!.transactionHash))!.status).toBe(0)
    expect(payment.observation.state).toBe('included-revert')
    expect(await chain.getBalance(recipient)).toBe(0n)
    expect(summarizeEvmNativeOperation(row).payment).toBe('reverted')
    await expectSettled(operationId)
    // The payer kept the value the payment did not move.
    const payer = payment.source.address.toLowerCase()
    expect(evmWalletInternals(alice).coinList!.latestOf(payer)!.valueWei).toBe(await chain.getBalance(payer))
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    await expectSettled(operationId)
  })

  // The lab wallet's stuck set: a move gathering coins into the paying account was mined and
  // reverted, so the payment (which waits for its funding to land) could never be sent. It is
  // given up (it never left the wallet), the set ends failed, and every source account,
  // the identity account among them, is spendable again at what the chain shows.
  it('a gathered Send whose funding moves revert: the unsent payment is given up, the set closes failed, and the identity account is spendable again', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const identity = alice.identity.address.raw
    await (await dev.sendTransaction({ to: main, value: 5n * 10n ** 16n })).wait()
    await (await dev.sendTransaction({ to: identity, value: 5n * 10n ** 16n })).wait()
    const recipient = Wallet.createRandom().address
    const value = 6n * 10n ** 16n
    let payer = ''
    const outcome = await outcomeOf(
      alice.sendLegacy!({
        recipient: { raw: recipient },
        value,
        // The account the coins are gathered into refuses every transfer to it.
        onSigned: async ({ txHash }) => {
          const row = operationOf(txHash)
          payer = row.members.find(member => member.transactionSet?.role === 'payment')!.source.address
          await chain.send('anvil_setCode', [payer, REVERTING_CODE])
        },
      }),
    )
    expect(outcome).toBeInstanceOf(LegacyTransactionSetFailedError)
    const operationId = (outcome as LegacyTransactionSetFailedError).operation.operationId
    const row = (await alice.readNativeOperation!(operationId))!
    const fundings = row.members.filter(member => member.transactionSet?.role === 'funding')
    expect(fundings.length).toBeGreaterThan(0)
    for (const member of fundings) {
      expect((await chain.getTransactionReceipt(member.signed!.transactionHash))!.status).toBe(0)
      expect(member.observation.state).toBe('included-revert')
    }
    // Nothing of the paying account ever left the wallet: given up, never broadcast.
    for (const member of row.members.filter(member => member.source.address === payer)) {
      expect(member.exposed).toBe(false)
      expect(member.observation.state).toBe('abandoned')
      expect(await chain.getTransaction(member.signed!.transactionHash)).toBeNull()
    }
    expect(await chain.getBalance(recipient)).toBe(0n)
    expect(summarizeEvmNativeOperation(row).payment).toBe('superseded')
    const funds = await expectSettled(operationId)
    // The identity account kept what its reverted move did not move, less that move's fee, and
    // swap funding draws on it.
    const identityHeld = await chain.getBalance(identity)
    expect(identityHeld).toBeGreaterThan(0n)
    expect(evmWalletInternals(alice).coinList!.latestOf(identity.toLowerCase())!.valueWei).toBe(identityHeld)
    expect(funds.otherBalance).toBeGreaterThan(0n)
    expect(funds.otherBalance).toBeLessThan(identityHeld)
    expect(funds.otherBalance).toBeGreaterThan(identityHeld - 10n ** 15n)
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    await expectSettled(operationId)
  })
})
