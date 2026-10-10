/**
 * INTEGRATION: concurrent paid messages from one wallet against real chain software.
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143), the wallet's real
 * provider and HTTP client talking JSON-RPC to it, real payments from the main account and from
 * funded single-use accounts, real signing, real typed custody and Level stores, real directory admission and sealing.
 *
 * Not real, and said so: the relay. The wallet reaches the node directly instead of through the
 * relay's RPC proxy (the mock below only swaps the URL and drops the relay capability), and
 * message delivery is the wallet-level relay stand-in of `canonical-two-wallets.testutil`, which
 * here broadcasts the payments of every second message to the node (as the relay does) and of
 * the others not at all, so both broadcasters are exercised.
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
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  fixture,
  mailboxes,
  offlineChain,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './monad-chain'

const mockNode = { url: '' }
jest.mock('../monad-provider', () => {
  const actual = jest.requireActual('../monad-provider')
  return {
    ...actual,
    // The wallet's own provider class, pointed at the node instead of the relay's RPC proxy.
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: mockNode.url,
        chainId: options.chainId,
      }),
  }
})
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(
      root,
      `anvil-${process.platform}-${arch}`,
      'bin',
      'anvil',
    )
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

/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
// Above the fee floor of a transfer on the node (about 4e13 wei at 1.9 gwei).
const STAMP = 10n ** 15n
const ID = (round: number, n: number) =>
  `00000000-0000-4000-8${round.toString(16).padStart(3, '0')}-${n
    .toString(16)
    .padStart(12, '0')}`

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: monad-parallel-send.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

suite('ten paid messages sent together on a real EVM node (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let f: Fixture
  let alice: EvmChainWalletHandle
  let bobMailbox: InboxRecord[]
  const relayed: Transaction[][] = []
  let relayBroadcast = 0

  beforeAll(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--silent'],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, { staticNetwork: true })
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
    f = await fixture()
    alice = f.alice
    bobMailbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)
    f.setMailbox(bobMailbox)
    const base = await f.directoryFor('alice', f.alice, f.bob)
    installCanonicalDirectory(alice, {
      ...base,
      // The relay stand-in: stores the message, then (for every second message, as the real
      // relay does for all) broadcasts its payments to the node, without waiting on the result.
      fetch: async (url, init) => {
        const answer = await base.fetch!(url, init)
        const payments = restoreCanonicalRequest({
          body: new Uint8Array(init.body!),
          contentType: init.headers['Content-Type'],
        }).parts.transactions.map(raw => Transaction.from(hexlify(raw)))
        relayed.push(payments)
        if (relayed.length % 2 === 0)
          for (const tx of payments) {
            relayBroadcast++
            void chain.broadcastTransaction(tx.serialized).catch(() => undefined)
          }
        return answer
      },
    })
  })
  afterAll(async () => {
    await alice?.close().catch(() => undefined)
    await f?.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
  })

  const send = (round: number, n: number) =>
    f.chain.directMessages.send({
      wallet: alice,
      recipient: f.bob.identity.address,
      items: [{ type: 'text', text: `round ${round} message ${n}` }],
      stampValue: STAMP,
      messageId: ID(round, n),
    })
  /** Ticks the wallet until every payment of `digests` is in a block. */
  async function settle(digests: string[]) {
    for (let pass = 0; pass < 200; pass++) {
      await f.chain.directMessages.reconcileAttempts({
        wallet: alice,
        payloadDigests: digests,
      })
      const states = digests.flatMap(
        digest =>
          f.chain.directMessages.paymentsOf?.({
            wallet: alice,
            payloadDigest: digest,
          }) ?? ['pending'],
      )
      if (states.every(state => state === 'spent')) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('payments did not settle')
  }
  /** What the node itself says about every payment of these sends. */
  async function onChain(sent: Awaited<ReturnType<typeof send>>[]) {
    const payments = sent.flatMap(result => result.stampPayments)
    const receipts = await Promise.all(
      payments.map(payment => chain.getTransactionReceipt(payment.txHash)),
    )
    const senders = receipts.map(receipt => receipt!.from.toLowerCase())
    return {
      payments,
      receipts,
      senders,
      senderNonces: await Promise.all(
        senders.map(sender => chain.getTransactionCount(sender, 'latest')),
      ),
      destinationBalances: await Promise.all(
        payments.map(payment => chain.getBalance(payment.destinationAddress)),
      ),
    }
  }

  it('with money only in the main account, ten messages started together are each paid once from it: ten nonces, all mined, nothing funded', async () => {
    const main = (await alice.getReceiveAddress()).raw
    await (
      await dev.sendTransaction({ to: main, value: 10n ** 18n })
    ).wait()
    const mainBefore = await chain.getBalance(main)
    const blockBefore = await chain.getBlockNumber()

    const start = Date.now()
    const sent = await Promise.all(
      Array.from({ length: 10 }, (_, n) => send(1, n)),
    )
    const elapsed = Date.now() - start
    await settle(sent.map(result => result.payloadDigest))
    const seen = await onChain(sent)

    // Every payment is in a block and succeeded, each the whole stamp in one transfer.
    expect(seen.payments).toHaveLength(10)
    expect(seen.receipts.every(receipt => receipt?.status === 1)).toBe(true)
    expect(new Set(seen.senders)).toEqual(new Set([main.toLowerCase()]))
    seen.payments.forEach((payment, i) => {
      expect(payment.valueWei).toBe(STAMP)
      expect(seen.destinationBalances[i]).toBe(STAMP)
    })
    expect(new Set(sent.map(result => result.payloadDigest)).size).toBe(10)
    expect(bobMailbox).toHaveLength(10)
    // The main account is one coin: ten payments, ten consecutive nonces, no collision, and no
    // transaction besides them (nothing was funded).
    expect(sent.flatMap(result => result.preparationTxHashes)).toEqual([])
    expect(await chain.getTransactionCount(main, 'latest')).toBe(10)
    const nonces = (
      await Promise.all(
        seen.payments.map(payment => chain.getTransaction(payment.txHash)),
      )
    ).map(tx => tx!.nonce)
    expect(nonces.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    // A message costs its stamp plus the gas of one transfer, nothing more.
    const fees = seen.receipts.reduce(
      (sum, receipt) => sum + receipt!.gasUsed * receipt!.gasPrice,
      0n,
    )
    expect(seen.receipts.every(receipt => receipt!.gasUsed === 21_000n)).toBe(
      true,
    )
    expect(await chain.getBalance(main)).toBe(mainBefore - 10n * STAMP - fees)
    // eslint-disable-next-line no-console
    console.log(
      `anvil round 1 (main account only): 10 messages, 10 payments mined in blocks ${
        blockBefore + 1
      }..${await chain.getBlockNumber()}, ${elapsed} ms, ${
        fees / 10n
      } wei of gas per message; ${relayBroadcast} payments broadcast by the relay stand-in, the rest by the wallet`,
    )
  })

  it('with ten accounts funded ahead, ten messages started together are paid in about the time of one', async () => {
    // Ten single-use accounts, funded from outside the wallet's main account, one stamp each.
    // Each keeps back more than any fee the wallet may quote (its quote is a few seconds old).
    const reserve = 21_000n * 10n ** 10n
    const before = alice.pool.records().length
    const rows = alice.pool.ensureSize(before + 10).slice(before)
    await alice.pool.flush()
    let nonce = await chain.getTransactionCount(dev.address, 'latest')
    await Promise.all(
      (
        await Promise.all(
          rows.map(row =>
            dev.sendTransaction({
              to: row.address,
              value: STAMP + reserve,
              nonce: nonce++,
            }),
          ),
        )
      ).map(tx => tx.wait()),
    )
    const main = (await alice.getReceiveAddress()).raw
    const mainNonce = await chain.getTransactionCount(main, 'latest')

    const startOne = Date.now()
    const one = await send(2, 100)
    const oneMs = Date.now() - startOne
    const start = Date.now()
    const sent = await Promise.all(
      Array.from({ length: 9 }, (_, n) => send(2, n)),
    )
    const nineMs = Date.now() - start
    const all = [one, ...sent]
    await settle(all.map(result => result.payloadDigest))
    const seen = await onChain(all)

    expect(seen.receipts.every(receipt => receipt?.status === 1)).toBe(true)
    expect(new Set(seen.senders)).toEqual(
      new Set(rows.map(row => row.address.toLowerCase())),
    )
    expect(seen.senderNonces.every(nonce => nonce === 1)).toBe(true)
    seen.payments.forEach((payment, i) =>
      expect(seen.destinationBalances[i]).toBe(payment.valueWei),
    )
    // Nothing was funded: the main account did not move.
    expect(all.flatMap(result => result.preparationTxHashes)).toEqual([])
    expect(await chain.getTransactionCount(main, 'latest')).toBe(mainNonce)
    expect(bobMailbox).toHaveLength(20)
    for (const row of rows)
      expect(alice.pool.getRecord(row.index)?.status).toBe('spent')
    // eslint-disable-next-line no-console
    console.log(
      `anvil round 2 (funded ahead): one send ${oneMs} ms; nine together ${nineMs} ms`,
    )
    // Sealing and signing are CPU work on one thread (about 0.1 to 0.2 s a message here), so
    // nine together are not as fast as one; the bound only catches a return to one-at-a-time
    // network waits. The wallet-level suite shows all requests in flight at once.
    expect(nineMs).toBeLessThan(9 * Math.max(oneMs, 500))
  })

  // From here the node mines only when told to, so "not mined yet" lasts as long as a test needs.
  const automine = (on: boolean) => chain.send('evm_setAutomine', [on])
  const mine = () => chain.send('evm_mine', [])
  const pause = (ms: number) =>
    new Promise(resolve => setTimeout(resolve, ms))
  const NATIVE_HOLDER = /:main-account$/
  /** Runs `started` and reports, after `ms`, whether it has finished. */
  async function stillWaiting<T>(started: Promise<T>, ms: number) {
    let done = false
    void started.then(
      () => (done = true),
      () => (done = true),
    )
    await pause(ms)
    return !done
  }

  it('a native send waits for a message payment from the main account to be mined, then holds the account itself until its own transfer is mined', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const nonce = await chain.getTransactionCount(main, 'latest')
    await automine(false)
    try {
      // Every funded account is spent: this message is paid from the main account.
      const first = await send(3, 0)
      expect(alice.pool.accountClaimedBy(main)).toBeDefined()
      expect(alice.pool.accountClaimedBy(main)).not.toMatch(NATIVE_HOLDER)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 1)

      const recipient = Wallet.createRandom().address
      const native = alice.sendNative({
        recipient: { raw: recipient },
        value: 12_345n,
      })
      // It waits its turn: no error, and no second transaction signed over the first.
      expect(await stillWaiting(native, 2_500)).toBe(true)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 1)
      await mine()
      const transfer = await native
      expect((await chain.getTransaction(transfer.txHash))!.nonce).toBe(
        nonce + 1,
      )

      // The send has returned and its transfer is not mined: the account is still held, and
      // the next message waits for it instead of signing at a third nonce.
      expect(alice.pool.accountClaimedBy(main)).toMatch(NATIVE_HOLDER)
      const second = send(3, 1)
      expect(await stillWaiting(second, 2_500)).toBe(true)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 2)
      await mine()
      const sent = await second
      await mine()
      await automine(true)
      await settle([first.payloadDigest, sent.payloadDigest])
      expect((await chain.getTransactionReceipt(transfer.txHash))!.status).toBe(
        1,
      )
      expect(await chain.getBalance(recipient)).toBe(12_345n)
      expect(
        (await chain.getTransaction(sent.stampPayments[0]!.txHash))!.nonce,
      ).toBe(nonce + 2)
      expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 3)
    } finally {
      await automine(true)
    }
  })

  it('a native send given a deadline gives up when it passes, having signed nothing', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const nonce = await chain.getTransactionCount(main, 'latest')
    await automine(false)
    try {
      const message = await send(4, 0)
      await expect(
        alice.sendNative({
          recipient: { raw: Wallet.createRandom().address },
          value: 1n,
          mainAccountWaitMs: 1_500,
        }),
      ).rejects.toThrow(/wait given for it ran out/)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 1)
      await mine()
      await automine(true)
      await settle([message.payloadDigest])
    } finally {
      await automine(true)
    }
  })

  it('a contract call takes the main account like every other spender and holds it until the chain decides; one that is never handed to the network holds nothing', async () => {
    const main = (await alice.getReceiveAddress()).raw
    const nonce = await chain.getTransactionCount(main, 'latest')
    const target = Wallet.createRandom().address
    await automine(false)
    try {
      const call = await alice.sendContractCall!({
        to: { raw: target },
        data: '0x1234',
        value: 7n,
        gasLimit: 60_000n,
      })
      expect(alice.pool.accountClaimedBy(main)).toMatch(NATIVE_HOLDER)
      const message = send(5, 0)
      expect(await stillWaiting(message, 2_500)).toBe(true)
      expect(await chain.getTransactionCount(main, 'pending')).toBe(nonce + 1)
      await mine()
      const sent = await message
      await mine()
      await automine(true)
      await settle([sent.payloadDigest])
      expect((await chain.getTransactionReceipt(call.txHash))!.status).toBe(1)
      expect(
        (await chain.getTransaction(sent.stampPayments[0]!.txHash))!.nonce,
      ).toBe(nonce + 1)

      // Signed, and the caller could not record it: it is discarded before any broadcast, the
      // main account is free at once, and the next message does not wait.
      await expect(
        alice.sendContractCall!({
          to: { raw: target },
          data: '0x1234',
          value: 7n,
          gasLimit: 60_000n,
          onSigned: async () => {
            throw new Error('the caller could not record it')
          },
        }),
      ).rejects.toThrow('the caller could not record it')
      expect(alice.pool.accountClaimedBy(main)).toBeUndefined()
      const after = await send(5, 1)
      await settle([after.payloadDigest])
      expect(await chain.getTransactionCount(main, 'latest')).toBe(nonce + 3)
    } finally {
      await automine(true)
    }
  })

  it('a transfer a host signs itself with the identity key goes through the claim: held until mined, and the next one waits', async () => {
    const identity = alice.identity.address.raw
    const signer = new Wallet(alice.identity.toPrivateKeyHex(), chain)
    const to = Wallet.createRandom().address
    await (
      await dev.sendTransaction({ to: identity, value: 10n ** 17n })
    ).wait()
    const own = () =>
      alice.runOwnTransfer!(
        async () => {
          // A fresh reader: the suite's provider may answer a count from its short cache.
          const reader = new JsonRpcProvider(mockNode.url, 10143, {
            staticNetwork: true,
            cacheTimeout: -1,
          })
          const nonce = await reader.getTransactionCount(identity, 'pending')
          reader.destroy()
          const tx = await signer.sendTransaction({ to, value: 9n, nonce })
          return { txHash: tx.hash, from: identity, nonce }
        },
        { mainAccountWaitMs: 1_500 },
      )
    await automine(false)
    try {
      const first = await own()
      expect(alice.pool.accountClaimedBy(identity)).toMatch(NATIVE_HOLDER)
      // Not mined: a second transfer does not sign behind it.
      await expect(own()).rejects.toThrow(/wait given for it ran out/)
      expect(await chain.getTransactionCount(identity, 'pending')).toBe(
        first.nonce + 1,
      )
      await mine()
      const second = await own()
      expect(second.nonce).toBe(first.nonce + 1)
      await mine()
      expect(await chain.getBalance(to)).toBe(18n)
    } finally {
      await automine(true)
    }
  })
})
