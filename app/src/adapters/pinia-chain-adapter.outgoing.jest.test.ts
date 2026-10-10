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
import { setConversationIdSalt as installTestConversationIdSalt } from '../stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

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
  const directMessages = activeChain.directMessages as Required<
    typeof activeChain.directMessages
  >
  let fundAhead: jest.SpiedFunction<typeof directMessages.fundAhead>
  /** The tick's question when no message asks one: which payments does no message account for. */
  let wholeWallet: jest.SpiedFunction<
    typeof directMessages.unattributedAttempts
  >
  const previousPromise = global.Promise
  beforeAll(() => {
    // The shared setup installs a Promise polyfill, but ES2020 async actions return native
    // promises. Pinia uses instanceof Promise to defer its `after` observers until completion.
    global.Promise = (async () => undefined)().constructor as PromiseConstructor
  })
  afterAll(() => {
    global.Promise = previousPromise
  })
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    // The fixture wallet is not a wallet the chain can fund for: the suite's default answer is
    // "nothing to do". The fund-ahead tests below replace it.
    fundAhead = jest
      .spyOn(directMessages, 'fundAhead')
      .mockResolvedValue({ outcome: 'ready', fundingTxHashes: [] })
    // Likewise it holds no payment attempts: asked, it has nothing to report. Tests that give
    // it an attempt replace these.
    jest.spyOn(directMessages, 'reconcileAttempts').mockResolvedValue({})
    wholeWallet = jest
      .spyOn(directMessages, 'unattributedAttempts')
      .mockResolvedValue([])
  })
  afterEach(() => jest.useRealTimers())

  it('runs the Pinia after observer only after the durable status mutation completes', async () => {
    const { chats } = await pendingMessage()
    const message = chats.chats[PEER]!.messages[0]
    const observed = jest.fn()
    const unsubscribe = chats.$onAction(({ name, after }) => {
      if (name === 'setOutgoingStateExclusive') {
        after(() => observed(message.status))
      }
    })
    const mutation = chats.setOutgoingState(
      PEER,
      message.payloadDigest,
      'error',
      {},
    )
    expect(observed).not.toHaveBeenCalled()
    await mutation
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith('error')
    unsubscribe()
  })

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

  // #1235 Stage 3. On main dce4bedf the tick never calls the wallet's re-observation: the first
  // four tests fail there (the mock is never called). The last two are pins, and pass there:
  // a stopped tick calls nothing, and a handle WITHOUT the method is tolerated (as in every
  // other test in this file, whose wallet has none).
  describe('native re-observation at the tick (#1235 Stage 3)', () => {
    const walletWith = (reobserveNativeOperations: unknown) =>
      ({ ...wallet, reobserveNativeOperations } as unknown as WalletHandle)

    it('calls it once per tick, only after reconcileOutgoing has settled, also when no message is pending', async () => {
      const { chats } = await pendingMessage()
      let release: (v: Record<string, 'live' | 'delivered'>) => void = () =>
        undefined
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValueOnce(
          new Promise(resolve => {
            release = resolve
          }),
        )
        .mockResolvedValue({ [HASH]: 'delivered' })
      const reobserve = jest.fn(async () => undefined)
      const polling = startOutgoingReconciliation({
        wallet: walletWith(reobserve),
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(reobserve).not.toHaveBeenCalled()
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(0)
      expect(reobserve).toHaveBeenCalledTimes(1)
      expect(reobserve).toHaveBeenCalledWith()
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(reobserve).toHaveBeenCalledTimes(2)
      // Nothing is pending any more: the idle tick still asks the wallet to look. No message
      // asks about a payment now, so the tick asks the wallet about none (#1236 Q3).
      expect(chats.chats[PEER]?.messages[0].status).toBe('confirmed')
      await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(wholeWallet.mock.calls).toEqual([
        [{ wallet: expect.anything(), knownDigests: [] }],
      ])
      expect(reobserve).toHaveBeenCalledTimes(3)
      polling.stop()
    })

    // Review of 09d2624a, where the call sat inside the tick's `try`: fails there.
    it('runs also when reconcileOutgoing rejects: the relay being down does not stop the wallet looking at the node', async () => {
      const { chats } = await pendingMessage()
      const reconcile = jest
        .spyOn(chats, 'reconcileOutgoing')
        .mockRejectedValue(new Error('fixture: relay unavailable'))
      const reobserve = jest.fn(async () => undefined)
      const polling = startOutgoingReconciliation({
        wallet: walletWith(reobserve),
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(
        'outgoing message reconciliation failed',
        expect.anything(),
      )
      expect(reobserve).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(reobserve).toHaveBeenCalledTimes(2)
      polling.stop()
    })

    it('does not wait for it: a re-observation that never settles does not hold the next tick', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      const reobserve = jest.fn(() => new Promise<void>(() => undefined))
      const polling = startOutgoingReconciliation({
        wallet: walletWith(reobserve),
      })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(reobserve).toHaveBeenCalledTimes(3)
      polling.stop()
    })

    it('survives its failure: a rejection or a synchronous throw is not a failed reconciliation, does not break the tick and does not go unhandled', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => void unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        await pendingMessage()
        const reconcile = jest
          .spyOn(activeChain.directMessages, 'reconcileAttempts')
          .mockResolvedValue({ [HASH]: 'live' })
        const reobserve = jest
          .fn()
          .mockRejectedValueOnce(new Error('fixture: node unavailable'))
          .mockImplementationOnce(() => {
            throw new Error('fixture: wallet closed')
          })
          .mockResolvedValue(undefined)
        const polling = startOutgoingReconciliation({
          wallet: walletWith(reobserve),
        })
        await jest.advanceTimersByTimeAsync(0)
        await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
        await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
        expect(reconcile).toHaveBeenCalledTimes(3)
        expect(reobserve).toHaveBeenCalledTimes(3)
        expect(console.warn).not.toHaveBeenCalledWith(
          'outgoing message reconciliation failed',
          expect.anything(),
        )
        polling.stop()
        await new Promise(resolve => setImmediate(resolve))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('pin: is not called by a tick that was stopped while reconciling', async () => {
      await pendingMessage()
      let release: (v: Record<string, 'live'>) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const reobserve = jest.fn(async () => undefined)
      const polling = startOutgoingReconciliation({
        wallet: walletWith(reobserve),
      })
      await jest.advanceTimersByTimeAsync(0)
      polling.stop()
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(
        10 * MAX_OUTGOING_RECONCILE_INTERVAL_MS,
      )
      expect(reobserve).not.toHaveBeenCalled()
    })

    it('pin: a wallet handle without the method has nothing to do', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(console.warn).not.toHaveBeenCalled()
      polling.stop()
    })
  })

  // #1235 Q4. On main 8c656f32 the chain client has no `fundAhead` and nothing asks for it:
  // this suite's spy on it cannot be installed there, so the whole file fails. The first five
  // tests are the behaviour added; the last three pin when it must NOT be asked.
  // #1236 Q3. On main 1715ec7c a tick asks the wallet only about payments a message here still
  // points at: with no such message the wallet is never asked, so the first, third and fourth
  // tests fail there (zero calls). The second and the last are pins and pass there. The question
  // is "which payments does no message account for" (`unattributedAttempts` with nothing known):
  // like any question it makes the wallet retry everything unresolved, and its answer is what
  // keeps the tick on its short pauses (see `pinia-chain-adapter.reload.jest.test.ts`).
  describe('the whole wallet is retried every tick (#1236 Q3)', () => {
    const none = { wallet, knownDigests: [] }

    it('asks the wallet about no payment in particular, once per tick, when no message has one', async () => {
      const reconcile = jest.spyOn(directMessages, 'reconcileAttempts')
      // Starting is not asking: the first question is the first tick's, never the caller's.
      const polling = startOutgoingReconciliation({ wallet })
      expect(wholeWallet).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(0)
      expect(wholeWallet.mock.calls).toEqual([[none]])
      await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
      await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
      expect(wholeWallet.mock.calls).toEqual([[none], [none], [none]])
      polling.stop()
      await jest.advanceTimersByTimeAsync(
        10 * IDLE_OUTGOING_RECONCILE_INTERVAL_MS,
      )
      expect(wholeWallet).toHaveBeenCalledTimes(3)
      // One question a tick: the wallet reported nothing, so there was nothing to follow up.
      expect(reconcile).not.toHaveBeenCalled()
    })

    it('pin: a message that has a payment is the one question of its tick', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile.mock.calls).toEqual([
        [{ wallet, payloadDigests: [HASH], maxPutAttempts: 1 }],
        [{ wallet, payloadDigests: [HASH], maxPutAttempts: 1 }],
      ])
      expect(wholeWallet).not.toHaveBeenCalled()
      polling.stop()
    })

    it('a message that failed before it had a payment does not stand in for the question', async () => {
      const chats = useChatStore()
      jest
        .spyOn(directMessages, 'send')
        .mockRejectedValue(new Error('fixture: refused before any payment'))
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'never paid' }],
      })
      expect(chats.chats[PEER]?.messages[0]).toEqual(
        expect.objectContaining({ status: 'error' }),
      )
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(wholeWallet.mock.calls).toEqual([[none]])
      polling.stop()
    })

    it('funds ahead only once the wallet has answered, and not after stop()', async () => {
      let answer: (v: string[]) => void = () => undefined
      const reconcile = wholeWallet
        .mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
        .mockRejectedValueOnce(new Error('fixture: wallet held'))
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(fundAhead).not.toHaveBeenCalled()
      answer([])
      await jest.advanceTimersByTimeAsync(0)
      expect(fundAhead).toHaveBeenCalledTimes(1)
      // A tick whose question failed funds nothing, says so, and looks again soon rather than
      // after the idle minute.
      await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(fundAhead).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(
        'outgoing message reconciliation failed',
        expect.any(Error),
      )
      await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(fundAhead).toHaveBeenCalledTimes(2)
      polling.stop()
      await jest.advanceTimersByTimeAsync(
        10 * IDLE_OUTGOING_RECONCILE_INTERVAL_MS,
      )
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(fundAhead).toHaveBeenCalledTimes(2)
    })

    it('pin: a message being sent right now is not joined by a second question', async () => {
      const chats = useChatStore()
      // The send is in flight for the whole test: its own first step settles the wallet.
      jest
        .spyOn(directMessages, 'send')
        .mockReturnValue(new Promise(() => undefined))
      void chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'in flight' }],
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(chats.chats[PEER]?.messages[0].status).toBe('pending')
      const reconcile = jest.spyOn(directMessages, 'reconcileAttempts')
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).not.toHaveBeenCalled()
      expect(wholeWallet).not.toHaveBeenCalled()
      polling.stop()
    })
  })

  describe('funding the next message ahead (#1235 Q4)', () => {
    const idle = () =>
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({})

    it('is asked only once a reconciliation has resolved, then on every tick that resolves, also with nothing pending', async () => {
      const { chats } = await pendingMessage()
      let release: (v: Record<string, 'live' | 'delivered'>) => void = () =>
        undefined
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValueOnce(
          new Promise(resolve => {
            release = resolve
          }),
        )
        .mockResolvedValue({ [HASH]: 'live' })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)
      // Starting the reconciliation is not a reason to fund: nothing has been looked at yet.
      expect(fundAhead).not.toHaveBeenCalled()
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(0)
      expect(fundAhead).toHaveBeenCalledTimes(1)
      expect(fundAhead).toHaveBeenCalledWith({ wallet })
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(fundAhead).toHaveBeenCalledTimes(2)
      expect(chats.chats[PEER]?.messages[0].status).toBe('payment-pending')
      polling.stop()
    })

    it('is not asked by a tick whose reconciliation failed, and is asked by the next one that resolves', async () => {
      const { chats } = await pendingMessage()
      const reconcile = jest
        .spyOn(chats, 'reconcileOutgoing')
        .mockRejectedValueOnce(new Error('fixture: relay unavailable'))
        .mockResolvedValue({ pending: 1 })
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(fundAhead).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(2)
      expect(fundAhead).toHaveBeenCalledTimes(1)
      polling.stop()
    })

    it('is asked as soon as a message is delivered, without waiting for the idle tick', async () => {
      idle()
      const chats = useChatStore()
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      expect(fundAhead).toHaveBeenCalledTimes(1)
      jest.spyOn(activeChain.directMessages, 'send').mockResolvedValue({
        payloadDigest: HASH,
        stampValueWei: 1n,
        stampPayments: [],
        preparationTxHashes: [],
      })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'delivered at once' }],
      })
      expect(chats.chats[PEER]?.messages[0].status).toBe('confirmed')
      // No timer ran: the next idle tick is a minute away.
      expect(fundAhead).toHaveBeenCalledTimes(2)
      polling.stop()
    })

    it('is not waited for: a pass that never settles does not hold the next tick', async () => {
      await pendingMessage()
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'live' })
      fundAhead.mockReturnValue(new Promise(() => undefined))
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
      await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
      expect(reconcile).toHaveBeenCalledTimes(3)
      expect(fundAhead).toHaveBeenCalledTimes(3)
      polling.stop()
    })

    it('survives its failure: a rejection or a synchronous throw is not a failed reconciliation, does not go unhandled, and is logged once', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => void unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        await pendingMessage()
        const reconcile = jest
          .spyOn(activeChain.directMessages, 'reconcileAttempts')
          .mockResolvedValue({ [HASH]: 'live' })
        fundAhead
          .mockReset()
          .mockRejectedValueOnce(new Error('fixture: wallet queue refused'))
          .mockImplementationOnce(() => {
            throw new Error('fixture: wallet closed')
          })
          .mockRejectedValue(new Error('fixture: still refused'))
        const polling = startOutgoingReconciliation({ wallet })
        await jest.advanceTimersByTimeAsync(0)
        await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS)
        await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
        expect(reconcile).toHaveBeenCalledTimes(3)
        expect(fundAhead).toHaveBeenCalledTimes(3)
        expect(console.warn).not.toHaveBeenCalledWith(
          'outgoing message reconciliation failed',
          expect.anything(),
        )
        expect(
          jest
            .mocked(console.warn)
            .mock.calls.filter(([line]) =>
              String(line).startsWith('funding ahead failed'),
            ),
        ).toHaveLength(1)
        polling.stop()
        await new Promise(resolve => setImmediate(resolve))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('pin: is not asked by a tick that was stopped while reconciling, nor by a delivery after stop', async () => {
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
      await jest.advanceTimersByTimeAsync(0)
      polling.stop()
      release({ [HASH]: 'live' })
      await jest.advanceTimersByTimeAsync(
        10 * MAX_OUTGOING_RECONCILE_INTERVAL_MS,
      )
      await chats.confirmOutgoing({
        address: PEER,
        id: chats.chats[PEER]?.messages[0].id ?? '',
        payloadDigest: HASH,
      })
      expect(fundAhead).not.toHaveBeenCalled()
    })

    it('pin: a delivery before any reconciliation has resolved asks for nothing', async () => {
      const { chats } = await pendingMessage()
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(new Promise(() => undefined))
      const polling = startOutgoingReconciliation({ wallet })
      await jest.advanceTimersByTimeAsync(0)
      await chats.confirmOutgoing({
        address: PEER,
        id: chats.chats[PEER]?.messages[0].id ?? '',
        payloadDigest: HASH,
      })
      expect(fundAhead).not.toHaveBeenCalled()
      polling.stop()
    })

    it('pin: a chain without the method has nothing to do', async () => {
      idle()
      // As on a chain whose client never had the method.
      fundAhead.mockRestore()
      const present = activeChain.directMessages.fundAhead
      activeChain.directMessages.fundAhead = undefined
      try {
        const polling = startOutgoingReconciliation({ wallet })
        await jest.advanceTimersByTimeAsync(0)
        await jest.advanceTimersByTimeAsync(IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
        expect(console.warn).not.toHaveBeenCalled()
        polling.stop()
      } finally {
        activeChain.directMessages.fundAhead = present
      }
    })
  })
})
