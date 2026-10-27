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
import { JsonRpcProvider, Transaction, Wallet, hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  fixture,
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
    // The set's own transfers that the account can no longer cover are given up.
    const old = (await operationOf(first.transactionSetOperationId!))!
    expect(describe(old).filter(state => /change/.test(state)).every(state => state.endsWith('abandoned'))).toBe(true)
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

  it('a partial collision (one of two payments taken): the message is paid once from other coins and the untaken coin is free again', async () => {
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
    held.release()
    expect(await held.sent).toMatch(/Another transaction used the coin/)
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
})
