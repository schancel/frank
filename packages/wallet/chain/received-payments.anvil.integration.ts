/**
 * INTEGRATION: payments to a contact, received stealth payments and received stamps, with two real
 * wallets against a REAL EVM node.
 *
 * The node is `anvil` (Foundry's local dev node of a real EVM client), started by this test on a
 * free port with chain ID 10143 and stopped afterwards. Nothing here is a hand-written chain:
 * every balance, nonce, receipt and broadcast is the node's. The test fails, loudly, when no
 * `anvil` is found; it never falls back to a stand-in chain.
 *
 * What is NOT real here, and so is not shown by this test: the relay. Its HTTP surface is the
 * repo's stand-in (`canonical-two-wallets.testutil.ts`): it stores a delivered message and
 * broadcasts NOTHING, which is exactly the case "the relay delivered without broadcasting"; where
 * a test needs the relay's own broadcast it sends the request's carried transactions to the node
 * itself. The mailbox read is that stand-in's too.
 *
 * Run (from packages/wallet). The node is the repo's `@foundry-rs/anvil` dev dependency (or
 * `ANVIL_BIN=/path/to/anvil`, or `anvil` on PATH):
 *
 *   ../../node_modules/.bin/jest -i --testMatch '<rootDir>/chain/received-payments.anvil.integration.ts'
 *
 * It is not picked up by the package's default `*.jest.test.ts` pattern, so an ordinary unit run
 * on a machine without a node does not report it as passing or failing.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonRpcProvider, Transaction, Wallet, getBytes, parseEther } from 'ethers'
import { toHex } from '@frank/codec'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'

import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { ContactPaymentPendingError, type ReceivedPayment } from './chain-wallet'
import {
  fixture,
  mailboxes,
  roots,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { withDefaultMessageItems } from './message-items.testutil'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import { createEvmChain, installCanonicalDirectory } from './evm-chain'
import { deriveEvmStealthPrivateKey } from '../evm-stealth'
import { LegacyTransactionSetPendingError } from './evm-legacy-transaction-set'
import { MonadStampPendingAttemptError } from '../evm-stamp-client'
import type { LegacySendResult } from './chain-wallet'

// The wallet normally reaches its node through the relay's RPC gateway. Here it is pointed
// straight at the real node this test started: the node is real, only the route to it differs.
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: process.env.FRANK_TEST_NODE_RPC_URL,
        chainId: options.chainId,
      }),
  }
})
jest.mock('../evm-http', () => {
  const actual = jest.requireActual('../evm-http')
  return {
    ...actual,
    MonadHttpClient: class extends actual.MonadHttpClient {
      constructor(options: { chainId: number | bigint }) {
        super({
          rpcUrl: process.env.FRANK_TEST_NODE_RPC_URL,
          chainId: options.chainId,
        })
      }
    },
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

jest.setTimeout(300_000)

const CHAIN_ID = 10143
/** anvil's first well-known development account: funded by the node at genesis. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const VALUE = parseEther('0.01')
const STAMP = parseEther('0.001')

let anvil: ChildProcess | undefined
let node: JsonRpcProvider
let dev: Wallet

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

beforeAll(async () => {
  // The repo's own dev dependency (`@foundry-rs/anvil`, packages/contracts), else PATH.
  const bundled = [
    join(__dirname, '../../contracts/node_modules/.bin/anvil'),
    join(
      __dirname,
      `../../../node_modules/@foundry-rs/anvil-${process.platform}-${process.arch}/bin/anvil`,
    ),
  ].find(candidate => existsSync(candidate))
  const bin = process.env.ANVIL_BIN ?? bundled ?? 'anvil'
  if (spawnSync(bin, ['--version']).status !== 0)
    throw new Error(
      `No real EVM node to test against: \`${bin} --version\` failed. Run yarn install (the repo depends on @foundry-rs/anvil), install Foundry, or set ANVIL_BIN. This test never substitutes a stand-in chain.`,
    )
  const port = await freePort()
  anvil = spawn(
    bin,
    // A quarter-stamp spend below is above the real payment floor at this fixed gas price.
    // Default Anvil base fees made that same fixture fail admission even on unchanged main.
    ['--port', String(port), '--chain-id', String(CHAIN_ID), '--base-fee', '0', '--gas-price', '1000000000', '--silent'],
    { stdio: 'ignore' },
  )
  const url = `http://127.0.0.1:${port}`
  process.env.FRANK_TEST_NODE_RPC_URL = url
  node = new JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  await until(
    'the node to answer',
    () => node.getBlockNumber().catch(() => -1),
    block => block >= 0,
  )
  dev = new Wallet(DEV_KEY, node)
})
afterAll(async () => {
  node?.destroy()
  anvil?.kill()
})

/** Real money from the node's development account, waited for until it is in a block. */
async function fund(address: string, value: bigint) {
  const sent = await dev.sendTransaction({ to: address, value })
  await sent.wait()
}
const subjectOf = (wallet: EvmChainWalletHandle) =>
  toHex(wallet.identity.compressedPubKey)
const mainOf = async (wallet: EvmChainWalletHandle) =>
  (await wallet.getReceiveAddress()).raw.toLowerCase()
const stealthOf = (wallet: EvmChainWalletHandle): ReceivedPayment[] =>
  wallet.getReceivedPayments!().filter(coin => coin.origin === 'stealth')
const stampsOf = (wallet: EvmChainWalletHandle, digest?: string): ReceivedPayment[] =>
  wallet
    .getReceivedPayments!()
    .filter(
      coin =>
        coin.origin === 'stamp' &&
        (digest === undefined || coin.payloadDigest === digest),
    )
/** The nonce at which the transaction set carrying `txHash` starts on `account`: the transfer
 * travels with the change it splits off, so nothing of the set on the chain leaves the
 * account's nonce here. */
const setStartNonce = (wallet: EvmChainWalletHandle, txHash: string, account: string) => {
  const operation = wallet
    .getNativeOperations!()
    .find(row => row.members.some(member => member.signed?.transactionHash === txHash))!
  return Math.min(
    ...operation.members
      .filter(member => member.source.address === account && member.signed)
      .map(member => Transaction.from(member.signed!.rawTransaction).nonce),
  )
}
/** A transfer whose change moves wait out the chain's spend spacing returns pending while they
 * land; the app's reconciler then finishes the same operation. This does the same. */
