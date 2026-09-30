/**
 * Outgoing direct-message delivery states (tickets #269, #270): a failed or payment-pending send
 * stays in the conversation, survives a reload, can be retried by hand, and never pays twice.
 *
 * `activeChain.directMessages` is mocked at its own boundary (no chain, relay or funds). The local
 * message store is an in-memory fake that behaves like the durable Level store, so "reload" here
 * means: a fresh Pinia and `rehydateChat` over what was actually written.
 *
 * Plain `node` environment; see `chats.jest.test.ts`'s header for why.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { rehydateChat, useChatStore } from './chats'
import type { OutgoingOutcome } from './chats'
import { activeChain } from '@frank/wallet/chain'
import type {
  DirectMessageAttemptStatus,
  DirectMessageSendResult,
  WalletHandle,
} from '@frank/wallet/chain'
import {
  MonadStampAbandonedError,
  MonadStampPendingAttemptError,
  MonadStampRecoveredAttemptError,
  MonadStampTerminalError,
} from '@frank/wallet/monad-stamp-client'
import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/monad-mailbox-client'
import type { MessageWrapper } from '@frank/cashweb/types/messages'
import {
  deserializeMessageWrapper,
  serializeMessageWrapper,
} from '@frank/cashweb/relay/storage/level-storage'
import { store as messageStorePromise } from '../adapters/level-message-store'

jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))

// The durable store: keyed exactly like LevelMessageStore (by `index`).
jest.mock('../adapters/level-message-store', () => {
  // Same (de)serialization as the real Level store, so exact wei values round trip.
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
      mostRecentMessageTime: jest.fn(async () => 0),
      getIterator: jest.fn(async () =>
        (async function* () {
          for (const value of serialized.values()) {
            yield deserializeMessageWrapper(value)
          }
        })(),
      ),
      // Test-only window onto the durable state.
      __serialized: serialized,
    }),
  }
})

async function durable(): Promise<Map<string, string>> {
  return (
    (await messageStorePromise) as unknown as {
      __serialized: Map<string, string>
    }
  ).__serialized
}

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const wallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle

const TEXT = [{ type: 'text' as const, text: 'held two' }]
const HASH = 'ab'.repeat(32)

const okResult = (payloadDigest: string): DirectMessageSendResult => ({
  payloadDigest,
  stampValueWei: 1_000_000_000_000n,
  stampPayments: [],
  preparationTxHashes: [],
})

type SendParams = Parameters<typeof activeChain.directMessages.send>[0]

/** A send that journals its exact payment set (as the wallet does, before any byte goes to the
 * relay) and then fails the way the relay's pending-receipt window does. */
function sendJournalsThenPending(digest = HASH) {
  return jest
    .spyOn(activeChain.directMessages, 'send')
    .mockImplementation(async (params: SendParams) => {
      await params.onAttemptCreated?.(digest)
      throw new MonadStampPendingAttemptError([digest])
    })
}

function reconcileReturns(
  ...answers: Array<Record<string, DirectMessageAttemptStatus>>
) {
  const spy = jest.spyOn(activeChain.directMessages, 'reconcileAttempts')
  for (const answer of answers) spy.mockResolvedValueOnce(answer)
  return spy
}

async function reload() {
  setActivePinia(createPinia())
  const chats = useChatStore()
  chats.$patch(
    await rehydateChat({
      activeChatAddr: null,
      chats: {},
      messages: {},
      lastReceived: 0,
    }),
  )
  return chats
}

/** What the durable store holds after the app stopped mid-send with no attempt digest recorded
 * (the digest write having failed): a pending outgoing record without `delivery.attemptDigest`. */
async function seedInterrupted() {
  const db = await durable()
  db.set(
    'pending:1:1:seed',
    serializeMessageWrapper({
      index: 'pending:1:1:seed',
      outbound: true,
      senderAddress: ME,
      copartyAddress: PEER,
      message: {
        outbound: true,
        status: 'pending',
        receivedTime: 1,
        serverTime: 1,
        items: TEXT,
        outpoints: [],
        senderAddress: ME,
        delivery: {},
      },
    }),
  )
}

const only = (chats: ReturnType<typeof useChatStore>) =>
  chats.chats[PEER]?.messages ?? []

