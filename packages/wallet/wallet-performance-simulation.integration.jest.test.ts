/**
 * INTEGRATION & PERFORMANCE BENCHMARK: wallet open, RPC coalescing, paid sends, high-volume
 * inbox decryption, and journal scaling. The budgets are machine independent: counted work
 * (node requests, signatures, transactions, relay requests), exact where it is deterministic,
 * and process CPU time. Wall-clock time is logged for reading but never asserted, because on a
 * shared CI runner it measures the runner's load as much as the wallet.
 */
import { performance } from 'node:perf_hooks'
import { SigningKey } from 'ethers'
import {
  chainHttpRequests,
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  offlineChain,
  providerBroadcasts,
  providerRequests,
  roots,
  STAMP,
  type Fixture,
  type InboxRecord,
} from './chain/canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './chain/evm-chain'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { toHex } from '@frank/codec'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { SEED_DISCOVERY_GAP } from './evm-seed-discovery'
import type { EvmChainWalletHandle } from './evm-wallet-handle'

jest.mock('./evm-provider', () =>
  require('./chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('./evm-http', () =>
  require('./chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () => {
  const mod =
    require('./chain/canonical-two-wallets.testutil').offlineMailboxModule()
  return {
    ...mod,
    fetchCanonicalMailboxPage: mod.fetchCanonicalInboxPage,
  }
})

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0
  const idx = Math.min(
    sortedMs.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1),
  )
  return sortedMs[idx]
}

/** How many requests of each method, keyed in sorted order so they compare and print stably. */
function countByMethod(methods: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const method of [...methods].sort()) counts[method] = (counts[method] ?? 0) + 1
  return counts
}

/**
 * Wall and process CPU (user + system) time of `run`, in ms. CPU is what these budgets assert:
 * it counts only the work this process did, so a busy or descheduled runner does not inflate
 * it. Wall is printed beside it for reading, never asserted.
 */
async function measured<T>(run: () => Promise<T> | T): Promise<{ value: T; wallMs: number; cpuMs: number }> {
  const cpuBefore = process.cpuUsage()
  const t0 = performance.now()
  const value = await run()
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpuBefore)
  return { value, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }
}

const timing = ({ wallMs, cpuMs }: { wallMs: number; cpuMs: number }) =>
  `CPU ${cpuMs.toFixed(1)} ms, wall ${wallMs.toFixed(1)} ms (reported only)`

