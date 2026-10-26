/**
 * INTEGRATION & PERFORMANCE BENCHMARK: Real-world wallet latency, RPC coalescing,
 * construction on spend, high-volume inbox decryption, and journal scaling.
 */
import { performance } from 'node:perf_hooks'
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
    if (f) {
      await f.close()
      f = undefined
    }
  })

  it('opens two real custody wallets and coalesces concurrent balance reads within latency budget', async () => {
    const openStart = performance.now()
    f = await fixture({ subAccountPoolSize: 4 })
    const openElapsedMs = performance.now() - openStart
    expect(openElapsedMs).toBeLessThan(1500)
    const reads = () => {
      const balance = providerRequests.filter(r => r === 'getBalance').length
      const nonce = providerRequests.filter(r => r === 'getTransactionCount').length
      providerRequests.length = 0
      return { balance, nonce }
    }
    const twelveReads = async (wallet: EvmChainWalletHandle) => {
      const start = performance.now()
      const balances = await Promise.all(
        Array.from({ length: 12 }, () => wallet.getBalance()),
      )
      for (const bal of balances) expect(bal).toBeGreaterThan(0n)
      return performance.now() - start
    }

    // A store never walked (a new or restored device): before its first balance is shown the
    // seed's two branches are walked once for the accounts they control, BIP-44 style, which
    // costs one nonce and one balance read per index up to the gap. Twelve concurrent first
    // reads share that one walk and one balance wave.
    providerRequests.length = 0
    await twelveReads(f.alice)
    const first = reads()
    expect(first.nonce).toBe(2 * SEED_DISCOVERY_GAP)
    expect(first.balance - 2 * SEED_DISCOVERY_GAP).toBeLessThanOrEqual(8)

    // Coalescing: 12 concurrent calls on a walked wallet collapse into one wave of at most 8
    // account reads, and the seed is not walked again.
    f.alice.invalidateBalanceCache!()
    providerRequests.length = 0
    const balanceElapsedMs = await twelveReads(f.alice)
    const steady = reads()
    expect(steady.nonce).toBe(0)
    expect(steady.balance).toBeLessThanOrEqual(8)
    expect(balanceElapsedMs).toBeLessThan(200)

    // The store keeps what the walk found: a reopened wallet's first balance needs no walk.
    await f.alice.close()
    const reopened = (await f.chain.createWallet(roots(0))) as EvmChainWalletHandle
    try {
      providerRequests.length = 0
      const reopenElapsedMs = await twelveReads(reopened)
      const again = reads()
      expect(again.nonce).toBe(0)
      expect(again.balance).toBeLessThanOrEqual(8)
      expect(reopenElapsedMs).toBeLessThan(200)
    } finally {
      await reopened.close()
    }
  })

  it('sends paid direct messages without prefunding sender accounts', async () => {
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

    const send = async (text: string) => {
      chainHttpRequests.length = 0
      providerBroadcasts.length = 0
      f!.setMailbox(bobMailbox)
      const requestsBefore = f!.requests.length
      const t0 = performance.now()
      const sent = await f!.chain.directMessages.send({
        wallet: f!.alice,
        recipient: f!.bob.identity.address,
        items: [{ type: 'text', text }],
        stampValue: STAMP,
      })
      const elapsed = performance.now() - t0
      f!.setMailbox(undefined)
      expect(sent.stampValueWei).toBe(STAMP)
      // Every message spends coins the wallet already holds, with zero on-the-spot funding txs
      expect(
        chainHttpRequests.filter(r => r === 'submitRawTransaction'),
      ).toHaveLength(0)
      // The bundle is what the wallet broadcast plus what the relay broadcast on storing the
      // message (its carried payments, which reach the chain only after that).
      const relayed = offlineChain.relayBroadcasts
        ? f!.requests
            .slice(requestsBefore)
            .reduce((n, request) => n + restoreCanonicalRequest(request).parts.transactions.length, 0)
        : 0
      return { elapsed, transactions: providerBroadcasts.length + relayed }
    }

    // The deposit is one large coin. A send that spends a coin that large also splits it into
    // the geometric radix distribution (owner rule: every send spreads money over more
    // accounts), one payment plus `maxChangeOutputs` change transactions in its bundle. That
    // distribution is the cold start of the coin list, as prefunding (`fundAhead`) was of the
    // sub-account pool this budget was first written for: it is bounded by its chain work here
    // and not timed.
    const MAX_BUNDLE = 1 + 20 // the fixture policy's maxChangeOutputs
    let distributing = 0
    for (;;) {
      const { transactions } = await send(`distribute-${distributing}`)
      expect(transactions).toBeLessThanOrEqual(MAX_BUNDLE)
      if (transactions < MAX_BUNDLE) break
      distributing++
      expect(distributing).toBeLessThanOrEqual(3)
    }

    // Now measure critical-path send latency across sequential paid messages
    const sendLatenciesMs: number[] = []
    const messageCount = 5
    for (let i = 0; i < messageCount; i++)
      sendLatenciesMs.push((await send(`fast-message-${i}`)).elapsed)

    const sorted = [...sendLatenciesMs].sort((a, b) => a - b)
    const p50 = percentile(sorted, 50)
    const p95 = percentile(sorted, 95)
    // The measured numbers stay in the CI log, so a margin can be read from a passing run.
    console.log(
      `steady paid DM sends: ${sendLatenciesMs.map(ms => ms.toFixed(1)).join(', ')} ms; p50 ${p50.toFixed(1)}, p95 ${p95.toFixed(1)}`,
    )
    expect(p50).toBeLessThan(110)
    expect(p95).toBeLessThan(180)
    expect(bobMailbox).toHaveLength(distributing + 1 + messageCount)
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

    const pollStart = performance.now()
    const received = await f.chain.directMessages.fetchSince({
      wallet: f.bob,
      sinceMs: 0,
    })
    const pollElapsedMs = performance.now() - pollStart

    expect(received).toHaveLength(batchSize)
    const perMessageMs = pollElapsedMs / batchSize
    expect(perMessageMs).toBeLessThan(55)
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

      const queryStart = performance.now()
      for (let q = 0; q < 200; q++) {
        expect(journal.referencesSpendIndex(85)).toBe(true)
        expect(journal.referencesSpendIndex(10)).toBe(false)
        expect(journal.canSelect(addresses[85], 0)).toBe(false)
        expect(journal.canSelect(addresses[10], 0)).toBe(true)
      }
      const queryElapsedMs = performance.now() - queryStart
      expect(queryElapsedMs).toBeLessThan(50)
    } finally {
      await journal.Close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
