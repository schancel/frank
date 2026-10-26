/**
 * INTEGRATION: a received stealth payment, verified on the chain, stays received when the node no
 * longer serves its transactions (a pruned node: Monad nodes and Frank's solonet keep a limited
 * window of blocks).
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143), the wallets' own
 * providers talking JSON-RPC to it, real coin selection, signing, custody and Level stores, real
 * directory admission and sealing. The payment is a set of many transactions (the sender holds
 * many small coins), as an in-chat payment from a wallet that received stamps is.
 *
 * Restricted, and said so: once the payment is verified, the recipient's provider stops serving
 * transactions, receipts and blocks below the block the payment landed after, exactly as a
 * pruned node answers (null). Every other read is the node's own answer.
 *
 * Not real: the relay. Delivery is the wallet-level relay stand-in of
 * `canonical-two-wallets.testutil`, and the sender submits its payments to the real node itself.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { JsonRpcProvider, Wallet } from 'ethers'
import { toHex } from '@frank/codec'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { fixture, mailboxes, offlineChain, type Fixture, type InboxRecord } from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import { evmStealthTransactionSetOperationId } from './evm-stealth-payments'
import { summarizeEvmNativeOperation, summarizeEvmNativeStampStages } from './evm-native-operation-status'
import { recipientAssetPaymentFromPrepared } from '../message-item-plugins/stealth-asset/from-prepared'
import { MonadStampPendingAttemptError } from '../evm-stamp-client'
import { PAYMENT_NOT_RECEIVED_AFTER_MS } from '../storage/evm-coin-store'
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
const SMALL = 10n * 21_000n * GAS_PRICE
const SMALL_COINS = 6
const ROOT = 20n * 10n ** 18n
const AMOUNT = 10n ** 18n
const STAMP = 10n ** 15n

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: received-payment-pruned.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.')
const suite = anvilBin ? describe : describe.skip

suite('a verified received payment on a node that no longer serves its blocks (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
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
    inbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), inbox)
    f.setMailbox(inbox)
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    installCanonicalDirectory(f.bob, await f.directoryFor('bob', f.bob, f.alice))
    // Alice holds many small coins and a root: her payment to bob is a set of transactions.
    const rows = f.alice.pool.ensureSize(f.alice.pool.records().length + SMALL_COINS).slice(-SMALL_COINS)
    await f.alice.pool.flush()
    let nonce = await chain.getTransactionCount(dev.address, 'latest')
    const funding = [
      dev.sendTransaction({ to: (await f.alice.getReceiveAddress()).raw, value: ROOT, nonce: nonce++ }),
      ...rows.map(row => dev.sendTransaction({ to: row.address, value: SMALL, nonce: nonce++ })),
    ]
    await Promise.all((await Promise.all(funding)).map(tx => tx.wait()))
    await f.alice.refreshTransactionSetInventory!()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  /** From now on, `wallet`'s node serves nothing below `firstKept`: what a pruned node answers. */
  function pruneBelow(wallet: EvmChainWalletHandle, firstKept: number) {
    const provider = wallet.provider
    const receipt = provider.getTransactionReceipt.bind(provider)
    const transaction = provider.getTransaction.bind(provider)
    const block = provider.getBlock.bind(provider)
    jest.spyOn(provider, 'getTransactionReceipt').mockImplementation(async hash => {
      const found = await receipt(hash)
      return found !== null && found.blockNumber < firstKept ? null : found
    })
    jest.spyOn(provider, 'getTransaction').mockImplementation(async hash => {
      const found = await transaction(hash)
      return found !== null && found.blockNumber !== null && found.blockNumber < firstKept ? null : found
    })
    jest.spyOn(provider, 'getBlock').mockImplementation(async (tag, prefetch) => {
      const found = await block(tag, prefetch)
      return found !== null && found.number < firstKept ? null : found
    })
  }

  it('stays received, at the amount that arrived, when the node later cannot show its transactions', async () => {
    const alice = f.alice
    const bob = f.bob
    const intent0 = {
      operationId: 'pruned-payment', chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
      recipientSpendPublicKey: bob.identity.compressedPubKey, amountAtomic: AMOUNT,
    }
    const quote = await alice.stealthPayments!.quote!(intent0)
    const stamp = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP })
    if (stamp.status !== 'available') throw new Error('stamp unavailable')
    const intent: StealthPaymentIntent = {
      ...intent0, maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
      messageStamp: { amountAtomic: STAMP, maxNativeFeeAtomic: stamp.maximumNativeFeeAtomic },
    }
    const prepared = await alice.stealthPayments!.prepare(intent)
    let digest: string | undefined
    try {
      digest = (await f.chain.directMessages.send({
        wallet: alice, recipient: bob.identity.address, messageId: '00000000-0000-4000-8000-000000000001',
        paymentOperationId: intent.operationId, stampValue: STAMP,
        items: [recipientAssetPaymentFromPrepared(prepared)],
        onEnvelopeDurable: d => alice.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: d }),
      })).payloadDigest
    } catch (error) {
      if (!(error instanceof MonadStampPendingAttemptError)) throw error
      digest = error.payloadHashes?.[0]
    }
    // The payment and its message's stamp are one transaction set; History shows the stamp as
    // its own send (a message stamp), the payment at what the recipient gets.
    const graph = alice.transactionSetPreparer!.getOperation(evmStealthTransactionSetOperationId(intent.operationId))!
    expect(summarizeEvmNativeOperation(graph)).toMatchObject({ intendedValueWei: AMOUNT.toString() })
    expect(summarizeEvmNativeStampStages(graph)).toEqual([
      expect.objectContaining({
        purpose: 'stamp',
        messageId: '00000000000040008000000000000001',
        intendedValueWei: STAMP.toString(),
      }),
    ])
    for (let pass = 0; pass < 100 && inbox.length === 0; pass++)
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: digest ? [digest] : [] })
    expect(inbox).toHaveLength(1)
    for (let pass = 0; pass < 100; pass++) {
      await alice.stealthPayments!.submit(intent.operationId).catch(() => undefined)
      if ((await chain.getBalance(prepared.recipientAddress)) >= AMOUNT) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(AMOUNT)

    // Bob reads the message and verifies the payment on the chain.
    await f.chain.directMessages.fetchSince({ wallet: bob, sinceMs: 0 })
    const address = prepared.recipientAddress.toLowerCase()
    const paymentOf = (all: readonly { address: string }[] | undefined) =>
      (all ?? []).find(coin => coin.address === address) as
        | { status: string; transactions?: readonly string[]; receivedAmountWei?: bigint }
        | undefined
    let verified: ReturnType<typeof paymentOf>
    for (let pass = 0; pass < 100; pass++) {
      verified = paymentOf(await bob.refreshReceivedPayments!())
      if (verified?.status === 'received') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(verified).toMatchObject({ status: 'received', receivedAmountWei: AMOUNT })
    // A set of transactions, as an in-chat payment from many coins is.
    expect(verified!.transactions!.length).toBeGreaterThan(1)

    // Blocks go by, and bob's node no longer serves the ones the payment is in. The message is
    // now long past.
    await chain.send('anvil_mine', ['0x10'])
    pruneBelow(bob, (await chain.getBlockNumber()) - 2)
    expect(await bob.provider.getTransactionReceipt(
      (await chain.getBlock('earliest'))!.hash!,
    )).toBeNull()
    const later = Date.now() + PAYMENT_NOT_RECEIVED_AFTER_MS + 60_000
    jest.spyOn(Date, 'now').mockReturnValue(later)
    for (let pass = 0; pass < 3; pass++) await bob.refreshReceivedPayments!().catch(() => undefined)

    const after = paymentOf(bob.getReceivedPayments!())
    expect(after).toMatchObject({ status: 'received', receivedAmountWei: AMOUNT })
    expect(bob.getMessagePayment!(digest!)).toMatchObject({
      contentStatus: 'received',
      contentReceivedWei: AMOUNT,
    })
    // Its money is still bob's to spend.
    bob.invalidateBalanceCache!()
    expect(await bob.getBalance()).toBeGreaterThanOrEqual(AMOUNT)
  })
})
