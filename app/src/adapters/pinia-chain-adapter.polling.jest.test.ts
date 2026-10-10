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

const documentListeners: Record<string, () => void> = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = {
  hasFocus: () => true,
  hidden: false,
  addEventListener: (event: string, cb: () => void) => {
    documentListeners[event] = cb
  },
  removeEventListener: (event: string) => {
    delete documentListeners[event]
  },
}

import axios from 'axios'
import { useMailboxStatusStore } from '../stores/mailbox-status'
import {
  BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
  MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS,
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
import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import { messageItems } from '../utils/message-items'
import { setConversationIdSalt as installTestConversationIdSalt } from '../stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    relayCursor: jest.fn(async () => 0),
    quarantineRelayReceipts: jest.fn(async () => undefined),
    suppressAndDelete: jest.fn(async () => undefined),
    suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
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
  // As the app's session does for every wallet: without a registry nothing is read.
  installMessageItemRegistry(wallet, messageItems)
  return { relay, identity, wallet }
}

const count = (relay: MockMailboxRelay, route: string, status?: number) =>
  relay.log.filter(
    l => l.route === route && (status === undefined || l.status === status),
  ).length

/** Advance 1 s at a time for `seconds`, returning the second at which each new challenge request
 * (= one poll attempt) was first observed. */