describe('Wallet real-world performance & reliability simulation (integration)', () => {
  jest.setTimeout(60_000)

  let f: Fixture | undefined

  beforeEach(() => {
    offlineChain.reset()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    providerRequests.length = 0
    chainHttpRequests.length = 0
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    if (f) {
      await f.close()
      f = undefined
    }
  })

  it('opens two real custody wallets and coalesces concurrent balance reads within CPU and request budgets', async () => {
    const open = await measured(() => fixture({ subAccountPoolSize: 4 }))
    f = open.value
    // The accounts holding funds that the seed walk finds in this fixture: one balance read each.
    const FUNDED_ACCOUNTS = 6
    const reads = () => {
      const balance = providerRequests.filter(r => r === 'getBalance').length
      const nonce = providerRequests.filter(r => r === 'getTransactionCount').length
      providerRequests.length = 0
      return { balance, nonce }
    }
    const twelveReads = async (wallet: EvmChainWalletHandle) => {
      const timed = await measured(() =>
        Promise.all(Array.from({ length: 12 }, () => wallet.getBalance())),
      )
      for (const bal of timed.value) expect(bal).toBeGreaterThan(0n)
      return timed
    }

    // A store never walked (a new or restored device): before its first balance is shown the
    // seed's two branches are walked once for the accounts they control, BIP-44 style, which
    // costs one nonce and one balance read per index up to the gap. Twelve concurrent first
    // reads share that one walk and one balance wave.
    providerRequests.length = 0
    await twelveReads(f.alice)
    const first = reads()
    expect(first.nonce).toBe(2 * SEED_DISCOVERY_GAP)
    expect(first.balance).toBe(2 * SEED_DISCOVERY_GAP + FUNDED_ACCOUNTS)

    // Coalescing: 12 concurrent calls on a walked wallet collapse into one wave of one read per
    // account the walk found (within the wave limit of 8), and the seed is not walked again.
    f.alice.invalidateBalanceCache!()
    providerRequests.length = 0
    const coalesced = await twelveReads(f.alice)
    const steady = reads()
    expect(steady.nonce).toBe(0)
    expect(steady.balance).toBe(FUNDED_ACCOUNTS)

    // The store keeps what the walk found: a reopened wallet's first balance needs no walk.
    await f.alice.close()
    const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    try {
      providerRequests.length = 0
      const reopenedReads = await twelveReads(reopened)
      const again = reads()
      expect(again.nonce).toBe(0)
      expect(again.balance).toBe(FUNDED_ACCOUNTS)
      console.log(
        `wallet open: ${timing(open)}; twelve coalesced balance reads: ${timing(coalesced)}; ` +
          `after reopen: ${timing(reopenedReads)}`,
      )
      // CPU ceilings: the wall budgets these replaced, kept as they were, since an idle run's CPU
      // here is about its wall time. Measured on an Apple M-series laptop: open ~150-190 ms, each
      // wave ~3-5 ms, unchanged with every core saturated. The request counts above are the
      // tight check.
      expect(open.cpuMs).toBeLessThan(1500)
      expect(coalesced.cpuMs).toBeLessThan(200)
      expect(reopenedReads.cpuMs).toBeLessThan(200)
    } finally {
      await reopened.close()
    }
  })

  it('sends paid direct messages without prefunding sender accounts', async () => {
    // Change amounts carry jitter from Math.random, and they decide which coins later sends
    // spend and so how much each send asks of the node. A fixed sequence makes that work the
    // same on every run, so it can be asserted exactly below.
    let entropy = 1
    jest
      .spyOn(Math, 'random')
      .mockImplementation(() => (entropy = (entropy * 48_271) % 2_147_483_647) / 2_147_483_647)
    f = await fixture({ subAccountPoolSize: 6 })
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const bobMailbox: InboxRecord[] = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)

    // The work of one send, counted where it leaves the wallet: JSON-RPC calls by method,
    // EVM transaction signatures (message and identity signatures go through @frank/nakamoto
    // and show only in CPU), chain HTTP calls and relay requests. These are exact on any machine.
    const signatures = jest.spyOn(SigningKey.prototype, 'sign')
    const send = async (text: string) => {
      chainHttpRequests.length = 0
      providerBroadcasts.length = 0
      f!.setMailbox(bobMailbox)
      const requestsBefore = f!.requests.length
      const providerRequestsBefore = providerRequests.length
      const signaturesBefore = signatures.mock.calls.length
      const cpuBefore = process.cpuUsage()
      const t0 = performance.now()
      const sent = await f!.chain.directMessages.send({
        wallet: f!.alice,
        recipient: f!.bob.identity.address,
        items: [{ type: 'text', text }],
        stampValue: STAMP,
      })
      const wallMs = performance.now() - t0
      const cpu = process.cpuUsage(cpuBefore)
      f!.setMailbox(undefined)
      expect(sent.stampValueWei).toBe(STAMP)
      // The bundle is what the wallet broadcast plus what the relay broadcast on storing the
      // message (its carried payments, which reach the chain only after that).
      const relayed = offlineChain.relayBroadcasts
        ? f!.requests
            .slice(requestsBefore)
            .reduce((n, request) => n + restoreCanonicalRequest(request).parts.transactions.length, 0)
        : 0
      return {
        wallMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        cpuMs: (cpu.user + cpu.system) / 1000,
        work: {
          transactions: providerBroadcasts.length + relayed,
          signatures: signatures.mock.calls.length - signaturesBefore,
          provider: countByMethod(providerRequests.slice(providerRequestsBefore)),
          // Every message spends coins the wallet already holds: no on-the-spot funding.
          chain: countByMethod(chainHttpRequests),
          relayRequests: f!.requests.length - requestsBefore,
        },
      }
    }

    // The deposit is one large coin. A send that spends a coin that large also splits it into
    // the geometric radix distribution (owner rule: every send spreads money over more
    // accounts), one payment plus `maxChangeOutputs` change transactions in its bundle. That
    // distribution is the cold start of the coin list, as prefunding (`fundAhead`) was of the
    // sub-account pool this budget was first written for: it is bounded by its chain work here
    // and not timed.
    const MAX_BUNDLE = 1 + 20 // the fixture policy's maxChangeOutputs
    const distribution: number[] = []
    for (;;) {
      const { work } = await send(`distribute-${distribution.length}`)
      expect(work.chain).toEqual({})
      expect(work.transactions).toBeLessThanOrEqual(MAX_BUNDLE)
      distribution.push(work.transactions)
      if (work.transactions < MAX_BUNDLE || distribution.length > 3) break
    }

    // Then sequential paid messages: their counted work and their CPU time are the budget.
    const messageCount = 5
    const samples: Awaited<ReturnType<typeof send>>[] = []
    for (let i = 0; i < messageCount; i++) samples.push(await send(`fast-message-${i}`))

    const sortedWall = samples.map(s => s.wallMs).sort((a, b) => a - b)
    const sortedCpu = samples.map(s => s.cpuMs).sort((a, b) => a - b)
    const cpuMedianMs = percentile(sortedCpu, 50)
    const cpuMaxMs = sortedCpu[sortedCpu.length - 1]
    // Kept in the CI log so a margin can be read from any run. Wall time is reported only: on a
    // shared runner it includes time the process was not scheduled at all (one recorded failure
    // took 786.9 ms of wall for 96.6 ms of CPU), so it measured the runner, not the wallet.
    console.log(
      `steady paid DM sends: wall ${samples.map(s => s.wallMs.toFixed(1)).join(', ')} ms ` +
        `(p50 ${percentile(sortedWall, 50).toFixed(1)}, p95 ${percentile(sortedWall, 95).toFixed(1)}, reported only); ` +
        `CPU ${samples.map(s => s.cpuMs.toFixed(1)).join(', ')} ms (median ${cpuMedianMs.toFixed(1)}, max ${cpuMaxMs.toFixed(1)})`,
    )
    console.log(
      `offline fixture paid DM diagnostics: ${samples
        .map((s, i) => `sample ${i + 1}: wall ${s.wallMs.toFixed(1)} ms, CPU user ${s.cpuUserMs.toFixed(1)} ms, system ${s.cpuSystemMs.toFixed(1)} ms, work ${JSON.stringify(s.work)}`)
        .join('; ')}`,
    )

    // Counted work, exact. With the entropy seeded above the sequence of sends is the same on
    // every machine, so any change in what a send asks of the node, signs, or sends to the relay
    // shows here first. The deposit is spread by two full bundles and one of five; the first two
    // measured messages still carry change transactions, and from the third on a send is one
    // payment.
    expect(distribution).toEqual([MAX_BUNDLE, MAX_BUNDLE, 5])
    const steady = {
      transactions: 1,
      signatures: 1,
      provider: { getBalance: 6, getBlock: 2, getBlockNumber: 2, getTransactionCount: 10, getTransactionReceipt: 2 },
      chain: {},
      relayRequests: 1,
    }
    expect(samples.map(s => s.work)).toEqual([
      {
        transactions: 3,
        signatures: 3,
        provider: { broadcastTransaction: 2, getBalance: 12, getBlock: 6, getBlockNumber: 5, getTransactionCount: 18, getTransactionReceipt: 6 },
        chain: {},
        relayRequests: 1,
      },
      {
        transactions: 2,
        signatures: 2,
        provider: { broadcastTransaction: 1, getBalance: 10, getBlock: 4, getBlockNumber: 4, getTransactionCount: 16, getTransactionReceipt: 4 },
        chain: {},
        relayRequests: 1,
      },
      steady,
      steady,
      steady,
    ])

    // CPU budget: process user + system time across the awaited send, which does not grow when
    // the runner is busy or the process is descheduled. Measured before these limits were set,
    // over 58 ubuntu-latest runs of this job (same five sends, entropy not yet seeded): median
    // 41-89 ms, max 69-155 ms per run, including the five runs whose wall-clock gate failed
    // (wall up to 786.9 ms). On an Apple M-series laptop: median ~35-41 ms, max ~65-76 ms, and
    // the same with 36 busy-loop processes saturating its 18 cores (wall then up to 203 ms).
    // The limits are about twice the worst CI value: runner variance stays under them, and a
    // send needing roughly double the CPU fails. Extra requests, signatures or transactions are
    // caught by the exact counts above, not by these.
    expect(cpuMedianMs).toBeLessThan(170)
    expect(cpuMaxMs).toBeLessThan(300)
    expect(bobMailbox).toHaveLength(distribution.length + messageCount)
  })

  it('decrypts, authenticates directory admission, and verifies stamps for a 20-message inbox batch within budget', async () => {
    f = await fixture({ subAccountPoolSize: 6 })
    installCanonicalDirectory(
      f.alice,
      await f.directoryFor('alice', f.alice, f.bob),
    )
    installCanonicalDirectory(
      f.bob,
      await f.directoryFor('bob', f.bob, f.alice),
    )
    const bobMailbox: InboxRecord[] = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), bobMailbox)

    const batchSize = 20
    for (let i = 0; i < batchSize; i++) {
      f.setMailbox(bobMailbox)
      await f.chain.directMessages.send({
        wallet: f.alice,
        recipient: f.bob.identity.address,
        items: [
          {
            type: 'text',
            text: `batch-inbox-payload-${i}-${'x'.repeat(120)}`,
          },
        ],
        stampValue: STAMP,
      })
      f.setMailbox(undefined)
    }
    expect(bobMailbox).toHaveLength(batchSize)

    providerRequests.length = 0
    chainHttpRequests.length = 0
    const poll = await measured(() =>
      f!.chain.directMessages.fetchSince({ wallet: f!.bob, sinceMs: 0 }),
    )
    const pollWork = { provider: countByMethod(providerRequests), chain: countByMethod(chainHttpRequests) }
    console.log(`20-message inbox poll: ${timing(poll)}; work ${JSON.stringify(pollWork)}`)

    expect(poll.value).toHaveLength(batchSize)
    // Stamps are verified from the transactions the messages carry: the poll asks the node
    // nothing.
    expect(pollWork).toEqual({ provider: {}, chain: {} })
    // CPU ceiling per message: the wall budget this replaced, kept as it was. Measured on an
    // Apple M-series laptop: ~8-10 ms per message, unchanged with every core saturated.
    expect(poll.cpuMs / batchSize).toBeLessThan(55)
  })

  it('scales EvmNativeOperationJournal reservation queries in sub-millisecond time across 100 operations', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Transaction, Wallet } = await import('ethers')
    const root = await mkdtemp(join(tmpdir(), 'frank-journal-bench-'))
    const journal = new EvmNativeOperationJournal({
      location: root,
      binding: {
        chainIdentifier: 'monad-testnet',
        nativeChainId: '10143',
        publicTuple: 'bench-wallet-descriptor',
      },
    })
    await journal.Open()
    try {
      const addresses: string[] = []
      for (let i = 0; i < 100; i++) {
        const spendAddr = new Wallet(
          '0x' + (i + 1).toString(16).padStart(64, '0'),
        ).address.toLowerCase()
        addresses.push(spendAddr)
        const row = await journal.prepare({
          kind: 'native',
          recipient: spendAddr,
          intendedValueWei: '1000',
          members: [
            {
              source: { kind: 'spend', address: spendAddr, index: i },
              unsignedTransaction: Transaction.from({
                type: 2,
                chainId: 10143n,
                nonce: 0,
                to: spendAddr,
                value: 1000n,
                gasLimit: 21000n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n,
              }).unsignedSerialized,
              dependencies: [],
            },
          ],
        })
        if (i < 80) {
          await journal.cancelUnsigned(row.operationId)
        }
      }

      const queries = await measured(() => {
        for (let q = 0; q < 200; q++) {
          expect(journal.referencesSpendIndex(85)).toBe(true)
          expect(journal.referencesSpendIndex(10)).toBe(false)
          expect(journal.canSelect(addresses[85], 0)).toBe(false)
          expect(journal.canSelect(addresses[10], 0)).toBe(true)
        }
      })
      console.log(`800 journal reservation queries: ${timing(queries)}`)
      // CPU ceiling for 800 queries, under a quarter of a millisecond each. Process CPU here
      // includes the garbage collector's helper threads, so it runs above wall: ~15-17 ms on an
      // Apple M-series laptop (wall ~11 ms), and CI is about 2.7x slower per core. The queries already
      // scan every row, so this catches a large per-row slowdown (roughly 10x), not a small one.
      expect(queries.cpuMs).toBeLessThan(200)
    } finally {
      await journal.Close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
