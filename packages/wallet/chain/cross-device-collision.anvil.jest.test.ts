/**
 * INTEGRATION: another device of the same account spends a message's coin at the same moment,
 * on a real EVM node (anvil).
 *
 * Real: the node, the wallet's provider, signing, the typed custody and Level stores, directory
 * admission and sealing. The other device's transaction is signed here with the coin's own key
 * (what the other device holds), at the nonce this wallet's payment was signed at.
 *
 * Not real, and said so: the relay. Delivery is the wallet-level relay stand-in of
 * `canonical-two-wallets.testutil` (as in `evm-parallel-send.anvil.jest.test.ts`); the real relay
 * binary runs in `yarn --cwd packages/bot regtest:monad-cross-device`.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'net'
import { dirname, join } from 'path'
import { FeeData, JsonRpcProvider, Transaction, Wallet, hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  fixture,
  roots,
  mailboxes,
  offlineChain,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import { nativeMemberSuperseded } from '../storage/evm-native-operation-journal'
import { LevelOutgoingMessageStore, type StoredMessage } from '../storage/outgoing-message-store'
import { evmStealthTransactionSetOperationId } from './evm-stealth-payments'
import { recipientAssetPaymentFromPrepared } from '../message-item-plugins/stealth-asset/from-prepared'
import type { StealthPaymentIntent } from '../stealth-payment'
import { detachPaidContactStamp } from './canonical-contact-recovery'

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
const STAMP = 10n ** 15n
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: cross-device-collision.anvil needs an anvil binary (set ANVIL_BIN).')
const suite = anvilBin ? describe : describe.skip

suite('another device of the account spends a message coin at the same moment (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let bobMailbox: InboxRecord[]
  /** Every row the wallet wrote, by digest. */
  const written = new Map<string, StoredMessage[]>()
  /** What the relay stand-in does with the next request: store it (default) or refuse it. */
  let beforeJudge: (() => Promise<void>) | undefined
  let relay: { stored: number; payments: Transaction[][]; precheck: boolean }
  const mine = (blocks = 1) => chain.send('anvil_mine', [`0x${blocks.toString(16)}`])

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
    offlineChain.reset()
    offlineChain.relayBroadcasts = false
    mailboxes.clear()
    written.clear()
    beforeJudge = undefined
    relay = { stored: 0, payments: [], precheck: true }
    const put = LevelOutgoingMessageStore.prototype.put
    jest.spyOn(LevelOutgoingMessageStore.prototype, 'put').mockImplementation(async function (this: LevelOutgoingMessageStore, row) {
      await put.call(this, row)
      written.set(row.digest, [...(written.get(row.digest) ?? []), structuredClone(row)])
    })
    f = await fixture({ transactionSetPolicy: undefined })
    alice = f.alice
    bobMailbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    const base = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(alice, {
      ...base,
      // The relay stand-in stores the message and broadcasts its payments, as the relay does.
      fetch: async (url, init) => {
        const restored = restoreCanonicalRequest({
          body: new Uint8Array(init.body!),
          contentType: init.headers['Content-Type'],
        })
        const payments = restored.parts.transactions.map(raw => Transaction.from(hexlify(raw)))
        // The relay's own check before it stores anything (`judge_payments`): a payment whose
        // nonce another transaction used, or a sender that cannot cover its payments.
        if (beforeJudge) {
          const run = beforeJudge
          beforeJudge = undefined
          await run()
        }
        if (relay.precheck) {
          const dead = await judge(payments)
          if (dead) return refusal(url, restored.identity, dead)
        }
        const answer = await base.fetch!(url, init)
        relay.stored++
        relay.payments.push(payments)
        for (const tx of payments) void chain.broadcastTransaction(tx.serialized).catch(() => undefined)
        return answer
      },
    })
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  async function judge(payments: Transaction[]): Promise<string | undefined> {
    const known = await Promise.all(payments.map(tx => chain.getTransaction(tx.hash!)))
    if (known.some(found => found?.blockNumber != null)) return undefined
    const owed = new Map<string, bigint>()
    for (const tx of payments) {
      if (tx.nonce < (await chain.getTransactionCount(tx.from!, 'pending'))) return 'stale_nonce'
      owed.set(tx.from!, (owed.get(tx.from!) ?? 0n) + tx.value + tx.gasLimit * tx.gasPrice!)
    }
    for (const [sender, total] of owed)
      if (total > (await chain.getBalance(sender, 'latest'))) return 'insufficient_total'
    return undefined
  }
  function refusal(url: string, identity: unknown, reason: string) {
    const answer = new TextEncoder().encode(JSON.stringify({ version: 1, phase: 'dead', identity, reason }))
    let read = false
    return {
      status: 200,
      url,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      body: {
        getReader: () => ({
          read: async () => (read ? { done: true as const } : ((read = true), { done: false as const, value: answer })),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }
  }

  /** Starts a paid message held just before anything of it leaves the wallet. */
  async function heldSend(n: number, stampValue = STAMP) {
    let reached!: (digest: string) => void
    const atHold = new Promise<string>(resolve => (reached = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const sent = f.chain.directMessages
      .send({
        wallet: alice,
        recipient: f.bob.identity.address,
        items: [{ type: 'text', text: `message ${n}` }],
        stampValue,
        messageId: ID(n),
        onAttemptCreated: async digest => {
          reached(digest)
          await released
        },
      })
      .then(
        () => 'returned',
        (error: Error) => `${error.name}: ${error.message}`,
      )
    const digest = await atHold
    return { digest, release, sent }
  }

  const rowOf = (digest: string) => written.get(digest)!.at(-1)!
  const operationOf = (id: string) => alice.transactionSetPreparer!.readOperation(id)
  const keyOf = (account: string) =>
    evmWalletInternals(alice).coinList!.all().find(coin => coin.account === account.toLowerCase())!.privateKey
  const summaryOf = (digest: string) =>
    f.chain.directMessages.paymentSummaryOf?.({ wallet: alice, payloadDigest: digest })
  const describe = (operation: Awaited<ReturnType<typeof operationOf>>) =>
    operation!.members.map(m =>
      `${m.transactionSet?.role} ${m.source.address}:${Transaction.from(m.unsignedTransaction).nonce} ${nativeMemberSuperseded(m) ? 'superseded' : m.observation.state}`)

  /** The other device's transaction at `nonce` of `account`, spending `value` of it. */
  async function takeNonce(account: string, nonce: number, value: bigint) {
    const foreign = await new Wallet(keyOf(account), chain).sendTransaction({
      type: 0,
      to: Wallet.createRandom().address,
      value,
      nonce,
      gasLimit: 21000n,
      gasPrice: 2n * 10n ** 9n,
    })
    expect((await foreign.wait())?.status).toBe(1)
    // Deep enough for the wallet to act on it.
    await mine(5)
    return foreign.hash
  }

  /** Ticks the wallet (a block each pass) until `done` holds of the message's row. */
  async function reconcileUntil(digest: string, done: (row: StoredMessage) => boolean, passes = 80) {
    for (let pass = 0; pass < passes; pass++) {
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [digest], maxPutAttempts: 2 })
      if (done(rowOf(digest))) return rowOf(digest)
      await mine()
    }
    const row = rowOf(digest)
    throw new Error(
      `not reached: outcome ${row.outcome} reason ${row.reason} payments ${JSON.stringify(row.payments.map(p => p.state))} ` +
        `other ${JSON.stringify(row.otherTransactions.map(p => p.state))} replaced ${row.replacedOperationIds} summary ${summaryOf(digest)}`,
    )
  }
  const settled = (row: StoredMessage) =>
    row.outcome === 'delivered' &&
    row.payments.length > 0 &&
    !row.payments.some(p => p.state === 'pending') &&
    !row.otherTransactions.some(p => p.state === 'pending')

  /** What the chain carried to `destinations`, by transactions other than `excluded`. */
  async function paidOnChain(payments: readonly { rawTx: string }[]) {
    let total = 0n
    for (const payment of payments) {
      const tx = Transaction.from(payment.rawTx)
      const receipt = await chain.getTransactionReceipt(tx.hash!)
      expect(receipt?.status).toBe(1)
      total += tx.value
    }
    return total
  }

  /** A later send that needs the money the collided account still holds is not refused as tied
   * up in a send that can never land. */
  async function laterSendGoesThrough(n: number, stampValue: bigint) {
    const later = await f.chain.directMessages
      .send({ wallet: alice, recipient: f.bob.identity.address, items: [{ type: 'text', text: 'later' }], stampValue, messageId: ID(n) })
      .then(
        result => result.payloadDigest,
        (error: Error) => `${error.name}: ${error.message}`,
      )
    expect(later).toMatch(/^[0-9a-f]{64}$/)
  }

  it('a nonce taken by a transaction of a different value: the message is paid from other coins, and what the account still holds is spendable again', async () => {
    // The payment takes the account's lower nonce; the set's change transfers follow it.
    jest.spyOn(Math, 'random').mockReturnValue(0.99)
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    const held = await heldSend(1)
    const first = rowOf(held.digest)
    const original = (await operationOf(first.transactionSetOperationId!))!
    const payment = original.members.find(m => m.transactionSet?.role === 'payment')!
    expect(payment.source.address).toBe(main)
    expect(original.members.filter(m => m.source.address === main).length).toBeGreaterThan(1)
    const planned = Transaction.from(payment.signed!.rawTransaction)
    // The other device spends most of the account at that nonce: the set's later transfers were
    // signed against money that is no longer there.
    await takeNonce(main, planned.nonce, 9n * 10n ** 17n)
    held.release()
    // The relay refuses it before storing anything (the nonce is used); it is not ended for that.
    expect(await held.sent).toMatch(/Another transaction used the coin/)
    const done = await reconcileUntil(held.digest, settled)
    expect(done.replacedOperationIds).toEqual([first.transactionSetOperationId])
    expect(bobMailbox).toHaveLength(1)
    expect(relay.stored).toBe(1)
    // Paid once, in full, by other transactions; the taken one never landed.
    expect(await paidOnChain(done.payments)).toBe(STAMP)
    expect(done.payments.some(p => Transaction.from(p.rawTx).hash === planned.hash)).toBe(false)
    expect(await chain.getTransactionReceipt(planned.hash!)).toBeNull()
    expect(summaryOf(held.digest)).toBe('paid')
    // The earlier set: its payment's nonce used by the other transaction, everything after it
    // given up; none of it holds the account or counts as money on its way back.
    const old = (await operationOf(first.transactionSetOperationId!))!
    expect(describe(old).filter(state => /payment/.test(state))).toEqual([expect.stringMatching(/superseded$/)])
    expect(describe(old).filter(state => /change/.test(state)).every(state => state.endsWith('abandoned'))).toBe(true)
    for (const m of old.members.filter(m => m.transactionSet?.role === 'change'))
      expect(await chain.getTransactionReceipt(m.signed!.transactionHash)).toBeNull()
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
    await laterSendGoesThrough(2, 5n * 10n ** 16n)
  })

  it('a message the relay already stored whose payment another transaction took: the same amount goes to the same destination, once', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99)
    // The relay's check passed while both transactions were waiting: it stored the message.
    relay.precheck = false
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    const held = await heldSend(1)
    const first = rowOf(held.digest)
    const original = (await operationOf(first.transactionSetOperationId!))!
    const payment = original.members.find(m => m.transactionSet?.role === 'payment')!
    const planned = Transaction.from(payment.signed!.rawTransaction)
    await takeNonce(main, planned.nonce, 9n * 10n ** 17n)
    held.release()
    expect(await held.sent).toBe('returned')
    expect(bobMailbox).toHaveLength(1)
    await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [held.digest] })
    const waiting = (await operationOf(first.transactionSetOperationId!))!
    const own = waiting.members.filter(member => member.transactionSet?.role !== 'payment')
    expect(own.length).toBeGreaterThan(0)
    expect(own.every(member => member.exposed && member.observation.state !== 'abandoned' &&
      member.observation.state !== 'included-success')).toBe(true)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    expect(rowOf(held.digest).otherTransactions.some(payment => payment.state === 'pending')).toBe(true)
    // The unresolved original must not block an independent funded source's real send.
    const before = alice.pool.records().length
    const spare = alice.pool.ensureSize(before + 1)[before]!
    await alice.pool.flush()
    await (await dev.sendTransaction({ to: spare.address, value: 5n * 10n ** 15n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const unrelated = await alice.transactionSetPreparer!.constructTransactionSet({
      operationId: 'unrelated-while-exposed-own-moves-short', amountWei: 10n ** 15n,
      sourceAccounts: [spare.address], kdf: () => dev.address,
    })
    await alice.transactionSetSubmission!.sendTransaction(unrelated)
    expect((await chain.getTransactionReceipt(unrelated.bundle[0]!.txHash))?.status).toBe(1)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    // Restart while the original remains financially unresolved, with the same signed graph.
    await alice.close()
    alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    installCanonicalDirectory(alice, await f.directoryFor('alice-reopened', alice, f.bob))
    expect((await operationOf(first.transactionSetOperationId!))!.members.map(member => member.signed))
      .toEqual(original.members.map(member => member.signed))
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(true)
    // Explicit independent test-only deposit: temporary insufficiency never invalidated the
    // old exposed own bytes. Their original fees/amounts/signatures must now recover unchanged.
    await (await dev.sendTransaction({ to: main, value: 9n * 10n ** 17n })).wait()
    await mine(5)
    // A node that includes transactions only in its next block (as Monad's does): the repayment
    // is still waiting when the pass that sent it ends, and a later pass finishes it.
    await chain.send('evm_setAutomine', [false])
    const done = await reconcileUntil(held.digest, row =>
      row.repayments?.every(repayment => repayment.state === 'spent') === true &&
      !row.otherTransactions.some(p => p.state === 'pending'))
    expect(done.repayments).toEqual([
      { payment: 0, operationId: `${first.transactionSetOperationId}-p0`, state: 'spent' },
    ])
    expect(summaryOf(held.digest)).toBe('repaid')
    // The destination the delivered message names holds exactly the stamp, once; the taken
    // payment never landed.
    expect(await chain.getBalance(planned.to!)).toBe(STAMP)
    expect(await chain.getTransactionReceipt(planned.hash!)).toBeNull()
    const repaid = (await operationOf(`${first.transactionSetOperationId}-p0`))!
    const repayment = repaid.members.filter(m => m.transactionSet?.role === 'payment')
    expect(repayment).toHaveLength(1)
    expect(Transaction.from(repayment[0]!.signed!.rawTransaction).to!.toLowerCase()).toBe(planned.to!.toLowerCase())
    // Every exposed original own move lands as signed once independently funded again.
    const old = (await operationOf(first.transactionSetOperationId!))!
    expect(old.members.map(member => member.signed)).toEqual(original.members.map(member => member.signed))
    expect(old.members.every(member => (member.earlierSignings?.length ?? 0) === 0)).toBe(true)
    let originalFees = 0n
    for (const member of old.members.filter(member => member.transactionSet?.role !== 'payment')) {
      const receipt = await chain.getTransactionReceipt(member.signed!.transactionHash)
      expect(receipt?.status).toBe(1)
      originalFees += receipt!.fee
    }
    expect(originalFees <= BigInt(original.maximumFeeWei)).toBe(true)
    // None of the account's coins is held by the earlier set (the repayment may hold the account).
    expect(evmWalletInternals(alice).coinList!.all().filter(coin =>
      coin.holder === first.transactionSetOperationId && coin.state !== 'spent')).toEqual([])
    await chain.send('evm_setAutomine', [true])
    // Resolved: nothing more is done for it, and it is paid again once only.
    for (let pass = 0; pass < 5; pass++) {
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [held.digest], maxPutAttempts: 2 })
      await mine()
    }
    expect(rowOf(held.digest).repayments).toHaveLength(1)
    await laterSendGoesThrough(2, 5n * 10n ** 16n)
  })

  it.each([false, true])('a partial collision rebuilds only when the untaken payment cannot already be in flight (earlier authorization=%s)', async earlierAuthorization => {
    // Two coins, neither covering the stamp alone: the payment is two transfers.
    const reserve = 4n * 21_000n * 2n * 10n ** 9n
    const before = alice.pool.records().length
    const rows = alice.pool.ensureSize(before + 2).slice(before)
    await alice.pool.flush()
    let nonce = await chain.getTransactionCount(dev.address, 'latest')
    await Promise.all(
      (await Promise.all(rows.map(row => dev.sendTransaction({ to: row.address, value: (STAMP * 6n) / 10n + reserve, nonce: nonce++ }))))
        .map(tx => tx.wait()),
    )
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const held = await heldSend(1)
    const first = rowOf(held.digest)
    expect(first.payments).toHaveLength(2)
    const [taken, untaken] = first.payments.map(p => Transaction.from(p.rawTx))
    await takeNonce(taken!.from!, taken!.nonce, 10n ** 14n)
    // Money for the payment built again.
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    if (earlierAuthorization) await alice.transactionSetPreparer!.authorizeSubmission(first.transactionSetOperationId!)
    held.release()
    expect(await held.sent).toMatch(/Another transaction used the coin/)
    if (earlierAuthorization) {
      for (let pass = 0; pass < 3; pass++) {
        await f.chain.directMessages.reconcileAttempts({wallet: alice, payloadDigests: [held.digest]})
        await mine(5)
      }
      const pending = rowOf(held.digest)
      expect(pending.outcome).toBeUndefined()
      expect(pending.request).toEqual(first.request)
      expect(pending.replacedOperationIds).toBeUndefined()
      expect(alice.transactionSetPreparer!.isSourceReserved(untaken!.from!)).toBe(true)
      expect(await chain.getTransactionReceipt(untaken!.hash!)).toBeNull()
      return
    }
    const done = await reconcileUntil(held.digest, settled)
    expect(done.replacedOperationIds).toEqual([first.transactionSetOperationId])
    expect(bobMailbox).toHaveLength(1)
    expect(await paidOnChain(done.payments)).toBe(STAMP)
    // Neither original payment landed; the untaken one was never handed to anyone.
    expect(await chain.getTransactionReceipt(taken!.hash!)).toBeNull()
    expect(await chain.getTransactionReceipt(untaken!.hash!)).toBeNull()
    const old = (await operationOf(first.transactionSetOperationId!))!
    const payments = old.members.filter(m => m.transactionSet?.role === 'payment')
    expect(payments.map(m => (nativeMemberSuperseded(m) ? 'superseded' : m.observation.state)).sort())
      .toEqual(['abandoned', 'superseded'])
    expect(alice.transactionSetPreparer!.isSourceReserved(untaken!.from!)).toBe(false)
    // The untaken coin is the wallet's again (spent by the rebuilt payment, or free).
    const coins = evmWalletInternals(alice).coinList!.all().filter(coin => coin.account === untaken!.from!.toLowerCase())
    expect(coins.some(coin => coin.state === 'unspent' || coin.state === 'spent')).toBe(true)
    expect(coins.some(coin => coin.state === 'pending_receipt' && coin.holder === first.transactionSetOperationId)).toBe(false)
  })

  it('multipart detachment policy waits for every old stamp part (native-preparer shape coverage)', async () => {
    // Supplemental policy coverage: the normal app writer carves a single stamp reserve.
    // This real native graph deliberately uses geometric change without that writer policy.
    await f.close()
    f = await fixture({ transactionSetPolicy: () => ({
      sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
      gasPriceWei: 1_000_000_000n, paymentGasLimit: () => 21000n,
      changeGasLimit: 21000n, paymentFeeIsExact: true, dustWei: 210_000_000_000_000n,
      radix: 2, jitterBps: 1500, maxChangeOutputs: 20, head: 100,
    }) })
    alice = f.alice
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const main = (await alice.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const preparer = alice.transactionSetPreparer!
    const lifecycle = alice.transactionSetLifecycle!
    const operationId = 'multipart-shape-contact'
    const messageId = 'ab'.repeat(16)
    const stageId = `stamp-${messageId}`
    const contactAmount = 10n ** 16n
    const stampAmount = 8n * 10n ** 17n
    const feeCap = 10n ** 17n
    await preparer.constructTransactionSet({ operationId, amountWei: contactAmount,
      maxFeeWei: feeCap, kdf: () => f.bob.identity.address.raw })
    const destinations = f.bob.pool.ensureSize(32).map(record => record.address)
    await f.bob.pool.flush()
    const stamp = await preparer.appendTransactionSet({ operationId, stageId,
      amountWei: stampAmount, maxFeeWei: feeCap, kdf: index => destinations[index]! })
    expect(stamp.bundle.length).toBeGreaterThan(1)
    const original = (await preparer.readOperation(operationId))!
    const contacts = original.members.filter(member => member.transactionSet?.role === 'payment' && member.transactionSet.stageId === undefined)
    const stamps = original.members.filter(member => member.transactionSet?.stageId === stageId && member.transactionSet.role === 'payment')
    const signed = original.members.map(member => member.signed)
    await preparer.authorizeSubmission(operationId)
    for (let pass = 0; pass < 3; pass++) { await lifecycle.replay(operationId, { payments: false }); await mine(5); await lifecycle.observe(operationId, chain) }
    for (const contact of contacts) {
      await preparer.markExposed(operationId, original.members.indexOf(contact))
      await (await chain.broadcastTransaction(contact.signed!.rawTransaction)).wait()
    }
    await lifecycle.observe(operationId, chain)
    for (const member of stamps) await preparer.markExposed(operationId, original.members.indexOf(member))
    // Opaque row sentinels test unchanged message identity here; full app cryptography and
    // actual mailbox delivery are covered by the seven original-operation cases below.
    const row: StoredMessage = {
      version: 2, consumerId: `frank-dm:${messageId}`, digest: 'cd'.repeat(32),
      recipientSubject: toHex(f.bob.identity.compressedPubKey), createdAt: Date.now(),
      transactionSetOperationId: operationId, transactionSetStageId: stageId,
      paymentOperationId: 'multipart-original-payment', unstored: true,
      payments: stamp.bundle.map(payment => ({ source: 'coin', address: payment.sourceAccount,
        rawTx: payment.rawTransaction, state: 'pending' })), otherTransactions: [],
      construction: { network: 'MONT', payload: 'cafe', context: 'beef',
        amountWei: stampAmount.toString(), boundary: 'multipart-shape' },
      request: { body: 'deadbeef', contentType: 'multipart/mixed' },
    }
    const owner: Parameters<typeof detachPaidContactStamp>[0] = {
      installedNetworkTag: 'MONT', chainId: 10143n,
      transactionSets: { preparer, lifecycle, provider: chain,
        refresh: () => alice.refreshTransactionSetInventory!(), untilBlock: async () => undefined,
        sendTransaction: prepared => alice.transactionSetSubmission!.sendTransaction(prepared),
        resolvePaymentOperation: async (id, amount) => {
          if (id !== row.paymentOperationId || amount !== stampAmount) throw new Error('Different original payment')
          return operationId
        },
      },
    }
    const take = async (member: typeof stamps[number]) => {
      const tx = Transaction.from(member.signed!.rawTransaction)
      await takeNonce(tx.from!, tx.nonce, 1n)
      await lifecycle.observe(operationId, chain)
    }
    await take(stamps[0]!)
    for (const live of stamps.slice(1)) {
      const tx = Transaction.from(live.signed!.rawTransaction)
      expect(await chain.getTransactionCount(tx.from!)).toBe(tx.nonce)
      expect(await chain.getBalance(tx.from!)).toBeGreaterThanOrEqual(tx.value + tx.gasLimit * tx.gasPrice!)
    }
    expect(await detachPaidContactStamp(owner, row)).toBeUndefined()
    expect(await preparer.readOperation(`stamp-${messageId}`)).toBeUndefined()
    for (const member of stamps.slice(1)) await take(member)
    const recovered = (await detachPaidContactStamp(owner, row))!
    expect(recovered.originalCombinedOperationId).toBe(operationId)
    expect(recovered.paymentOperationId).toBe(row.paymentOperationId)
    expect(recovered.digest).toBe(row.digest)
    expect(recovered.construction).toMatchObject(row.construction!)
    expect((await preparer.readOperation(operationId))!.members.map(member => member.signed)).toEqual(signed)
    expect(await chain.getBalance(f.bob.identity.address.raw)).toBe(contactAmount)
    expect(stamps.reduce((sum, member) => sum + Transaction.from(member.signed!.rawTransaction).value, 0n)).toBe(stampAmount)
    for (const member of stamps) {
      expect(await chain.getTransactionReceipt(member.signed!.transactionHash)).toBeNull()
      expect(nativeMemberSuperseded((await preparer.readOperation(operationId))!.members[original.members.indexOf(member)]!)).toBe(true)
    }
  })

  async function heldCombinedSend(feeAllowanceMultiplier = 1n, multipleSources = false) {
    jest.spyOn(Math, 'random').mockReturnValue(0.99)
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    if (multipleSources) {
      const before = alice.pool.records().length
      const sources = alice.pool.ensureSize(before + 2).slice(before)
      await alice.pool.flush()
      for (const source of sources)
        await (await dev.sendTransaction({to: source.address, value: 7n * 10n ** 15n})).wait()
    } else await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const intent0 = {
      operationId: 'contact-collision', chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
      recipientSpendPublicKey: f.bob.identity.compressedPubKey, amountAtomic: 10n ** 16n,
    }
    const quote = await alice.stealthPayments!.quote!(intent0)
    const stamp = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP })
    if (stamp.status !== 'available') throw new Error('stamp unavailable')
    const intent: StealthPaymentIntent = {
      ...intent0, maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic * feeAllowanceMultiplier,
      messageStamp: { amountAtomic: STAMP, maxNativeFeeAtomic: stamp.maximumNativeFeeAtomic * feeAllowanceMultiplier },
    }
    const prepared = await alice.stealthPayments!.prepare(intent)
    let reached!: (digest: string) => void
    const atHold = new Promise<string>(resolve => (reached = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const sent = f.chain.directMessages
      .send({
        wallet: alice, recipient: f.bob.identity.address, messageId: ID(1),
        paymentOperationId: intent.operationId, stampValue: STAMP,
        items: [recipientAssetPaymentFromPrepared(prepared)],
        onEnvelopeDurable: d => alice.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: d }),
        onAttemptCreated: async digest => {
          reached(digest)
          await released
        },
      })
      .then(() => 'returned', (error: Error) => `${error.name}: ${error.message}`)
    const digest = await atHold
    const first = rowOf(digest)
    expect(first.transactionSetStageId).toBeDefined()
    const operationId = evmStealthTransactionSetOperationId(intent.operationId)
    const original = (await operationOf(operationId))!
    const stampPayment = original.members.find(m =>
      m.transactionSet?.role === 'payment' && m.transactionSet.stageId === first.transactionSetStageId)!
    const planned = Transaction.from(stampPayment.signed!.rawTransaction)
    return { intent, prepared, digest, first, operationId, original, stampPayment, planned, release, sent }
  }

  it.each([false, true])('background recovery withholds contact payments before durable relay storage (already authorized=%s)', async alreadyAuthorized => {
    const { intent, prepared, operationId, original, release, sent, digest } = await heldCombinedSend()
    if (alreadyAuthorized) await alice.transactionSetPreparer!.authorizeSubmission(operationId)
    beforeJudge = async () => {
      expect((await operationOf(operationId))!.submissionAuthorized === true).toBe(alreadyAuthorized)
      const contact = original.members.find(m => m.transactionSet?.role === 'payment' && m.transactionSet.stageId === undefined)!
      for (let pass = 0; pass < 3; pass++) {
        await alice.reobserveNativeOperations!()
        await mine(5)
      }
      expect(await chain.getTransactionReceipt(contact.signed!.transactionHash)).toBeNull()
      expect(await chain.getBalance(prepared.recipientAddress)).toBe(0n)
    }
    release()
    expect(await sent).toBe('returned')
    const delivered = await reconcileUntil(digest, settled)
    expect(delivered.outcome).toBe('delivered')
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(intent.amountAtomic)
  })
  it.each(['automatic', 'fee-approval', 'link-cut', 'signed-cut', 'delivery-cut', 'multiple-sources', 'partial-contact'] as const)('an already included contact finishes its original delivery after every stamp is taken (%s)', async variant => {
    const feeReview = variant === 'fee-approval'
    const { intent, prepared, digest, first, operationId, original, stampPayment, planned, release, sent } = await heldCombinedSend(feeReview ? 1n : 100n, variant === 'multiple-sources' || variant === 'partial-contact')
    const contacts = original.members.filter(m => m.transactionSet?.role === 'payment' && m.transactionSet.stageId === undefined)
    if (variant === 'multiple-sources' || variant === 'partial-contact') expect(contacts.length).toBeGreaterThan(1)
    // An earlier process may already have authorized and sent the contact before relay storage.
    await alice.transactionSetPreparer!.authorizeSubmission(operationId)
    beforeJudge = async () => {
      const contact = original.members.find(m => m.transactionSet?.role === 'payment' && m.transactionSet.stageId === undefined)!
      if ((await chain.getBalance(stampPayment.source.address)) < 10n ** 14n)
        await (await dev.sendTransaction({ to: stampPayment.source.address, value: 10n ** 14n })).wait()
      await takeNonce(stampPayment.source.address, planned.nonce, 1n)
      for (let pass = 0; pass < 3; pass++) {
        await alice.reobserveNativeOperations!()
        await mine(5)
      }
      for (const member of variant === 'partial-contact' ? contacts.slice(0, 1) : contacts) {
        await alice.transactionSetPreparer!.markExposed(operationId, original.members.indexOf(member))
        if (!(await chain.getTransactionReceipt(member.signed!.transactionHash)))
          await (await chain.broadcastTransaction(member.signed!.rawTransaction)).wait()
      }
      await alice.reobserveNativeOperations!()
      expect((await operationOf(operationId))!.members.find(m => m.signed?.rawTransaction === contact.signed!.rawTransaction)!.observation.state).toBe('included-success')
      if (feeReview) jest.spyOn(alice.provider, 'getFeeData').mockResolvedValue(new FeeData(4000000000n, 4000000000n, 0n))
    }
    release()
    expect(await sent).toMatch(/Another transaction used the coin/)
    if (variant === 'partial-contact') {
      for (let pass = 0; pass < 3; pass++) {
        await f.chain.directMessages.reconcileAttempts({wallet: alice, payloadDigests: [digest]})
        await mine(5)
      }
      const held = rowOf(digest)
      expect(held.originalCombinedOperationId).toBeUndefined()
      expect(held.outcome).toBeUndefined()
      expect(held.request).toEqual(first.request)
      expect(held.construction?.payload).toBe(first.construction?.payload)
      expect(bobMailbox).toHaveLength(0)
      for (const member of contacts.slice(1)) {
        await alice.transactionSetPreparer!.markExposed(operationId, original.members.indexOf(member))
        await (await chain.broadcastTransaction(member.signed!.rawTransaction)).wait()
      }
      await alice.reobserveNativeOperations!()
    }
    const reopen = async () => {
      const directory = evmWalletInternals(alice).canonicalDirectory!
      await alice.close()
      alice = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
      installCanonicalDirectory(alice, directory)
      if (feeReview) jest.spyOn(alice.provider, 'getFeeData').mockResolvedValue(new FeeData(4000000000n, 4000000000n, 0n))
    }
    if (variant.endsWith('-cut')) {
      const write = jest.mocked(LevelOutgoingMessageStore.prototype.put).getMockImplementation()!
      let interrupted = false
      jest.mocked(LevelOutgoingMessageStore.prototype.put).mockImplementation(async function(this: LevelOutgoingMessageStore, row) {
        await write.call(this, row)
        const cut = row.originalCombinedOperationId !== undefined && (
          (variant === 'link-cut' && row.payments.length === 0) ||
          (variant === 'signed-cut' && row.request !== undefined && row.payments.length > 0) ||
          (variant === 'delivery-cut' && row.outcome === 'delivered'))
        if (cut && !interrupted) { interrupted = true; throw new Error('interrupted after durable recovery write') }
      })
      await expect(f.chain.directMessages.reconcileAttempts({wallet: alice, payloadDigests: [digest], maxPutAttempts: 2})).rejects.toThrow('interrupted after durable recovery write')
      jest.mocked(LevelOutgoingMessageStore.prototype.put).mockImplementation(write)
      expect(interrupted).toBe(true)
      await reopen()
    }
    if (feeReview) {
      await reconcileUntil(digest, row => row.reason === 'stamp_recovery_fee_required', 16)
      expect(f.chain.directMessages.recoveryFeeRequiredOf!({wallet: alice, payloadDigest: digest})).toBe(true)
      await f.chain.directMessages.discardAttempt?.({wallet: alice, payloadDigest: digest})
      expect(rowOf(digest).outcome).toBeUndefined()
      expect(rowOf(digest).originalCombinedOperationId).toBe(operationId)
      const review = (await f.chain.directMessages.recoveryFeeReview!({wallet: alice, payloadDigest: digest}))!
      expect(review.paidContactAtomic).toBe(intent.amountAtomic)
      expect(review.requiredTotalNetworkFeeAtomic).toBeGreaterThan(review.maximumTotalNetworkFeeAtomic)
      const params = {wallet: alice, payloadDigest: digest, recoveryOperationId: review.recoveryOperationId,
        maximumTotalNetworkFeeAtomic: review.requiredTotalNetworkFeeAtomic}
      await expect(f.chain.directMessages.approveRecoveryFee!({...params, maximumTotalNetworkFeeAtomic: review.requiredTotalNetworkFeeAtomic - 1n})).rejects.toThrow('fee')
      await expect(f.chain.directMessages.approveRecoveryFee!({...params, recoveryOperationId: 'another-original'})).rejects.toThrow('another operation')
      await f.chain.directMessages.approveRecoveryFee!(params)
      await f.chain.directMessages.approveRecoveryFee!(params)
      expect(f.chain.directMessages.recoveryFeeRequiredOf!({wallet: alice, payloadDigest: digest})).toBe(false)
      await reopen()
    }
    const delivered = await reconcileUntil(digest, settled, 16)
    expect(delivered.outcome).toBe('delivered')
    expect(delivered).toMatchObject({ originalCombinedOperationId: operationId })
    expect(delivered.construction?.payload).toBe(first.construction?.payload)
    expect(delivered.construction?.context).toBe(first.construction?.context)
    expect(delivered.digest).toBe(digest)
    expect(delivered.paymentOperationId).toBe(intent.operationId)
    expect(await f.chain.directMessages.endOf!({wallet: alice,payloadDigest:digest})).toBeUndefined()
    const contact = (await operationOf(operationId))!.members.find(m => m.transactionSet?.role === 'payment' && m.transactionSet.stageId === undefined)!
    expect(contact.observation.state).toBe('included-success')
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(intent.amountAtomic)
    expect(bobMailbox).toHaveLength(1)
    expect(await chain.getTransactionReceipt(stampPayment.signed!.transactionHash)).toBeNull()
    expect(await paidOnChain(delivered.payments)).toBe(STAMP)
    for (let pass = 0; pass < 3; pass++)
      await f.chain.directMessages.reconcileAttempts({wallet: alice, payloadDigests: [digest]})
    expect(bobMailbox).toHaveLength(1)
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(intent.amountAtomic)
  })
  it('a payment to a contact whose combined set another transaction took: it ends saying so, nothing paid, nothing held', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99)
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const intent0 = {
      operationId: 'contact-collision', chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
      recipientSpendPublicKey: f.bob.identity.compressedPubKey, amountAtomic: 10n ** 16n,
    }
    const quote = await alice.stealthPayments!.quote!(intent0)
    const stamp = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP })
    if (stamp.status !== 'available') throw new Error('stamp unavailable')
    const intent: StealthPaymentIntent = {
      ...intent0, maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
      messageStamp: { amountAtomic: STAMP, maxNativeFeeAtomic: stamp.maximumNativeFeeAtomic },
    }
    const prepared = await alice.stealthPayments!.prepare(intent)
    let reached!: (digest: string) => void
    const atHold = new Promise<string>(resolve => (reached = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const sent = f.chain.directMessages
      .send({
        wallet: alice, recipient: f.bob.identity.address, messageId: ID(1),
        paymentOperationId: intent.operationId, stampValue: STAMP,
        items: [recipientAssetPaymentFromPrepared(prepared)],
        onEnvelopeDurable: d => alice.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: d }),
        onAttemptCreated: async digest => {
          reached(digest)
          await released
        },
      })
      .then(() => 'returned', (error: Error) => `${error.name}: ${error.message}`)
    const digest = await atHold
    const first = rowOf(digest)
    expect(first.transactionSetStageId).toBeDefined()
    const operationId = evmStealthTransactionSetOperationId(intent.operationId)
    const original = (await operationOf(operationId))!
    const stampPayment = original.members.find(m =>
      m.transactionSet?.role === 'payment' && m.transactionSet.stageId === first.transactionSetStageId)!
    const planned = Transaction.from(stampPayment.signed!.rawTransaction)
    // The other device holds that account's key too, and what pays its gas.
    if ((await chain.getBalance(stampPayment.source.address)) < 10n ** 14n) {
      await (await dev.sendTransaction({ to: stampPayment.source.address, value: 10n ** 14n })).wait()
    }
    await takeNonce(stampPayment.source.address, planned.nonce, 1n)
    release()
    expect(await sent).toMatch(/Another transaction used the coin/)
    const ended = await reconcileUntil(digest, row => row.outcome === 'dead')
    expect(ended.reason).toBe('payment_taken')
    expect(await f.chain.directMessages.endOf!({ wallet: alice, payloadDigest: digest })).toEqual({ reason: 'payment-taken' })
    expect(bobMailbox).toHaveLength(0)
    // No payment of the set landed (the contact's nor the stamp); the wallet's own move that
    // funded the stamp's account may have, and stays the wallet's. None of it is held.
    const old = (await operationOf(operationId))!
    for (const member of old.members) {
      if (member.observation.state === 'included-success') {
        expect(member.transactionSet?.role).not.toBe('payment')
        continue
      }
      expect(member.observation.state === 'abandoned' || nativeMemberSuperseded(member)).toBe(true)
      expect(await chain.getTransactionReceipt(member.signed!.transactionHash)).toBeNull()
    }
    expect(old.members.filter(m => m.transactionSet?.role === 'payment').map(m =>
      nativeMemberSuperseded(m) ? 'superseded' : m.observation.state)).toEqual(['abandoned', 'superseded'])
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(0n)
    await laterSendGoesThrough(2, 5n * 10n ** 16n)
  })
  it('a contact payment of a combined set another transaction took, the stamp untouched: the relay (which checks only the stamp) is not handed the message; it ends saying so', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99)
    const main = (await alice.getReceiveAddress()).raw.toLowerCase()
    await (await dev.sendTransaction({ to: main, value: 10n ** 18n })).wait()
    await mine(5)
    await alice.refreshTransactionSetInventory!()
    const intent0 = {
      operationId: 'contact-collision-carried', chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
      recipientSpendPublicKey: f.bob.identity.compressedPubKey, amountAtomic: 10n ** 16n,
    }
    const quote = await alice.stealthPayments!.quote!(intent0)
    const stamp = await f.chain.directMessages.quoteStamp!({ wallet: alice, stampValue: STAMP })
    if (stamp.status !== 'available') throw new Error('stamp unavailable')
    const intent: StealthPaymentIntent = {
      ...intent0, maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
      messageStamp: { amountAtomic: STAMP, maxNativeFeeAtomic: stamp.maximumNativeFeeAtomic },
    }
    const prepared = await alice.stealthPayments!.prepare(intent)
    let reached!: (digest: string) => void
    const atHold = new Promise<string>(resolve => (reached = resolve))
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const sent = f.chain.directMessages
      .send({
        wallet: alice, recipient: f.bob.identity.address, messageId: ID(3),
        paymentOperationId: intent.operationId, stampValue: STAMP,
        items: [recipientAssetPaymentFromPrepared(prepared)],
        onEnvelopeDurable: d => alice.stealthPayments!.expose({ operationId: intent.operationId, payloadDigest: d }),
        onAttemptCreated: async digest => {
          reached(digest)
          await released
        },
      })
      .then(() => 'returned', (error: Error) => `${error.name}: ${error.message}`)
    const digest = await atHold
    const first = rowOf(digest)
    expect(first.transactionSetStageId).toBeDefined()
    const operationId = evmStealthTransactionSetOperationId(intent.operationId)
    const original = (await operationOf(operationId))!
    // The contact payment (the operation's own, no stage) travels inside the message; the relay
    // sees and checks only the stamp.
    const contactPayment = original.members.find(m =>
      m.transactionSet?.role === 'payment' && m.transactionSet.stageId === undefined)!
    // The other device uses that account's next nonce: the contact payment's own, or that of the
    // set's move from the same account it stands on.
    const next = await chain.getTransactionCount(contactPayment.source.address, 'latest')
    expect(next).toBeLessThanOrEqual(Transaction.from(contactPayment.signed!.rawTransaction).nonce)
    await takeNonce(contactPayment.source.address, next, 1n)
    release()
    expect(await sent).toMatch(/Another transaction used the coin/)
    const ended = await reconcileUntil(digest, row => row.outcome === 'dead')
    expect(ended.reason).toBe('payment_taken')
    expect(await f.chain.directMessages.endOf!({ wallet: alice, payloadDigest: digest })).toEqual({ reason: 'payment-taken' })
    expect(bobMailbox).toHaveLength(0)
    // No payment of the set landed (the contact's nor the stamp); the wallet's own move that
    // funded the stamp's account may have, and stays the wallet's. None of it is held.
    const old = (await operationOf(operationId))!
    for (const member of old.members) {
      if (member.observation.state === 'included-success') {
        expect(member.transactionSet?.role).not.toBe('payment')
        continue
      }
      expect(member.observation.state === 'abandoned' || nativeMemberSuperseded(member)).toBe(true)
      expect(await chain.getTransactionReceipt(member.signed!.transactionHash)).toBeNull()
    }
    // Both payments are given up: the taken nonce was the contact payment's own or a move it
    // stands on, and the stamp was withdrawn with it (the relay never held it).
    const paymentStates = old.members.filter(m => m.transactionSet?.role === 'payment').map(m =>
      nativeMemberSuperseded(m) ? 'superseded' : m.observation.state)
    expect(paymentStates).toHaveLength(2)
    for (const state of paymentStates) expect(['abandoned', 'superseded']).toContain(state)
    expect(alice.transactionSetPreparer!.isSourceReserved(main)).toBe(false)
    expect(await chain.getBalance(prepared.recipientAddress)).toBe(0n)
    await laterSendGoesThrough(2, 5n * 10n ** 16n)
  })
})