async function pollTimeline(
  relay: MockMailboxRelay,
  seconds: number,
): Promise<number[]> {
  // Cursor initialization is asynchronous but deliberately happens before the first relay call.
  // Let that one-time local read settle so the timeline remains relative to the immediate poll.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const times: number[] = []
  let seen = count(relay, 'challenge')
  for (let t = 1; t <= seconds; t++) {
    await jest.advanceTimersByTimeAsync(1000)
    const n = count(relay, 'challenge')
    if (n !== seen) {
      times.push(t)
      seen = n
    }
  }
  return times
}

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
    // Tiny cap so the loop hits it quickly: poll 1 = inbox (1), poll 2 = inbox (2),
    // poll 3 = inbox -> 429 (unified mailbox recovery, ticket #922).
    const { relay, wallet } = setup({ maxUsedChallenges: 2 })
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
    expect(count(relay, 'inbox', 200)).toBeGreaterThanOrEqual(2)
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
    // The ladder actually reaches the 60 s cap (and no further).
    expect(gaps.some(g => g >= 59 && g <= 61)).toBe(true)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(
      MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS / 1000 + 1,
    )
  })

  it('the 404 backoff ladder restarts after a success (404, 404, success, 404 -> 14 s again)', async () => {
    const { relay, wallet } = setup({ maxUsedChallenges: 30 })
    relay.inject('challenge', { status: 404 }, { status: 404 })
    const polling = startDirectMessagePolling({ wallet })
    // Attempts: 0 (404) -> +14 -> 14 (404) -> +28 -> 42 (success) -> 7 s cadence.
    const first = await pollTimeline(relay, 60)
    expect(first.slice(0, 3)).toEqual([14, 42, 49])
    relay.inject('challenge', { status: 404 })
    const second = await pollTimeline(relay, 40)
    // Next poll fails with 404 (ladder was reset by the success), so the following gap is 14 s,
    // not the 56 s a non-reset counter would give.
    const fail = second.findIndex((t, i) => i > 0 && t - second[i - 1] > 8)
    expect(second[fail] - second[fail - 1]).toBe(14)
    polling.stop()
  })

  it('an unknown error (500) backs off modestly and is logged once, resetting on success', async () => {
    const { relay, wallet } = setup({ maxUsedChallenges: 30 })
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    relay.inject('challenge', { status: 500 }, { status: 500 }, { status: 500 })
    const polling = startDirectMessagePolling({ wallet })
    const times = await pollTimeline(relay, 80)
    // Attempts at 0 (fail, 7 s), 7 (fail, 14 s), 21 (fail, 28 s), 49 (success), then 56...
    expect(times.slice(0, 5)).toEqual([7, 21, 49, 56, 63])
    expect(errorSpy).toHaveBeenCalledTimes(1) // identical consecutive errors log once
    polling.stop()
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

  describe('mailbox status shown to the user (ticket #271)', () => {
    it('reports unavailable on a 404 mailbox and clears after a successful poll', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      relay.inject('challenge', { status: 404 })
      const status = useMailboxStatusStore()
      expect(status.state).toBe('ok')
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('unavailable')
      expect(status.retryInMs).toBe(14_000)
      await jest.advanceTimersByTimeAsync(14_000)
      expect(status.state).toBe('ok')
      expect(status.retryInMs).toBeNull()
      polling.stop()
    })

    it('reports rate-limited on a 429 capacity answer and clears on recovery', async () => {
      // Same tiny cap as the Retry-After test above: the third poll's inbox read is refused (429).
      const { wallet } = setup({ maxUsedChallenges: 2 })
      const polling = startDirectMessagePolling({ wallet })
      const status = useMailboxStatusStore()
      await jest.advanceTimersByTimeAsync(7000 * 2 + 1000)
      expect(status.state).toBe('rate-limited')
      expect(status.retryInMs).toBeGreaterThanOrEqual(60_000)
      await jest.advanceTimersByTimeAsync(70_000)
      expect(status.state).toBe('ok')
      polling.stop()
    })

    it('reports rate-limited on duck-typed 429 without ChallengeCapacityError instance', async () => {
      const { wallet } = setup({ maxUsedChallenges: 120 })
      const fetchSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockRejectedValueOnce({
          status: 429,
          code: 'mailbox_challenge_capacity',
          retryAfterMs: 45_000,
        })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('rate-limited')
      expect(status.retryInMs).toBe(45_000)
      polling.stop()
      fetchSpy.mockRestore()
    })

    it('reports rate-limited on generic 429 status and defaults retryInMs to 60s', async () => {
      const { wallet } = setup({ maxUsedChallenges: 120 })
      const fetchSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockRejectedValueOnce({
          status: 429,
        })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('rate-limited')
      expect(status.retryInMs).toBe(60_000)
      polling.stop()
      fetchSpy.mockRestore()
    })

    it('shows unreachable only from the second consecutive failure, then clears', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      relay.inject('challenge', { status: 500 }, { status: 500 })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('ok') // one blip is not surfaced
      await jest.advanceTimersByTimeAsync(7000)
      expect(status.state).toBe('unreachable')
      await jest.advanceTimersByTimeAsync(20_000)
      expect(status.state).toBe('ok')
      polling.stop()
    })

    it('stop() clears a shown problem', async () => {
      const { relay, wallet } = setup({ enabled: false })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('unavailable')
      polling.stop()
      expect(status.state).toBe('ok')
      expect(relay).toBeDefined()
    })
    it('a poll that fails after stop() does not put a problem back (in-flight race)', async () => {
      const { relay, wallet } = setup({ enabled: false })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      polling.stop() // the first poll is already in flight
      expect(status.state).toBe('ok')
      await jest.advanceTimersByTimeAsync(30_000)
      expect(count(relay, 'challenge')).toBeGreaterThan(0)
      expect(status.state).toBe('ok')
      expect(status.retryInMs).toBeNull()
    })

    it('maps a 401 to unauthorized, only from the second consecutive failure', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      // A 401 is retried once with a fresh challenge, so each poll consumes two 401s.
      relay.inject(
        'inbox',
        { status: 401 },
        { status: 401 },
        { status: 401 },
        { status: 401 },
      )
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('ok') // first failure is not surfaced
      await jest.advanceTimersByTimeAsync(7000)
      expect(status.state).toBe('unauthorized')
      await jest.advanceTimersByTimeAsync(20_000)
      expect(status.state).toBe('ok')
      polling.stop()
    })

    it('triggers onAuthRecovery when direct-message polling encounters 401', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      relay.inject('inbox', { status: 401 }, { status: 401 })
      const onAuthRecovery = jest.fn(async () => undefined)
      const polling = startDirectMessagePolling({ wallet, onAuthRecovery })
      await jest.advanceTimersByTimeAsync(1000)
      expect(onAuthRecovery).toHaveBeenCalled()
      polling.stop()
    })

    it('a 404 resets the consecutive-failure count and a later plain failure replaces the 404 state', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      relay.inject(
        'challenge',
        { status: 500 },
        { status: 404 },
        { status: 500 },
      )
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('ok') // plain failure #1: not surfaced
      await jest.advanceTimersByTimeAsync(7000)
      expect(status.state).toBe('unavailable') // 404
      await jest.advanceTimersByTimeAsync(14_000)
      // plain failure again: not "two consecutive" (the 404 intervened) so the backoff stays at
      // the base interval, yet the stale "relay does not offer messaging" is replaced.
      expect(status.state).toBe('unreachable')
      expect(status.retryInMs).toBe(7000)
      await jest.advanceTimersByTimeAsync(7000)
      expect(status.state).toBe('ok')
      polling.stop()
    })

    it('a 429 also resets the consecutive-failure count', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      relay.inject(
        'challenge',
        { status: 500 },
        {
          status: 429,
          body: { error: 'mailbox_challenge_capacity' },
          headers: { 'retry-after': '10' },
        },
        { status: 500 },
      )
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000 + 7000 + 1000)
      expect(status.state).toBe('rate-limited')
      await jest.advanceTimersByTimeAsync(10_000)
      expect(status.state).toBe('unreachable')
      expect(status.retryInMs).toBe(7000)
      polling.stop()
    })
  })

  describe('energy optimization and visibility lifecycle', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = false
    })

    it('floors poll delay at MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS (2500ms) on slow fetches', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      let first = true
      // Delay only the initial request by 6000ms so the first poll takes exactly 6000ms elapsed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedAxios.mockImplementation(async (config: any) => {
        if (first) {
          first = false
          await new Promise(r => setTimeout(r, 6000))
        }
        return relay.http({
          method: config.method,
          url: config.url,
          params: config.params,
          headers: config.headers,
        })
      })

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      // Initial poll takes 6000ms.
      await jest.advanceTimersByTimeAsync(6000)
      const challengesAfterPoll1 = count(relay, 'challenge')
      expect(challengesAfterPoll1).toBeGreaterThanOrEqual(1)

      // In steady state: 7000 - 6000 = 1000ms, but floored at MIN (2500ms).
      // Advance 2400ms: poll 2 should NOT have started yet
      await jest.advanceTimersByTimeAsync(2400)
      expect(count(relay, 'challenge')).toBe(challengesAfterPoll1)

      // Advance 200ms (total 2600ms): poll 2 initiates
      await jest.advanceTimersByTimeAsync(200)
      expect(count(relay, 'challenge')).toBeGreaterThan(challengesAfterPoll1)

      polling.stop()
    })

    it('relaxes polling to at least BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS (30s) when hidden', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = true

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      await jest.advanceTimersByTimeAsync(100) // Initial poll completes immediately
      expect(count(relay, 'challenge')).toBe(1)

      // Advance 25s: should NOT poll while hidden
      await jest.advanceTimersByTimeAsync(25_000)
      expect(count(relay, 'challenge')).toBe(1)

      // Advance 6s (total >30s): background poll fires
      await jest.advanceTimersByTimeAsync(6000)
      expect(count(relay, 'challenge')).toBe(2)

      polling.stop()
    })

    it('wakes up immediately when document becomes visible', async () => {
      const { relay, wallet } = setup({ maxUsedChallenges: 30 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = true

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      await jest.advanceTimersByTimeAsync(100)
      expect(count(relay, 'challenge')).toBe(1)

      // In background for 10s
      await jest.advanceTimersByTimeAsync(10_000)
      expect(count(relay, 'challenge')).toBe(1)

      // Tab becomes visible: trigger listener
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = false
      documentListeners['visibilitychange']?.()
      await jest.advanceTimersByTimeAsync(100)
      expect(count(relay, 'challenge')).toBe(2)

      polling.stop()
    })
  })
})
