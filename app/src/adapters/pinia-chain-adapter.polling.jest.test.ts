/**
 * The direct-message polling loop (`startDirectMessagePolling`): its cadence, how long it waits
 * after each kind of mailbox failure, what it shows the user, and that it recovers after a
 * success. Fake timers drive the default 7 s cadence.
 *
 * The transport is not the subject, so the read is replaced at the one seam the loop calls:
 * `activeChain.directMessages.fetchSince`. It rejects with the errors the mailbox client really
 * throws for a relay's 404, 429, 401 and 500 (`@frank/cashweb/relay/monad-mailbox-client`), which
 * is what the wallet's read passes up unchanged.
 */
import { createPinia, setActivePinia } from 'pinia'
import { syncOwnProfileWithRelay } from '../utils/own-profile'

jest.mock('../utils/own-profile', () => ({
  syncOwnProfileWithRelay: jest.fn().mockResolvedValue('unchanged'),
}))

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

import { useMailboxStatusStore } from '../stores/mailbox-status'
import {
  BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
  MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  startDirectMessagePolling,
} from './pinia-chain-adapter'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import {
  MonadMailboxAuthError,
  MonadMailboxChallengeCapacityError,
  MonadMailboxError,
  MonadMailboxUnavailableError,
} from '@frank/cashweb/relay/monad-mailbox-client'
import { activeChain, type WalletHandle } from '@frank/wallet/chain'

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

jest.setTimeout(120_000)

/** What one read answers: an error to reject with, and/or how long the read takes. */
interface Answer {
  error?: unknown
  delayMs?: number
}
/** The relay's 404 for a mailbox route. */
const unavailable = (): Answer => ({
  error: new MonadMailboxUnavailableError(
    'Canonical private mailbox: HTTP 404',
    404,
  ),
})
/** The relay's 429 `mailbox_challenge_capacity`, with its Retry-After. */
const capacity = (retryAfterMs = 60_000): Answer => ({
  error: new MonadMailboxChallengeCapacityError(
    'Canonical private mailbox: HTTP 429 mailbox_challenge_capacity',
    retryAfterMs,
  ),
})
/** The relay's 401 for the signed read (after the client's one retry with a fresh challenge). */
const unauthorized = (): Answer => ({
  error: new MonadMailboxAuthError(
    'Canonical private mailbox: HTTP 401',
    'request',
  ),
})
/** Any other status: the client's plain mailbox error. */
const serverError = (): Answer => ({
  error: new MonadMailboxError('Canonical private mailbox: HTTP 500', 500),
})

/** A mailbox whose reads answer from `queue` first, then from `always`, then succeed empty. */
class Mailbox {
  /** `Date.now()` (fake clock) at the start of every read. */
  readonly reads: number[] = []
  private readonly queue: Answer[] = []
  always: Answer | undefined
  inject(...answers: Answer[]) {
    this.queue.push(...answers)
  }
  get count() {
    return this.reads.length
  }
  async read(): Promise<[]> {
    this.reads.push(Date.now())
    const answer = this.queue.shift() ?? this.always ?? {}
    if (answer.delayMs !== undefined)
      await new Promise(resolve => setTimeout(resolve, answer.delayMs))
    if (answer.error !== undefined) throw answer.error
    return []
  }
}

function setup(always?: Answer) {
  const mailbox = new Mailbox()
  mailbox.always = always
  jest
    .spyOn(activeChain.directMessages, 'fetchSince')
    .mockImplementation(() => mailbox.read())
  const identity = MonadIdentity.generate()
  const wallet = { identity } as unknown as WalletHandle
  return { mailbox, wallet }
}

/** Advance 1 s at a time for `seconds`, returning the second at which each new read (= one poll
 * attempt) was first observed. */
async function pollTimeline(
  mailbox: Mailbox,
  seconds: number,
): Promise<number[]> {
  // Cursor initialization is asynchronous but deliberately happens before the first read.
  // Let that one-time local read settle so the timeline remains relative to the immediate poll.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const times: number[] = []
  let seen = mailbox.count
  for (let t = 1; t <= seconds; t++) {
    await jest.advanceTimersByTimeAsync(1000)
    const n = mailbox.count
    if (n !== seen) {
      times.push(t)
      seen = n
    }
  }
  return times
}

