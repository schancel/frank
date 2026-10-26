/**
 * INTEGRATION: a stealth payment carried by a paid message, from a wallet holding many small coins
 * and one large root, against real chain software.
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143, a stable 1 gwei price),
 * the wallet's own provider talking JSON-RPC to it, real coin selection, signing, typed custody
 * and Level stores, real directory admission and sealing.
 *
 * Not real, and said so: the relay. The wallet reaches the node directly instead of through the
 * relay's RPC proxy, and message delivery is the wallet-level relay stand-in of
 * `canonical-two-wallets.testutil`. The failures exercised here happen before anything is handed
 * to a relay; the delivered case submits its payments to the real node itself.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { toHex } from '@frank/codec'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { fixture, mailboxes, offlineChain, roots, type Fixture, type InboxRecord } from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import { evmStealthTransactionSetOperationId } from './evm-stealth-payments'
import { recipientAssetPaymentFromPrepared } from '../message-item-plugins/stealth-asset/from-prepared'
import { NativeFeeExceededError } from './chain-wallet'
import { MonadStampPendingAttemptError } from '../evm-stamp-client'
import type { StealthPaymentIntent } from '../stealth-payment'

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

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN)) return process.env.ANVIL_BIN
  try {
    const root = dirname(dirname(require.resolve('@foundry-rs/anvil/package.json')))
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

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const GAS_PRICE = 10n ** 9n
const TRANSFER_FEE = 21_000n * GAS_PRICE
/** Like received stamps: ten transfers' fee each, the payment floor. */
const SMALL = 10n * TRANSFER_FEE
const SMALL_COINS = 12
const ROOT = 20n * 10n ** 18n
const AMOUNT = 10n ** 18n
const STAMP = 10n ** 15n
const MESSAGE = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: evm-stealth-fee-bound.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.')
const suite = anvilBin ? describe : describe.skip

