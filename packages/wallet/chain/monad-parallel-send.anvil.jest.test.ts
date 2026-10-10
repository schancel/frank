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
})
