/**
 * How soon the background tick retries a paid message after the app is reloaded, and how often
 * until it is resolved. The tick's pauses used to be decided by the messages on screen alone: a
 * payment the wallet still held unresolved, with no message pointing at it when the tick looked
 * (a row that never got its payment recorded because the app stopped between the wallet's journal
 * write and the row's, a deleted message), left the tick on its idle minute.
 *
 * A message whose row did record its payment is `payment-pending` after a reload and was already
 * retried on the short pauses: the app restores the chat store before it starts messaging
 * (`boot/setup-apis.ts`, then `boot/monad-direct-messages.ts`). The first test pins that. The
 * second covers the order the app does not use today (the tick first, the chats later), so the
 * pauses do not depend on that order.
 *
 * `activeChain.directMessages` is a small model of a wallet holding one payment set the relay
 * keeps without delivering: every question it is asked re-sends that same set, as the real wallet
 * does. The message store is an in-memory fake that behaves like the durable Level store, so a
 * "reload" is a fresh Pinia, a fresh tick, and `rehydateChat` over what was actually written
 * (as in `../stores/chats.outgoing.jest.test.ts`). Fake timers at the real intervals: the times
 * below are the times a user would wait. Each test names what it measures on the revision before.
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
import { rehydateChat, useChatStore } from '../stores/chats'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import { MonadStampPendingAttemptError } from '@frank/wallet/monad-stamp-client'
import type { MessageWrapper } from '@frank/cashweb/types/messages'
import { setConversationIdSalt as installTestConversationIdSalt } from '../stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
// The durable store: keyed exactly like LevelMessageStore (by `index`).
jest.mock('./level-message-store', () => {
  const { serializeMessageWrapper, deserializeMessageWrapper } =
    jest.requireActual('@frank/cashweb/relay/storage/level-storage')
  const serialized = new Map<string, string>()
  return {
    store: Promise.resolve({
      saveMessage: jest.fn(async (wrapper: MessageWrapper) => {
        serialized.set(wrapper.index, serializeMessageWrapper(wrapper))
      }),
      deleteMessage: jest.fn(async (index: string) => {
        serialized.delete(index)
      }),
      getMessage: jest.fn(async (index: string) => {
        const value = serialized.get(index)
        return value === undefined
          ? undefined
          : deserializeMessageWrapper(value)
      }),
      mostRecentMessageTime: jest.fn(async () => 0),
      getIterator: jest.fn(async () =>
        (async function* () {
          for (const value of serialized.values()) {
            yield deserializeMessageWrapper(value)
          }
        })(),
      ),
      __serialized: serialized,
    }),
  }
})

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const HASH = 'ab'.repeat(32)
const wallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle
const SECOND = 1_000

describe('the tick after a reload', () => {
  const directMessages = activeChain.directMessages as Required<
    typeof activeChain.directMessages
  >
  const previousPromise = global.Promise
  let started = 0
  /** The wallet model: one payment set, which the relay keeps until `relayDelivers`. */
  let held: {
    delivered: boolean
    relayDelivers: boolean
    /** When the payment set was handed to the relay again, in ms since the reload. */
    resends: number[]
    /** Payments built. The model never builds one; a send through it would be counted here. */
    payments: number
  }
  let stop: (() => void) | undefined

  beforeAll(() => {
    // As in the outgoing suite: Pinia defers `after` observers on native promises only.
    global.Promise = (async () => undefined)().constructor as PromiseConstructor
  })
  afterAll(() => {
    global.Promise = previousPromise
  })
  beforeEach(async () => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.spyOn(console, 'info').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store } = jest.requireMock('./level-message-store')
    ;(await store).__serialized.clear()
    held = { delivered: false, relayDelivers: false, resends: [], payments: 0 }
    const resend = () => {
      if (held.delivered) return
      held.resends.push(Date.now() - started)
      if (held.relayDelivers) held.delivered = true
    }
    jest
      .spyOn(directMessages, 'fundAhead')
      .mockResolvedValue({ outcome: 'ready', fundingTxHashes: [] })
    // Reports every payment no message accounts for, delivered ones included, as the wallet does.
    jest
      .spyOn(directMessages, 'unattributedAttempts')
      .mockImplementation(async ({ knownDigests }) => {
        resend()
        return knownDigests.includes(HASH) ? [] : [HASH]
      })
    jest
      .spyOn(directMessages, 'reconcileAttempts')
      .mockImplementation(async ({ payloadDigests }) => {
        resend()
        return Object.fromEntries(
          payloadDigests.map(digest => [
            digest,
            digest !== HASH ? 'unknown' : held.delivered ? 'delivered' : 'live',
          ]),
        )
      })
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    jest.useRealTimers()
  })

  /** Sends a message whose payment the wallet journals and the relay then keeps. With
   * `recorded: false` the app stops before the payment is recorded on the message's row. */
  async function sendThenRelayKeepsIt({ recorded }: { recorded: boolean }) {
    jest.spyOn(directMessages, 'send').mockImplementation(async params => {
      held.payments += 1
      if (!recorded) return new Promise(() => undefined)
      await params.onAttemptCreated?.(HASH)
      throw new MonadStampPendingAttemptError([HASH])
    })
    const sending = useChatStore().sendMessage({
      wallet,
      address: PEER,
      items: [{ type: 'text', text: 'sent just before the reload' }],
    })
    if (recorded) await sending
    else await jest.advanceTimersByTimeAsync(0)
  }
  /** The app starts again: nothing in memory, the tick started, the chats not loaded yet. */
  function reloadAndStartTheTick() {
    const metadata = { ...useChatStore().$state }
    setActivePinia(createPinia())
    started = Date.now()
    stop = startOutgoingReconciliation({ wallet }).stop
    return async () => {
      const chats = useChatStore()
      chats.$patch(await rehydateChat({ ...metadata }))
      return chats
    }
  }
  const message = () => useChatStore().chats[PEER]?.messages[0]

  it('pin: with the chats loaded before the tick starts, the message is retried at once', async () => {
    await sendThenRelayKeepsIt({ recorded: true })
    held.relayDelivers = true
    const loadChats = reloadAndStartTheTick()
    stop?.()
    await loadChats()
    started = Date.now()
    stop = startOutgoingReconciliation({ wallet }).stop
    await jest.advanceTimersByTimeAsync(0)
    expect(held.resends).toEqual([0])
    expect(message()?.status).toBe('confirmed')
    expect(held.payments).toBe(1)
  })

  // Not the app's start-up order today (see the header). Before: the first tick finds no message,
  // so nothing is pending and the next look is the idle minute away: 60 s (on main the wallet is
  // not even asked at the first tick). After: the wallet says a payment is unresolved, and the
  // next tick is 4 s later.
  it('if the chats load after the tick started, the message is delivered 4 s after the reload, not 60 s', async () => {
    await sendThenRelayKeepsIt({ recorded: true })
    const loadChats = reloadAndStartTheTick()
    await jest.advanceTimersByTimeAsync(0)
    // The first tick asked the wallet, which re-sent the set; the relay still keeps it.
    expect(held.resends).toEqual([0])
    await jest.advanceTimersByTimeAsync(SECOND)
    await loadChats()
    // What the user sees meanwhile: the message, marked as waiting for its payment.
    expect(message()).toEqual(
      expect.objectContaining({
        status: 'payment-pending',
        delivery: expect.objectContaining({ attemptDigest: HASH }),
      }),
    )
    held.relayDelivers = true
    let deliveredAfter: number | undefined
    for (let waited = SECOND; waited < 3 * 60 * SECOND; waited += SECOND) {
      await jest.advanceTimersByTimeAsync(SECOND)
      if (message()?.status === 'confirmed') {
        deliveredAfter = waited + SECOND
        break
      }
    }
    expect(deliveredAfter).toBe(2 * OUTGOING_RECONCILE_INTERVAL_MS)
    expect(held.resends).toEqual([0, 2 * OUTGOING_RECONCILE_INTERVAL_MS])
    expect(held.payments).toBe(1)
  })

  // The case a reload can really produce. Before: on main the tick never asks the wallet about
  // this payment (no message points at it): zero re-sends, however long the app stays open. With
  // the whole wallet asked every tick but the pauses decided by the messages alone: one re-send
  // a minute. After: the short pauses.
  it('a payment whose message never recorded it is retried at 0, 4, 12, 27 and 42 s, until it is delivered', async () => {
    await sendThenRelayKeepsIt({ recorded: false })
    const loadChats = reloadAndStartTheTick()
    await loadChats()
    // What the user sees: the message as failed, "interrupted before it was sent", with Retry.
    expect(message()).toEqual(
      expect.objectContaining({
        status: 'error',
        delivery: { failureReason: 'interrupted' },
      }),
    )
    await jest.advanceTimersByTimeAsync(43 * SECOND)
    expect(held.resends).toEqual(
      [0, 4, 12, 27, 42].map(seconds => seconds * SECOND),
    )
    held.relayDelivers = true
    await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(held.delivered).toBe(true)
    expect(held.resends).toHaveLength(6)
    // Resolved: the tick is back on its idle minute, and the wallet's continued listing of the
    // delivered payment is not a reason to hurry.
    const asked = () =>
      jest.mocked(directMessages.unattributedAttempts).mock.calls.length +
      jest.mocked(directMessages.reconcileAttempts).mock.calls.length
    const before = asked()
    await jest.advanceTimersByTimeAsync(
      10 * IDLE_OUTGOING_RECONCILE_INTERVAL_MS,
    )
    expect(asked() - before).toBe(10)
    expect(held.payments).toBe(1)
  })

  // Before: found at an idle tick, it would be looked at again a minute later.
  it('a payment the wallet reports at an idle tick restarts the short pauses', async () => {
    held.delivered = true
    reloadAndStartTheTick()
    // Start-up: the wallet lists the delivered payment once, is asked what became of it 4 s
    // later, and from then on the tick idles: at 64 s, and next at 124 s.
    await jest.advanceTimersByTimeAsync(2 * IDLE_OUTGOING_RECONCILE_INTERVAL_MS)
    const other = 'cd'.repeat(32)
    let otherLive = true
    const resends: number[] = []
    const base = Date.now()
    jest
      .mocked(directMessages.unattributedAttempts)
      .mockImplementation(async () => {
        if (otherLive) resends.push(Date.now() - base)
        return [HASH, other]
      })
    jest
      .mocked(directMessages.reconcileAttempts)
      .mockImplementation(async ({ payloadDigests }) => {
        if (otherLive) resends.push(Date.now() - base)
        return Object.fromEntries(
          payloadDigests.map(digest => [
            digest,
            digest === other && otherLive ? 'live' : 'delivered',
          ]),
        )
      })
    // The next idle tick finds it.
    await jest.advanceTimersByTimeAsync(5 * SECOND)
    expect(resends).toHaveLength(1)
    const found = resends[0]
    await jest.advanceTimersByTimeAsync(13 * SECOND)
    expect(resends.map(at => at - found)).toEqual([0, 4 * SECOND, 12 * SECOND])
    otherLive = false
  })

  it('a wallet that cannot say what became of its payments is asked that once, not on every tick', async () => {
    reloadAndStartTheTick()
    const followUp = jest
      .mocked(directMessages.reconcileAttempts)
      .mockRejectedValue(new Error('fixture: wallet held'))
    await jest.advanceTimersByTimeAsync(
      10 * IDLE_OUTGOING_RECONCILE_INTERVAL_MS,
    )
    expect(followUp).toHaveBeenCalledTimes(1)
    expect(followUp).toHaveBeenCalledWith({ wallet, payloadDigests: [HASH] })
  })
})
