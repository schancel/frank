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
import { activeChain } from '@frank/wallet/chain'
import type { DirectMessageReceived, WalletHandle } from '@frank/wallet/chain'

jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))
// See `../stores/chats.jest.test.ts`'s header for why this needs mocking too.
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
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

function makeRecord(
  overrides: Partial<DirectMessageReceived> = {},
): DirectMessageReceived {
  return {
    senderAddress: { raw: SENDER_ADDRESS },
    recipientAddress: { raw: RECIPIENT_ADDRESS },
    items: [{ type: 'text', text: 'hi' }],
    payloadDigest: 'digest-1',
    burnValueWei: 1_000_000_000_000n,
    receivedTime: 1_700_000_000_000,
    ...overrides,
  }
}

describe('adapters/pinia-chain-adapter.ts (ticket #42)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
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
      expect(wrapper?.message.burnValueWei).toBe(1_000_000_000_000n)
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
  })

  describe('startDirectMessagePolling', () => {
    const wallet: WalletHandle = {
      identity: {
        address: { raw: RECIPIENT_ADDRESS },
        displayAddress: RECIPIENT_ADDRESS,
      },
    }

    // Real timers with a tiny intervalMs, rather than fake timers: this repo's fake-timer +
    // async-microtask interplay (jest 29 modern fake timers + Pinia + the mocked leveldb promise)
    // proved unreliable in practice (polls never observed as run), so this favors a few tens of
    // milliseconds of real wall-clock time for a much more robust test.
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

      const polling = startDirectMessagePolling({ wallet, intervalMs: 20 })

      // Initial immediate poll.
      await wait(10)
      expect(receiveMessagesSpy).toHaveBeenCalledTimes(1)
      expect(fetchSinceSpy).toHaveBeenNthCalledWith(1, {
        wallet,
        sinceMs: 0,
      })

      // Next interval tick should use the advanced sinceMs (the first record's receivedTime).
      await wait(30)
      expect(fetchSinceSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(fetchSinceSpy).toHaveBeenNthCalledWith(2, {
        wallet,
        sinceMs: 1_700_000_000_000,
      })
      // No new messages on any subsequent poll.
      expect(receiveMessagesSpy).toHaveBeenCalledTimes(1)

      polling.stop()
      const callsAtStop = fetchSinceSpy.mock.calls.length
      await wait(60)
      expect(fetchSinceSpy.mock.calls.length).toBe(callsAtStop)
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

      const polling = startDirectMessagePolling({ wallet, intervalMs: 20 })

      await wait(10)
      expect(consoleErrorSpy).toHaveBeenCalled()
      expect(receiveMessagesSpy).not.toHaveBeenCalled()

      // The failed poll doesn't stop the loop -- a later poll still runs.
      await wait(30)
      expect(fetchSinceSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

      polling.stop()
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