async function finished(
  wallet: EvmChainWalletHandle,
  transfer: Promise<LegacySendResult>,
): Promise<LegacySendResult> {
  let operationId: string
  try {
    return await transfer
  } catch (error) {
    if (!(error instanceof LegacyTransactionSetPendingError)) throw error
    operationId = error.operation.operationId
  }
  for (let pass = 0; pass < 200; pass++) {
    try {
      return await wallet.resumeLegacySend!(operationId)
    } catch (error) {
      if (!(error instanceof LegacyTransactionSetPendingError)) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new Error('transfer did not settle')
}
/** Reads the chain through the wallet until nothing of it is pending any more. */
async function settled(wallet: EvmChainWalletHandle) {
  await until(
    'the wallet to see its received payments on the chain',
    () => wallet.refreshReceivedPayments!(),
    coins => coins.every(coin => coin.status !== 'pending'),
  )
  wallet.invalidateBalanceCache!()
}

describe('payments between two wallets on a real EVM node', () => {
  let f!: Fixture
  let alice: EvmChainWalletHandle
  let bob: EvmChainWalletHandle
  let bobMailbox: InboxRecord[]
  let extraRoots: string[]
  let snapshot: string | undefined
  const poll = (wallet: EvmChainWalletHandle, chain = f.chain) =>
    chain.directMessages.fetchSince({ wallet, sinceMs: 0 })
  /** A paid message whose stamp is funded within its own set waits for that funding to be
   * spendable (blocks after it lands) before the relay is given it, and its send answers
   * "pending; nothing failed". A real chain keeps making blocks and the host's tick finishes the
   * same message; here the node makes a block and the test ticks, until it is delivered. */
  const delivered = async (
    wallet: EvmChainWalletHandle,
    sending: Promise<{ payloadDigest: string }>,
    { paid = false }: { paid?: boolean } = {},
  ): Promise<{ payloadDigest: string }> => {
    let digest: string | undefined
    try {
      digest = (await sending).payloadDigest
    } catch (error) {
      if (!(error instanceof MonadStampPendingAttemptError) || error.reason !== 'awaiting-funding')
        throw error
      digest = error.payloadHashes[0]!
      for (let pass = 0; ; pass++) {
        if (pass === 50) throw new Error('message was not delivered')
        await node.send('evm_mine', [])
        const outcomes = await f.chain.directMessages.reconcileAttempts({
          wallet,
          payloadDigests: [digest],
        })
        if (outcomes[digest] === 'delivered') break
        if (outcomes[digest] === 'dead') throw new Error('message refused')
      }
    }
    // With `paid`, also until its payments are on the chain: the tick after delivery hands a
    // payment not yet seen there to the node again, the same bytes.
    for (let pass = 0; paid; pass++) {
      const states = f.chain.directMessages.paymentsOf!({ wallet, payloadDigest: digest })
      if (states && states.length > 0 && states.every(state => state === 'spent')) break
      if (pass === 50) throw new Error('message payments did not land')
      await f.chain.directMessages.reconcileAttempts({ wallet, payloadDigests: [digest] })
      await node.send('evm_mine', [])
    }
    return { payloadDigest: digest }
  }
  /** What the relay does with a message's payments: broadcasts each carried transaction. */
  const relayBroadcasts = async (requestIndex: number) => {
    const { parts } = restoreCanonicalRequest(f.requests[requestIndex])
    for (const raw of parts.transactions) {
      const hex = toHexString(raw)
      // The recipient's wallet may have put it on the chain already: a second broadcast of a
      // mined transaction is refused by the node and changes nothing.
      await node.broadcastTransaction(hex).catch(() => undefined)
      expect((await node.waitForTransaction(Transaction.from(hex).hash!))!.status).toBe(1)
    }
  }
  const toHexString = (bytes: Uint8Array) => '0x' + toHex(bytes)

  beforeEach(async () => {
    // Every test starts from the same chain state: the wallets are opened from the same seeds
    // with fresh storage each time, and a one-time account used by an earlier test would
    // otherwise already have spent its nonce on the chain.
    if (snapshot !== undefined) await node.send('evm_revert', [snapshot])
    snapshot = await node.send('evm_snapshot', [])
    mailboxes.clear()
    extraRoots = []
    // The shared fixture's fixed policy (3 wei gas, head 100) is for its stub node; against a
    // real node the wallet prices and paces its transactions from the node, as in production.
    // A message's default stamp is STAMP, the amount every assertion here counts.
    f = await fixture({
      transactionSetPolicy: undefined,
      resolveDefaultStamp: fixedStampDefault(STAMP),
    })
    alice = f.alice
    bob = f.bob
    installCanonicalDirectory(alice, await f.directoryFor('alice', alice, bob))
    installCanonicalDirectory(bob, await f.directoryFor('bob', bob, alice))
    bobMailbox = []
    mailboxes.set(subjectOf(bob), bobMailbox)
    mailboxes.set(subjectOf(alice), [])
    f.setMailbox(bobMailbox)
    // Alice has real money. Bob has none of his own: whatever he spends, he received.
    await fund(await mainOf(alice), parseEther('1'))
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await f?.close().catch(() => undefined)
    for (const root of extraRoots) rmSync(root, { recursive: true, force: true })
  })

  it('A pays B: B sees it pending, then received from the chain, spends it, still has it after a reload, and finds it again on a fresh restore', async () => {
    const sent = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
      memo: 'lunch',
    })
    const oneTime = sent.stealthAddress.toLowerCase()
    // The node has the transfer, from alice's main account.
    const transfer = await until(
      'the transfer to be known to the node',
      () => node.getTransaction(sent.txHash),
      tx => tx !== null,
    )
    expect(transfer!.from.toLowerCase()).toBe(await mainOf(alice))
    expect(transfer!.to!.toLowerCase()).toBe(oneTime)
    expect(bobMailbox).toHaveLength(1)

    // B reads his mailbox: recorded, pending, worth nothing until the chain is read.
    const [message] = await poll(bob)
    expect(message.items[0]).toMatchObject({ type: 'stealth', memo: 'lunch' })
    expect(stealthOf(bob)).toEqual([
      expect.objectContaining({
        address: oneTime,
        claimedAmountWei: VALUE,
        spendable: false,
      }),
    ])
    await settled(bob)
    expect(stealthOf(bob)[0]).toMatchObject({
      status: 'received',
      amountWei: VALUE,
      receivedAmountWei: VALUE,
      spendable: true,
    })
    expect(await node.getBalance(oneTime)).toBe(VALUE)
    // The stamp of that message is B's money too (the relay stand-in broadcast nothing: B's
    // wallet put the carried stamp payments on the chain itself).
    const stampTotal = stampsOf(bob).reduce((sum, coin) => sum + coin.amountWei, 0n)
    expect(stampTotal).toBe(STAMP)
    expect(await bob.getBalance()).toBe(VALUE + STAMP)

    // B spends it in an ordinary send. He has no other money.
    const carol = Wallet.createRandom().address
    const spent = await finished(bob, bob.sendLegacy!({
      recipient: { raw: carol },
      value: VALUE / 2n,
    }))
    const spend = await node.waitForTransaction(spent.txHash)
    expect(spend!.status).toBe(1)
    expect(spend!.from.toLowerCase()).toBe(oneTime)
    expect(await node.getBalance(carol)).toBe(VALUE / 2n)

    // Reload: a new handle on the same storage, and no mailbox read.
    await settled(bob)
    // What the send left is still his: the residual of the one-time account went to fresh
    // change accounts of his seed (the split every send makes), less the moves' fees.
    const held = await bob.getBalance()
    expect(held).toBeGreaterThan(STAMP)
    expect(held).toBeLessThan(VALUE + STAMP - VALUE / 2n)
    const known = bob.getReceivedPayments!().map(coin => coin.address).sort()
    await bob.close()
    const reloaded = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      expect(reloaded.getReceivedPayments!().map(coin => coin.address).sort()).toEqual(
        known,
      )
      await settled(reloaded)
      const left = await node.getBalance(oneTime)
      expect(stealthOf(reloaded)[0]).toMatchObject({ address: oneTime, amountWei: left })
      expect(await reloaded.getBalance()).toBe(held)
    } finally {
      await reloaded.close()
    }

    // Restored from the seed on a fresh device: nothing known until the mailbox is read from
    // the start; reading it again adds nothing.
    const root = mkdtempSync(join(tmpdir(), 'received-payments-restore-'))
    extraRoots.push(root)
    const freshChain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const restored = (await freshChain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      installCanonicalDirectory(
        restored,
        await f.directoryFor('bob-restored', restored, alice),
      )
      expect(restored.getReceivedPayments!()).toEqual([])
      await poll(restored, freshChain)
      await settled(restored)
      expect(restored.getReceivedPayments!().map(coin => coin.address).sort()).toEqual(
        known,
      )
      expect(stealthOf(restored)[0]).toMatchObject({ address: oneTime, status: 'received' })
      const again = restored.getReceivedPayments!()
      await poll(restored, freshChain)
      expect(restored.getReceivedPayments!()).toEqual(again)
    } finally {
      await restored.close()
    }
  })

  it('a deposit from outside Frank is listed once, read from the chain; a contact payment and the wallet moving its own money are not; balance, coin list and deposits agree; a reload and another device list the same', async () => {
    const aliceMain = await mainOf(alice)
    const bobMain = await mainOf(bob)
    // A payment to a contact: a Frank payment from alice's main account to bob's one-time account.
    const sent = await alice.sendToContact!({ recipient: bob.identity.address, value: VALUE })
    await until(
      'the contact payment to be in a block',
      () => node.getTransactionReceipt(sent.txHash),
      receipt => receipt !== null,
    )
    await poll(bob)
    await settled(bob)
    // A plain transfer from outside Frank to bob's receive address.
    const outside = await (await dev.sendTransaction({ to: bobMain, value: parseEther('0.3') })).wait()
    await node.send('evm_mine', [])

    await bob.refreshExternalDeposits!()
    const [deposit, ...more] = bob.getExternalDeposits!()
    expect(more).toEqual([])
    expect(deposit).toMatchObject({
      id: `${outside!.hash.toLowerCase()}:native`,
      chainIdentifier: 'monad-testnet',
      txHash: outside!.hash.toLowerCase(),
      to: bobMain,
      from: dev.address.toLowerCase(),
      asset: { kind: 'native' },
      amount: parseEther('0.3').toString(),
      blockNumber: outside!.blockNumber,
      blockHash: outside!.blockHash.toLowerCase(),
    })
    // Alice's deposits: the faucet's funding only. Her payment to bob and its change moves are
    // the wallet's own sends.
    await alice.refreshExternalDeposits!()
    expect(
      alice.getExternalDeposits!().map(row => [row.to, row.from, row.amount]),
    ).toEqual([[aliceMain, dev.address.toLowerCase(), parseEther('1').toString()]])

    // The balance counts what the chain shows at the receive address, and that is the deposit;
    // the received payment is counted once, from the coin list.
    bob.invalidateBalanceCache!()
    const parts = await bob.getBalanceParts!()
    expect(parts.main).toBe(await node.getBalance(bobMain))
    expect(parts.main).toBe(BigInt(deposit!.amount))
    expect(stealthOf(bob)[0]).toMatchObject({ status: 'received', amountWei: VALUE })

    // A reload reads no block again and lists nothing twice; another device (fresh storage,
    // same seed) lists the same rows from the chain alone.
    const listed = bob.getExternalDeposits!()
    await bob.close()
    const reloaded = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      expect(reloaded.getExternalDeposits!()).toEqual(listed)
      const reads = jest.spyOn(reloaded.provider as JsonRpcProvider, 'send')
      await reloaded.refreshExternalDeposits!()
      expect(reads.mock.calls.map(([method]) => method)).not.toContain('eth_getBlockByNumber')
      expect(reloaded.getExternalDeposits!()).toEqual(listed)
    } finally {
      await reloaded.close()
    }
    const root = mkdtempSync(join(tmpdir(), 'received-payments-deposits-'))
    extraRoots.push(root)
    const device = (await withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    ).createWallet(roots(1))) as EvmChainWalletHandle
    try {
      await device.refreshExternalDeposits!()
      expect(device.getExternalDeposits!()).toEqual(listed)
    } finally {
      await device.close()
    }
  })

  it('the relay cannot be reached: no transfer reaches the node and the source stays claimed; after a restart the same message is delivered and the transfer is broadcast once', async () => {
    const aliceMain = await mainOf(alice)
    f.setPhase('fail')
    const refused = await alice
      .sendToContact!({ recipient: bob.identity.address, value: VALUE })
      .catch(error => error)
    expect(refused).toBeInstanceOf(ContactPaymentPendingError)
    const [saved] = alice.getContactPayments!()
    expect(saved.state).toBe('prepared')
    // Nothing of the transfer reached the node: it is unknown there and its nonce is unused.
    expect(await node.getTransaction(saved.txHash!)).toBeNull()
    // The transfer is one member of its transaction set (beside the change it splits off).
    const operation = alice
      .getNativeOperations!()
      .find(row => row.members.some(member => member.signed?.transactionHash === saved.txHash))!
    const transfer = operation.members.find(
      member => member.signed?.transactionHash === saved.txHash,
    )!
    expect(transfer.source.address).toBe(aliceMain)
    const heldNonce = Transaction.from(transfer.signed!.rawTransaction).nonce
    expect(await node.getTransactionCount(aliceMain)).toBe(heldNonce)
    expect(bobMailbox).toHaveLength(0)

    // Nothing else can take the claimed account's nonce: an ordinary send only it could cover
    // (more than all of alice's other coins together: the change the transfer's set already
    // split off, on the chain before the relay was tried) is refused, and the transfer cannot
    // be pushed out by hand.
    let elsewhere = 0n
    for (const member of operation.members)
      if (member.transactionSet?.role === 'change' && member.observation.state === 'included-success')
        elsewhere += await node.getBalance(Transaction.from(member.signed!.rawTransaction).to!)
    await expect(
      alice.sendLegacy!({
        recipient: { raw: Wallet.createRandom().address },
        value: elsewhere + 1n,
      }),
    ).rejects.toThrow('Insufficient available EVM coins')
    await expect(alice.resumeNativeOperation!(operation.operationId)).rejects.toThrow(
      'is broadcast once its message is delivered',
    )
    expect(await node.getTransactionCount(aliceMain)).toBe(heldNonce)
    expect(await node.getTransaction(saved.txHash!)).toBeNull()
    await alice.close()

    const restarted = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    try {
      installCanonicalDirectory(
        restarted,
        await f.directoryFor('alice-restarted', restarted, bob),
      )
      expect(restarted.getContactPayments!()[0].state).toBe('prepared')
      expect(await node.getTransaction(saved.txHash!)).toBeNull()
      f.setPhase('delivered')
      // The host's ordinary mailbox read is what finishes it.
      await poll(restarted)
      await until(
        'the payment to be delivered and paid',
        async () => {
          await restarted.resumeContactPayments!()
          return restarted.getContactPayments!()[0].state
        },
        state => state === 'paid',
      )
      expect(restarted.getContactPayments!()[0]).toMatchObject({
        messageId: saved.messageId,
        txHash: saved.txHash,
      })
      expect(bobMailbox).toHaveLength(1)
      const receipt = await node.getTransactionReceipt(saved.txHash!)
      expect(receipt!.status).toBe(1)
      const oneTime = receipt!.to!.toLowerCase()
      // Paid once: the one-time address holds the amount once, from the held nonce, and the
      // journal holds one operation for it.
      expect(await node.getBalance(oneTime)).toBe(VALUE)
      expect((await node.getTransaction(saved.txHash!))!.nonce).toBe(heldNonce)
      expect(
        restarted
          .getNativeOperations!()
          .filter(row => row.recipient === oneTime && !row.cancelled),
      ).toHaveLength(1)

      const [message] = await poll(bob)
      expect(message.messageId).toBe(saved.messageId)
      await settled(bob)
      expect(stealthOf(bob)[0]).toMatchObject({ status: 'received', amountWei: VALUE })
    } finally {
      await restarted.close()
    }
  })

  it('the relay accepts and the sender stops before its own broadcast: the recipient broadcasts the carried transfer and has the money', async () => {
    // The relay has the message before anything of the transfer reaches the node.
    // Before the relay has it, her wallet puts only its own self-sends (the change the
    // transfer splits off, and the funding of the stamp) on the chain.
    const transferAttempts: { raw: string; afterStored: boolean }[] = []
    let transferHash: string | undefined
    const real = alice.provider.broadcastTransaction.bind(alice.provider)
    jest.spyOn(alice.provider, 'broadcastTransaction').mockImplementation(async raw => {
      const hash = Transaction.from(raw).hash
      transferHash ??= alice.getContactPayments!()[0]?.txHash
      if (hash === transferHash)
        transferAttempts.push({ raw, afterStored: bobMailbox.length === 1 })
      // Alice's device is gone once the relay has the message: no broadcast after that.
      if (bobMailbox.length === 1) throw new Error('device stopped')
      return real(raw)
    })
    const sent = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    expect(sent.txHash).toBe(transferHash)
    // Every attempt at the transfer (the same bytes, retried) came after the relay stored it.
    // A retry is allowed only as the very same signed bytes the relay stored.
    expect(transferAttempts.length).toBeGreaterThan(0)
    expect(transferAttempts.every(attempt => attempt.afterStored)).toBe(true)
    expect(new Set(transferAttempts.map(attempt => attempt.raw)).size).toBe(1)
    expect(Transaction.from(transferAttempts[0]!.raw).hash).toBe(sent.txHash)
    expect(bobMailbox).toHaveLength(1)
    expect(await node.getTransaction(sent.txHash)).toBeNull()

    await poll(bob)
    await settled(bob)
    // The node now has exactly alice's signed transfer, put there by bob's wallet.
    const landed = await node.getTransaction(sent.txHash)
    expect(landed!.from.toLowerCase()).toBe(await mainOf(alice))
    expect(stealthOf(bob)[0]).toMatchObject({
      address: sent.stealthAddress.toLowerCase(),
      status: 'received',
      amountWei: VALUE,
      spendable: true,
    })
    expect(await bob.getBalance()).toBe(VALUE + STAMP)
  })

  it('the app path: the wallet prepares, the host sends the message itself, and the transfer reaches the node only once that message is stored', async () => {
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    expect(await node.getTransaction(prepared.txHash)).toBeNull()
    expect(alice.getContactPayments!()[0].state).toBe('prepared')

    // The host's send does not reach the relay: still nothing at the node.
    f.setPhase('fail')
    let attempt: string | undefined
    await f.chain.directMessages
      .send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [prepared.item],
        onAttemptCreated: digest => {
          attempt = digest
        },
      })
      .catch(() => undefined)
    await alice.resumeContactPayments!()
    expect(await node.getTransaction(prepared.txHash)).toBeNull()

    // The host's retry gets the same bytes stored: now the wallet broadcasts.
    f.setPhase('delivered')
    await f.chain.directMessages.reconcileAttempts({
      wallet: alice,
      payloadDigests: [attempt!],
    })
    await until(
      'the prepared payment to be paid',
      async () => {
        await alice.resumeContactPayments!()
        return alice.getContactPayments!()[0].state
      },
      state => state === 'paid',
    )
    expect((await node.getTransactionReceipt(prepared.txHash))!.status).toBe(1)
    expect(await node.getBalance(prepared.stealthAddress)).toBe(VALUE)
    expect(bobMailbox).toHaveLength(1)

    await poll(bob)
    await settled(bob)
    expect(stealthOf(bob)[0]).toMatchObject({
      address: prepared.stealthAddress.toLowerCase(),
      status: 'received',
      amountWei: VALUE,
      spendable: true,
    })
  })

  it('one coin under the reserve rule: the stamp is funded at the lower nonce before the relay has the message, the contact transfer at the next nonce only after it is stored', async () => {
    // The owner's two-nonce ruling for an account-based chain: alice's whole wallet is one
    // coin, below the network's reserve (Monad: 10 MON, 3 blocks). The stamp's funding leaves
    // first, at that account's lowest nonce; the transfer the message carries is the next nonce
    // and reaches the node only once the relay stored the message. No self-payment round trip
    // and no consolidation.
    await f.close()
    f = await fixture({
      transactionSetPolicy: undefined,
      resolveDefaultStamp: fixedStampDefault(STAMP),
      spendSpacingBlocks: 3,
      reserveBalanceWei: parseEther('10'),
    })
    alice = f.alice
    bob = f.bob
    installCanonicalDirectory(alice, await f.directoryFor('alice', alice, bob))
    installCanonicalDirectory(bob, await f.directoryFor('bob', bob, alice))
    bobMailbox = []
    mailboxes.set(subjectOf(bob), bobMailbox)
    mailboxes.set(subjectOf(alice), [])
    f.setMailbox(bobMailbox)
    const aliceMain = await mainOf(alice)
    expect(await node.getBalance(aliceMain)).toBe(parseEther('1'))
    const startNonce = await node.getTransactionCount(aliceMain)
    // The deposit is spendable once it is older than the spacing window.
    for (let i = 0; i < 5; i++) await node.send('evm_mine', [])
    // Every broadcast of alice's wallet, and whether the relay had stored the message by then.
    const broadcasts: { hash: string; afterStored: boolean }[] = []
    const real = alice.provider.broadcastTransaction.bind(alice.provider)
    jest.spyOn(alice.provider, 'broadcastTransaction').mockImplementation(async raw => {
      broadcasts.push({ hash: Transaction.from(raw).hash!, afterStored: bobMailbox.length === 1 })
      return real(raw)
    })
    const sending = alice.sendToContact!({ recipient: bob.identity.address, value: VALUE })
      .catch(error => error)
    // A real chain keeps making blocks while the host's tick finishes the same payment.
    let mining = true
    const miner = (async () => {
      while (mining) {
        await node.send('evm_mine', [])
        await sleep(100)
      }
    })()
    try {
      const outcome = await sending
      if (!(outcome && 'txHash' in outcome) && !(outcome instanceof ContactPaymentPendingError))
        throw outcome
      await until(
        'the contact payment to be paid',
        async () => {
          await alice.resumeContactPayments!()
          return alice.getContactPayments!()[0].state
        },
        state => state === 'paid',
      )
    } finally {
      mining = false
      await miner
    }
    const [payment] = alice.getContactPayments!()
    const operation = alice
      .getNativeOperations!()
      .find(row => row.members.some(member => member.signed?.transactionHash === payment.txHash))!
    const nonceOf = (member: (typeof operation.members)[number]) =>
      Transaction.from(member.signed!.rawTransaction).nonce
    const transfer = operation.members.find(member => member.signed?.transactionHash === payment.txHash)!
    const stampPayment = operation.members.find(member =>
      member.transactionSet?.role === 'payment' && member.transactionSet.stageId !== undefined)!
    const funding = operation.members[stampPayment.dependencies[0]!]!
    // The stamp is funded from the one coin at its lowest nonce; the transfer is the next one.
    expect(funding.source.address).toBe(aliceMain)
    expect(nonceOf(funding)).toBe(startNonce)
    expect(transfer.source.address).toBe(aliceMain)
    expect(nonceOf(transfer)).toBe(startNonce + 1)
    const fundingReceipt = await node.getTransactionReceipt(funding.signed!.transactionHash)
    const transferReceipt = await node.getTransactionReceipt(payment.txHash!)
    expect(fundingReceipt!.status).toBe(1)
    expect(transferReceipt!.status).toBe(1)
    // The funding went out before the relay had the message; no payment it carries did.
    expect(broadcasts.find(item => item.hash === funding.signed!.transactionHash)?.afterStored).toBe(false)
    const carried = new Set(operation.members
      .filter(member => member.transactionSet?.role === 'payment')
      .map(member => member.signed!.transactionHash))
    expect(broadcasts.filter(item => carried.has(item.hash) && !item.afterStored)).toEqual([])
    expect(broadcasts.some(item => item.hash === payment.txHash && item.afterStored)).toBe(true)
    // The transfer waited out the account's quiet window after the funding landed.
    expect(transferReceipt!.blockNumber).toBeGreaterThanOrEqual(fundingReceipt!.blockNumber + 3)
    expect(await node.getBalance(transferReceipt!.to!)).toBe(VALUE)
    expect(bobMailbox).toHaveLength(1)
    await poll(bob)
    await settled(bob)
    expect(stealthOf(bob)[0]).toMatchObject({ status: 'received', amountWei: VALUE })
  })

  it('a payment nothing of which was ever sent is released: its account is free at the same nonce, and its transfer can never land', async () => {
    const aliceMain = await mainOf(alice)
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const heldNonce = setStartNonce(alice, prepared.txHash, aliceMain)
    expect(alice.getContactPayments!()[0]).toMatchObject({
      state: 'prepared',
      holdsFunds: true,
    })
    await expect(
      alice.sendLegacy!({
        recipient: { raw: Wallet.createRandom().address },
        value: parseEther('0.5'),
      }),
    ).rejects.toThrow('Insufficient available EVM coins')

    // The outgoing message is deleted before it was ever sent.
    expect(await alice.settleContactPayment!(prepared.item.ephemeralPubKey!)).toBe(
      'released',
    )
    expect(alice.getContactPayments!()[0]).toMatchObject({
      state: 'released',
      holdsFunds: false,
    })
    // The account is free: an ordinary send goes out at the nonce the cancelled transfer had.
    const carol = Wallet.createRandom().address
    const spent = await finished(alice, alice.sendLegacy!({
      recipient: { raw: carol },
      value: parseEther('0.5'),
    }))
    const landed = await node.waitForTransaction(spent.txHash)
    expect(landed!.status).toBe(1)
    expect(setStartNonce(alice, spent.txHash, aliceMain)).toBe(heldNonce)
    expect(landed!.from.toLowerCase()).toBe(aliceMain)
    // The released transfer can never land now, and a message carrying it never leaves.
    await expect(
      node.broadcastTransaction('0x' + prepared.item.transactions![0]),
    ).rejects.toThrow()
    expect(await node.getBalance(prepared.stealthAddress)).toBe(0n)
    await expect(
      f.chain.directMessages.send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [prepared.item],
      }),
    ).rejects.toThrow('cancelled before anything was sent')
    expect(bobMailbox).toHaveLength(0)
  })

  it('a released payment never reaches the contact, even with its nonce still free: its message is refused, and later messages carry nothing of it', async () => {
    const aliceMain = await mainOf(alice)
    const broadcastHashes: string[] = []
    const realBroadcast = alice.provider.broadcastTransaction.bind(alice.provider)
    jest.spyOn(alice.provider, 'broadcastTransaction').mockImplementation(async raw => {
      broadcastHashes.push(Transaction.from(raw).hash!)
      return realBroadcast(raw)
    })
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const signed = Transaction.from('0x' + prepared.item.transactions![0])
    const heldNonce = setStartNonce(alice, prepared.txHash, aliceMain)
    expect(await alice.settleContactPayment!(prepared.item.ephemeralPubKey!)).toBe(
      'released',
    )
    // The nonce is NOT consumed here: if those bytes left the device they would land.
    expect(await node.getTransactionCount(aliceMain)).toBe(heldNonce)
    const requests = f.requests.length
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        f.chain.directMessages.send({
          wallet: alice,
          recipient: bob.identity.address,
          items: [prepared.item],
        }),
      ).rejects.toThrow('cancelled before anything was sent')
    expect(f.requests).toHaveLength(requests)
    // An ordinary message (which first settles every earlier attempt of this wallet).
    await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [{ type: 'text', text: 'hello' }],
    })
    const received = await poll(bob)
    expect(received.flatMap(message => message.items.map(item => item.type))).toEqual([
      'text',
    ])
    await settled(bob)
    expect(stealthOf(bob)).toEqual([])
    expect(await node.getTransaction(signed.hash!)).toBeNull()
    expect(await node.getBalance(prepared.stealthAddress)).toBe(0n)
    expect(await node.getTransactionCount(aliceMain)).toBeGreaterThanOrEqual(signed.nonce)
    // The wallet no longer holds the signed bytes anywhere.
    expect(alice.getContactPayments!()[0]).toMatchObject({ state: 'released' })
    expect(alice.getContactPayments!()[0].txHash).toBeUndefined()
    // Nothing signed of it was ever exposed: the wallet never broadcast it, no request to the
    // relay carried it, and no record the wallet keeps still holds its bytes.
    expect(broadcastHashes).not.toContain(signed.hash)
    const handed = f.requests.flatMap(request =>
      restoreCanonicalRequest(request).parts.transactions.map(
        raw => Transaction.from(toHexString(raw)).hash,
      ),
    )
    expect(handed).not.toContain(signed.hash)
    expect(
      alice
        .getNativeOperations!()
        .flatMap(row => row.members)
        .filter(member => member.signed?.transactionHash === signed.hash),
    ).toEqual([])
  })

  it('a free message carries a payment too: the sender is told it was delivered, pays, and holds nothing', async () => {
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
      stampValue: 0n,
    })
    await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [prepared.item],
      stampValue: 0n,
    })
    await until(
      'the payment to be paid',
      async () => {
        await alice.resumeContactPayments!()
        return alice.getContactPayments!()[0]
      },
      payment => payment.state === 'paid' && !payment.holdsFunds,
    )
    expect(await node.getBalance(prepared.stealthAddress)).toBe(VALUE)
    await poll(bob)
    await settled(bob)
    expect(await bob.getBalance()).toBe(VALUE)
  })

  it('a claim larger than what the chain shows is shown at the chain amount; a transfer that never landed is never counted', async () => {
    const sent = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const [message] = await poll(bob)
    const honest = message.items[0] as {
      ephemeralPubKey: string
      transactions: string[]
    }
    await bob.close()
    bobMailbox.length = 0

    const root = mkdtempSync(join(tmpdir(), 'received-payments-claim-'))
    extraRoots.push(root)
    const chain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const fresh = (await chain.createWallet(roots(1))) as EvmChainWalletHandle
    // The forged claims come from alice's account on another device, which never made that
    // payment: her own wallet binds a contact payment to the one message that carries it and
    // refuses to send its item in any other.
    const forgerRoot = mkdtempSync(join(tmpdir(), 'received-payments-forger-'))
    extraRoots.push(forgerRoot)
    const forgerChain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(forgerRoot, 'wallet') }),
    )
    installCanonicalDirectory(fresh, await f.directoryFor('bob-claim', fresh, alice))
    await alice.close()
    let forger: EvmChainWalletHandle | undefined
    try {
      forger = (await forgerChain.createWallet(roots(0))) as EvmChainWalletHandle
      installCanonicalDirectory(forger, await f.directoryFor('alice-forger', forger, fresh))
      // The same real transfer, under a claim a thousand times larger.
      await forgerChain.directMessages.send({
        wallet: forger,
        recipient: fresh.identity.address,
        items: [
          {
            type: 'stealth',
            networkTag: 'MONT',
            keyType: 1,
            ephemeralPubKey: honest.ephemeralPubKey,
            transactions: honest.transactions,
            amount: Number(VALUE) * 1000,
          },
        ],
      })
      // And a claim with no transfer behind it at all.
      const empty = await forgerChain.directMessages.send({
        wallet: forger,
        recipient: fresh.identity.address,
        items: [
          {
            type: 'stealth',
            networkTag: 'MONT',
            keyType: 1,
            ephemeralPubKey: '02' + '22'.repeat(32),
            transactions: ['77'.repeat(32)],
            amount: Number(VALUE),
          },
        ],
      })
      await poll(fresh, chain)
      await until(
        'the real transfer and the stamps to be seen',
        () => fresh.refreshReceivedPayments!(),
        coins =>
          coins
            .filter(coin => coin.address !== unseenAddress(coins))
            .every(coin => coin.status === 'received'),
      )
      fresh.invalidateBalanceCache!()
      const inflated = stealthOf(fresh).find(
        coin => coin.address === sent.stealthAddress.toLowerCase(),
      )!
      expect(inflated).toMatchObject({
        status: 'received',
        amountWei: VALUE,
        receivedAmountWei: VALUE,
        claimedAmountWei: VALUE * 1000n,
      })
      const never = stealthOf(fresh).find(
        coin => coin.address !== sent.stealthAddress.toLowerCase(),
      )!
      expect(never).toMatchObject({ amountWei: 0n, spendable: false })
      expect(['pending', 'not-received']).toContain(never.status)
      expect(fresh.getMessagePayment!(empty.payloadDigest).status).not.toBe('received')
      // The balance is the real transfer and the two messages' stamps: the empty claim adds 0.
      expect(await fresh.getBalance()).toBe(VALUE + 2n * STAMP)
      // Even real money parked at that address by someone else is not this claim arriving.
      await fund(never.address, VALUE)
      await fresh.refreshReceivedPayments!()
      fresh.invalidateBalanceCache!()
      expect(await fresh.getBalance()).toBe(VALUE + 2n * STAMP)
    } finally {
      await forger?.close()
      await fresh.close()
    }
    function unseenAddress(coins: ReceivedPayment[]): string | undefined {
      return coins.find(
        coin =>
          coin.origin === 'stealth' &&
          coin.address !== sent.stealthAddress.toLowerCase(),
      )?.address
    }
  })

  it('a sender cannot forge "received": a real, mined, unrelated transaction or a signed zero-value transfer proves nothing', async () => {
    // A real transaction in a real block that has nothing to do with bob.
    const elsewhere = Wallet.createRandom().address
    const unrelated = await dev.sendTransaction({ to: elsewhere, value: 1n })
    expect((await unrelated.wait())!.status).toBe(1)
    const byHash = await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: '02' + '44'.repeat(32),
          transactions: [unrelated.hash.slice(2)],
          amount: Number(parseEther('10')),
          amountWei: parseEther('10').toString(),
        },
      ],
    })
    // A properly signed, MINED transfer of nothing to the very one-time address bob derives.
    const ephemeral = Wallet.createRandom().signingKey.compressedPublicKey
    const target = deriveEvmStealthPrivateKey({
      recipientSpendSecret: bob.identity.toPrivateKeyHex(),
      ephemeralPubKey: getBytes(ephemeral),
    }).stealthAddress
    const zero = await dev.sendTransaction({ to: target, value: 0n })
    expect((await zero.wait())!.status).toBe(1)
    const byZero = await f.chain.directMessages.send({
      wallet: alice,
      recipient: bob.identity.address,
      items: [
        {
          type: 'stealth',
          networkTag: 'MONT',
          keyType: 1,
          ephemeralPubKey: ephemeral.slice(2),
          transactions: [zero.hash.slice(2)],
          amount: Number(parseEther('10')),
          amountWei: parseEther('10').toString(),
        },
      ],
    })
    await poll(bob)
    for (let i = 0; i < 4; i++) await bob.refreshReceivedPayments!()
    bob.invalidateBalanceCache!()

    expect(stealthOf(bob).length).toBe(2)
    for (const coin of stealthOf(bob)) {
      expect(coin.status).not.toBe('received')
      expect(coin).toMatchObject({ amountWei: 0n, spendable: false })
      expect(coin.receivedAmountWei).toBeUndefined()
    }
    expect(stealthOf(bob).map(coin => coin.address)).toContain(target.toLowerCase())
    expect(stealthOf(bob).every(coin => coin.claimedAmountWei === parseEther('10'))).toBe(true)
    for (const sent of [byHash, byZero]) {
      const payment = await bob.checkMessagePayment!(sent.payloadDigest)
      expect(payment.status).not.toBe('received')
    }
    // Bob's balance is the two messages' stamps, once they land, and nothing else.
    await until(
      'the stamps to land',
      async () => {
        await bob.refreshReceivedPayments!()
        return stampsOf(bob)
      },
      stamps => stamps.length > 0 && stamps.every(stamp => stamp.status === 'received'),
    )
    bob.invalidateBalanceCache!()
    expect(await bob.getBalance()).toBe(2n * STAMP)
  })

  it('a payment whose nonce another transaction took is failed and never counted', async () => {
    // Alice signs and delivers, and her own broadcast of what the message carries does not
    // reach the node (her self-sends before the relay has the message do).
    const realBroadcast = alice.provider.broadcastTransaction.bind(alice.provider)
    const aliceBroadcast = jest
      .spyOn(alice.provider, 'broadcastTransaction')
      .mockImplementation(async raw => {
        if (bobMailbox.length > 0) throw new Error('node unreachable')
        return realBroadcast(raw)
      })
    const sent = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    aliceBroadcast.mockRestore()
    expect(await node.getTransaction(sent.txHash)).toBeNull()
    // Another transaction from the same account takes that nonce, on the real chain.
    const aliceKey = new Wallet(alice.mainPrivateKey!, node)
    await (
      await aliceKey.sendTransaction({ to: aliceKey.address, value: 0n })
    ).wait()

    await poll(bob)
    await until(
      'the wallet to learn the payment can never land',
      () => bob.refreshReceivedPayments!(),
      coins => coins.some(coin => coin.origin === 'stealth' && coin.status === 'failed'),
    )
    bob.invalidateBalanceCache!()
    expect(stealthOf(bob)).toEqual([
      expect.objectContaining({
        address: sent.stealthAddress.toLowerCase(),
        status: 'failed',
        amountWei: 0n,
        claimedAmountWei: VALUE,
        spendable: false,
      }),
    ])
    expect(bob.getMessagePayment!(sent.payloadDigest).status).toBe('failed')
    expect(await node.getBalance(sent.stealthAddress)).toBe(0n)
    // Only the message's stamp is his.
    await settled(bob)
    expect(await bob.getBalance()).toBe(STAMP)
  })

  it('stamps: delivered without a broadcast, the recipient broadcasts and verifies; then they are spent, or moved by an explicit sweep', async () => {
    // Nobody but the recipient broadcasts what the messages carry: not the relay stand-in, and
    // not alice's wallet (its broadcast of a carried payment never reaches the node). Her
    // self-sends, which the carried payments stand on, do.
    const carriedHashes = () =>
      new Set(
        f.requests.flatMap(request =>
          restoreCanonicalRequest(request).parts.transactions.map(
            raw => Transaction.from(toHexString(raw)).hash,
          ),
        ),
      )
    const realBroadcast = alice.provider.broadcastTransaction.bind(alice.provider)
    jest.spyOn(alice.provider, 'broadcastTransaction').mockImplementation(async raw => {
      if (carriedHashes().has(Transaction.from(raw).hash)) throw new Error('node unreachable')
      return realBroadcast(raw)
    })
    const send = (text: string) =>
      delivered(
        alice,
        f.chain.directMessages.send({
          wallet: alice,
          recipient: bob.identity.address,
          items: [{ type: 'text', text }],
          stampValue: STAMP,
        }),
      )
    // Alice's host tick: what the chain shows of a delivered message is read, and her own moves
    // that stood behind its payment on the same account (they wait for it, in nonce order) go
    // out once it landed, so her next message has that money.
    const tick = async (digest: string) => {
      await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [digest] })
      await settled(alice)
    }
    const first = await send('one')
    // The relay stand-in delivered and broadcast nothing: the node has never heard of the
    // stamp payments, and no stamp account holds anything.
    const carried = restoreCanonicalRequest(f.requests[0]).parts.transactions.map(raw =>
      Transaction.from(toHexString(raw)),
    )
    expect(carried.length).toBeGreaterThan(0)
    for (const tx of carried) {
      expect(await node.getTransaction(tx.hash!)).toBeNull()
      expect(await node.getBalance(tx.to!)).toBe(0n)
    }
    const [message] = await poll(bob)
    expect(message.stampValueWei).toBe(STAMP)

    // "Has the payment for this message landed?": the wallet broadcasts the carried
    // transactions itself, then sees them included.
    await until(
      'the first message stamp to land',
      () => bob.checkMessagePayment!(first.payloadDigest),
      payment => payment.status === 'received',
    )
    expect(bob.getMessagePayment!(first.payloadDigest)).toMatchObject({
      status: 'received',
      receivedWei: STAMP,
    })
    for (const payment of message.stampPayments)
      expect(await node.getBalance(payment.destinationAddress)).toBe(payment.valueWei)
    await tick(first.payloadDigest)

    // For the second message the relay does broadcast: the wallet's own broadcast of what is
    // already mined changes nothing, and the stamp is counted once.
    const second = await send('two')
    await relayBroadcasts(1)
    await tick(second.payloadDigest)
    // The third is again broadcast by nobody but its recipient.
    const third = await send('three')
    expect(f.requests).toHaveLength(3)
    for (const raw of restoreCanonicalRequest(f.requests[2]).parts.transactions)
      expect(await node.getTransaction(Transaction.from(toHexString(raw)).hash!)).toBeNull()
    await poll(bob)
    await settled(bob)
    expect(await bob.getBalance()).toBe(3n * STAMP)

    // Spent by an ordinary send (B has no other money).
    const carol = Wallet.createRandom().address
    const spent = await finished(bob, bob.sendLegacy!({ recipient: { raw: carol }, value: STAMP / 4n }))
    expect((await node.waitForTransaction(spent.txHash))!.status).toBe(1)
    expect(await node.getBalance(carol)).toBe(STAMP / 4n)
    await settled(bob)

    // An explicit sweep of the third message's stamp: it goes to B's seed-derived main account.
    // (Deleting a message never does this: see the next test.)
    const bobMain = await mainOf(bob)
    const mainBefore = await node.getBalance(bobMain)
    const thirdStamps = stampsOf(bob, third.payloadDigest)
    const thirdHeld = async () => {
      let total = 0n
      for (const coin of thirdStamps) total += await node.getBalance(coin.address)
      return total
    }
    // (The send above took its money from whichever stamp account was largest, so part of
    // this may already be spent.)
    const heldBefore = await thirdHeld()
    expect(heldBefore).toBeGreaterThan(STAMP / 4n)

    // With the node unreachable the sweep says so, and nothing moved.
    const unreachable = jest
      .spyOn(bob.provider, 'getBalance')
      .mockRejectedValue(new Error('node unreachable'))
    expect(
      await bob.sweepReceivedCoins!({ payloadDigests: [third.payloadDigest] }),
    ).toEqual({
      [third.payloadDigest]: { outcome: 'failed', reason: 'node unreachable' },
    })
    unreachable.mockRestore()
    expect(await thirdHeld()).toBe(heldBefore)

    expect(
      await bob.sweepReceivedCoins!({ payloadDigests: [third.payloadDigest] }),
    ).toEqual({ [third.payloadDigest]: { outcome: 'swept' } })
    const swept = (await node.getBalance(bobMain)) - mainBefore
    // All of it but the moves' own fees is now at the main account.
    expect(swept).toBeGreaterThan((heldBefore * 8n) / 10n)
    expect(swept).toBeLessThanOrEqual(heldBefore)
    expect(await thirdHeld()).toBeLessThan(heldBefore / 10n)

    // Asked for every message: every unspent stamp left is swept.
    const all = [first.payloadDigest, second.payloadDigest, third.payloadDigest]
    const stampCoins = stampsOf(bob)
    let leftInStamps = 0n
    for (const coin of stampCoins) leftInStamps += await node.getBalance(coin.address)
    const mainBeforeAll = await node.getBalance(bobMain)
    const answers = await bob.sweepReceivedCoins!({ payloadDigests: all })
    for (const digest of all)
      expect(['swept', 'none']).toContain(answers[digest].outcome)
    await settled(bob)
    // No stamp account holds anything worth a move now: what they held is at the seed-derived
    // main account, less the moves' fees. (The residual of B's own send is on fresh change of
    // his seed, which a restore finds by walking the seed.)
    for (const coin of stampCoins)
      expect(await node.getBalance(coin.address)).toBeLessThan(STAMP / 100n)
    const atMain = await node.getBalance(bobMain)
    expect(atMain - mainBeforeAll).toBeGreaterThan((leftInStamps * 8n) / 10n)
    expect(atMain - mainBeforeAll).toBeLessThanOrEqual(leftInStamps)
    expect(await bob.getBalance()).toBeGreaterThanOrEqual(atMain)
  })

  it('a deleted message: no money moves and its coin is still spent from; a second wallet opened from the same roots with empty state finds the coin through the note to self, without the message, and spends it', async () => {
    // Bob can find himself in the directory, as with a real relay: his notes to self go out.
    const selfAware = async (owner: string, self: EvmChainWalletHandle) => {
      const base = await f.directoryFor(owner, self, alice)
      const subject = subjectOf(self)
      const address = self.identity.address.raw.toLowerCase()
      return {
        ...base,
        peerCurrent: async (wanted: { address: string } | { subject: string }) =>
          ('subject' in wanted
            ? wanted.subject === subject
            : wanted.address.toLowerCase() === address)
            ? { subject, endpoint: base.homeEndpoint, current: await base.selfCurrent() }
            : base.peerCurrent(wanted),
      }
    }
    installCanonicalDirectory(bob, await selfAware('bob-self', bob))

    const send = (text: string) =>
      delivered(
        alice,
        f.chain.directMessages.send({
          wallet: alice,
          recipient: bob.identity.address,
          items: [{ type: 'text', text }],
          stampValue: STAMP,
        }),
        { paid: true },
      )
    const first = await send('one')
    const second = await send('two')
    expect(bobMailbox).toHaveLength(2)
    expect((await poll(bob)).map(m => m.payloadDigest).sort()).toEqual(
      [first.payloadDigest, second.payloadDigest].sort(),
    )
    await settled(bob)
    expect(await bob.getBalance()).toBe(2n * STAMP)
    // The wallet wrote, for each coin, how its key is derived, in a free note to itself.
    await bob.noteReceivedCoins!()
    const coins = stampsOf(bob)
    expect(bobMailbox).toHaveLength(2 + coins.length)
    const addresses = coins.map(coin => coin.address).sort()

    // The messages are DELETED. The wallet is not asked anything by a delete; here the messages
    // are also gone from the relay's mailbox, so nothing but the notes can lead to the coins.
    const bobMain = await mainOf(bob)
    const mainBefore = await node.getBalance(bobMain)
    const broadcastsBefore = await node.getBlockNumber()
    bobMailbox.splice(0, 2)
    expect(await poll(bob)).toEqual([])
    await settled(bob)
    // No money moved: no block was made, the main account holds what it held, the coins hold
    // the stamps, and the balance is what it was.
    expect(await node.getBlockNumber()).toBe(broadcastsBefore)
    expect(await node.getBalance(bobMain)).toBe(mainBefore)
    let held = 0n
    for (const address of addresses) held += await node.getBalance(address)
    expect(held).toBe(2n * STAMP)
    expect(await bob.getBalance()).toBe(2n * STAMP)
    expect(stampsOf(bob).every(coin => coin.spendable)).toBe(true)

    // The deleted message's coin is spent by an ordinary send (B has no other money).
    const carol = Wallet.createRandom().address
    const spent = await finished(bob, bob.sendLegacy!({ recipient: { raw: carol }, value: STAMP / 4n }))
    const spend = await node.waitForTransaction(spent.txHash)
    expect(spend!.status).toBe(1)
    expect(addresses).toContain(spend!.from.toLowerCase())
    expect(await node.getBalance(carol)).toBe(STAMP / 4n)
    await settled(bob)
    await bob.close()

    // A SECOND wallet of the same account: same roots, empty state. Its mailbox holds no
    // message that brought money, only the notes.
    const root = mkdtempSync(join(tmpdir(), 'received-payments-second-device-'))
    extraRoots.push(root)
    const secondChain = withDefaultMessageItems(
      createEvmChain({ ...f.config, walletStorageLocation: join(root, 'wallet') }),
    )
    const secondDevice = (await secondChain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      installCanonicalDirectory(secondDevice, await selfAware('bob-second', secondDevice))
      expect(secondDevice.getReceivedPayments!()).toEqual([])
      const requests = f.requests.length
      // The notes are the wallet's: none is handed on as a message.
      expect(await poll(secondDevice, secondChain)).toEqual([])
      expect(f.requests).toHaveLength(requests)
      expect(
        secondDevice.getReceivedPayments!().map(coin => coin.address).sort(),
      ).toEqual(addresses)
      // Claims until the chain is read; then exactly what the chain holds.
      await settled(secondDevice)
      // The coin the send above spent from is empty (its residual went to fresh change of the
      // seed, which this device finds from the seed, not from the notes); the other is whole.
      let left = 0n
      for (const address of addresses) left += await node.getBalance(address)
      expect(left).toBe(STAMP)
      expect(await secondDevice.getBalance()).toBeGreaterThan(left)

      // And it can SPEND them: the key it derived from the note signs for the money. The
      // amount is more than all of the earlier send's change together (under 3/4 of a stamp),
      // so the noted, untouched coin must pay it.
      const dave = Wallet.createRandom().address
      const again = await finished(secondDevice, secondDevice.sendLegacy!({
        recipient: { raw: dave },
        value: (STAMP * 8n) / 10n,
      }))
      const moved = await node.waitForTransaction(again.txHash)
      expect(moved!.status).toBe(1)
      // The money left the noted coin (directly, or through the account it funded first).
      let leftAfter = 0n
      for (const address of addresses) leftAfter += await node.getBalance(address)
      expect(leftAfter).toBeLessThanOrEqual(left - (STAMP * 8n) / 10n)
      expect(await node.getBalance(dave)).toBe((STAMP * 8n) / 10n)
      // It read the notes from the mailbox, so it wrote none itself. (The send above noted
      // itself to the account's other devices, as every send to an address does.)
      const afterSend = f.requests.length
      const mailboxAfterSend = bobMailbox.length
      await secondDevice.noteReceivedCoins!()
      expect(f.requests).toHaveLength(afterSend)
      expect(bobMailbox).toHaveLength(mailboxAfterSend)
    } finally {
      await secondDevice.close()
    }
  })
})
