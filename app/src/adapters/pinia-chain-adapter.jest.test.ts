/**
 * Unit tests for `pinia-chain-adapter.ts` (ticket #42): the `DirectMessageReceived` ->
 * `ReceivedMessageWrapper` adapter and the `activeChain.directMessages.fetchSince` poll loop.
 * Mocks `activeChain` at its own boundary (`jest.spyOn`), not the underlying Monad wallet clients.
 *
 * Deliberately run under plain `node` (not `jsdom`) -- see `../stores/chats.jest.test.ts`'s header
 * for why. `chats.receiveMessages` (invoked by the poll loop) unconditionally touches
 * `document.hasFocus()`, so a minimal stub is installed below; `../utils/notifications` is mocked
 * since node has no `Notification` API either.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  startDirectMessagePolling,
  toReceivedMessageWrapper,
} from './pinia-chain-adapter'
import { useChatStore } from '../stores/chats'
import { useContactStore } from '../stores/contacts'
import { store as messageStorePromise } from './level-message-store'
import { activeChain } from '@frank/wallet/chain'
import type { DirectMessageReceived, WalletHandle } from '@frank/wallet/chain'

jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))
// See `../stores/chats.jest.test.ts`'s header for why this needs mocking too.
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    relayCursor: jest.fn(async () => 0),
    advanceRelayCursor: jest.fn(async (_address: string, next: number) => next),
    suppressAndDelete: jest.fn(async () => undefined),
    suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
    getIterator: async function* () {
      /* no persisted Lotus-era messages in tests */
    },
  }),
}))

const SENDER_ADDRESS = '0x4C4C4C4C4C4c4C4C4C4C4c4C4C4c4C4c4C4C4c4C'
const RECIPIENT_ADDRESS = '0x5d5d5d5D5D5D5d5d5d5d5D5d5D5D5d5D5D5d5d5D'

const PUB_KEY_HEX =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PUB_KEY_BYTES = Uint8Array.from(Buffer.from(PUB_KEY_HEX, 'hex'))

type MockMessageStore = {
  saveMessage: jest.Mock
  relayCursor: jest.Mock
  advanceRelayCursor: jest.Mock
  mostRecentMessageTime: jest.Mock
}
let mockMessageStore: MockMessageStore

function makeRecord(
  overrides: Partial<DirectMessageReceived> = {},
): DirectMessageReceived {
  return {
    senderAddress: { raw: SENDER_ADDRESS },
    recipientAddress: { raw: RECIPIENT_ADDRESS },
    items: [{ type: 'text', text: 'hi' }],
    payloadDigest: 'digest-1',
    stampValueWei: 1_000_000_000_000n,
    receivedTime: 1_700_000_000_000,
    ...overrides,
  }
}

// Generous ceiling only: with fake timers nothing waits on wall-clock time, but cold module
// transforms under CPU load can exceed the 1 s default from jest.setup.ts (ticket #285).
jest.setTimeout(30_000)

