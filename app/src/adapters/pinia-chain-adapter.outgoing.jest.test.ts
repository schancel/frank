/**
 * Background reconciliation of outgoing messages whose payment is pending (#270): backoff, no new
 * payment, flips to sent on delivery. Plain `node` env, see `../stores/chats.jest.test.ts`.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  IDLE_OUTGOING_RECONCILE_INTERVAL_MS,
  MAX_OUTGOING_RECONCILE_INTERVAL_MS,
  OUTGOING_RECONCILE_INTERVAL_MS,
  startOutgoingReconciliation,
} from './pinia-chain-adapter'
import { useChatStore } from '../stores/chats'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import { MonadStampPendingAttemptError } from '@frank/wallet/monad-stamp-client'

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

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const HASH = 'ab'.repeat(32)
const wallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle

describe('startOutgoingReconciliation (#270)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => jest.useRealTimers())

  async function pendingMessage() {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new MonadStampPendingAttemptError([HASH])
      })
    const chats = useChatStore()
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: [{ type: 'text', text: 'held two' }],
    })
    expect(chats.chats[PEER]?.messages[0].status).toBe('payment-pending')
    return { chats, send }
  }

  it('re-sends the same payment on a doubling backoff and flips to Sent when it delivers, without ever building another payment', async () => {
    const { chats, send } = await pendingMessage()
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({ [HASH]: 'live' })

    const polling = startOutgoingReconciliation({ wallet })
    await jest.advanceTimersByTimeAsync(0)
    expect(reconcile).toHaveBeenCalledTimes(1)

    // Still pending: pauses of 30 s, 60 s, then capped at 120 s.
    await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS - 1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(4)
    expect(chats.chats[PEER]?.messages[0].status).toBe('payment-pending')

    // The receipt lands; the very same bytes are accepted.
    reconcile.mockResolvedValue({ [HASH]: 'delivered' })
    await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(chats.chats[PEER]?.messages).toEqual([
      expect.objectContaining({ payloadDigest: HASH, status: 'confirmed' }),
    ])
    expect(send).toHaveBeenCalledTimes(1)
    polling.stop()
  })

  it('stop() ends the loop', async () => {
    await pendingMessage()
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({ [HASH]: 'live' })
    const polling = startOutgoingReconciliation({ wallet })
    await jest.advanceTimersByTimeAsync(0)
    polling.stop()
    await jest.advanceTimersByTimeAsync(10 * MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('a NEW pending message resets the backoff instead of waiting out the old one', async () => {
    const { chats } = await pendingMessage()
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({ [HASH]: 'live' })
    const polling = startOutgoingReconciliation({ wallet })
    await jest.advanceTimersByTimeAsync(0)
    // Let the backoff climb to its 120 s cap.
    await jest.advanceTimersByTimeAsync(
      2 * OUTGOING_RECONCILE_INTERVAL_MS +
        4 * OUTGOING_RECONCILE_INTERVAL_MS +
        MAX_OUTGOING_RECONCILE_INTERVAL_MS,
    )
    const callsBefore = reconcile.mock.calls.length

    // A second message becomes payment-pending with its own attempt.
    const HASH2 = 'cd'.repeat(32)
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async params => {
        await params.onAttemptCreated?.(HASH2)
        throw new MonadStampPendingAttemptError([HASH2])
      })
    reconcile.mockResolvedValue({ [HASH]: 'live', [HASH2]: 'live' })
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: [{ type: 'text', text: 'second' }],
    })
    await jest.advanceTimersByTimeAsync(OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile.mock.calls.length).toBeGreaterThan(callsBefore)
    polling.stop()
  })

  describe('one timer chain only', () => {
    it('after a reload with one pending message and one tick, exactly one timer is scheduled', async () => {
      const { chats } = await pendingMessage()
      // As after a reload: the attempt is recorded but not yet confirmed live this session.
      const message = chats.chats[PEER]?.messages[0]
      if (message?.delivery) delete message.delivery.live
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      // The tick's own setOutgoingState(live: true) must not look like a new arrival.
      expect(jest.getTimerCount()).toBe(1)
      polling.stop()
    })

    it('a message that becomes pending mid-tick still leaves exactly one timer', async () => {
      const { chats } = await pendingMessage()
      let release: (v: Record<string, 'live'>) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0) // tick is now waiting on the wallet
      const HASH2 = 'cd'.repeat(32)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async params => {
          await params.onAttemptCreated?.(HASH2)
          throw new MonadStampPendingAttemptError([HASH2])
        })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(0)
      expect(jest.getTimerCount()).toBe(1)
      polling.stop()
    })

    it('after stop() no timer remains, including one armed mid-tick', async () => {
      await pendingMessage()
      let release: (v: Record<string, 'live'>) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      polling.stop()
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(0)
      expect(jest.getTimerCount()).toBe(0)
    })

    it('a new pending message resets the ladder: the next gap is the base interval doubled, not the old cap', async () => {
      const { chats } = await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(
        2 * OUTGOING_RECONCILE_INTERVAL_MS +
          4 * OUTGOING_RECONCILE_INTERVAL_MS +
          MAX_OUTGOING_RECONCILE_INTERVAL_MS,
      )
      const HASH2 = 'cd'.repeat(32)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async params => {
          await params.onAttemptCreated?.(HASH2)
          throw new MonadStampPendingAttemptError([HASH2])
        })
      reconcile.mockResolvedValue({ [HASH]: 'live', [HASH2]: 'live' })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })
      const before = reconcile.mock.calls.length
      await jest.advanceTimersByTimeAsync(OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile.mock.calls.length).toBe(before + 1) // base interval
      // Next gap is 2 x base (30 s); with the reset lost it would be the 120 s cap.
      await jest.advanceTimersByTimeAsync(
        2 * OUTGOING_RECONCILE_INTERVAL_MS - 1,
      )
      expect(reconcile.mock.calls.length).toBe(before + 1)
      await jest.advanceTimersByTimeAsync(1)
      expect(reconcile.mock.calls.length).toBe(before + 2)
      expect(jest.getTimerCount()).toBe(1)
      polling.stop()
    })
  })

  describe('lifecycle and visibility throttling', () => {
    interface MockDocument {
      hasFocus: () => boolean
      hidden: boolean
      addEventListener: jest.Mock
      removeEventListener: jest.Mock
    }
    let listeners: Record<string, ((event?: Event) => void)[]> = {}
    const originalDocument = (global as unknown as { document?: MockDocument })
      .document

    const getDocument = (): MockDocument =>
      (global as unknown as { document: MockDocument }).document

    beforeEach(() => {
      listeners = {}
      ;(global as unknown as { document: MockDocument }).document = {
        hasFocus: () => true,
        hidden: false,
        addEventListener: jest.fn(
          (event: string, cb: (event?: Event) => void) => {
            listeners[event] = listeners[event] || []
            listeners[event].push(cb)
          },
        ),
        removeEventListener: jest.fn(
          (event: string, cb: (event?: Event) => void) => {
            if (listeners[event]) {
              listeners[event] = listeners[event].filter(l => l !== cb)
            }
          },
        ),
      }
    })

    afterEach(() => {
      ;(global as unknown as { document?: MockDocument }).document =
        originalDocument
    })

    function triggerVisibilityChange(hidden: boolean) {
      getDocument().hidden = hidden
      for (const cb of listeners['visibilitychange'] ?? []) {
        cb()
      }
    }

    it('backs off to idle cadence (60s) when pending === 0', async () => {
      const chats = useChatStore()
      const reconcileOutgoingSpy = jest.spyOn(chats, 'reconcileOutgoing')

      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcileOutgoingSpy).toHaveBeenCalledTimes(1)

      // Nothing pending: should pause for IDLE_OUTGOING_RECONCILE_INTERVAL_MS (60s), not 15s
      await jest.advanceTimersByTimeAsync(OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcileOutgoingSpy).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(
        IDLE_OUTGOING_RECONCILE_INTERVAL_MS -
          OUTGOING_RECONCILE_INTERVAL_MS -
          1,
      )
      expect(reconcileOutgoingSpy).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(1)
      expect(reconcileOutgoingSpy).toHaveBeenCalledTimes(2)

      polling.stop()
    })

    it('relaxes reconciliation delay to at least 60s when document.hidden = true', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })

      getDocument().hidden = true

      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)

      // In foreground, backoff after 1st tick would be 30s (2 * 15s).
      // But because document.hidden = true, delay is relaxed to Math.max(30s, 60s) = 60s.
      await jest.advanceTimersByTimeAsync(30_000)
      expect(reconcile).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(30_000)
      expect(reconcile).toHaveBeenCalledTimes(2)

      polling.stop()
    })

    it('wakes up and triggers tick() immediately when visibility changes to visible', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })

      getDocument().hidden = true

      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)

      // Tab remains hidden for 20s (timer armed for 60s)
      await jest.advanceTimersByTimeAsync(20_000)
      expect(reconcile).toHaveBeenCalledTimes(1)

      // Tab becomes visible again
      triggerVisibilityChange(false)
      await jest.advanceTimersByTimeAsync(0)

      // Should have triggered tick immediately upon becoming visible
      expect(reconcile).toHaveBeenCalledTimes(2)

      polling.stop()
    })

    it('removes visibilitychange listener and clears timer on stop()', async () => {
      const polling = startOutgoingReconciliation({ wallet })
      expect(getDocument().addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      )
      expect(listeners['visibilitychange']?.length).toBe(1)

      polling.stop()
      expect(getDocument().removeEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function),
      )
      expect(listeners['visibilitychange']?.length).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    })
  })
})