describe('direct-message polling: cadence, backoff and status', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    // The push stream is a second transport beside the poll; it is not under test here.
    if (activeChain.directMessages.subscribeMailboxStream)
      jest
        .spyOn(activeChain.directMessages, 'subscribeMailboxStream')
        .mockReturnValue(() => undefined)
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('retries an unreachable own profile on the next successful poll', async () => {
    const sync = jest.mocked(syncOwnProfileWithRelay)
    sync.mockClear()
    sync.mockResolvedValueOnce('unreachable').mockResolvedValueOnce('adopted')
    const { wallet, mailbox } = setup()
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(1000)
    expect(sync).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(7000)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(mailbox.count).toBe(2)
    polling.stop()
    expect(sync.mock.calls[1][0].isCancelled?.()).toBe(true)
  })

  it('a slow profile read does not delay mailbox polls or start overlapping profile reads', async () => {
    const sync = jest.mocked(syncOwnProfileWithRelay)
    sync.mockClear()
    let finish!: (outcome: 'unchanged') => void
    sync.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const { wallet, mailbox } = setup()
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(22_000)
    expect(mailbox.count).toBe(4)
    expect(sync).toHaveBeenCalledTimes(1)
    polling.stop()
    finish('unchanged')
    await Promise.resolve()
  })

  it('steady state at the default 7 s cadence reads once per poll, about nine times a minute', async () => {
    const { mailbox, wallet } = setup()
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000)
    polling.stop()

    expect(DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBe(7000)
    expect(mailbox.count).toBeGreaterThanOrEqual(40)
    // Reads inside any 60 s window: the relay bounds authenticated reads per recipient per
    // minute, so the cadence itself must stay far below a bound of 30.
    let peak = 0
    for (const start of mailbox.reads) {
      peak = Math.max(
        peak,
        mailbox.reads.filter(t => t >= start && t < start + 60_000).length,
      )
    }
    expect(peak).toBeLessThanOrEqual(11)
  })

  it('backs off for the relay-requested Retry-After on 429 capacity and keeps polling', async () => {
    // Polls 1 and 2 succeed; poll 3 is refused with the relay's 60 s Retry-After.
    const { mailbox, wallet } = setup()
    mailbox.inject({}, {}, capacity(60_000))
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(7000 * 2 + 1000)
    expect(mailbox.count).toBe(3)

    // Retry-After is 60 s: no read at all during the next ~59 s (a fixed cadence: 8 more).
    await jest.advanceTimersByTimeAsync(58_000)
    expect(mailbox.count).toBe(3)

    // After the pause polling resumes, at the steady cadence again.
    await jest.advanceTimersByTimeAsync(10_000)
    expect(mailbox.count).toBeGreaterThanOrEqual(5)
    polling.stop()
  })

  it('backs off progressively (capped) while the relay has no mailbox, and stays alive', async () => {
    const { mailbox, wallet } = setup(unavailable())
    const polling = startDirectMessagePolling({ wallet })
    const timeline: number[] = []
    let last = 0
    for (let i = 0; i < 300; i++) {
      await jest.advanceTimersByTimeAsync(1000)
      const n = mailbox.count
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
    const { mailbox, wallet } = setup()
    mailbox.inject(unavailable(), unavailable())
    const polling = startDirectMessagePolling({ wallet })
    // Attempts: 0 (404) -> +14 -> 14 (404) -> +28 -> 42 (success) -> 7 s cadence.
    const first = await pollTimeline(mailbox, 60)
    expect(first.slice(0, 3)).toEqual([14, 42, 49])
    mailbox.inject(unavailable())
    const second = await pollTimeline(mailbox, 40)
    // Next poll fails with 404 (ladder was reset by the success), so the following gap is 14 s,
    // not the 56 s a non-reset counter would give.
    const fail = second.findIndex((t, i) => i > 0 && t - second[i - 1] > 8)
    expect(second[fail] - second[fail - 1]).toBe(14)
    polling.stop()
  })

  it('an unknown error (500) backs off modestly and is logged once, resetting on success', async () => {
    const { mailbox, wallet } = setup()
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    mailbox.inject(serverError(), serverError(), serverError())
    const polling = startDirectMessagePolling({ wallet })
    const times = await pollTimeline(mailbox, 80)
    // Attempts at 0 (fail, 7 s), 7 (fail, 14 s), 21 (fail, 28 s), 49 (success), then 56...
    expect(times.slice(0, 5)).toEqual([7, 21, 49, 56, 63])
    expect(errorSpy).toHaveBeenCalledTimes(1) // identical consecutive errors log once
    polling.stop()
  })

  it('stop() prevents any further read', async () => {
    const { mailbox, wallet } = setup()
    const polling = startDirectMessagePolling({ wallet })
    await jest.advanceTimersByTimeAsync(1000)
    polling.stop()
    const seen = mailbox.count
    expect(seen).toBe(1)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(mailbox.count).toBe(seen)
  })

  describe('mailbox status shown to the user (ticket #271)', () => {
    it('reports unavailable on a 404 mailbox and clears after a successful poll', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject(unavailable())
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
      // As in the Retry-After test above: the third poll's read is refused (429).
      const { mailbox, wallet } = setup()
      mailbox.inject({}, {}, capacity(60_000))
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
      const { mailbox, wallet } = setup()
      mailbox.inject({
        error: {
          status: 429,
          code: 'mailbox_challenge_capacity',
          retryAfterMs: 45_000,
        },
      })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('rate-limited')
      expect(status.retryInMs).toBe(45_000)
      polling.stop()
    })

    it('reports rate-limited on generic 429 status and defaults retryInMs to 60s', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject({ error: { status: 429 } })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('rate-limited')
      expect(status.retryInMs).toBe(60_000)
      polling.stop()
    })

    it('shows unreachable only from the second consecutive failure, then clears', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject(serverError(), serverError())
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
      const { wallet } = setup(unavailable())
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('unavailable')
      polling.stop()
      expect(status.state).toBe('ok')
    })

    it('a poll that fails after stop() does not put a problem back (in-flight race)', async () => {
      // The read takes 5 s and then fails; stop() arrives while it is in flight.
      const { mailbox, wallet } = setup({ ...unavailable(), delayMs: 5000 })
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({ wallet })
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      expect(mailbox.count).toBe(1)
      polling.stop() // the first poll is already in flight
      expect(status.state).toBe('ok')
      await jest.advanceTimersByTimeAsync(30_000)
      expect(mailbox.count).toBe(1)
      expect(status.state).toBe('ok')
      expect(status.retryInMs).toBeNull()
    })

    it('maps a 401 to unauthorized, only from the second consecutive failure', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject(unauthorized(), unauthorized())
      const status = useMailboxStatusStore()
      const polling = startDirectMessagePolling({
        wallet,
        onAuthRecovery: async () => undefined,
      })
      await jest.advanceTimersByTimeAsync(1000)
      expect(status.state).toBe('ok') // first failure is not surfaced
      await jest.advanceTimersByTimeAsync(7000)
      expect(status.state).toBe('unauthorized')
      await jest.advanceTimersByTimeAsync(20_000)
      expect(status.state).toBe('ok')
      polling.stop()
    })

    it('triggers onAuthRecovery when direct-message polling encounters 401', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject(unauthorized())
      const onAuthRecovery = jest.fn(async () => undefined)
      const polling = startDirectMessagePolling({ wallet, onAuthRecovery })
      await jest.advanceTimersByTimeAsync(1000)
      expect(onAuthRecovery).toHaveBeenCalledTimes(1)
      polling.stop()
    })

    it('a 404 resets the consecutive-failure count and a later plain failure replaces the 404 state', async () => {
      const { mailbox, wallet } = setup()
      mailbox.inject(serverError(), unavailable(), serverError())
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
      const { mailbox, wallet } = setup()
      mailbox.inject(serverError(), capacity(10_000), serverError())
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
      expect(MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBe(2500)
      const { mailbox, wallet } = setup()
      // Only the first read is slow: it takes 6000 ms.
      mailbox.inject({ delayMs: 6000 })

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      await jest.advanceTimersByTimeAsync(6000)
      expect(mailbox.count).toBe(1)

      // In steady state: 7000 - 6000 = 1000ms, but floored at MIN (2500ms).
      // Advance 2400ms: poll 2 should NOT have started yet
      await jest.advanceTimersByTimeAsync(2400)
      expect(mailbox.count).toBe(1)

      // Advance 200ms (total 2600ms): poll 2 initiates
      await jest.advanceTimersByTimeAsync(200)
      expect(mailbox.count).toBe(2)

      polling.stop()
    })

    it('relaxes polling to at least BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS (30s) when hidden', async () => {
      expect(BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBe(30_000)
      const { mailbox, wallet } = setup()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = true

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      await jest.advanceTimersByTimeAsync(100) // Initial poll completes immediately
      expect(mailbox.count).toBe(1)

      // Advance 25s: should NOT poll while hidden
      await jest.advanceTimersByTimeAsync(25_000)
      expect(mailbox.count).toBe(1)

      // Advance 6s (total >30s): background poll fires
      await jest.advanceTimersByTimeAsync(6000)
      expect(mailbox.count).toBe(2)

      polling.stop()
    })

    it('wakes up immediately when document becomes visible', async () => {
      const { mailbox, wallet } = setup()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = true

      const polling = startDirectMessagePolling({ wallet, intervalMs: 7000 })
      await jest.advanceTimersByTimeAsync(100)
      expect(mailbox.count).toBe(1)

      // In background for 10s
      await jest.advanceTimersByTimeAsync(10_000)
      expect(mailbox.count).toBe(1)

      // Tab becomes visible: trigger listener
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(global as any).document.hidden = false
      documentListeners['visibilitychange']?.()
      await jest.advanceTimersByTimeAsync(100)
      expect(mailbox.count).toBe(2)

      polling.stop()
    })
  })
})