suite('a stealth payment and its message stamp from many small coins and one large root (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: Awaited<ReturnType<Fixture['directoryFor']>>
  let inbox: InboxRecord[]

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(anvilBin!, ['--port', String(port), '--chain-id', '10143', '--base-fee', '0',
      '--gas-price', String(GAS_PRICE), '--silent'], { stdio: 'ignore' })
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
    inbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), inbox)
    f.setMailbox(inbox)
    directory = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(alice, directory)
    // One large root and many small single-use accounts, as a wallet that received stamps holds.
    const rows = alice.pool.ensureSize(alice.pool.records().length + SMALL_COINS).slice(-SMALL_COINS)
    await alice.pool.flush()
    let nonce = await chain.getTransactionCount(dev.address, 'latest')
    const funding = [
      dev.sendTransaction({ to: (await alice.getReceiveAddress()).raw, value: ROOT, nonce: nonce++ }),
      ...rows.map(row => dev.sendTransaction({ to: row.address, value: SMALL, nonce: nonce++ })),
    ]
    await Promise.all((await Promise.all(funding)).map(tx => tx.wait()))
    await alice.refreshTransactionSetInventory!()
  })
  afterEach(async () => {
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  /** What the review in the app authorizes: the quoted payment fee, and the stamp's quoted fee. */
  async function review(operationId: string, stampFee?: bigint): Promise<StealthPaymentIntent> {
    const intent = {
      operationId, chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
      recipientSpendPublicKey: f.bob.identity.compressedPubKey, amountAtomic: AMOUNT,
    }
    const quote = await alice.stealthPayments!.quote!(intent)
    const stamp = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP })
    if (stamp.status !== 'available') throw new Error('stamp unavailable')
    return { ...intent, maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
      messageStamp: { amountAtomic: STAMP, maxNativeFeeAtomic: stampFee ?? stamp.maximumNativeFeeAtomic } }
  }
  const send = (wallet: EvmChainWalletHandle, n: number, intent: StealthPaymentIntent, prepared: Awaited<ReturnType<NonNullable<EvmChainWalletHandle['stealthPayments']>['prepare']>>) =>
    f.chain.directMessages.send({
      wallet, recipient: f.bob.identity.address, messageId: MESSAGE(n),
      paymentOperationId: intent.operationId, stampValue: STAMP,
      items: [recipientAssetPaymentFromPrepared(prepared)],
      onEnvelopeDurable: digest => wallet.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: digest }),
    })
  const held = (wallet: EvmChainWalletHandle) =>
    evmWalletInternals(wallet).coinList!.all().filter(coin => coin.state === 'spend_pending' || coin.state === 'pending_receipt')
  const authorized = (intent: StealthPaymentIntent) => intent.maxNativeFeeAtomic + intent.messageStamp!.maxNativeFeeAtomic
  const operationFee = (wallet: EvmChainWalletHandle, id: string) =>
    wallet.transactionSetPreparer!.getOperation(id)!.members.reduce((sum, member) => {
      const tx = Transaction.from(member.signed!.rawTransaction)
      return sum + tx.gasLimit * (tx.gasPrice ?? tx.maxFeePerGas!)
    }, 0n)

  it('pays the recipient and its stamp within the fee the user authorized, and lands on the node', async () => {
    const intent = await review('stealth-within-bound')
    const prepared = await alice.stealthPayments!.prepare(intent)
    const id = evmStealthTransactionSetOperationId(intent.operationId)
    const first = alice.transactionSetPreparer!.getOperation(id)!
    // The payment gathers value across the small coins and the root, whose residual is chained
    // into change on the root itself.
    expect(new Set(first.members.map(member => member.source.address)).size).toBeGreaterThan(SMALL_COINS)
    expect(first.members.filter(member => member.source.address === (alice.mainAccount!.address).toLowerCase()).length).toBeGreaterThan(1)
    let digest: string | undefined
    try {
      digest = (await send(alice, 1, intent, prepared)).payloadDigest
    } catch (error) {
      expect(error).toBeInstanceOf(MonadStampPendingAttemptError)
      digest = (error as MonadStampPendingAttemptError).payloadHashes?.[0]
    }
    // The stamp stage was added to the same operation, and the whole of it stays in the bound.
    const graph = alice.transactionSetPreparer!.getOperation(id)!
    expect(graph.members.some(member => member.transactionSet?.stageId !== undefined)).toBe(true)
    expect(operationFee(alice, id)).toBeLessThanOrEqual(authorized(intent))
    for (let pass = 0; pass < 100 && inbox.length === 0; pass++)
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: digest ? [digest] : [] })
    expect(inbox).toHaveLength(1)
    // Delivered: the host submits the original payment (its same bytes).
    for (let pass = 0; pass < 100; pass++) {
      await alice.stealthPayments!.submit(intent.operationId).catch(() => undefined)
      if ((await chain.getBalance(prepared.recipientAddress)) >= AMOUNT) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(AMOUNT)
    // What the node charged for every member of the set is within what the user authorized.
    let charged = 0n
    for (const member of alice.transactionSetPreparer!.getOperation(id)?.members ?? graph.members) {
      const receipt = await chain.getTransactionReceipt(member.signed!.transactionHash)
      if (receipt) charged += receipt.gasUsed * receipt.gasPrice
    }
    expect(charged).toBeLessThanOrEqual(authorized(intent))
  })

  it('a message whose payment would exceed the authorized fee fails before anything is signed or sent, and frees its coins at once and after a restart', async () => {
    // Authorize no fee at all for the stamp: its stage cannot be signed within the bound.
    const intent = await review('stealth-over-bound', 0n)
    const prepared = await alice.stealthPayments!.prepare(intent)
    const id = evmStealthTransactionSetOperationId(intent.operationId)
    expect(held(alice).length).toBeGreaterThan(SMALL_COINS)
    const rootNonce = await chain.getTransactionCount((await alice.getReceiveAddress()).raw, 'latest')
    await expect(send(alice, 2, intent, prepared)).rejects.toBeInstanceOf(NativeFeeExceededError)
    // Nothing was handed to the relay or the node.
    expect(inbox).toHaveLength(0)
    expect(await chain.getTransactionCount((await alice.getReceiveAddress()).raw, 'pending')).toBe(rootNonce)
    // Its coins are spendable again right away; the payment says it was released, not sent.
    expect(held(alice)).toEqual([])
    expect(await alice.stealthPayments!.status!(intent.operationId)).toMatchObject({ status: 'failed', submitted: false, released: true })
    expect((await alice.transactionSetPreparer!.readOperation(id))?.cancelled).toBe(true)
    // A restart keeps them free.
    await alice.close()
    alice = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
    await alice.refreshTransactionSetInventory!()
    expect(held(alice)).toEqual([])
    // The same funds pay a fresh, correctly authorized payment.
    const again = await review('stealth-after-release')
    await alice.stealthPayments!.prepare(again)
    expect(alice.transactionSetPreparer!.getOperation(evmStealthTransactionSetOperationId(again.operationId))).toBeDefined()
  })

  it('a message left unsigned by a crash is ended after a restart, and Retry no longer fails on held bytes', async () => {
    const intent = await review('stealth-crashed', 0n)
    const prepared = await alice.stealthPayments!.prepare(intent)
    // The stamp stage write fails without proving anything: the record is kept, as before.
    const append = jest.spyOn(alice.transactionSetPreparer!, 'appendTransactionSet').mockRejectedValueOnce(new Error('interrupted'))
    await expect(send(alice, 3, intent, prepared)).rejects.toThrow('interrupted')
    append.mockRestore()
    expect(held(alice).length).toBeGreaterThan(SMALL_COINS)
    await alice.close()
    alice = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
    expect(held(alice).length).toBeGreaterThan(SMALL_COINS)
    const attempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: MESSAGE(3) })
    // The host's Retry names the message: the resend pass tries to sign it, which the bound
    // refuses, so it ends and its payment is released.
    const statuses = await f.chain.directMessages.reconcileAttempts({
      wallet: alice, payloadDigests: [attempt!.payloadDigest], messageIds: [MESSAGE(3)],
      onEnvelopeDurable: digest => alice.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: digest }),
    })
    expect(statuses[attempt!.payloadDigest]).toBe('dead')
    expect(held(alice)).toEqual([])
    expect(await alice.stealthPayments!.status!(intent.operationId)).toMatchObject({ released: true })
    expect(inbox).toHaveLength(0)
  })

  it('discarding a message that was never signed frees its payment', async () => {
    const intent = await review('stealth-discarded', 0n)
    const prepared = await alice.stealthPayments!.prepare(intent)
    jest.spyOn(alice.transactionSetPreparer!, 'appendTransactionSet').mockRejectedValueOnce(new Error('interrupted'))
    await expect(send(alice, 4, intent, prepared)).rejects.toThrow('interrupted')
    const attempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: MESSAGE(4) })
    await f.chain.directMessages.discardAttempt!({ wallet: alice, payloadDigest: attempt!.payloadDigest })
    expect(held(alice)).toEqual([])
    expect(await alice.stealthPayments!.status!(intent.operationId)).toMatchObject({ released: true })
    expect(await f.chain.directMessages.deliveryOf!({ wallet: alice, payloadDigest: attempt!.payloadDigest })).toBe('dead')
  })

  it('a payment that was exposed is never released, whatever happens to its message', async () => {
    const intent = await review('stealth-exposed', 0n)
    const prepared = await alice.stealthPayments!.prepare(intent)
    const id = evmStealthTransactionSetOperationId(intent.operationId)
    // One of its signed transactions may be out (handed to the node or a relay).
    await alice.transactionSetPreparer!.markExposed(id, 0)
    const before = held(alice).map(coin => `${coin.account}:${coin.nonce}`).sort()
    await expect(send(alice, 5, intent, prepared)).rejects.toBeInstanceOf(Error)
    const attempt = await f.chain.directMessages.attemptOf!({ wallet: alice, messageId: MESSAGE(5) })
    await f.chain.directMessages.discardAttempt!({ wallet: alice, payloadDigest: attempt!.payloadDigest })
    // Its stamp stage cannot be added to an exposed operation: the pass says so, and nothing moves.
    await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [attempt!.payloadDigest] }).catch(() => undefined)
    expect(held(alice).map(coin => `${coin.account}:${coin.nonce}`).sort()).toEqual(before)
    expect((await alice.transactionSetPreparer!.readOperation(id))?.cancelled).toBeFalsy()
    expect(await alice.stealthPayments!.status!(intent.operationId)).not.toMatchObject({ released: true })
    expect(await f.chain.directMessages.deliveryOf!({ wallet: alice, payloadDigest: attempt!.payloadDigest })).not.toBe('dead')
  })
})
