/**
 * Unit tests for `stores/chats.ts`'s rewiring onto `ActiveChain` (ticket #42). Per the ticket's own
 * instructions, `activeChain` is mocked at its own boundary (`jest.spyOn` on
 * `activeChain.directMessages.send`) rather than reaching into `monad-chain.ts`/the underlying
 * Monad wallet clients -- those already have their own tests (ticket #41). `activeChain.parseAddress`
 * /`formatAddress` are exercised for real (pure, no network) to genuinely prove the store-key
 * consistency decision documented in this file's own header (ticket #42, decision 2).
 *
 * Deliberately *not* run under the `jsdom` testEnvironment: this app's `jest.config.js` maps
 * `quasar`'s `browser` export condition (picked up by `jsdom`) to `pinia`'s own ESM browser build
 * (`pinia.esm-browser.js`, raw `import` syntax jest's transform doesn't cover) -- a pre-existing
 * gap never hit before this ticket's first-ever `stores/*.ts` tests. Plain `node` env resolves both
 * to their CJS builds instead. `receiveMessages` unconditionally evaluates `document.hasFocus()` in
 * its notify loop (see `chats.ts`), so a minimal `document` stub is installed below instead; `
 * ../utils/notifications` is mocked since node has no `Notification` API either, which
 * `desktopNotify` would otherwise call.
 *
 * `../adapters/level-message-store` is also mocked: it opens a real on-disk `level` DB as an
 * unconditional *module-import-time* side effect (`export const store = createStore()`), purely to
 * back `rehydateChat`'s (unused by these tests) leveldb iteration -- another pre-existing gap never
 * hit before this ticket, since no test previously imported `chats.ts`. Without mocking it, running
 * this file alongside `contacts.jest.test.ts`/`pinia-chain-adapter.jest.test.ts` (each importing
 * `chats.ts` fresh in their own module registry) races to open the same on-disk DB path and crashes
 * the whole jest process with an unhandled LevelUP lock error.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { rehydateChat, useChatStore } from './chats'
import { useContactStore } from './contacts'
import { store as messageStorePromise } from '../adapters/level-message-store'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageWrapper } from '@frank/cashweb/types/messages'
import { desktopNotify } from '../utils/notifications'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: jest.fn(async function* () {
      /* no persisted messages by default */
    }),
  }),
}))

jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))

const SENDER_ADDRESS = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const RECIPIENT_ADDRESS = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
// Same address as RECIPIENT_ADDRESS, different case -- exercises store-key consistency (decision 2).
const RECIPIENT_ADDRESS_LOWERCASE = RECIPIENT_ADDRESS.toLowerCase()

type MockMessageStore = {
  saveMessage: jest.Mock
  deleteMessage: jest.Mock
  mostRecentMessageTime: jest.Mock
  getIterator: jest.Mock
}
let mockMessageStore: MockMessageStore

function makeWallet(address: string): WalletHandle {
  return {
    identity: {
      address: { raw: address },
      displayAddress: address,
    },
  }
}