describe('adapters/pinia-chain-adapter.ts (ticket #42)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    mockMessageStore =
      (await messageStorePromise) as unknown as MockMessageStore
    mockMessageStore.saveMessage.mockClear()
    mockMessageStore.relayCursor.mockReset().mockResolvedValue(0)
    mockMessageStore.advanceRelayCursor
      .mockReset()
      .mockImplementation(async (_address: string, next: number) => next)
    mockMessageStore.mostRecentMessageTime.mockReset().mockResolvedValue(0)
    useContactStore().addContact({
      address: SENDER_ADDRESS,
      contact: {
        profile: { name: 'Sender', bio: '', avatar: '', pubKey: null },
      },
    })
  })

  describe('toReceivedMessageWrapper', () => {
    it('adapts a DirectMessageReceived record into a ReceivedMessageWrapper', async () => {
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })

      const wrapper = await toReceivedMessageWrapper(makeRecord())

      expect(wrapper).toBeDefined()
      expect(wrapper?.senderAddress).toBe(SENDER_ADDRESS)
      expect(wrapper?.copartyAddress).toBe(SENDER_ADDRESS)
      expect(wrapper?.index).toBe('digest-1')
      expect(wrapper?.stampValue).toBe(1_000_000_000_000)
      expect(wrapper?.message.outpoints).toEqual([])
      expect(wrapper?.message.stampValueWei).toBe(1_000_000_000_000n)
      expect(wrapper?.message.destinationAddress).toBe(RECIPIENT_ADDRESS)
    })

    it('returns undefined when the sender has no resolvable profile', async () => {
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue(undefined)
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)

      const wrapper = await toReceivedMessageWrapper(makeRecord())

      expect(wrapper).toBeUndefined()
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('uses the pubkey that MonadChain already resolved without a second profile lookup', async () => {
      const fetchProfile = jest.spyOn(activeChain, 'fetchProfile')

      const wrapper = await toReceivedMessageWrapper(
        makeRecord({ senderPublicKey: PUB_KEY_BYTES }),
      )

      expect(wrapper).toBeDefined()
      expect(fetchProfile).not.toHaveBeenCalled()
    })
  })

  describe('startDirectMessagePolling', () => {
    const wallet: WalletHandle = {
      identity: {
        address: { raw: RECIPIENT_ADDRESS },
        displayAddress: RECIPIENT_ADDRESS,
      },
    }

    // Fake timers drive the poll loop's chained `setTimeout`s and `Date.now()` (ticket #285), so no
    // test depends on wall-clock time. `nextTick`/`setImmediate`/`queueMicrotask` are deliberately
    // left real: this repo's jest.setup.ts swaps in the `promise` polyfill for `global.Promise`, and
    // it schedules its callbacks through them, so faking them stalls every awaited mock. `settle()`
    // yields to real `setImmediate` several times, which lets each poll's whole promise chain
    // (fetchSince -> profile lookup -> receiveMessages) run to its next `await` or to completion.
    const realSetImmediate = setImmediate
    const settle = async () => {
      for (let i = 0; i < 25; i++)
        await new Promise<void>(resolve => realSetImmediate(resolve))
    }
    // Let pending work finish, advance logical time by `ms`, and let everything that became runnable finish.
    const advance = async (ms: number) => {
      // Settle first so a timer that a just-finished poll is about to schedule already exists.
      await settle()
      jest.advanceTimersByTime(ms)
      await settle()
    }
    // Condition wait in logical time: advance one interval at a time, up to a fixed number of
    // steps (not a wall-clock ceiling), so a slow machine can never make it time out early.
    const advanceUntil = async (
      condition: () => boolean,
      stepMs = 20,
      maxSteps = 200,
    ) => {
      await settle()
      for (let i = 0; i < maxSteps && !condition(); i++) await advance(stepMs)
      expect(condition()).toBe(true)
    }
    // Every poller a test starts is stopped afterwards, so a failing test cannot leak a live loop
    // into the next one.
    const pollers: { stop: () => void }[] = []
    const startPolling = (intervalMs: number) => {
      const polling = startDirectMessagePolling({ wallet, intervalMs })
      pollers.push(polling)
      return polling
    }
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      })
    })
    afterEach(() => {
      pollers.splice(0).forEach(polling => polling.stop())
      jest.useRealTimers()
    })

    it('feeds fetchSince results into chats.receiveMessages and advances sinceMs', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValueOnce([makeRecord()])
        .mockResolvedValue([])

      const polling = startPolling(20)

      // Initial immediate poll.
      await settle()
      expect(receiveMessagesSpy).toHaveBeenCalledTimes(1)
      expect(mockMessageStore.advanceRelayCursor).toHaveBeenCalledWith(
        RECIPIENT_ADDRESS,
        1_700_000_000_001,
        [],
        [expect.objectContaining({ index: 'digest-1' })],
      )
      expect(fetchSinceSpy).toHaveBeenNthCalledWith(1, {
        wallet,
        sinceMs: 0,
        onTruncated: expect.any(Function),
        onSkippedTimestamp: expect.any(Function),
      })

      // The relay bound is inclusive, so advance one millisecond past the received record.
      await advance(30)
      expect(fetchSinceSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
        wallet,
        sinceMs: 1_700_000_000_001,
        onTruncated: expect.any(Function),
        onSkippedTimestamp: expect.any(Function),
      })
      // No new messages on any subsequent poll.
      expect(receiveMessagesSpy).toHaveBeenCalledTimes(1)

      polling.stop()
      const callsAtStop = fetchSinceSpy.mock.calls.length
      await advance(60)
      expect(fetchSinceSpy.mock.calls.length).toBe(callsAtStop)
    })

    it('replays a timestamp group when a later sibling profile is unresolved', async () => {
      const profile = {
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      }
      jest
        .spyOn(activeChain, 'fetchProfile')
        .mockResolvedValueOnce(profile)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(profile)
      const rows = [
        makeRecord({ payloadDigest: 'same-time-a', receivedTime: 700 }),
        makeRecord({ payloadDigest: 'same-time-b', receivedTime: 700 }),
      ]
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockImplementation(async ({ sinceMs }) =>
          rows.filter(row => row.receivedTime >= sinceMs),
        )

      const polling = startPolling(20)
      await advanceUntil(() => fetchSinceSpy.mock.calls.length >= 2)
      polling.stop()

      expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
        wallet,
        sinceMs: 700,
        onTruncated: expect.any(Function),
        onSkippedTimestamp: expect.any(Function),
      })
      expect(mockMessageStore.advanceRelayCursor).toHaveBeenLastCalledWith(
        RECIPIENT_ADDRESS,
        701,
        [],
        expect.arrayContaining([
          expect.objectContaining({ index: 'same-time-a' }),
          expect.objectContaining({ index: 'same-time-b' }),
        ]),
      )
      expect(useChatStore().messages['same-time-a']).toBeDefined()
      expect(useChatStore().messages['same-time-b']).toBeDefined()
    })

    it('rejects unsafe wire timestamps without granting them cursor authority', async () => {
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValueOnce([
          makeRecord({
            payloadDigest: 'unsafe-time',
            receivedTime: '9007199254740992' as never,
          }),
          makeRecord({ payloadDigest: 'safe-time', receivedTime: 100 }),
        ])
        .mockResolvedValue([])

      const polling = startPolling(20)
      await advanceUntil(() => fetchSinceSpy.mock.calls.length >= 2)
      polling.stop()

      expect(useChatStore().messages['unsafe-time']).toBeUndefined()
      expect(useChatStore().messages['safe-time']).toBeDefined()
      expect(fetchSinceSpy.mock.calls[1][0].sinceMs).toBe(101)
    })

    it('does not poll after stop while cursor hydration is deferred', async () => {
      let releaseCursor: ((cursor: number) => void) | undefined
      mockMessageStore.relayCursor.mockReturnValueOnce(
        new Promise(resolve => {
          releaseCursor = resolve
        }),
      )
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValue([])

      const polling = startPolling(20)
      polling.stop()
      releaseCursor?.(0)
      await settle()
      await advance(40)

      expect(fetchSinceSpy).not.toHaveBeenCalled()
    })

    it('uses only the current recipient cursor, never another account or an outbound clock', async () => {
      const oldAddress = '0x1111111111111111111111111111111111111111'
      const replacementAddress = RECIPIENT_ADDRESS
      mockMessageStore.mostRecentMessageTime.mockResolvedValue(99_999)
      mockMessageStore.relayCursor.mockImplementation(async address =>
        address.toLowerCase() === oldAddress.toLowerCase() ? 9000 : 20,
      )
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValue([])
      const oldPolling = startDirectMessagePolling({
        wallet: {
          identity: {
            address: { raw: oldAddress },
            displayAddress: oldAddress,
          },
        },
        intervalMs: 20,
      })
      pollers.push(oldPolling)
      await settle()
      oldPolling.stop()

      const replacementPolling = startDirectMessagePolling({
        wallet: {
          identity: {
            address: { raw: replacementAddress },
            displayAddress: replacementAddress,
          },
        },
        intervalMs: 20,
      })
      pollers.push(replacementPolling)
      await settle()

      expect(fetchSinceSpy.mock.calls[0]?.[0].sinceMs).toBe(9000)
      expect(fetchSinceSpy.mock.calls.at(-1)?.[0].sinceMs).toBe(20)
      expect(mockMessageStore.mostRecentMessageTime).not.toHaveBeenCalled()
    })

    it('a truncated inbox scan never skips the rest of a timestamp group (F1 regression)', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      const warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      // Relay rows: X@99, A@100, B@100 (same timestamp). The first scan fetched [X, A] on page 1
      // and page 2 failed; the client cuts the result back to the complete group [X] and reports
      // the truncation. `since` is inclusive, so the next poll from 100 must still return A and B.
      const rows = [
        makeRecord({ payloadDigest: 'x', receivedTime: 99 }),
        makeRecord({ payloadDigest: 'a', receivedTime: 100 }),
        makeRecord({ payloadDigest: 'b', receivedTime: 100 }),
      ]
      let firstScan = true
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockImplementation(async ({ sinceMs, onTruncated }) => {
          if (firstScan) {
            firstScan = false
            onTruncated?.(new Error('page 2 failed'))
            return rows.filter(r => r.receivedTime === 99)
          }
          return rows.filter(r => r.receivedTime >= sinceMs)
        })

      const polling = startPolling(20)
      await advanceUntil(() => receiveMessagesSpy.mock.calls.length >= 2)
      polling.stop()

      expect(warnSpy).toHaveBeenCalled()
      expect(fetchSinceSpy.mock.calls[1][0].sinceMs).toBe(100)
      const digests = receiveMessagesSpy.mock.calls.flatMap(([batch]) =>
        batch.map(m => m.payloadDigest ?? (m as { digest?: string }).digest),
      )
      expect(receiveMessagesSpy).toHaveBeenCalledTimes(2)
      expect(digests).toHaveLength(3)
    })

    it('stop() during an in-flight poll delivers nothing and never reschedules (wallet switch)', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      let release: (records: DirectMessageReceived[]) => void = () => undefined
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockImplementation(
          () =>
            new Promise<DirectMessageReceived[]>(resolve => {
              release = resolve
            }),
        )

      const polling = startPolling(10)
      await advanceUntil(() => fetchSinceSpy.mock.calls.length === 1, 10)
      polling.stop() // the old wallet is switched away while its request is still in flight
      release([makeRecord({ payloadDigest: 'old-wallet-msg' })])
      await advance(80) // several intervals: any reschedule would show up as a second call

      expect(receiveMessagesSpy).not.toHaveBeenCalled()
      expect(fetchSinceSpy).toHaveBeenCalledTimes(1)
    })

    it('stop after receive queued prevents the old session from advancing its cursor', async () => {
      const chats = useChatStore()
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValueOnce([makeRecord({ payloadDigest: 'old-session' })])
        .mockResolvedValue([])
      let receiveStarted: (() => void) | undefined
      const started = new Promise<void>(resolve => {
        receiveStarted = resolve
      })
      let releaseReceive: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        releaseReceive = resolve
      })
      jest.spyOn(chats, 'receiveMessages').mockImplementationOnce(async () => {
        receiveStarted?.()
        await gate
        return { suppressedReceipts: [] }
      })

      const polling = startPolling(20)
      await started
      polling.stop()
      releaseReceive?.()
      await settle()

      expect(mockMessageStore.advanceRelayCursor).not.toHaveBeenCalled()
    })

    it('advances beyond a valid record returned after an earlier poison record was filtered', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      // MonadChain.fetchSince filters the authenticated malformed record at timestamp 100 and
      // returns the valid record later in the same relay page.
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValueOnce([
          makeRecord({
            payloadDigest: 'valid-after-poison',
            receivedTime: 200,
          }),
        ])
        .mockResolvedValue([])

      const polling = startPolling(20)
      try {
        await advanceUntil(() => fetchSinceSpy.mock.calls.length >= 2)
        expect(receiveMessagesSpy).toHaveBeenCalledWith(
          [expect.objectContaining({ index: 'valid-after-poison' })],
          RECIPIENT_ADDRESS,
          expect.any(Function),
        )
        expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
          wallet,
          sinceMs: 201,
          onTruncated: expect.any(Function),
          onSkippedTimestamp: expect.any(Function),
        })
      } finally {
        polling.stop()
      }
    })

    it('does not let one failed poll stop future polling', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockRejectedValueOnce(new Error('relay unreachable'))
        .mockResolvedValue([])

      const polling = startPolling(20)

      await settle()
      expect(consoleErrorSpy).toHaveBeenCalled()
      expect(receiveMessagesSpy).not.toHaveBeenCalled()

      // The failed poll doesn't stop the loop -- a later poll still runs.
      await advance(30)
      expect(fetchSinceSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

      polling.stop()
    })

    it('does not advance the cursor when durable receipt fails', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest
        .spyOn(chats, 'receiveMessages')
        .mockRejectedValueOnce(new Error('indexeddb write failed'))
        .mockResolvedValue({ suppressedReceipts: [] })
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockResolvedValueOnce([makeRecord()])
        .mockResolvedValue([])

      const polling = startPolling(20)
      try {
        await advanceUntil(() => fetchSinceSpy.mock.calls.length >= 2)
        expect(consoleErrorSpy).toHaveBeenCalled()
        expect(receiveMessagesSpy).toHaveBeenCalledTimes(1)
        expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
          wallet,
          sinceMs: 0,
          onTruncated: expect.any(Function),
          onSkippedTimestamp: expect.any(Function),
        })
      } finally {
        polling.stop()
      }
    })

    it('quarantines a terminal missing-profile row without skipping its valid same-time sibling', async () => {
      const chats = useChatStore()
      const receiveMessagesSpy = jest.spyOn(chats, 'receiveMessages')
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockImplementationOnce(async ({ onSkippedTimestamp }) => {
          // This is the MonadChain -> adapter seam: MonadChain cannot return the raw row
          // without its sender profile, so it reports only the omitted row's relay timestamp.
          onSkippedTimestamp?.(100)
          return [makeRecord({ payloadDigest: 'same-time', receivedTime: 100 })]
        })
        .mockResolvedValue([])

      const polling = startPolling(20)
      try {
        await advanceUntil(() => fetchSinceSpy.mock.calls.length >= 2)
        expect(consoleErrorSpy).not.toHaveBeenCalled()
        expect(receiveMessagesSpy).toHaveBeenCalledWith(
          [expect.objectContaining({ index: 'same-time' })],
          RECIPIENT_ADDRESS,
          expect.any(Function),
        )
        expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
          wallet,
          sinceMs: 101,
          onTruncated: expect.any(Function),
          onSkippedTimestamp: expect.any(Function),
        })
      } finally {
        polling.stop()
      }
    })

    it('makes bounded progress past more terminal profile misses than one mailbox scan budget', async () => {
      jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
        address: { raw: SENDER_ADDRESS },
        pubKey: PUB_KEY_BYTES,
      })
      let scan = 0
      const fetchSinceSpy = jest
        .spyOn(activeChain.directMessages, 'fetchSince')
        .mockImplementation(async ({ onSkippedTimestamp }) => {
          scan += 1
          if (scan === 1) {
            // The feed scans at most 64 pages x 100 rows. Every terminal row in that bounded
            // prefix must grant progress or newer valid mail can starve forever.
            for (let timestamp = 1; timestamp <= 6400; timestamp++) {
              onSkippedTimestamp?.(timestamp)
            }
            return []
          }
          return scan === 2
            ? [makeRecord({ payloadDigest: 'after-terminal-prefix', receivedTime: 6401 })]
            : []
        })

      const polling = startPolling(20)
      try {
        await advanceUntil(
          () =>
            fetchSinceSpy.mock.calls.length >= 3 &&
            useChatStore().messages['after-terminal-prefix'] !== undefined,
        )
        expect(fetchSinceSpy.mock.calls[1]?.[0].sinceMs).toBe(6401)
        expect(fetchSinceSpy.mock.calls[2]?.[0].sinceMs).toBe(6402)
      } finally {
        polling.stop()
      }
    })

    it('defaults to a 5-10s-range poll interval', () => {
      expect(DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(
        5000,
      )
      expect(DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(
        10_000,
      )
    })
  })
})