describe('outgoing direct messages (#269, #270)', () => {
  beforeEach(async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  describe('#269: a failed message survives a reload with its Retry', () => {
    it('keeps the text and the failure reason across a reload', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(
          Object.assign(new Error('no response'), { isAxiosError: true }),
        )
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
        stampValue: 5n,
      })
      expect(outcome).toEqual({ state: 'failed', reason: 'unreachable' })

      const restored = await reload()
      expect(only(restored)).toEqual([
        expect.objectContaining({
          status: 'error',
          outbound: true,
          items: TEXT,
          stampValueWei: 5n,
          delivery: expect.objectContaining({ failureReason: 'unreachable' }),
        }),
      ])
    })

    it('Retry after a reload delivers it, and the failed record is replaced (not duplicated)', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadMailboxUnavailableError('404', 404))
      await useChatStore().sendMessage({ wallet, address: PEER, items: TEXT })

      const restored = await reload()
      const [failed] = only(restored)
      expect(failed.status).toBe('error')
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))
      const outcome = await restored.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: failed.payloadDigest,
      })
      expect(outcome).toEqual({
        state: 'sent',
        payloadDigest: 'cd'.repeat(32),
      })
      expect(only(restored)).toEqual([
        expect.objectContaining({ status: 'confirmed', items: TEXT }),
      ])
      // And the durable copy after one more reload is the single confirmed message.
      expect(only(await reload())).toHaveLength(1)
      expect([...(await durable()).keys()]).toEqual(['cd'.repeat(32)])
    })

    it('Discard removes it durably; it does not come back after a reload', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('boom'))
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      await chats.deleteMessage({
        address: PEER,
        payloadDigest: only(chats)[0].payloadDigest,
      })
      expect(only(await reload())).toEqual([])
    })

    it.each([
      [
        'a 404 mailbox',
        new MonadMailboxUnavailableError('404', 404),
        'unavailable',
      ],
      [
        'a terminal relay verdict',
        new MonadStampTerminalError(
          'terminal',
          422,
          'mailbox_terminal',
          true,
          {},
        ),
        'rejected',
      ],
      ['anything else', new Error('nonsense'), 'error'],
    ] as const)('classifies %s as %s', async (_name, error, reason) => {
      jest.spyOn(activeChain.directMessages, 'send').mockRejectedValue(error)
      const outcome = await useChatStore().sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      expect(outcome).toEqual({ state: 'failed', reason })
    })

    it('an in-flight message left over from a stopped app becomes a failed one (no attempt) it can Retry', async () => {
      let release: () => void = () => undefined
      jest.spyOn(activeChain.directMessages, 'send').mockReturnValue(
        new Promise(resolve => {
          release = () => resolve(okResult(HASH))
        }),
      )
      void useChatStore().sendMessage({ wallet, address: PEER, items: TEXT })
      await new Promise(resolve => setImmediate(resolve))
      // The app is closed here: what is durable is a 'pending' record.
      const restored = await reload()
      release()
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ failureReason: 'interrupted' }),
        }),
      )
    })
  })

  describe('#270: pending payment is not a failure, and it reconciles', () => {
    async function pendingMessage() {
      const send = sendJournalsThenPending()
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      return { send, chats, outcome }
    }

    it('shows Payment pending (not Failed) and records the exact attempt on the message', async () => {
      const { chats, outcome } = await pendingMessage()
      expect(outcome).toEqual({ state: 'payment-pending' })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: { attemptDigest: HASH, live: true },
        }),
      )
    })

    it('flips to Sent when the same payment finally delivers, with one copy and no rebuilt payment', async () => {
      const { send, chats } = await pendingMessage()
      const reconcile = reconcileReturns(
        { [HASH]: 'live' },
        { [HASH]: 'delivered' },
      )

      await expect(chats.reconcileOutgoing({ wallet })).resolves.toEqual({
        pending: 1,
      })
      expect(only(chats)[0].status).toBe('payment-pending')

      await expect(chats.reconcileOutgoing({ wallet })).resolves.toEqual({
        pending: 0,
      })
      expect(only(chats)).toEqual([
        expect.objectContaining({
          payloadDigest: HASH,
          status: 'confirmed',
          items: TEXT,
        }),
      ])
      expect(send).toHaveBeenCalledTimes(1) // never re-sent as a new message
      expect(reconcile).toHaveBeenCalledTimes(2)
      // Sender history after a reload holds the message once, in its true state.
      expect(only(await reload())).toEqual([
        expect.objectContaining({ payloadDigest: HASH, status: 'confirmed' }),
      ])
    })

    it('a reload while the payment is pending keeps it pending and reconcilable', async () => {
      await pendingMessage()
      const restored = await reload()
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: { attemptDigest: HASH },
        }),
      )
      reconcileReturns({ [HASH]: 'delivered' })
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)[0].status).toBe('confirmed')
    })

    it('a leftover local record beside its confirmed twin is shown once after a reload', async () => {
      const { chats } = await pendingMessage()
      const localId = only(chats)[0].payloadDigest
      const db = await durable()
      const local = deserializeMessageWrapper(db.get(localId) as string)
      // Crash between the two writes of the re-key: both records exist.
      db.set(
        HASH,
        serializeMessageWrapper({
          ...local,
          index: HASH,
          message: {
            ...local.message,
            status: 'confirmed',
            delivery: undefined,
          },
        }),
      )
      const restored = await reload()
      expect(only(restored)).toHaveLength(1)
      expect(only(restored)[0].status).toBe('confirmed')
      // And the durable store keeps the confirmed record and drops the leftover local one.
      await new Promise(resolve => setImmediate(resolve))
      expect([...db.keys()]).toEqual([HASH])
      expect(
        deserializeMessageWrapper(db.get(HASH) as string).message.status,
      ).toBe('confirmed')
    })

    it('does not surface the message as Failed when sending is blocked behind an earlier pending attempt, and sends it once that clears', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadStampPendingAttemptError(['other']))
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({ status: 'payment-pending', delivery: {} }),
      )
      send.mockResolvedValueOnce(okResult('ef'.repeat(32)))
      await chats.reconcileOutgoing({ wallet })
      expect(only(chats)).toEqual([
        expect.objectContaining({ status: 'confirmed' }),
      ])
      expect(send).toHaveBeenCalledTimes(2)
    })
  })

  describe('a manual Retry never pays twice for the same message', () => {
    async function failedWithAttempt() {
      // The send journaled its payment set, then failed for an unrelated reason.
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementationOnce(async (params: SendParams) => {
          await params.onAttemptCreated?.(HASH)
          throw new Error('storage hiccup after journaling')
        })
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ attemptDigest: HASH }),
        }),
      )
      return { send, chats, id: only(chats)[0].payloadDigest }
    }

    it('live attempt: Retry re-sends the SAME bytes (no new payment set is built)', async () => {
      const { send, chats, id } = await failedWithAttempt()
      const reconcile = reconcileReturns({ [HASH]: 'live' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [HASH] }),
      )
      expect(send).toHaveBeenCalledTimes(1) // only the original send ever built payments
      expect(only(chats)[0].status).toBe('payment-pending')
    })

    it('delivered attempt: Retry just confirms it; nothing is sent again', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'delivered' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: HASH })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('terminal attempt: Retry builds new payments exactly once', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'dead' })
      send.mockResolvedValueOnce(okResult('12'.repeat(32)))
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '12'.repeat(32) })
      expect(send).toHaveBeenCalledTimes(2)
      expect(only(chats)).toHaveLength(1)
    })

    it('the background loop never builds a new payment for a dead attempt; it waits for the user', async () => {
      const { send, chats } = await failedWithAttempt()
      // Put it back to payment-pending like an in-progress pending message.
      const message = only(chats)[0]
      message.status = 'payment-pending'
      reconcileReturns({ [HASH]: 'dead' })
      await chats.reconcileOutgoing({ wallet })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ failureReason: 'rejected' }),
        }),
      )
    })

    it('unknown fate: Retry asks for confirmation and sends nothing until it is given', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'unknown' }, { [HASH]: 'unknown' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).toHaveBeenCalledTimes(1)

      send.mockResolvedValueOnce(okResult('34'.repeat(32)))
      await expect(
        chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: id,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '34'.repeat(32) })
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('an abandoned attempt (relay may own the bytes) is unverified, not freely retryable', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new MonadStampAbandonedError('gone', HASH))
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'failed', reason: 'unverified' })
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    })

    it('a Recovered earlier attempt marks this draft failed until the user confirms sending it again', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadStampRecoveredAttemptError(['other']))
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({})
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'failed', reason: 'recovered' })
      const id = only(chats)[0].payloadDigest
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'recovered' })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('a second click while a retry is running is ignored', async () => {
      const { send, chats, id } = await failedWithAttempt()
      let release: (
        status: Record<string, DirectMessageAttemptStatus>,
      ) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const first = chats.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: id,
      })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'busy' })
      release({ [HASH]: 'live' })
      await first
      expect(send).toHaveBeenCalledTimes(1)
    })
  })

  describe('F1: an attempt that could not be recorded is never re-paid unconfirmed', () => {
    /** The wallet journaled a payment set, and the durable write attributing it to the message
     * fails (as it does when local storage is full or broken). */
    async function failDigestWrites() {
      const db = await durable()
      const store = (await messageStorePromise) as unknown as {
        saveMessage: jest.Mock
      }
      const original = store.saveMessage.getMockImplementation()
      store.saveMessage.mockImplementation(
        async (wrapper: MessageWrapper, options?: unknown) => {
          if (wrapper.message.delivery?.attemptDigest !== undefined) {
            throw new Error('disk full')
          }
          return original?.(wrapper, options)
        },
      )
      return () => {
        store.saveMessage.mockImplementation(original)
        return db
      }
    }

    it('layer (a): the send aborts before the relay when the digest write fails, and nothing is left to re-pay', async () => {
      const restore = await failDigestWrites()
      let reachedRelay = false
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async (params: SendParams) => {
          // Like the wallet: a failing callback aborts the send before any PUT.
          await params.onAttemptCreated?.(HASH)
          reachedRelay = true
          return okResult(HASH)
        })
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      expect(reachedRelay).toBe(false)
      expect(outcome).toEqual(expect.objectContaining({ state: 'failed' }))
      restore()
      // After a rolled-back attempt the wallet knows it is dead: Retry may pay once, exactly once.
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'dead' })
      send.mockResolvedValueOnce(okResult('56'.repeat(32)))
      await expect(
        chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(chats)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '56'.repeat(32) })
    })

    it('layer (b), the reviewer repro: a fail-open wallet plus a lost digest write still cannot re-pay an interrupted message without confirmation', async () => {
      // Fail-open wallet (the old behaviour) with a failing digest write: the payment set was
      // journaled and may be submitted, yet the message was stored with no attempt digest and
      // the app then stopped.
      await seedInterrupted()
      const send = jest.spyOn(activeChain.directMessages, 'send')

      const restored = await reload()
      const [message] = only(restored)
      expect(message.status).toBe('error')
      expect(message.delivery).toEqual(
        expect.objectContaining({ failureReason: 'interrupted' }),
      )
      expect(message.delivery?.attemptDigest).toBeUndefined() // the digest was lost

      // The wallet still accounts for a payment no message points at (journaled / resumed).
      const unattributed = jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([HASH])
      const reconcile = jest.spyOn(
        activeChain.directMessages,
        'reconcileAttempts',
      )
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled() // no second payment
      expect(unattributed).toHaveBeenCalledWith(
        expect.objectContaining({ wallet }),
      )
      // Asking again without confirming is still refused (the check repeats).
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()

      send.mockResolvedValueOnce(okResult('78'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '78'.repeat(32) })
    })

    it('an interrupted message with provably no unattributed payment retries without a prompt', async () => {
      await seedInterrupted()
      const restored = await reload()
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([])
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue(okResult('9a'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '9a'.repeat(32) })
    })

    it('if the unattributed-payment check itself fails, it asks rather than pays', async () => {
      await seedInterrupted()
      const restored = await reload()
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockRejectedValue(new Error('journal unreadable'))
      const send = jest.spyOn(activeChain.directMessages, 'send')
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('rehydrating stored records', () => {
    it('a persisted pending record WITH an attempt digest comes back payment-pending, keeping the digest', async () => {
      const db = await durable()
      db.set(
        'pending:1:1:zz',
        serializeMessageWrapper({
          index: 'pending:1:1:zz',
          outbound: true,
          senderAddress: ME,
          copartyAddress: PEER,
          message: {
            outbound: true,
            status: 'pending',
            receivedTime: 1,
            serverTime: 1,
            items: TEXT,
            outpoints: [],
            senderAddress: ME,
            delivery: { attemptDigest: HASH },
          },
        }),
      )
      const [message] = only(await reload())
      expect(message.status).toBe('payment-pending')
      expect(message.delivery).toEqual({ attemptDigest: HASH })
    })

    it('an old-format record (no delivery field) still loads unchanged', async () => {
      const db = await durable()
      db.set(
        'old',
        JSON.stringify({
          index: 'old',
          outbound: true,
          senderAddress: ME,
          copartyAddress: PEER,
          message: {
            outbound: true,
            status: 'confirmed',
            receivedTime: 5,
            serverTime: 5,
            items: TEXT,
            outpoints: [],
            senderAddress: ME,
          },
        }),
      )
      const [message] = only(await reload())
      expect(message).toEqual(
        expect.objectContaining({
          payloadDigest: 'old',
          status: 'confirmed',
          items: TEXT,
        }),
      )
      expect(message.delivery).toBeUndefined()
    })
  })
})