describe('stores/chats.ts (ticket #42)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    mockMessageStore =
      (await messageStorePromise) as unknown as MockMessageStore
    mockMessageStore.saveMessage.mockClear()
    mockMessageStore.deleteMessage.mockClear()
    mockMessageStore.mostRecentMessageTime.mockClear()
    mockMessageStore.getIterator.mockClear()
    jest.mocked(desktopNotify).mockClear()
  })

  describe('sendMessage', () => {
    it('sends through activeChain.directMessages.send and records a confirmed message', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      const onPreparationProgress = jest.fn()
      const sendSpy = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue({
          payloadDigest: 'deadbeef',
          stampValueWei: 1_000_000_000_000n,
          preparationTxHashes: [],
        })

      const result = await chats.sendMessage({
        wallet,
        address: RECIPIENT_ADDRESS,
        items: [{ type: 'text', text: 'hello' }],
        onPreparationProgress,
      })

      expect(result.payloadDigest).toBe('deadbeef')
      expect(sendSpy).toHaveBeenCalledWith({
        wallet,
        recipient: { raw: RECIPIENT_ADDRESS },
        items: [{ type: 'text', text: 'hello' }],
        onPreparationProgress,
      })

      const chat = chats.chats[RECIPIENT_ADDRESS]
      expect(chat).toBeDefined()
      expect(chat?.messages).toHaveLength(1)
      const message = chat?.messages[0]
      expect(message?.status).toBe('confirmed')
      expect(message?.outpoints).toEqual([])
      expect(message?.stampValueWei).toBe(1_000_000_000_000n)
      expect(message?.payloadDigest).toBe('deadbeef')
      expect(mockMessageStore.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'deadbeef',
          outbound: true,
          copartyAddress: RECIPIENT_ADDRESS,
          message: expect.objectContaining({
            stampValueWei: 1_000_000_000_000n,
          }),
        }),
        { advanceCursor: false },
      )
    })

    it('keys the chat by activeChain.formatAddress regardless of input case (decision 2)', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      jest.spyOn(activeChain.directMessages, 'send').mockResolvedValue({
        payloadDigest: 'abc123',
        stampValueWei: 42n,
        preparationTxHashes: [],
      })

      await chats.sendMessage({
        wallet,
        address: RECIPIENT_ADDRESS_LOWERCASE,
        items: [{ type: 'text', text: 'hi' }],
      })

      // Stored under the canonical (checksummed) form, not the lowercase input.
      expect(chats.chats[RECIPIENT_ADDRESS]).toBeDefined()
      expect(chats.chats[RECIPIENT_ADDRESS_LOWERCASE]).toBeUndefined()
    })

    it('rejects and does not record a message for an unparseable address', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      const sendSpy = jest.spyOn(activeChain.directMessages, 'send')

      await expect(
        chats.sendMessage({
          wallet,
          address: 'not-a-real-address',
          items: [{ type: 'text', text: 'hi' }],
        }),
      ).rejects.toThrow()
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('propagates a send failure without recording a confirmed message', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('no registered profile'))

      await expect(
        chats.sendMessage({
          wallet,
          address: RECIPIENT_ADDRESS,
          items: [{ type: 'text', text: 'hi' }],
        }),
      ).rejects.toThrow('no registered profile')

      // The chat shell may exist (created before the send attempt), but no message was recorded.
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages ?? []).toHaveLength(0)
    })
  })

  it('restores the durable resume cursor even when no messages remain locally', async () => {
    mockMessageStore.mostRecentMessageTime.mockResolvedValueOnce(789)

    const restored = await rehydateChat({
      activeChatAddr: null,
      chats: {},
      messages: {},
      lastReceived: 123,
    })

    expect(restored.lastReceived).toBe(789)
  })

  it('rehydrates exact inbox and outbox values from the durable message store', async () => {
    const persisted = (async function* (): AsyncGenerator<MessageWrapper> {
      for (const [index, outbound, copartyAddress, valueWei] of [
        ['inbox', false, RECIPIENT_ADDRESS, 10_000_000_000_000_001n],
        ['outbox', true, RECIPIENT_ADDRESS, 20_000_000_000_000_002n],
      ] as const) {
        yield {
          index,
          outbound,
          senderAddress: outbound ? SENDER_ADDRESS : RECIPIENT_ADDRESS,
          copartyAddress,
          message: {
            outbound,
            status: 'confirmed',
            receivedTime: Number(valueWei % 1000n),
            serverTime: Number(valueWei % 1000n),
            items: [{ type: 'text', text: index }],
            outpoints: [],
            senderAddress: outbound ? SENDER_ADDRESS : RECIPIENT_ADDRESS,
            stampValueWei: valueWei,
            stampPayments: [
              {
                txHash: `tx-${index}`,
                destinationAddress: RECIPIENT_ADDRESS,
                valueWei,
              },
            ],
          },
        }
      }
    })()
    mockMessageStore.getIterator.mockResolvedValueOnce(persisted)

    const restored = await rehydateChat({
      activeChatAddr: null,
      chats: {},
      messages: {},
      lastReceived: 0,
    })

    expect(restored.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(2)
    expect(restored.messages.inbox?.stampValueWei).toBe(10_000_000_000_000_001n)
    expect(restored.messages.outbox?.stampPayments?.[0]?.valueWei).toBe(
      20_000_000_000_000_002n,
    )
  })

  describe('receiveMessages with stampValueWei (decision 1)', () => {
    function makeWrapper(
      overrides: Partial<ReceivedMessageWrapper> = {},
    ): ReceivedMessageWrapper {
      return {
        outbound: false,
        senderAddress: RECIPIENT_ADDRESS,
        copartyAddress: RECIPIENT_ADDRESS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        copartyPubKey: {} as any,
        index: 'digest-1',
        stampValue: 5000,
        message: {
          outbound: false,
          status: 'confirmed',
          items: [{ type: 'text', text: 'hi there' }],
          serverTime: Date.now(),
          receivedTime: Date.now(),
          outpoints: [],
          stampValueWei: 5000n,
          senderAddress: RECIPIENT_ADDRESS,
          destinationAddress: SENDER_ADDRESS,
        },
        ...overrides,
      }
    }

    it('uses stampValueWei (not stampPrice(outpoints)) for a Monad-sourced message', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      // Pre-register the contact so receiveMessages doesn't attempt a network refresh.
      contacts.addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })

      await chats.receiveMessages([makeWrapper()])

      const chat = chats.chats[RECIPIENT_ADDRESS]
      expect(chat).toBeDefined()
      expect(chat?.totalValue).toBe(5000)
      expect(chat?.totalUnreadValue).toBe(5000)
      expect(chat?.totalUnreadMessages).toBe(1)
      expect(chat?.messages[0].stampValueWei).toBe(5000n)
      expect(chat?.messages[0].outpoints).toEqual([])
      expect(mockMessageStore.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'digest-1',
          copartyAddress: RECIPIENT_ADDRESS,
          message: expect.objectContaining({ stampValueWei: 5000n }),
        }),
      )
    })

    it('still falls back to stampPrice(outpoints) when stampValueWei is absent (Lotus-origin)', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      contacts.addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })

      const wrapper = makeWrapper()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (wrapper.message as any).stampValueWei

      await chats.receiveMessages([wrapper])

      const chat = chats.chats[RECIPIENT_ADDRESS]
      // No outpoints, no stampValueWei -> stampPrice([]) === 0.
      expect(chat?.totalValue).toBe(0)
    })

    it('continues applying a batch after an already-present message', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      contacts.addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      const first = makeWrapper()
      await chats.receiveMessages([first])

      const later = makeWrapper({
        index: 'digest-2',
        message: {
          ...first.message,
          items: [{ type: 'text', text: 'second' }],
          serverTime: first.message.serverTime + 1,
          receivedTime: first.message.receivedTime + 1,
        },
      })
      await chats.receiveMessages([first, later])

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(2)
      expect(chats.messages['digest-2']?.items).toEqual([
        { type: 'text', text: 'second' },
      ])
    })

    it('does not notify again when a polling retry replays a durable message', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      contacts.addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          notify: true,
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      jest.spyOn(document, 'hasFocus').mockReturnValue(false)
      const wrapper = makeWrapper()

      await chats.receiveMessages([wrapper])
      await chats.receiveMessages([wrapper])

      expect(desktopNotify).toHaveBeenCalledTimes(1)
    })
  })

  it('deletes a message durably before removing it from the chat', async () => {
    const chats = useChatStore()
    chats.chats[RECIPIENT_ADDRESS] = {
      address: RECIPIENT_ADDRESS,
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    }
    chats.sendMessageLocal({
      address: RECIPIENT_ADDRESS,
      senderAddress: SENDER_ADDRESS,
      index: 'delete-me',
      items: [{ type: 'text', text: 'temporary' }],
      outpoints: [],
      status: 'confirmed',
      previousHash: null,
    })

    await chats.deleteMessage({
      address: RECIPIENT_ADDRESS,
      payloadDigest: 'delete-me',
    })

    expect(mockMessageStore.deleteMessage).toHaveBeenCalledWith('delete-me')
    expect(chats.messages['delete-me']).toBeUndefined()
    expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
  })
})
