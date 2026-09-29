/**
 * Integration-style test of the REAL direct-message polling loop (`startDirectMessagePolling` ->
 * `MonadChain.directMessages.fetchSince` -> mailbox client -> signed challenge/inbox reads)
 * against `MockMailboxRelay`, which enforces the relay's per-recipient cap on consumed
 * challenges. Fake timers drive the default 7 s cadence.
 *
 * The cap modelled here is 30 per 60 s: the relay follow-up to #197 (a dependency of this PR);
 * #197 as first merged had 8, which even an inbox-only 7 s poll (~8.6/min) exceeds.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import axios from 'axios'
import {
  DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
  startDirectMessagePolling,
} from './pinia-chain-adapter'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { InMemoryStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'
import { MockMailboxRelay } from '@frank/cashweb/relay/monad-mailbox-mock-relay.testutil'
import {
  fetchMonadMailboxInbox,
  fetchMonadMailboxRecoveries,
} from '@frank/cashweb/relay/monad-mailbox-client'
import { mailboxAuthFor } from '@frank/wallet/monad-identity'
import type { WalletHandle } from '@frank/wallet/chain'

jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))

const mockedAxios = axios as unknown as jest.Mock
jest.setTimeout(120_000)
const BASE = 'https://relay.test'

function setup(
  relayOptions: ConstructorParameters<typeof MockMailboxRelay>[0],
) {
  const relay = new MockMailboxRelay(relayOptions)
  const identity = MonadIdentity.generate()
  relay.registerProfile(identity.address.raw, identity.compressedPubKey)
  mockedAxios.mockImplementation(async (config: any) => {
    const response = await relay.http({
      method: config.method,
      url: config.url,
      params: config.params,
      headers: config.headers,
    })
    return response
  })
  const wallet = {
    identity,
    pool: {},
    leaseManager: {},
    provider: {},
    httpClient: {},
    relayBaseUrl: BASE,
    stampPaymentJournal: new InMemoryStampPaymentJournal(),
  } as unknown as WalletHandle
  return { relay, identity, wallet }
}

const count = (relay: MockMailboxRelay, route: string, status?: number) =>
  relay.log.filter(
    l => l.route === route && (status === undefined || l.status === status),
  ).length

describe('direct-message polling vs the relay challenge cap', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    })
    mockedAxios.mockReset()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('steady state at the default 7 s cadence never hits the cap (one challenge per poll)', async () => {
    const { relay, wallet } = setup({ maxUsedChallenges: 30 })
    const polling = startDirectMessagePolling({ wallet })
    let peak = 0
    for (let second = 0; second < 5 * 60; second++) {
      await jest.advanceTimersByTimeAsync(1000)
      peak = Math.max(peak, relay.usedChallenges(wallet.identity.address.raw))
    }
    polling.stop()
    // Live consumed challenges in any 60 s window: ~9 inbox reads + 1 recovery. The old cadence
    // (inbox + recovery every poll) peaked at ~18 and fails this bound.
    expect(peak).toBeLessThanOrEqual(11)

    expect(DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBe(7000)
    const polls = count(relay, 'inbox')
    expect(polls).toBeGreaterThanOrEqual(40)
    expect(count(relay, 'inbox', 429)).toBe(0)
    expect(relay.log.filter(l => l.status === 429)).toHaveLength(0)
    // Recovery synced about once a minute, not every poll.
    expect(count(relay, 'recovery')).toBeLessThanOrEqual(6)
    // Peak consumption inside the 60 s window stays well under the cap.
  })

  it('CONTROL: against the cap of 8 that #197 first merged with, even one challenge per 7 s poll is rate limited (why the raise to 30 is a dependency)', async () => {
    const { relay, identity } = setup({ maxUsedChallenges: 8 })
    const auth = mailboxAuthFor(identity, BASE)
    let capacityErrors = 0
    let stopped = false
    const loop = (async () => {
      while (!stopped) {
        try {
          await fetchMonadMailboxInbox({ ...auth, sinceMs: 0 })
          await fetchMonadMailboxRecoveries(auth)
        } catch {
          capacityErrors++
        }
        await new Promise(resolve => setTimeout(resolve, 7000))
      }
    })()
    await jest.advanceTimersByTimeAsync(3 * 60 * 1000)
    stopped = true
    await jest.advanceTimersByTimeAsync(8000)
    await loop
    expect(capacityErrors).toBeGreaterThan(0)
    expect(relay.log.some(l => l.status === 429)).toBe(true)
  })

  it('backs off for the relay-requested Retry-After on 429 capacity and keeps polling', async () => {
    // Tiny cap so the loop hits it quickly: poll 1 = inbox + recovery (2), poll 2 = inbox (3),
    // poll 3 = inbox -> 429.
    const { relay, wallet } = setup({ maxUsedChallenges: 3 })
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(7000 * 2 + 1000)
    expect(count(relay, 'inbox', 429)).toBe(1)
    const readsAtLimit = count(relay, 'inbox')

    // Retry-After is 60 s: no request at all during the next ~59 s (old loop: 8 more).
    await jest.advanceTimersByTimeAsync(58_000)
    expect(count(relay, 'inbox')).toBe(readsAtLimit)

    // After the pause the consumed challenges have expired and polling resumes successfully.
    await jest.advanceTimersByTimeAsync(10_000)
    expect(count(relay, 'inbox')).toBeGreaterThan(readsAtLimit)
    expect(count(relay, 'inbox', 200)).toBeGreaterThanOrEqual(3)
    polling.stop()
  })

  it('backs off progressively (capped) while the relay has no mailbox, and stays alive', async () => {
    const { relay, wallet } = setup({ enabled: false })
    const polling = startDirectMessagePolling({ wallet })
    const timeline: number[] = []
    let last = 0
    for (let i = 0; i < 300; i++) {
      await jest.advanceTimersByTimeAsync(1000)
      const n = count(relay, 'challenge')
      if (n !== last) {
        timeline.push(i + 1)
        last = n
      }
    }
    polling.stop()
    // 404s: attempts at ~0, 14, 42, 98, 158, 218, 278 s instead of 43 hammering polls.
    expect(timeline.length).toBeGreaterThanOrEqual(5)
    expect(timeline.length).toBeLessThanOrEqual(8)
    const gaps = timeline.slice(1).map((t, i) => t - timeline[i])
    expect(gaps[1]).toBeGreaterThan(gaps[0])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(
      MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS / 1000 + 1,
    )
  })

  it('stop() prevents any further request', async () => {
    const { relay, wallet } = setup({})
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(1000)
    polling.stop()
    const seen = relay.log.length
    await jest.advanceTimersByTimeAsync(60_000)
    expect(relay.log.length).toBe(seen)
  })
})
