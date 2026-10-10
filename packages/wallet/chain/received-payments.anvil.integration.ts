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
import { createEvmChain, installCanonicalDirectory } from './monad-chain'
import { deriveEvmStealthPrivateKey } from '../monad-stealth'

// The wallet normally reaches its node through the relay's RPC gateway. Here it is pointed
// straight at the real node this test started: the node is real, only the route to it differs.
jest.mock('../monad-provider', () => {
  const actual = jest.requireActual('../monad-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: process.env.FRANK_TEST_NODE_RPC_URL,
        chainId: options.chainId,
      }),
  }
})
jest.mock('../monad-http', () => {
  const actual = jest.requireActual('../monad-http')
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
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
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
    ['--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'],
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
    f = await fixture({ defaultStampValueWei: STAMP })
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
    const spent = await bob.sendNative({
      recipient: { raw: carol },
      value: VALUE / 2n,
    })
    const spend = await node.waitForTransaction(spent.txHash)
    expect(spend!.status).toBe(1)
    expect(spend!.from.toLowerCase()).toBe(oneTime)
    expect(await node.getBalance(carol)).toBe(VALUE / 2n)

    // Reload: a new handle on the same storage, and no mailbox read.
    await settled(bob)
    const known = bob.getReceivedPayments!().map(coin => coin.address).sort()
    await bob.close()
    const reloaded = (await f.chain.createWallet(roots(1))) as EvmChainWalletHandle
    try {
      expect(reloaded.getReceivedPayments!().map(coin => coin.address).sort()).toEqual(
        known,
      )
      await settled(reloaded)
      const left = await node.getBalance(oneTime)
      expect(left).toBeGreaterThan(0n)
      expect(stealthOf(reloaded)[0]).toMatchObject({
        status: 'received',
        amountWei: left,
      })
      expect(await reloaded.getBalance()).toBe(left + STAMP)
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
    const operation = alice
      .getNativeOperations!()
      .find(row => row.members[0]!.signed?.transactionHash === saved.txHash)!
    expect(operation.members[0]!.source.address).toBe(aliceMain)
    const heldNonce = Transaction.from(
      operation.members[0]!.signed!.rawTransaction,
    ).nonce
    expect(await node.getTransactionCount(aliceMain)).toBe(heldNonce)
    expect(bobMailbox).toHaveLength(0)

    // Nothing else can take the claimed account's nonce: an ordinary send only it could cover
    // is refused, background stamp funding does not spend from it, and the transfer cannot be
    // pushed out by hand.
    await expect(
      alice.sendNative({
        recipient: { raw: Wallet.createRandom().address },
        value: parseEther('0.5'),
      }),
    ).rejects.toThrow('Insufficient unreserved native funds')
    await f.chain.directMessages.fundAhead!({ wallet: alice })
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
    const seenByNodeAtBroadcast: boolean[] = []
    const real = alice.provider.broadcastTransaction.bind(alice.provider)
    jest.spyOn(alice.provider, 'broadcastTransaction').mockImplementation(async () => {
      seenByNodeAtBroadcast.push(bobMailbox.length === 1)
      // Alice's device is gone from here on: her broadcast never happens.
      throw new Error('device stopped')
    })
    void real
    const sent = await alice.sendToContact!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    expect(seenByNodeAtBroadcast).toEqual([true])
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

  it('a payment nothing of which was ever sent is released: its account is free at the same nonce, and its transfer can never land', async () => {
    const aliceMain = await mainOf(alice)
    const prepared = await alice.prepareContactPayment!({
      recipient: bob.identity.address,
      value: VALUE,
    })
    const heldNonce = Transaction.from('0x' + prepared.item.transactions![0]).nonce
    expect(alice.getContactPayments!()[0]).toMatchObject({
      state: 'prepared',
      holdsFunds: true,
    })
    await expect(
      alice.sendNative({
        recipient: { raw: Wallet.createRandom().address },
        value: parseEther('0.5'),
      }),
    ).rejects.toThrow('Insufficient unreserved native funds')

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
    const spent = await alice.sendNative({
      recipient: { raw: carol },
      value: parseEther('0.5'),
    })
    const landed = await node.waitForTransaction(spent.txHash)
    expect(landed!.status).toBe(1)
    expect((await node.getTransaction(spent.txHash))!.nonce).toBe(heldNonce)
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
    try {
      installCanonicalDirectory(fresh, await f.directoryFor('bob-claim', fresh, alice))
      // The same real transfer, under a claim a thousand times larger.
      await f.chain.directMessages.send({
        wallet: alice,
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
      const empty = await f.chain.directMessages.send({
        wallet: alice,
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
    // Alice signs and delivers, and her own broadcast does not reach the node.
    const aliceBroadcast = jest
      .spyOn(alice.provider, 'broadcastTransaction')
      .mockRejectedValue(new Error('node unreachable'))
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

  it('stamps: delivered without a broadcast, the recipient broadcasts and verifies; then they are spent, or swept before a delete', async () => {
    const send = (text: string) =>
      f.chain.directMessages.send({
        wallet: alice,
        recipient: bob.identity.address,
        items: [{ type: 'text', text }],
        stampValue: STAMP,
      })
    const first = await send('one')
    const second = await send('two')
    const third = await send('three')
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
    // For the second message the relay does broadcast: the wallet's own broadcast of what is
    // already mined changes nothing, and the stamp is counted once.
    await relayBroadcasts(1)
    await settled(bob)
    expect(await bob.getBalance()).toBe(3n * STAMP)

    // Spent by an ordinary send (B has no other money).
    const carol = Wallet.createRandom().address
    const spent = await bob.sendNative({ recipient: { raw: carol }, value: STAMP / 4n })
    expect((await node.waitForTransaction(spent.txHash))!.status).toBe(1)
    expect(await node.getBalance(carol)).toBe(STAMP / 4n)
    await settled(bob)

    // Deleting the third message: its unspent stamp goes to B's seed-derived main account.
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

    // With the node unreachable the answer is that the message must stay, and nothing moved.
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

    // Clearing the conversation: every unspent stamp left in it is swept.
    const all = [first.payloadDigest, second.payloadDigest, third.payloadDigest]
    const answers = await bob.sweepReceivedCoins!({ payloadDigests: all })
    for (const digest of all)
      expect(['swept', 'none']).toContain(answers[digest].outcome)
    await settled(bob)
    // What a restore from the seed finds is the main account: nearly everything is there now.
    const atMain = await node.getBalance(bobMain)
    expect(atMain).toBeGreaterThan((3n * STAMP - STAMP / 4n) * 8n / 10n)
    expect(await bob.getBalance()).toBeLessThanOrEqual(atMain + STAMP / 10n)
  })
})
