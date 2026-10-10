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
import { createApp } from 'vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  indexOutboundDeliveryOwners,
  rehydateChat,
  rehydrateState,
  useChatStore,
  makeConversationId,
  type Conversation,
  uuidv5,
  NULL_CONVERSATION_NAMESPACE,
  getTrustedEmailGatewayAddress,
  type RestorableState,
  type ChatMessage,
} from './chats'
import { useProfileStore } from './my-profile'
import { useContactStore } from './contacts'
import { store as messageStorePromise } from '../adapters/level-message-store'
import {
  activeChain,
  CanonicalMessagingHoldError,
  CanonicalRecipientNotPublishedError,
} from '@frank/wallet/chain'
import { sameCanonicalAddress } from '../utils/own-address'
import type { WalletHandle } from '@frank/wallet/chain'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageWrapper, EmailItem } from '@frank/cashweb/types/messages'
import { desktopNotify } from '../utils/notifications'
import { defaultEmailGatewayAddress } from '../utils/constants'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    relayCursor: jest.fn(async () => 0),
    quarantineRelayReceipts: jest.fn(async () => undefined),
    suppressAndDelete: jest.fn(async () => undefined),
    suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
    getIterator: jest.fn(async function* () {
      /* no persisted messages by default */
    }),
  }),
}))

jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
}))
const mockBalanceRefresh = jest.fn()
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({
    refresh: mockBalanceRefresh,
  }),
}))
const mockOwnAddress = jest.fn()
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: () => mockOwnAddress(),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))
jest.setTimeout(10000)

const SENDER_ADDRESS = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const RECIPIENT_ADDRESS = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const THIRD_ADDRESS = '0x3333333333333333333333333333333333333333'
// Same address as RECIPIENT_ADDRESS, different case -- exercises store-key consistency (decision 2).
const RECIPIENT_ADDRESS_LOWERCASE = RECIPIENT_ADDRESS.toLowerCase()

type MockMessageStore = {
  saveMessage: jest.Mock
  deleteMessage: jest.Mock
  suppressAndDelete: jest.Mock
  suppressedRelayReceipts: jest.Mock
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

function conversationFor(
  state: { conversations: Record<string, Conversation> },
  address: string,
): Conversation | undefined {
  return Object.values(state.conversations).find(c => c.address === address)
}

function seedConversation(
  chats: ReturnType<typeof useChatStore>,
  address: string,
  fields: Partial<Conversation>,
) {
  const conv = chats.openDirectConversation(address)
  Object.assign(conv, fields)
  for (const message of conv.messages) message.conversationId = conv.id
  return conv
}

describe('stores/chats.ts (ticket #42)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    mockMessageStore =
      (await messageStorePromise) as unknown as MockMessageStore
    mockMessageStore.saveMessage.mockReset().mockResolvedValue(undefined)
    mockMessageStore.deleteMessage.mockReset().mockResolvedValue(undefined)
    mockMessageStore.suppressAndDelete.mockReset().mockResolvedValue(undefined)
    mockMessageStore.suppressedRelayReceipts
      .mockReset()
      .mockResolvedValue(new Set<string>())
    mockMessageStore.mostRecentMessageTime.mockReset().mockResolvedValue(0)
    mockMessageStore.getIterator.mockClear()
    jest.mocked(desktopNotify).mockClear()
    mockOwnAddress.mockReset()
    mockOwnAddress.mockResolvedValue(SENDER_ADDRESS)
    jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
  })

  it('indexes outbound payload and attempt ownership in one history pass', () => {
    let attemptReads = 0
    const messages = Array.from({ length: 300 }, (_, index) => {
      const delivery = {}
      Object.defineProperty(delivery, 'attemptDigest', {
        enumerable: true,
        get: () => {
          attemptReads += 1
          return `attempt-${index}`
        },
      })
      return {
        outbound: true,
        payloadDigest: `payload-${index}`,
        delivery,
      }
    })

    const owners = indexOutboundDeliveryOwners({
      [RECIPIENT_ADDRESS]: { messages } as never,
    })
    expect(attemptReads).toBe(300)
    for (let index = 0; index < 3000; index += 1) {
      const owner = owners.byAttempt.get(`attempt-${index % 300}`)
      expect(owner?.index).toBe(`payload-${index % 300}`)
    }
    expect(attemptReads).toBe(300)
  })

  describe('sendMessage', () => {
    it('reconciles a receipt batch with one history/accounting pass per chat', async () => {
      const chats = useChatStore()
      const historySize = 200
      const batchSize = 50
      let statusReads = 0
      const history = Array.from({ length: historySize }, (_, index) => {
        const message = {
          outbound: true,
          payloadDigest: `pending:complexity-${index}`,
          receivedTime: index,
          serverTime: index,
          items: [{ type: 'text' as const, text: `${index}` }],
          outpoints: [],
          senderAddress: SENDER_ADDRESS,
          delivery: { attemptDigest: `delivered-complexity-${index}` },
        }
        Object.defineProperty(message, 'status', {
          enumerable: true,
          get: () => {
            statusReads += 1
            return 'payment-pending'
          },
        })
        chats.messages[message.payloadDigest] = message as never
        return message as never
      })
      seedConversation(chats, SENDER_ADDRESS, {
        address: SENDER_ADDRESS,
        messages: history,
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: historySize,
        lastRead: 0,
        stampAmount: 1,
      })
      const wrappers = Array.from({ length: batchSize }, (_, index) => ({
        outbound: false,
        senderAddress: SENDER_ADDRESS,
        copartyAddress: SENDER_ADDRESS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        copartyPubKey: {} as any,
        index: `delivered-complexity-${index}`,
        stampValue: 1,
        message: {
          outbound: false,
          status: 'confirmed',
          items: [{ type: 'text' as const, text: `${index}` }],
          serverTime: 1000 + index,
          receivedTime: 1000 + index,
          outpoints: [],
          stampValueWei: 1n,
          senderAddress: SENDER_ADDRESS,
          destinationAddress: SENDER_ADDRESS,
        },
      }))

      await chats.receiveMessages(wrappers, SENDER_ADDRESS)

      expect(chats.chats[SENDER_ADDRESS]?.messages).toHaveLength(historySize)
      expect(statusReads).toBeLessThanOrEqual(historySize)
    })

    it('keeps one outbound stamped message when a self-send loops back from the relay (#420)', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      contacts.addContact({
        address: SENDER_ADDRESS,
        contact: {
          profile: {
            name: 'Alice',
            bio: '',
            avatar: 'alice.png',
            pubKey: null,
          },
        },
      })
      jest.spyOn(activeChain.directMessages, 'send').mockResolvedValue({
        payloadDigest: 'self-digest',
        stampValueWei: 7000n,
        stampPayments: [
          {
            txHash: '0xstamp',
            destinationAddress: SENDER_ADDRESS,
            valueWei: 7000n,
          },
        ],
        preparationTxHashes: [],
      })

      await chats.sendMessage({
        wallet,
        address: SENDER_ADDRESS,
        items: [{ type: 'text', text: 'note to self' }],
        stampValue: 7000n,
      })
      const loopbackTime = Date.now() + 1000
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: SENDER_ADDRESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'self-digest',
          stampValue: 7000,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'note to self' }],
            serverTime: loopbackTime,
            receivedTime: loopbackTime,
            outpoints: [],
            stampValueWei: 7000n,
            stampPayments: [
              {
                txHash: '0xstamp',
                destinationAddress: SENDER_ADDRESS,
                valueWei: 7000n,
              },
            ],
            senderAddress: SENDER_ADDRESS,
            destinationAddress: SENDER_ADDRESS,
          },
        },
      ])

      expect(chats.chats[SENDER_ADDRESS]?.messages).toHaveLength(1)
      expect(chats.chats[SENDER_ADDRESS]?.messages[0]).toEqual(
        expect.objectContaining({
          payloadDigest: 'self-digest',
          outbound: true,
          stampValueWei: 7000n,
          serverTime: loopbackTime,
          destinationAddress: SENDER_ADDRESS,
        }),
      )
      expect(chats.chats[SENDER_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(chats.chats[SENDER_ADDRESS]?.totalValue).toBe(7000)
      expect(desktopNotify).not.toHaveBeenCalled()
      expect(mockMessageStore.saveMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          index: 'self-digest',
          outbound: true,
          copartyAddress: SENDER_ADDRESS,
          message: expect.objectContaining({
            outbound: true,
            stampValueWei: 7000n,
            destinationAddress: SENDER_ADDRESS,
          }),
        }),
        { advanceCursor: false },
      )
      const persisted = mockMessageStore.saveMessage.mock.calls.at(
        -1,
      )?.[0] as MessageWrapper
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield persisted
        })(),
      )
      const restored = await rehydateChat({
        activeChatAddr: SENDER_ADDRESS,
        chats: {
          [SENDER_ADDRESS]: chats.chats[SENDER_ADDRESS]!,
        },
        messages: {},
        lastReceived: loopbackTime,
      })
      expect(conversationFor(restored, SENDER_ADDRESS)?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'self-digest',
          outbound: true,
          stampValueWei: 7000n,
        }),
      ])
      expect(conversationFor(restored, SENDER_ADDRESS)?.totalValue).toBe(7000)
    })

    it('serializes an overlapping relay save with send completion and reloads one relay-authored record', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      contacts.addContact({
        address: SENDER_ADDRESS,
        contact: {
          profile: { name: 'Alice', bio: '', avatar: '', pubKey: null },
        },
      })
      let finishSend:
        | ((result: {
            payloadDigest: string
            stampValueWei: bigint
            stampPayments: Array<{
              txHash: string
              destinationAddress: string
              valueWei: bigint
            }>
            preparationTxHashes: string[]
          }) => void)
        | undefined
      let attemptRecorded: Promise<void> | undefined
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async options => {
          attemptRecorded = options.onAttemptCreated?.('race-digest')
          await attemptRecorded
          return new Promise(resolve => {
            finishSend = resolve
          })
        })

      const sending = chats.sendMessage({
        wallet,
        address: SENDER_ADDRESS,
        items: [{ type: 'text', text: 'racing note' }],
        stampValue: 9000n,
      })
      while (!attemptRecorded) await Promise.resolve()
      await attemptRecorded
      const pendingIndex = Object.keys(chats.messages).find(key =>
        key.startsWith('pending:'),
      )
      expect(pendingIndex).toBeDefined()
      if (!pendingIndex) throw new Error('pending message was not recorded')

      const loopbackTime = Date.now() + 2000
      let relaySaveStartedResolve: (() => void) | undefined
      const relaySaveStarted = new Promise<void>(resolve => {
        relaySaveStartedResolve = resolve
      })
      let releaseRelaySave: (() => void) | undefined
      const relaySaveGate = new Promise<void>(resolve => {
        releaseRelaySave = resolve
      })
      mockMessageStore.saveMessage.mockImplementation(async wrapper => {
        if (
          wrapper.index === 'race-digest' &&
          wrapper.message.serverTime === loopbackTime
        ) {
          relaySaveStartedResolve?.()
          await relaySaveGate
        }
      })
      mockMessageStore.deleteMessage.mockRejectedValue(
        new Error('simulated crash before stale-pending cleanup'),
      )
      const warning = jest.spyOn(console, 'warn').mockImplementation()
      const receiving = chats.receiveMessages([
        {
          outbound: false,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: SENDER_ADDRESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'race-digest',
          stampValue: 9000,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'racing note' }],
            serverTime: loopbackTime,
            receivedTime: loopbackTime,
            outpoints: [],
            stampValueWei: 9000n,
            stampPayments: [
              {
                txHash: '0xrace',
                destinationAddress: SENDER_ADDRESS,
                valueWei: 9000n,
              },
            ],
            senderAddress: SENDER_ADDRESS,
            destinationAddress: SENDER_ADDRESS,
          },
        },
      ])
      await relaySaveStarted

      finishSend?.({
        payloadDigest: 'race-digest',
        stampValueWei: 9000n,
        stampPayments: [
          {
            txHash: '0xrace',
            destinationAddress: SENDER_ADDRESS,
            valueWei: 9000n,
          },
        ],
        preparationTxHashes: [],
      })
      let sendSettled = false
      void sending.then(() => {
        sendSettled = true
      })
      await Promise.resolve()
      expect(sendSettled).toBe(false)
      releaseRelaySave?.()
      await Promise.all([receiving, sending])

      const chat = chats.chats[SENDER_ADDRESS]
      expect(chat?.messages).toHaveLength(1)
      expect(chat?.messages[0]).toEqual(
        expect.objectContaining({
          payloadDigest: 'race-digest',
          outbound: true,
          status: 'confirmed',
          stampValueWei: 9000n,
        }),
      )
      expect(chats.messages[pendingIndex]).toBeUndefined()
      expect(chats.messages['race-digest']).toBe(chat?.messages[0])
      expect(chat?.totalUnreadMessages).toBe(0)
      expect(chat?.totalUnreadValue).toBe(0)
      expect(chat?.totalValue).toBe(9000)
      expect(desktopNotify).not.toHaveBeenCalled()
      expect(mockMessageStore.deleteMessage).toHaveBeenCalledWith(pendingIndex)

      const pending = mockMessageStore.saveMessage.mock.calls.find(
        ([wrapper]) =>
          wrapper.index === pendingIndex &&
          wrapper.message.delivery?.attemptDigest === 'race-digest',
      )?.[0] as MessageWrapper
      expect(pending).toBeDefined()
      const persisted = mockMessageStore.saveMessage.mock.calls.find(
        ([wrapper]) =>
          wrapper.index === 'race-digest' &&
          wrapper.message.serverTime === loopbackTime,
      )?.[0] as MessageWrapper
      expect(
        mockMessageStore.saveMessage.mock.calls.filter(
          ([wrapper]) => wrapper.index === 'race-digest',
        ),
      ).toHaveLength(1)
      if (!chat) throw new Error('self chat was not retained')
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield pending
          yield persisted
        })(),
      )
      const restored = await rehydateChat({
        activeChatAddr: SENDER_ADDRESS,
        chats: { [SENDER_ADDRESS]: chat },
        messages: {},
        lastReceived: loopbackTime,
      })
      expect(conversationFor(restored, SENDER_ADDRESS)?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'race-digest',
          outbound: true,
          stampValueWei: 9000n,
        }),
      ])
      expect(
        conversationFor(restored, SENDER_ADDRESS)?.totalUnreadMessages,
      ).toBe(0)
      expect(conversationFor(restored, SENDER_ADDRESS)?.totalUnreadValue).toBe(
        0,
      )
      expect(conversationFor(restored, SENDER_ADDRESS)?.totalValue).toBe(9000)
      expect(restored.messages['race-digest']).toBe(
        conversationFor(restored, SENDER_ADDRESS)?.messages[0],
      )
      expect(restored.messages[pendingIndex]).toBeUndefined()
      mockMessageStore.deleteMessage.mockResolvedValue(undefined)
      await Promise.resolve()
      warning.mockRestore()
    })

    it('reaccounts and resorts a rehydrated old-account digest collision as inbound', async () => {
      const chats = useChatStore()
      chats.openDirectConversation(RECIPIENT_ADDRESS)
      chats.openDirectConversation(THIRD_ADDRESS)
      const contacts = useContactStore()
      mockOwnAddress.mockResolvedValue(RECIPIENT_ADDRESS)
      contacts.addContact({
        address: SENDER_ADDRESS,
        contact: {
          profile: { name: 'Old account', bio: '', avatar: '', pubKey: null },
        },
      })
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* (): AsyncGenerator<MessageWrapper> {
          for (const [index, copartyAddress, stampValueWei] of [
            ['shared-digest', RECIPIENT_ADDRESS, 111n],
            ['other-digest', THIRD_ADDRESS, 150n],
          ] as const) {
            yield {
              index,
              outbound: true,
              senderAddress: SENDER_ADDRESS,
              copartyAddress,
              message: {
                conversationId: chats.chats[copartyAddress]!.id,
                outbound: true,
                status: 'confirmed',
                items: [{ type: 'text', text: index }],
                serverTime: Number(stampValueWei),
                receivedTime: Number(stampValueWei),
                outpoints: [],
                stampValueWei,
                senderAddress: SENDER_ADDRESS,
              },
            }
          }
        })(),
      )
      chats.$patch(await rehydateChat(chats.$state))
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(111)
      expect(chats.getSortedChatOrder.map(chat => chat?.address)).toEqual([
        THIRD_ADDRESS,
        RECIPIENT_ADDRESS,
      ])

      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: SENDER_ADDRESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'shared-digest',
          stampValue: 222,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'from old account' }],
            serverTime: 222,
            receivedTime: 222,
            outpoints: [],
            stampValueWei: 222n,
            senderAddress: SENDER_ADDRESS,
            destinationAddress: RECIPIENT_ADDRESS,
          },
        },
      ])

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(0)
      expect(chats.chats[SENDER_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'shared-digest',
          outbound: false,
          senderAddress: SENDER_ADDRESS,
        }),
      ])
      expect(chats.chats[SENDER_ADDRESS]?.totalUnreadMessages).toBe(1)
      expect(chats.chats[SENDER_ADDRESS]?.totalUnreadValue).toBe(222)
      expect(chats.chats[SENDER_ADDRESS]?.totalValue).toBe(222)
      expect(
        Object.values(chats.chats).reduce(
          (sum, chat) => sum + (chat?.totalValue ?? 0),
          0,
        ),
      ).toBe(372)
      expect(chats.getSortedChatOrder.map(chat => chat?.address)).toEqual([
        SENDER_ADDRESS,
        THIRD_ADDRESS,
        RECIPIENT_ADDRESS,
      ])
      expect(mockMessageStore.saveMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          index: 'shared-digest',
          outbound: false,
          copartyAddress: SENDER_ADDRESS,
        }),
        { advanceCursor: false },
      )
    })

    it('matches the current outbox route canonically without inbound accounting', async () => {
      const chats = useChatStore()
      seedConversation(chats, RECIPIENT_ADDRESS, {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      })
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        senderAddress: SENDER_ADDRESS,
        index: 'outbox-replay',
        items: [{ type: 'text', text: 'already sent' }],
        outpoints: [],
        stampValueWei: 333n,
        status: 'confirmed',
        previousHash: null,
      })

      await chats.receiveMessages([
        {
          outbound: true,
          senderAddress: SENDER_ADDRESS.toLowerCase(),
          copartyAddress: RECIPIENT_ADDRESS.toLowerCase(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'outbox-replay',
          stampValue: 333,
          message: {
            outbound: true,
            status: 'confirmed',
            items: [{ type: 'text', text: 'already sent' }],
            serverTime: 333,
            receivedTime: 333,
            outpoints: [],
            stampValueWei: 333n,
            senderAddress: SENDER_ADDRESS,
            destinationAddress: RECIPIENT_ADDRESS,
          },
        },
      ])

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'outbox-replay',
          outbound: true,
          serverTime: 333,
        }),
      ])
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadValue).toBe(0)
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(333)
    })

    it('reattributes an old-account attempt match and removes its stale pending key', async () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      mockOwnAddress.mockResolvedValue(RECIPIENT_ADDRESS)
      contacts.addContact({
        address: SENDER_ADDRESS,
        contact: {
          profile: { name: 'Old account', bio: '', avatar: '', pubKey: null },
        },
      })
      seedConversation(chats, RECIPIENT_ADDRESS, {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      })
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        senderAddress: SENDER_ADDRESS,
        index: 'pending:old-attempt',
        items: [{ type: 'text', text: 'old draft' }],
        outpoints: [],
        stampValueWei: 111n,
        status: 'payment-pending',
        previousHash: null,
        delivery: { attemptDigest: 'delivered-old-attempt' },
      })

      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: SENDER_ADDRESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'delivered-old-attempt',
          stampValue: 222,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'old draft' }],
            serverTime: 222,
            receivedTime: 222,
            outpoints: [],
            stampValueWei: 222n,
            senderAddress: SENDER_ADDRESS,
            destinationAddress: RECIPIENT_ADDRESS,
          },
        },
      ])

      expect(chats.messages['pending:old-attempt']).toBeUndefined()
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
      expect(chats.chats[SENDER_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'delivered-old-attempt',
          outbound: false,
        }),
      ])
      expect(mockMessageStore.deleteMessage).toHaveBeenCalledWith(
        'pending:old-attempt',
      )
      expect(chats.chats[SENDER_ADDRESS]?.totalValue).toBe(222)
      const confirmed = mockMessageStore.saveMessage.mock.calls.find(
        ([wrapper]) => wrapper.index === 'delivered-old-attempt',
      )?.[0] as MessageWrapper
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield {
            index: 'pending:old-attempt',
            outbound: true,
            senderAddress: SENDER_ADDRESS,
            copartyAddress: RECIPIENT_ADDRESS,
            message: {
              conversationId: chats.chats[RECIPIENT_ADDRESS]!.id,
              outbound: true,
              status: 'payment-pending',
              receivedTime: 1,
              serverTime: 1,
              items: [{ type: 'text', text: 'old draft' }],
              outpoints: [],
              stampValueWei: 111n,
              senderAddress: SENDER_ADDRESS,
              delivery: { attemptDigest: 'delivered-old-attempt' },
            },
          }
          yield confirmed
        })(),
      )
      const restored = await rehydateChat({
        activeChatAddr: null,
        chats: {},
        messages: {},
        lastReceived: 0,
      })
      expect(restored.messages['pending:old-attempt']).toBeUndefined()
      expect(conversationFor(restored, SENDER_ADDRESS)?.messages).toHaveLength(
        1,
      )
    })

    it.each(['discard', 'clear'] as const)(
      'serializes %s after a deferred loopback save without resurrection',
      async operation => {
        const chats = useChatStore()
        const contacts = useContactStore()
        contacts.addContact({
          address: SENDER_ADDRESS,
          contact: {
            profile: { name: 'Alice', bio: '', avatar: '', pubKey: null },
          },
        })
        seedConversation(chats, SENDER_ADDRESS, {
          address: SENDER_ADDRESS,
          messages: [],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: 0,
          lastRead: 0,
          stampAmount: 1,
        })
        chats.sendMessageLocal({
          address: SENDER_ADDRESS,
          senderAddress: SENDER_ADDRESS,
          index: 'pending:discard-race',
          items: [{ type: 'text', text: 'discard me' }],
          outpoints: [],
          stampValueWei: 9n,
          status: 'pending',
          previousHash: null,
          delivery: { attemptDigest: 'discard-race-digest' },
        })
        let saveStarted: (() => void) | undefined
        const started = new Promise<void>(resolve => {
          saveStarted = resolve
        })
        let releaseSave: (() => void) | undefined
        const saveGate = new Promise<void>(resolve => {
          releaseSave = resolve
        })
        mockMessageStore.saveMessage.mockImplementation(async wrapper => {
          if (wrapper.index === 'discard-race-digest') {
            saveStarted?.()
            await saveGate
          }
        })
        const receiving = chats.receiveMessages([
          {
            outbound: false,
            senderAddress: SENDER_ADDRESS,
            copartyAddress: SENDER_ADDRESS,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            copartyPubKey: {} as any,
            index: 'discard-race-digest',
            stampValue: 9,
            message: {
              outbound: false,
              status: 'confirmed',
              items: [{ type: 'text', text: 'discard me' }],
              serverTime: 9,
              receivedTime: 9,
              outpoints: [],
              stampValueWei: 9n,
              senderAddress: SENDER_ADDRESS,
            },
          },
        ])
        await started
        const deleting =
          operation === 'discard'
            ? chats.deleteMessage({
                address: SENDER_ADDRESS,
                payloadDigest: 'pending:discard-race',
              })
            : chats.clearChat(SENDER_ADDRESS)
        releaseSave?.()
        await Promise.all([receiving, deleting])

        expect(chats.chats[SENDER_ADDRESS]?.messages).toHaveLength(0)
        expect(chats.messages['pending:discard-race']).toBeUndefined()
        expect(chats.messages['discard-race-digest']).toBeUndefined()
        expect(mockMessageStore.suppressAndDelete).toHaveBeenCalledWith(
          SENDER_ADDRESS,
          expect.arrayContaining(
            operation === 'discard'
              ? ['pending:discard-race', 'discard-race-digest']
              : ['discard-race-digest'],
          ),
          expect.arrayContaining([
            expect.objectContaining({
              payloadDigest: 'discard-race-digest',
            }),
          ]),
        )
      },
    )

    it.each(['discard', 'clear'] as const)(
      'keeps %s authoritative when a started loopback is waiting for identity',
      async operation => {
        const chats = useChatStore()
        seedConversation(chats, SENDER_ADDRESS, {
          address: SENDER_ADDRESS,
          messages: [],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: 0,
          lastRead: 0,
          stampAmount: 1,
        })
        chats.sendMessageLocal({
          address: SENDER_ADDRESS,
          senderAddress: SENDER_ADDRESS,
          index: 'pending:identity-race',
          items: [{ type: 'text', text: 'discard before identity' }],
          outpoints: [],
          stampValueWei: 9n,
          status: 'pending',
          previousHash: null,
          delivery: { attemptDigest: 'identity-race-digest' },
        })
        const durableSuppressions = new Set<string>()
        mockMessageStore.suppressAndDelete.mockImplementation(
          async (_address, _digests, suppressions) => {
            for (const suppression of suppressions) {
              durableSuppressions.add(suppression.payloadDigest)
            }
          },
        )
        mockMessageStore.suppressedRelayReceipts.mockImplementation(
          async (_address, receipts) =>
            new Set(
              receipts
                .filter(receipt =>
                  durableSuppressions.has(receipt.payloadDigest),
                )
                .map(receipt => receipt.payloadDigest),
            ),
        )
        let releaseIdentity: (() => void) | undefined
        mockOwnAddress.mockReturnValueOnce(
          new Promise(resolve => {
            releaseIdentity = () => resolve(SENDER_ADDRESS)
          }),
        )
        const receiving = chats.receiveMessages([
          {
            outbound: false,
            senderAddress: SENDER_ADDRESS,
            copartyAddress: SENDER_ADDRESS,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            copartyPubKey: {} as any,
            index: 'identity-race-digest',
            stampValue: 9,
            message: {
              outbound: false,
              status: 'confirmed',
              items: [{ type: 'text', text: 'discard before identity' }],
              serverTime: 9,
              receivedTime: 9,
              outpoints: [],
              stampValueWei: 9n,
              senderAddress: SENDER_ADDRESS,
            },
          },
        ])

        await (operation === 'discard'
          ? chats.deleteMessage({
              address: SENDER_ADDRESS,
              payloadDigest: 'pending:identity-race',
            })
          : chats.clearChat(SENDER_ADDRESS))
        releaseIdentity?.()
        await receiving

        expect(chats.chats[SENDER_ADDRESS]?.messages).toHaveLength(0)
        expect(chats.messages['identity-race-digest']).toBeUndefined()
        expect(mockMessageStore.saveMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ index: 'identity-race-digest' }),
          expect.anything(),
        )
      },
    )

    it('does not hold delivery confirmation behind a stalled profile refresh', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      let releaseRefresh: (() => void) | undefined
      const refresh = jest.spyOn(useContactStore(), 'refresh').mockReturnValue(
        new Promise(resolve => {
          releaseRefresh = () => resolve(undefined)
        }) as never,
      )
      const receiving = chats.receiveMessages([
        {
          outbound: false,
          senderAddress: THIRD_ADDRESS,
          copartyAddress: THIRD_ADDRESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          copartyPubKey: {} as any,
          index: 'unknown-contact',
          stampValue: 1,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'hello' }],
            serverTime: 1,
            receivedTime: 1,
            outpoints: [],
            stampValueWei: 1n,
            senderAddress: THIRD_ADDRESS,
          },
        },
      ])
      while (!refresh.mock.calls.length) await Promise.resolve()

      seedConversation(chats, RECIPIENT_ADDRESS, {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      })
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        senderAddress: wallet.identity.displayAddress,
        index: 'pending:while-profile-stalls',
        items: [{ type: 'text', text: 'outbound' }],
        outpoints: [],
        stampValueWei: 7n,
        status: 'pending',
        previousHash: null,
      })
      await chats.confirmOutgoing({
        address: RECIPIENT_ADDRESS,
        id: 'pending:while-profile-stalls',
        payloadDigest: 'confirmed-while-profile-stalls',
        stampValueWei: 7n,
      })
      expect(chats.messages['confirmed-while-profile-stalls']).toBeDefined()

      releaseRefresh?.()
      await receiving
    })

    it('shows one pending message immediately and reconciles it after the send completes', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      let resolveSend:
        | ((result: {
            payloadDigest: string
            stampValueWei: bigint
            preparationTxHashes: string[]
          }) => void)
        | undefined
      jest.spyOn(activeChain.directMessages, 'send').mockReturnValue(
        new Promise(resolve => {
          resolveSend = resolve
        }),
      )

      const sending = chats.sendMessage({
        wallet,
        address: RECIPIENT_ADDRESS,
        items: [{ type: 'text', text: 'optimistic hello' }],
        stampValue: 123n,
      })

      const pending = chats.chats[RECIPIENT_ADDRESS]?.messages
      expect(pending).toHaveLength(1)
      expect(pending?.[0]).toEqual(
        expect.objectContaining({
          status: 'pending',
          items: [{ type: 'text', text: 'optimistic hello' }],
          stampValueWei: 123n,
        }),
      )

      resolveSend?.({
        payloadDigest: 'confirmed-digest',
        stampValueWei: 123n,
        preparationTxHashes: [],
      })
      await sending

      const confirmed = chats.chats[RECIPIENT_ADDRESS]?.messages
      expect(confirmed).toHaveLength(1)
      expect(confirmed?.[0]).toEqual(
        expect.objectContaining({
          payloadDigest: 'confirmed-digest',
          status: 'confirmed',
          items: [{ type: 'text', text: 'optimistic hello' }],
        }),
      )
      expect(
        Object.keys(chats.messages).filter(key => key.startsWith('pending:')),
      ).toEqual([])
    })

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

      const outcome = await chats.sendMessage({
        wallet,
        address: RECIPIENT_ADDRESS,
        items: [{ type: 'text', text: 'hello' }],
        onPreparationProgress,
      })

      expect(outcome).toEqual({ state: 'sent', payloadDigest: 'deadbeef' })
      expect(sendSpy).toHaveBeenCalledWith({
        wallet,
        recipient: { raw: RECIPIENT_ADDRESS },
        conversationId: expect.any(String),
        items: [{ type: 'text', text: 'hello' }],
        onPreparationProgress,
        onAttemptCreated: expect.any(Function),
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

    it('keeps a failed send in the conversation, marked failed, instead of throwing (#269)', async () => {
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
      ).resolves.toEqual({ state: 'failed', reason: 'error' })

      const messages = chats.chats[RECIPIENT_ADDRESS]?.messages ?? []
      expect(messages).toHaveLength(1)
      expect(messages[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          items: [{ type: 'text', text: 'hi' }],
        }),
      )
      // The failed message and its text are stored durably (the full reload proof is in
      // chats.outgoing.jest.test.ts).
      expect(mockMessageStore.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          outbound: true,
          message: expect.objectContaining({ status: 'error' }),
        }),
        { advanceCursor: false },
      )
    })

    it('classifies stamp preparation insufficient funds without exposing wallet detail', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(
          new Error(
            'Insufficient main account balance to prepare stamp accounts: secret technical totals',
          ),
        )

      await expect(
        chats.sendMessage({
          wallet,
          address: RECIPIENT_ADDRESS,
          items: [{ type: 'text', text: 'cannot afford this yet' }],
        }),
      ).resolves.toEqual({
        state: 'failed',
        reason: 'insufficient-funds',
      })
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages[0]?.delivery).toEqual(
        expect.objectContaining({
          failureReason: 'insufficient-funds',
          detail: expect.stringContaining('secret technical totals'),
        }),
      )
    })

    it('reports recipient-unregistered when recipient has no directory entry', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(
          new CanonicalRecipientNotPublishedError(RECIPIENT_ADDRESS),
        )

      await expect(
        chats.sendMessage({
          wallet,
          address: RECIPIENT_ADDRESS,
          items: [{ type: 'text', text: 'hello unregistered user' }],
        }),
      ).resolves.toEqual({
        state: 'failed',
        reason: 'recipient-unregistered',
      })
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages[0]?.delivery).toEqual(
        expect.objectContaining({
          failureReason: 'recipient-unregistered',
        }),
      )
    })

    it('classifies CanonicalMessagingHoldError as actionable interrupted error and logs to console', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      const consoleErrorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      const holdError = new CanonicalMessagingHoldError(
        'An earlier payment could not be finished yet.',
      )
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(holdError)

      await expect(
        chats.sendMessage({
          wallet,
          address: RECIPIENT_ADDRESS,
          items: [{ type: 'text', text: 'held message' }],
        }),
      ).resolves.toEqual({
        state: 'failed',
        reason: 'error',
      })
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages[0]?.delivery).toEqual(
        expect.objectContaining({
          failureReason: 'error',
        }),
      )
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[sendDirectMessage error]:',
        holdError,
      )
      consoleErrorSpy.mockRestore()
    })

    it('does not make a delivered message look retryable when local persistence fails', async () => {
      const chats = useChatStore()
      const wallet = makeWallet(SENDER_ADDRESS)
      jest.spyOn(activeChain.directMessages, 'send').mockResolvedValue({
        payloadDigest: 'delivered-digest',
        stampValueWei: 321n,
        preparationTxHashes: [],
      })
      mockMessageStore.saveMessage.mockImplementation(async wrapper => {
        // Only the confirmed record's write fails; the earlier pending writes are best effort.
        if (wrapper.index === 'delivered-digest') {
          throw new Error('local storage unavailable')
        }
      })

      await expect(
        chats.sendMessage({
          wallet,
          address: RECIPIENT_ADDRESS,
          items: [{ type: 'text', text: 'already delivered' }],
          stampValue: 321n,
        }),
      ).rejects.toThrow('local storage unavailable')

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'delivered-digest',
          status: 'confirmed',
        }),
      ])
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
            conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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

    expect(conversationFor(restored, RECIPIENT_ADDRESS)?.messages).toHaveLength(
      2,
    )
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
        { advanceCursor: false },
      )
    })

    it('refreshes the active balance when an incoming message with a confirmed stamp arrives', async () => {
      const chats = useChatStore()
      mockBalanceRefresh.mockClear()
      await chats.receiveMessages([
        makeWrapper({ index: 'stamp-refresh-test' }),
      ])
      expect(mockBalanceRefresh).toHaveBeenCalled()
    })

    it('returns durable suppressions to the delivery caller without recreating the row', async () => {
      const chats = useChatStore()
      const wrapper = makeWrapper({ index: 'discarded-receipt' })
      mockMessageStore.suppressedRelayReceipts.mockResolvedValueOnce(
        new Set(['discarded-receipt']),
      )

      await expect(
        chats.receiveMessages([wrapper], SENDER_ADDRESS),
      ).resolves.toEqual({
        suppressedReceipts: [
          {
            payloadDigest: 'discarded-receipt',
            receivedTime: wrapper.message.receivedTime,
          },
        ],
        cancelled: false,
      })
      expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      expect(chats.messages['discarded-receipt']).toBeUndefined()
      expect(desktopNotify).not.toHaveBeenCalled()
    })

    it('rehydrates a new chat with lastRead zero as unread just like live insertion', async () => {
      const chats = useChatStore()
      useContactStore().addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      await chats.receiveMessages([makeWrapper()])
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(1)

      const persisted = mockMessageStore.saveMessage.mock.calls.at(-1)?.[0]
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield persisted
        })(),
      )
      const restored = await rehydateChat({
        activeChatAddr: null,
        chats: {
          [RECIPIENT_ADDRESS]: {
            ...chats.chats[RECIPIENT_ADDRESS]!,
            messages: [],
            lastRead: 0,
          },
        },
        messages: {},
        lastReceived: 0,
      })
      expect(
        conversationFor(restored, RECIPIENT_ADDRESS)?.totalUnreadMessages,
      ).toBe(1)
      expect(
        conversationFor(restored, RECIPIENT_ADDRESS)?.totalUnreadValue,
      ).toBe(5000)
    })

    it('persists an active-chat receipt as read across navigation and reload', async () => {
      const chats = useChatStore()
      useContactStore().addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      chats.setActiveChat(RECIPIENT_ADDRESS)
      const wrapper = makeWrapper()

      await chats.receiveMessages([wrapper])
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(chats.chats[RECIPIENT_ADDRESS]?.lastRead).toBe(
        wrapper.message.serverTime,
      )
      chats.setActiveChat(THIRD_ADDRESS)

      const persisted = mockMessageStore.saveMessage.mock.calls.at(-1)?.[0]
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield persisted
        })(),
      )
      const restored = await rehydateChat(chats.$state)

      expect(
        conversationFor(restored, RECIPIENT_ADDRESS)?.totalUnreadMessages,
      ).toBe(0)
      expect(
        conversationFor(restored, RECIPIENT_ADDRESS)?.totalUnreadValue,
      ).toBe(0)
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

    function notifyingContact() {
      useContactStore().addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          notify: true,
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      jest.spyOn(document, 'hasFocus').mockReturnValue(false)
    }

    it('notifies once when two overlapping polls deliver the same message from an unknown contact (#412)', async () => {
      const chats = useChatStore()
      jest.spyOn(document, 'hasFocus').mockReturnValue(false)
      // Loading an unknown contact awaits, which is the window between the "already have it?"
      // check and the message being stored.
      jest
        .spyOn(useContactStore(), 'refresh')
        .mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 5)),
        )
      const wrapper = makeWrapper()

      await Promise.all([
        chats.receiveMessages([wrapper]),
        chats.receiveMessages([{ ...wrapper }]),
      ])

      expect(desktopNotify).toHaveBeenCalledTimes(1)
    })

    it('notifies once when two overlapping polls deliver the same message from a known contact (#412)', async () => {
      const chats = useChatStore()
      notifyingContact()
      const wrapper = makeWrapper()

      await Promise.all([
        chats.receiveMessages([wrapper]),
        chats.receiveMessages([{ ...wrapper }]),
      ])

      expect(desktopNotify).toHaveBeenCalledTimes(1)
    })

    it('tags the notification with the message index so the browser collapses repeats (#412)', async () => {
      const chats = useChatStore()
      notifyingContact()

      await chats.receiveMessages([makeWrapper({ index: 'digest-tag' })])

      expect(desktopNotify).toHaveBeenCalledWith(
        'Bob',
        'hi there',
        '',
        expect.any(Function),
        'digest-tag',
      )
    })

    it('stores a message once when two overlapping polls deliver it (#412)', async () => {
      const chats = useChatStore()
      jest.spyOn(document, 'hasFocus').mockReturnValue(false)
      jest
        .spyOn(useContactStore(), 'refresh')
        .mockImplementation(
          () => new Promise(resolve => setTimeout(resolve, 5)),
        )
      const wrapper = makeWrapper()

      await Promise.all([
        chats.receiveMessages([wrapper]),
        chats.receiveMessages([{ ...wrapper }]),
      ])

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(1)
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(1)
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(5000)
    })

    it('still notifies different messages that overlap (#412)', async () => {
      const chats = useChatStore()
      notifyingContact()

      await Promise.all([
        chats.receiveMessages([makeWrapper({ index: 'digest-a' })]),
        chats.receiveMessages([makeWrapper({ index: 'digest-b' })]),
      ])

      expect(desktopNotify).toHaveBeenCalledTimes(2)
    })

    it('does not let an overlapping poll store a message whose claimer failed, so a retry can still notify (#412)', async () => {
      const chats = useChatStore()
      notifyingContact()
      mockMessageStore.saveMessage
        .mockRejectedValueOnce(new Error('disk'))
        .mockResolvedValue(undefined)
      const wrapper = makeWrapper()

      await Promise.allSettled([
        chats.receiveMessages([wrapper]),
        chats.receiveMessages([{ ...wrapper }]),
      ])

      expect(chats.chats[RECIPIENT_ADDRESS]?.messages ?? []).toHaveLength(0)
      expect(desktopNotify).not.toHaveBeenCalled()

      await chats.receiveMessages([wrapper])
      expect(desktopNotify).toHaveBeenCalledTimes(1)
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(1)
    })

    it('lets a retry notify when the first attempt failed before storing (#412)', async () => {
      const chats = useChatStore()
      notifyingContact()
      mockMessageStore.saveMessage.mockRejectedValueOnce(new Error('disk'))
      const wrapper = makeWrapper()

      await expect(chats.receiveMessages([wrapper])).rejects.toThrow('disk')
      await chats.receiveMessages([wrapper])

      expect(desktopNotify).toHaveBeenCalledTimes(1)
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(1)
    })
  })

  it('deletes an ordinary non-self outbound without an impossible sender-mailbox tombstone', async () => {
    const chats = useChatStore()
    seedConversation(chats, RECIPIENT_ADDRESS, {
      address: RECIPIENT_ADDRESS,
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    })
    chats.sendMessageLocal({
      address: RECIPIENT_ADDRESS,
      senderAddress: SENDER_ADDRESS,
      index: 'delete-me',
      items: [{ type: 'text', text: 'temporary' }],
      outpoints: [],
      stampValueWei: 10n,
      status: 'confirmed',
      previousHash: null,
    })
    expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(10)

    await chats.deleteMessage({
      address: RECIPIENT_ADDRESS,
      payloadDigest: 'delete-me',
    })

    expect(mockMessageStore.suppressAndDelete).not.toHaveBeenCalled()
    expect(mockMessageStore.deleteMessage).toHaveBeenCalledWith('delete-me')
    expect(chats.messages['delete-me']).toBeUndefined()
    expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
    expect(chats.chats[RECIPIENT_ADDRESS]?.totalValue).toBe(0)
  })

  it('deletes message from a conversation keyed by UUID in chats.conversations', async () => {
    const chats = useChatStore()
    const convId = '33333333-3333-4333-8333-000000000001'
    chats.conversations[convId] = {
      id: convId,
      address: RECIPIENT_ADDRESS,
      kind: 'direct',
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    } as any
    chats.sendMessageLocal({
      address: RECIPIENT_ADDRESS,
      senderAddress: SENDER_ADDRESS,
      index: 'conv-delete-me',
      items: [{ type: 'text', text: 'delete me from conv' }],
      outpoints: [],
      stampValueWei: 10n,
      status: 'confirmed',
      previousHash: null,
      conversationId: convId,
    })
    expect(chats.conversations[convId]?.messages).toHaveLength(1)

    await chats.deleteMessage({
      address: RECIPIENT_ADDRESS,
      payloadDigest: 'conv-delete-me',
    })

    expect(chats.messages['conv-delete-me']).toBeUndefined()
    expect(chats.conversations[convId]?.messages).toHaveLength(0)
  })

  it('keeps durable receipt suppression for an outbound self-route', async () => {
    const chats = useChatStore()
    seedConversation(chats, SENDER_ADDRESS, {
      address: SENDER_ADDRESS,
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    })
    chats.sendMessageLocal({
      address: SENDER_ADDRESS,
      senderAddress: SENDER_ADDRESS,
      index: 'delete-self',
      items: [{ type: 'text', text: 'temporary loopback' }],
      outpoints: [],
      stampValueWei: 10n,
      status: 'confirmed',
      previousHash: null,
    })

    await chats.deleteMessage({
      address: SENDER_ADDRESS,
      payloadDigest: 'delete-self',
    })

    expect(mockMessageStore.suppressAndDelete).toHaveBeenCalledWith(
      SENDER_ADDRESS,
      ['delete-self'],
      [{ payloadDigest: 'delete-self', receivedTime: expect.any(Number) }],
    )
    expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
  })

  it('clears ordinary outbound history without growing sender-mailbox suppression', async () => {
    const chats = useChatStore()
    seedConversation(chats, RECIPIENT_ADDRESS, {
      address: RECIPIENT_ADDRESS,
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    })
    for (const digest of ['clear-one', 'clear-two']) {
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        senderAddress: SENDER_ADDRESS,
        index: digest,
        items: [{ type: 'text', text: digest }],
        outpoints: [],
        stampValueWei: 10n,
        status: 'confirmed',
        previousHash: null,
      })
    }

    await chats.clearChat(RECIPIENT_ADDRESS)

    expect(mockMessageStore.suppressAndDelete).not.toHaveBeenCalled()
    expect(mockMessageStore.deleteMessage.mock.calls).toEqual([
      ['clear-one'],
      ['clear-two'],
    ])
    expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
  })

  describe('readAll (ticket #368)', () => {
    it('opening a chat that has no messages yet is not an error-level console event', () => {
      const chats = useChatStore()
      const errorSpy = jest.spyOn(console, 'error').mockImplementation()
      jest.spyOn(console, 'debug').mockImplementation()

      chats.readAll(RECIPIENT_ADDRESS)

      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('ticket #1237: sole conversation owner', () => {
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'

    function incoming(
      conversationId: string,
      index: string,
      time: number,
    ): ReceivedMessageWrapper {
      return {
        conversationId,
        outbound: false,
        senderAddress: RECIPIENT_ADDRESS,
        copartyAddress: RECIPIENT_ADDRESS,
        copartyPubKey: { toBuffer: () => new Uint8Array(33) },
        index,
        stampValue: 0,
        message: {
          conversationId,
          outbound: false,
          status: 'confirmed',
          senderAddress: RECIPIENT_ADDRESS,
          destinationAddress: SENDER_ADDRESS,
          items: [{ type: 'text', text: index }],
          serverTime: time,
          receivedTime: time,
          outpoints: [],
        },
      }
    }

    function independentPair() {
      const chats = useChatStore()
      const create = (conversationId: string) =>
        chats.createConversation({
          participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
          address: RECIPIENT_ADDRESS,
          conversationId,
          name: 'Equal subject',
        })
      return { chats, first: create(firstId), second: create(secondId) }
    }

    it('renames only the exact owner metadata and refuses empty or unknown subjects', async () => {
      const { chats, first, second } = independentPair()
      const defaultThread = chats.openDirectConversation(RECIPIENT_ADDRESS)
      await chats.receiveMessages([incoming(first.id, 'rename-receipt', 100)])
      const before = JSON.parse(JSON.stringify(chats.$state))
      const now = jest.spyOn(Date, 'now').mockReturnValue(123456789)
      try {
        chats.renameConversation(first.id, '  Updated subject  ')
        expect(first.name).toBe('Updated subject')
        expect(first.updatedAt).toBe(123456789)
        const after = JSON.parse(JSON.stringify(chats.$state))
        after.conversations[first.id].name = before.conversations[first.id].name
        after.conversations[first.id].updatedAt =
          before.conversations[first.id].updatedAt
        expect(after).toEqual(before)
        chats.renameConversation(first.id, second.name!)
        expect(first.name).toBe(second.name)
        expect(chats.chats[RECIPIENT_ADDRESS].id).toBe(defaultThread.id)
        const unchanged = JSON.stringify(chats.$state)
        for (const id of ['missing-id', '__proto__', 'constructor']) {
          expect(() => chats.renameConversation(id, 'Subject')).toThrow(
            /conversation/i,
          )
        }
        expect(() => chats.renameConversation(first.id, '  ')).toThrow(
          /subject/i,
        )
        expect(JSON.stringify(chats.$state)).toBe(unchanged)
      } finally {
        now.mockRestore()
      }
    })

    it('persists only the conversation metadata owner and reconstructs its default index on reopen', async () => {
      let persistence: {
        save(
          storage: { put: jest.Mock },
          mutation: unknown,
          state: unknown,
        ): Promise<void>
      }
      const pinia = createPinia()
      pinia.use(({ options, store }) => {
        if (store.$id === 'chats')
          persistence = options.storage as typeof persistence
      })
      createApp({}).use(pinia)
      setActivePinia(pinia)
      const chats = useChatStore()
      const defaultThread = chats.openDirectConversation(RECIPIENT_ADDRESS)
      const independent = chats.createConversation({
        address: RECIPIENT_ADDRESS,
        participants: [RECIPIENT_ADDRESS],
        name: 'Equal',
      })
      defaultThread.name = 'Equal'
      independent.deletedAt = 50
      chats.activeConversationId = defaultThread.id
      const put = jest.fn(async () => undefined)
      await persistence!.save({ put }, {}, chats.$state)
      const raw = JSON.parse(put.mock.calls[0][1])
      expect(raw.chats).toBeUndefined()
      expect(raw.activeChatAddr).toBeUndefined()
      expect(raw.logicalMessages).toBeUndefined()
      expect(Object.keys(raw.conversations).sort()).toEqual(
        [defaultThread.id, independent.id].sort(),
      )
      mockMessageStore.getIterator.mockResolvedValueOnce([])
      const restored = await rehydrateState(raw)
      setActivePinia(createPinia())
      const reopened = useChatStore()
      reopened.$patch(restored)
      expect(reopened.chats[RECIPIENT_ADDRESS]?.id).toBe(defaultThread.id)
      expect(reopened.conversations[independent.id].deletedAt).toBe(50)
      expect(reopened.conversations[independent.id].name).toBe('Equal')
      expect(reopened.activeConversationId).toBe(defaultThread.id)
    })

    it('keeps same-peer subjects, listing, unread and ID activation independent', async () => {
      const { chats, first, second } = independentPair()
      await chats.receiveMessages([
        incoming(first.id, 'first-owned', 100),
        incoming(second.id, 'second-owned', 200),
      ])
      expect(chats.getSortedChatOrder.map(c => c.id).sort()).toEqual([
        firstId,
        secondId,
      ])
      first.name = 'Renamed subject'
      chats.setActiveConversation(first.id)
      expect(first.totalUnreadMessages).toBe(0)
      expect(second.totalUnreadMessages).toBe(1)
      expect(second.name).toBe('Equal subject')
      expect(first.messages.map(m => m.payloadDigest)).toEqual(['first-owned'])
      expect(second.messages.map(m => m.payloadDigest)).toEqual([
        'second-owned',
      ])
    })

    it('rebuilds membership from persisted conversation IDs without peer reparenting', async () => {
      const { chats, first, second } = independentPair()
      const wrappers = [
        incoming(first.id, 'first-restored', 100),
        incoming(second.id, 'second-restored', 200),
      ]
      first.name = 'Renamed subject'
      first.lastRead = 100
      for (let reload = 0; reload < 2; reload += 1) {
        mockMessageStore.getIterator.mockResolvedValueOnce(
          (async function* () {
            for (const wrapper of wrappers) yield wrapper
          })(),
        )
        const restored = await rehydrateState(chats.$state)
        expect(Object.keys(restored.conversations).sort()).toEqual([
          firstId,
          secondId,
        ])
        expect(
          restored.conversations[firstId].messages.map(m => m.payloadDigest),
        ).toEqual(['first-restored'])
        expect(
          restored.conversations[secondId].messages.map(m => m.payloadDigest),
        ).toEqual(['second-restored'])
        expect(restored.conversations[firstId].totalUnreadMessages).toBe(0)
        expect(restored.conversations[secondId].totalUnreadMessages).toBe(1)
        expect(restored.logicalMessages['first-restored']?.conversationId).toBe(
          firstId,
        )
        expect(
          restored.logicalMessages['second-restored']?.conversationId,
        ).toBe(secondId)
        chats.$patch(restored)
      }
    })

    it('deletes only the addressed same-peer conversation', async () => {
      const { chats, first, second } = independentPair()
      await chats.receiveMessages([
        incoming(first.id, 'first-delete', 100),
        incoming(second.id, 'second-keep', 200),
      ])
      await chats.deleteConversation(first.id, 300)
      expect(first.messages).toHaveLength(0)
      expect(first.deletedAt).toBe(300)
      expect(second.messages.map(m => m.payloadDigest)).toEqual(['second-keep'])
      expect(second.deletedAt).toBeUndefined()
      expect(chats.messages['second-keep']).toBeDefined()
    })

    it.each([false, true])(
      'rejects conflicting logical owners within one batch before any persistence (existing conversations: %s)',
      async existingConversations => {
        const chats = existingConversations
          ? independentPair().chats
          : useChatStore()
        const before = JSON.stringify(chats.$state)
        const first = incoming(firstId, 'batch-first', 100)
        const second = incoming(secondId, 'batch-second', 200)
        first.message.logicalMessageId = 'shared-logical-id'
        second.message.logicalMessageId = 'shared-logical-id'
        await expect(chats.receiveMessages([first, second])).rejects.toThrow(
          /Logical message.*another conversation/,
        )
        expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
        expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
        expect(JSON.stringify(chats.$state)).toBe(before)

        // Rejection must release receipt claims and leave a valid later batch usable.
        second.message.logicalMessageId = 'second-logical-id'
        await chats.receiveMessages([first, second])
        expect(mockMessageStore.saveMessage).toHaveBeenCalledTimes(2)
        const rows = mockMessageStore.saveMessage.mock.calls.map(([row]) => row)
        mockMessageStore.getIterator.mockResolvedValueOnce(rows)
        const reopened = await rehydrateState(chats.$state)
        expect(reopened.conversations[firstId].messages).toHaveLength(1)
        expect(reopened.conversations[secondId].messages).toHaveLength(1)
        expect(
          reopened.logicalMessages['shared-logical-id']?.conversationId,
        ).toBe(firstId)
        expect(
          reopened.logicalMessages['second-logical-id']?.conversationId,
        ).toBe(secondId)
      },
    )

    it('accepts same-conversation logical revisions in a single batch and on replay', async () => {
      const chats = useChatStore()
      const first = incoming(firstId, 'revision-first', 100)
      const second = incoming(firstId, 'revision-second', 200)
      first.message.logicalMessageId = 'shared-logical-id'
      second.message.logicalMessageId = 'shared-logical-id'
      await chats.receiveMessages([first, second])
      await chats.receiveMessages([first, second])
      expect(chats.conversations[firstId].messages).toHaveLength(2)
      expect(
        chats.logicalMessages['shared-logical-id']?.revisions,
      ).toHaveLength(2)
    })

    describe('who sent each message', () => {
      // A message is filed under the conversation ID it carries. Whoever sent it, the stored
      // message names that sender; it is never taken to be from the conversation's peer.
      const fromThird = (index: string, time: number, stampValueWei = 0n) => {
        const wrapper = incoming(firstId, index, time)
        wrapper.senderAddress = THIRD_ADDRESS
        wrapper.copartyAddress = THIRD_ADDRESS
        wrapper.copartyPubKey = {
          toBuffer: () => new Uint8Array(33).fill(7),
        } as never
        wrapper.message.senderAddress = THIRD_ADDRESS
        wrapper.message.stampValueWei = stampValueWei
        return wrapper
      }
      const withPeer = () => {
        const chats = useChatStore()
        const conversation = chats.createConversation({
          participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
          address: RECIPIENT_ADDRESS,
          conversationId: firstId,
        })
        return { chats, conversation }
      }

      it("two people: a received message is its sender's, and nobody joins", async () => {
        const { chats, conversation } = withPeer()
        await chats.receiveMessages([incoming(firstId, 'from-peer', 100)])
        expect(conversation.messages).toHaveLength(1)
        expect(conversation.messages[0].outbound).toBe(false)
        expect(conversation.messages[0].senderAddress).toBe(RECIPIENT_ADDRESS)
        expect(conversation.participants).toEqual(
          [SENDER_ADDRESS, RECIPIENT_ADDRESS].sort(),
        )
        expect(chats.getLatestMessage(firstId)?.senderAddress).toBe(
          RECIPIENT_ADDRESS,
        )
      })

      it('a third person who sends with the conversation ID lands in it as themselves and becomes a participant', async () => {
        const { chats, conversation } = withPeer()
        await chats.receiveMessages([
          incoming(firstId, 'from-peer', 100),
          fromThird('from-third', 200),
        ])
        expect(conversation.messages.map(m => m.payloadDigest)).toEqual([
          'from-peer',
          'from-third',
        ])
        expect(conversation.messages.map(m => m.senderAddress)).toEqual([
          RECIPIENT_ADDRESS,
          THIRD_ADDRESS,
        ])
        // Still the conversation it was: same ID, same peer for what we send.
        expect(conversation.id).toBe(firstId)
        expect(conversation.address).toBe(RECIPIENT_ADDRESS)
        expect(conversation.participants).toEqual(
          [SENDER_ADDRESS, RECIPIENT_ADDRESS, THIRD_ADDRESS].sort(),
        )
        expect(conversation.members?.[THIRD_ADDRESS]).toMatchObject({
          address: THIRD_ADDRESS,
          pubKeyHex: '07'.repeat(33),
        })
        expect(chats.getLatestMessage(firstId)?.senderAddress).toBe(
          THIRD_ADDRESS,
        )
        // Posting into someone else's conversation does not make them a contact.
        expect(useContactStore().isContact(THIRD_ADDRESS)).toBe(false)
        expect(useContactStore().isContact(RECIPIENT_ADDRESS)).toBe(true)

        // The same after a reload from what was saved.
        const rows = mockMessageStore.saveMessage.mock.calls.map(([row]) => row)
        mockMessageStore.getIterator.mockResolvedValueOnce(rows)
        const reopened = await rehydrateState(chats.$state)
        expect(
          reopened.conversations[firstId].messages.map(m => m.senderAddress),
        ).toEqual([RECIPIENT_ADDRESS, THIRD_ADDRESS])
        expect(reopened.conversations[firstId].participants).toEqual(
          [SENDER_ADDRESS, RECIPIENT_ADDRESS, THIRD_ADDRESS].sort(),
        )
        expect(reopened.conversations[firstId].address).toBe(RECIPIENT_ADDRESS)
      })

      it('a reload files a saved third-person message even when the participant list was not saved', async () => {
        const { chats } = withPeer()
        // The conversation as it was saved before the third person wrote.
        const before = {
          ...chats.$state,
          conversations: {
            [firstId]: {
              ...chats.conversations[firstId],
              participants: [...chats.conversations[firstId].participants],
              members: { ...chats.conversations[firstId].members },
              messages: [],
            },
          },
        }
        await chats.receiveMessages([fromThird('from-third', 200)])
        const rows = mockMessageStore.saveMessage.mock.calls.map(([row]) => row)
        mockMessageStore.getIterator.mockResolvedValueOnce(rows)
        const reopened = await rehydrateState(before)
        expect(reopened.conversations[firstId].messages).toHaveLength(1)
        expect(reopened.conversations[firstId].participants).toContain(
          THIRD_ADDRESS,
        )
      })

      it("our own message read back from the mailbox is ours, not the peer's and not a new participant", async () => {
        const { chats, conversation } = withPeer()
        const own = incoming(firstId, 'own-copy', 100)
        own.outbound = true
        own.senderAddress = SENDER_ADDRESS
        own.message.outbound = true
        own.message.senderAddress = SENDER_ADDRESS
        await chats.receiveMessages([own])
        expect(conversation.messages).toHaveLength(1)
        expect(conversation.messages[0].outbound).toBe(true)
        expect(conversation.messages[0].senderAddress).toBe(SENDER_ADDRESS)
        expect(conversation.participants).toEqual(
          [SENDER_ADDRESS, RECIPIENT_ADDRESS].sort(),
        )
        expect(conversation.totalUnreadMessages).toBe(0)
      })

      it('still refuses our own message into a conversation with a different peer', async () => {
        const chats = useChatStore()
        const foreign = chats.createConversation({
          participants: [SENDER_ADDRESS, THIRD_ADDRESS],
          address: THIRD_ADDRESS,
          conversationId: firstId,
        })
        const own = incoming(firstId, 'own-misfiled', 100)
        own.outbound = true
        own.senderAddress = SENDER_ADDRESS
        own.message.outbound = true
        own.message.senderAddress = SENDER_ADDRESS
        await expect(chats.receiveMessages([own])).rejects.toThrow(
          /conversation.*(peer|recipient|participant)/i,
        )
        expect(foreign.messages).toHaveLength(0)
        expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      })

      it('what a third person paid does not move the price suggested for the peer', async () => {
        const { chats } = withPeer()
        const before = chats.getPeerStampSuggestion(firstId)
        await chats.receiveMessages([fromThird('rich-third', 200, 10n ** 18n)])
        expect(chats.getPeerStampSuggestion(firstId)).toBe(before)
        expect(chats.getPeerStampMetrics(firstId)).toEqual(
          chats.getPeerStampMetrics(secondId),
        )
      })
    })
  })

  describe('#1237: explicit durable conversation format', () => {
    const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    function row(
      index: string,
      items: MessageWrapper['message']['items'],
      conversationId?: string,
    ): MessageWrapper {
      return {
        index,
        outbound: true,
        senderAddress: SENDER_ADDRESS,
        copartyAddress: RECIPIENT_ADDRESS,
        message: {
          outbound: true,
          senderAddress: SENDER_ADDRESS,
          status: 'confirmed',
          receivedTime: 100,
          serverTime: 100,
          outpoints: [],
          items,
          ...(conversationId === undefined ? {} : { conversationId }),
        },
      }
    }

    describe.each([false, true])(
      'outbound durable twins (reversed: %s)',
      reversed => {
        function twins(logicalPending?: string, logicalConfirmed?: string) {
          const pending = row(
            'local-storage-key',
            [{ type: 'text', text: 'paid' }],
            ownerId,
          )
          pending.message.status = 'pending'
          pending.message.logicalMessageId = logicalPending
          pending.message.delivery = { attemptDigest: 'confirmed-digest' }
          const confirmed = row(
            'confirmed-digest',
            [{ type: 'text', text: 'paid' }],
            ownerId,
          )
          confirmed.message.logicalMessageId = logicalConfirmed
          // Equivalent address spellings must not evade association validation.
          confirmed.senderAddress = SENDER_ADDRESS.toLowerCase()
          confirmed.message.senderAddress = SENDER_ADDRESS.toLowerCase()
          confirmed.copartyAddress = RECIPIENT_ADDRESS.toLowerCase()
          return { pending, confirmed }
        }

        it.each(['conversation', 'logical message'])(
          'rejects conflicting %s ownership before any row normalization',
          async conflict => {
            // Omit both logical IDs for a conversation conflict so only the attempt's
            // conversation-owner check can reject it, not either logical-owner check.
            const { pending, confirmed } =
              conflict === 'conversation'
                ? twins()
                : twins('logical-pending', 'logical-confirmed')
            if (conflict === 'conversation') {
              confirmed.message.conversationId =
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            }
            const interrupted = row(
              'earlier-pending',
              [{ type: 'text', text: 'queued' }],
              ownerId,
            )
            interrupted.message.status = 'pending'
            const pair = reversed ? [confirmed, pending] : [pending, confirmed]
            const rows = [interrupted, ...pair]
            const before = JSON.stringify(rows)
            const metadata = { conversations: {}, lastReceived: 0 }
            const chats = useChatStore()
            const stateBefore = JSON.stringify(chats.$state)
            mockMessageStore.getIterator.mockResolvedValue(rows)
            for (let attempt = 0; attempt < 2; attempt++) {
              await expect(rehydrateState(metadata)).rejects.toThrow(
                /stored.*attempt.*ownership/i,
              )
              expect(JSON.stringify(rows)).toBe(before)
              expect(metadata).toEqual({ conversations: {}, lastReceived: 0 })
              expect(JSON.stringify(chats.$state)).toBe(stateBefore)
              expect(
                mockMessageStore.mostRecentMessageTime,
              ).not.toHaveBeenCalled()
              expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
              expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
            }
          },
        )

        it.each([
          ['logical-message', 'logical-message'],
          [undefined, 'logical-message'],
          ['logical-message', undefined],
          [undefined, undefined],
        ])(
          'retains same-owner twins with logical IDs %s / %s',
          async (pendingId, confirmedId) => {
            const { pending, confirmed } = twins(pendingId, confirmedId)
            const rows = reversed ? [confirmed, pending] : [pending, confirmed]
            const before = JSON.stringify(rows)
            mockMessageStore.getIterator.mockResolvedValue(rows)
            const restored = await rehydrateState({
              conversations: {},
              lastReceived: 0,
            })
            expect(Object.keys(restored.messages)).toEqual(['confirmed-digest'])
            expect(
              restored.conversations[ownerId].messages.map(
                message => message.payloadDigest,
              ),
            ).toEqual(['confirmed-digest'])
            expect(JSON.stringify(rows)).toBe(before)
            expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
            expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
          },
        )
      },
    )

    it.each([
      ['missing', undefined, [{ type: 'text', text: 'old ownerless row' }]],
      ['empty', '', [{ type: 'text', text: 'old ownerless row' }]],
      ['malformed', 'not-an-id', [{ type: 'text', text: 'old ownerless row' }]],
      [
        'mixed',
        undefined,
        [{ type: 'wallet-sync' }, { type: 'text', text: 'visible' }],
      ],
      ['unknown', undefined, [{ type: 'future-internal-type' }]],
      ['empty items', undefined, []],
    ])(
      'rejects %s ownership before normalization, pruning or metadata mutation',
      async (_case, id, items) => {
        const pending = row(
          'local-pending',
          [{ type: 'text', text: 'funded' }],
          ownerId,
        )
        pending.message.status = 'pending'
        pending.message.delivery = { attemptDigest: 'confirmed-digest' }
        const confirmed = row(
          'confirmed-digest',
          [{ type: 'text', text: 'funded' }],
          ownerId,
        )
        const invalid = row(
          'unsupported-row',
          items as MessageWrapper['message']['items'],
          id as string | undefined,
        )
        const rows = [pending, confirmed, invalid]
        const before = JSON.stringify(rows)
        const metadata = { conversations: {}, lastReceived: 0 }
        mockMessageStore.getIterator.mockResolvedValue(rows)
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(rehydrateState(metadata)).rejects.toThrow(
            /stored.*conversation|conversation.*format/i,
          )
          expect(JSON.stringify(rows)).toBe(before)
          expect(metadata).toEqual({ conversations: {}, lastReceived: 0 })
          expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
          expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
        }
      },
    )

    describe.each([false, true])(
      'complete durable envelope (internal: %s)',
      internal => {
        it.each([
          ['missing body', 'wrapper', 'message', undefined],
          ['array body', 'wrapper', 'message', []],
          ['scalar body', 'wrapper', 'message', 'invalid'],
          ['missing status', 'message', 'status', undefined],
          ['empty status', 'message', 'status', ''],
          ['missing received time', 'message', 'receivedTime', undefined],
          ['non-numeric received time', 'message', 'receivedTime', '100'],
          ['missing server time', 'message', 'serverTime', undefined],
          ['non-finite server time', 'message', 'serverTime', NaN],
          ['missing items', 'message', 'items', undefined],
          ['non-array items', 'message', 'items', {}],
          ['missing outpoints', 'message', 'outpoints', undefined],
          ['non-array outpoints', 'message', 'outpoints', {}],
          ['missing coparty', 'wrapper', 'copartyAddress', undefined],
          ['empty coparty', 'wrapper', 'copartyAddress', ''],
        ])(
          'rejects %s before any earlier row mutation',
          async (_label, target, field, value) => {
            const interrupted = row(
              'interrupted',
              [{ type: 'text', text: 'pending' }],
              ownerId,
            )
            interrupted.message.status = 'pending'
            const leftover = row(
              'leftover',
              [{ type: 'text', text: 'paid' }],
              ownerId,
            )
            leftover.message.status = 'pending'
            leftover.message.delivery = { attemptDigest: 'confirmed-digest' }
            const confirmed = row(
              'confirmed-digest',
              [{ type: 'text', text: 'paid' }],
              ownerId,
            )
            const malformed = row(
              'malformed-last',
              (internal
                ? [{ type: 'wallet-sync' }]
                : [
                    { type: 'text', text: 'visible' },
                  ]) as MessageWrapper['message']['items'],
              ownerId,
            )
            Object.assign(
              target === 'message' ? malformed.message : malformed,
              { [field as string]: value },
            )
            const rows = [interrupted, leftover, confirmed, malformed]
            const before = JSON.stringify(rows)
            const metadata = { conversations: {}, lastReceived: 0 }
            mockMessageStore.getIterator.mockResolvedValue(rows)
            const failure = await rehydrateState(metadata).then(
              () => null,
              error => error as Error,
            )
            expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
            expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
            expect(interrupted.message.status).toBe('pending')
            expect(failure).toMatchObject({
              message: expect.stringMatching(/stored message envelope/),
            })
            expect(JSON.stringify(rows)).toBe(before)
            expect(metadata).toEqual({ conversations: {}, lastReceived: 0 })
          },
        )
      },
    )

    it('preserves pure internal rows under the message owner without chat or logical indexes', async () => {
      const internal = row('internal-record', [
        { type: 'wallet-sync' },
        { type: 'payment-transfer' },
        { type: 'swap-record' },
      ] as MessageWrapper['message']['items'])
      const before = JSON.stringify(internal)
      mockMessageStore.getIterator.mockResolvedValue([internal])
      const restored = await rehydrateState({
        conversations: {},
        lastReceived: 0,
      })
      expect(restored.conversations).toEqual({})
      expect(restored.logicalMessages).toEqual({})
      expect(restored.messages[internal.index]).toEqual({
        payloadDigest: internal.index,
        ...internal.message,
      })
      expect(JSON.stringify(internal)).toBe(before)
      expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
    })

    it.each([false, true])(
      'persists the actual self row and reopens it (internal: %s)',
      async internal => {
        const chats = useChatStore()
        const items = internal
          ? [{ type: 'wallet-sync' }]
          : [{ type: 'text', text: 'saved note' }]
        const id = await chats.selfSendMessage({
          items: items as MessageWrapper['message']['items'],
        })
        const persisted = mockMessageStore.saveMessage.mock.calls.at(
          -1,
        )[0] as MessageWrapper
        expect(persisted).toMatchObject({
          index: id,
          outbound: true,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: SENDER_ADDRESS,
          message: { logicalMessageId: id, destinationAddress: SENDER_ADDRESS },
        })
        expect(persisted.message.conversationId).toBe(
          chats.messages[id]?.conversationId,
        )
        mockMessageStore.getIterator.mockResolvedValue([persisted])
        const reopened = await rehydrateState(chats.$state)
        expect(reopened.messages[id]?.logicalMessageId).toBe(id)
        if (internal) {
          expect(chats.conversations).toEqual({})
          expect(reopened.conversations).toEqual({})
          expect(reopened.logicalMessages).toEqual({})
        } else {
          const owner = chats.messages[id]!.conversationId!
          expect(owner).toBeTruthy()
          expect(reopened.conversations[owner].messages[0].payloadDigest).toBe(
            id,
          )
        }
      },
    )

    it('does not invent a self-note owner when canonical identity is unavailable', async () => {
      mockOwnAddress.mockResolvedValue(null)
      const chats = useChatStore()
      await expect(
        chats.selfSendMessage({ items: [{ type: 'text', text: 'note' }] }),
      ).rejects.toThrow(/canonical self/i)
      expect(chats.conversations).toEqual({})
      expect(chats.messages).toEqual({})
      expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
    })

    it.each([
      'direction',
      'sender',
      'index',
      'malformed owner',
      'foreign owner',
    ])(
      'does not let pure internal content hide %s corruption',
      async corruption => {
        const chats = useChatStore()
        chats.createConversation({
          conversationId: ownerId,
          participants: [THIRD_ADDRESS],
          address: THIRD_ADDRESS,
        })
        const internal = row('internal-record', [
          { type: 'wallet-sync' },
        ] as MessageWrapper['message']['items'])
        if (corruption === 'direction') internal.outbound = false
        if (corruption === 'sender') internal.senderAddress = THIRD_ADDRESS
        if (corruption === 'index') internal.index = ''
        if (corruption === 'malformed owner')
          internal.message.conversationId = 'invalid'
        if (corruption === 'foreign owner')
          internal.message.conversationId = ownerId
        mockMessageStore.getIterator.mockResolvedValue([internal])
        await expect(rehydrateState(chats.$state)).rejects.toThrow()
        expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
        expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      },
    )

    it('checks an internal explicit owner against later conversational rows before publishing', async () => {
      const internal = row(
        'internal-first',
        [{ type: 'wallet-sync' }] as MessageWrapper['message']['items'],
        ownerId,
      )
      const visible = row(
        'visible-later',
        [{ type: 'text', text: 'other peer' }],
        ownerId,
      )
      visible.copartyAddress = THIRD_ADDRESS
      mockMessageStore.getIterator.mockResolvedValue([internal, visible])
      await expect(
        rehydrateState({ conversations: {}, lastReceived: 0 }),
      ).rejects.toThrow(/recipient/)
      expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
    })

    it('preflights owner affinity and logical ownership before pruning a valid earlier row', async () => {
      const chats = useChatStore()
      chats.createConversation({
        conversationId: ownerId,
        address: RECIPIENT_ADDRESS,
        participants: [RECIPIENT_ADDRESS],
      })
      const other = chats.createConversation({
        address: THIRD_ADDRESS,
        participants: [THIRD_ADDRESS],
      })
      const pending = row(
        'local-pending',
        [{ type: 'text', text: 'funded' }],
        ownerId,
      )
      pending.message.status = 'pending'
      pending.message.delivery = { attemptDigest: 'confirmed-digest' }
      const confirmed = row(
        'confirmed-digest',
        [{ type: 'text', text: 'funded' }],
        ownerId,
      )
      confirmed.message.logicalMessageId = 'same-logical'
      const conflict = row(
        'other-message',
        [{ type: 'text', text: 'different owner' }],
        other.id,
      )
      for (const mode of ['affinity', 'logical']) {
        if (mode === 'logical') {
          conflict.copartyAddress = THIRD_ADDRESS
          conflict.message.logicalMessageId = 'same-logical'
        }
        mockMessageStore.getIterator.mockResolvedValue([
          pending,
          confirmed,
          conflict,
        ])
        await expect(rehydrateState(chats.$state)).rejects.toThrow()
        expect(pending.message.status).toBe('pending')
        expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
      }
    })
  })

  describe('ticket #1237: distinct recipient ownership', () => {
    it('keeps addressless pairs separate in the list and unread total', () => {
      const chats = useChatStore()
      const first = chats.createConversation({
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
      })
      const second = chats.createConversation({
        participants: [SENDER_ADDRESS, THIRD_ADDRESS],
      })
      first.totalUnreadMessages = 1
      second.totalUnreadMessages = 2

      expect(
        chats.getSortedChatOrder.map(conversation => conversation.id).sort(),
      ).toEqual([first.id, second.id].sort())
      expect(chats.totalUnread).toBe(3)
    })

    it.each(['null', 'throws', 'known'] as const)(
      'keeps addressless pairs owned through repeated hydration when own address is %s',
      async mode => {
        const chats = useChatStore()
        const first = chats.createConversation({
          participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        })
        const second = chats.createConversation({
          participants: [SENDER_ADDRESS, THIRD_ADDRESS],
        })
        for (const [conversation, senderAddress, digest] of [
          [first, RECIPIENT_ADDRESS, 'first-addressless'],
          [second, THIRD_ADDRESS, 'second-addressless'],
        ] as const) {
          conversation.messages.push({
            payloadDigest: digest,
            conversationId: conversation.id,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: digest }],
            serverTime: 100,
            receivedTime: 100,
            outpoints: [],
            senderAddress,
          })
        }
        if (mode === 'null') mockOwnAddress.mockResolvedValue(null)
        if (mode === 'throws') {
          mockOwnAddress.mockRejectedValue(new Error('identity unavailable'))
        }

        const durableRows = [first, second].flatMap(conv =>
          conv.messages.map(message => ({
            index: message.payloadDigest,
            copartyAddress: message.senderAddress,
            senderAddress: message.senderAddress,
            outbound: message.outbound,
            message,
          })),
        )
        for (let reload = 0; reload < 2; reload += 1) {
          mockMessageStore.getIterator.mockResolvedValueOnce(durableRows)
          const restored = await rehydrateState(chats.$state)
          expect(Object.keys(restored.conversations).sort()).toEqual(
            [first.id, second.id].sort(),
          )
          expect(conversationFor(restored, SENDER_ADDRESS)).toBeUndefined()
          for (const [id, digest] of [
            [first.id, 'first-addressless'],
            [second.id, 'second-addressless'],
          ]) {
            const conversation = restored.conversations[id]
            expect(conversation.address).toBe(id)
            expect(conversation.messages).toHaveLength(1)
            expect(conversation.messages[0]).toMatchObject({
              payloadDigest: digest,
              conversationId: id,
            })
            expect(conversation.totalUnreadMessages).toBe(1)
          }
          chats.$patch(restored)
        }
      },
    )

    it.each([true, false])(
      'does not reuse overlapping participant sets (explicit recipient: %s)',
      explicitRecipient => {
        const chats = useChatStore()
        const first = chats.createConversation({
          participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
          address: explicitRecipient ? RECIPIENT_ADDRESS : undefined,
        })
        const second = chats.createConversation({
          participants: [SENDER_ADDRESS, THIRD_ADDRESS],
          address: explicitRecipient ? THIRD_ADDRESS : undefined,
        })

        expect(second.id).not.toBe(first.id)
        expect(first.participants).toEqual(
          [SENDER_ADDRESS, RECIPIENT_ADDRESS].sort(),
        )
        expect(second.participants).toEqual(
          [SENDER_ADDRESS, THIRD_ADDRESS].sort(),
        )
      },
    )

    it('keeps addressless pairs addressable by ID without guessing a recipient alias', () => {
      const chats = useChatStore()
      jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
      const conversation = chats.createConversation({
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'explicit-thread',
      })
      chats.createConversation({
        participants: [RECIPIENT_ADDRESS, SENDER_ADDRESS],
        topic: 'explicit-thread',
      })
      chats.setActiveConversation(conversation.id)
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        conversationId: conversation.id,
        senderAddress: SENDER_ADDRESS,
        index: 'id-routed',
        items: [{ type: 'text', text: 'known conversation' }],
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
        timestamp: 100,
      })

      expect(conversation.address).toBe(conversation.id)
      expect(chats.chats[SENDER_ADDRESS]).toBeUndefined()
      expect(chats.chats[RECIPIENT_ADDRESS]).toBeUndefined()
      expect(chats.activeConversationId).toBe(conversation.id)
      expect(chats.messages['id-routed'].conversationId).toBe(conversation.id)
      expect(
        conversation.messages.map(message => message.payloadDigest),
      ).toEqual(['id-routed'])
    })

    it('reuses a recipient placeholder without publishing a self alias or redirecting self messages', () => {
      const chats = useChatStore()
      const placeholder = chats.openDirectConversation(RECIPIENT_ADDRESS)
      for (let activation = 0; activation < 2; activation += 1) {
        expect(
          chats.openDirectConversation(RECIPIENT_ADDRESS_LOWERCASE, [
            SENDER_ADDRESS,
            RECIPIENT_ADDRESS_LOWERCASE,
          ]).id,
        ).toBe(placeholder.id)
      }

      chats.sendMessageLocal({
        address: SENDER_ADDRESS,
        senderAddress: SENDER_ADDRESS,
        index: 'self-only',
        items: [{ type: 'text', text: 'self message' }],
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
        timestamp: 100,
      })

      expect(chats.chats[SENDER_ADDRESS]).toBeUndefined()
      expect(placeholder.messages).toHaveLength(0)
      expect(chats.messages['self-only']).toBeUndefined()
      expect(chats.chats[RECIPIENT_ADDRESS]?.id).toBe(placeholder.id)
    })

    it.each(['setActiveChat', 'setActiveConversation'] as const)(
      '%s on self cannot activate or rename a remote conversation',
      activate => {
        const chats = useChatStore()
        jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
        const remote = chats.openDirectConversation(RECIPIENT_ADDRESS, [
          SENDER_ADDRESS,
          RECIPIENT_ADDRESS,
        ])
        chats.sendMessageLocal({
          address: RECIPIENT_ADDRESS,
          senderAddress: SENDER_ADDRESS,
          index: 'remote-only',
          items: [{ type: 'text', text: 'remote message' }],
          outpoints: [],
          status: 'confirmed',
          previousHash: null,
          timestamp: 100,
        })

        for (let activation = 0; activation < 2; activation += 1) {
          chats[activate](SENDER_ADDRESS)
          expect(chats.activeConversationId).not.toBe(remote.id)
          expect(remote.address).toBe(RECIPIENT_ADDRESS)
          expect(remote.messages.map(message => message.payloadDigest)).toEqual(
            ['remote-only'],
          )
          chats[activate](RECIPIENT_ADDRESS)
          expect(chats.activeConversationId).toBe(remote.id)
        }
      },
    )

    it('retains recipient ownership, unread state, tombstones and pending delivery links through repeated hydration', async () => {
      const chats = useChatStore()
      const first = chats.createConversation({
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        address: RECIPIENT_ADDRESS,
      })
      const second = chats.createConversation({
        participants: [SENDER_ADDRESS, THIRD_ADDRESS],
        address: THIRD_ADDRESS,
      })
      first.deletedAt = 50
      const wrappers: MessageWrapper[] = [
        {
          index: 'first-incoming',
          outbound: false,
          senderAddress: RECIPIENT_ADDRESS,
          copartyAddress: RECIPIENT_ADDRESS,
          message: {
            conversationId: first.id,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'first history' }],
            serverTime: 40,
            receivedTime: 40,
            outpoints: [],
            senderAddress: RECIPIENT_ADDRESS,
          },
        },
        {
          index: 'second-pending',
          outbound: true,
          senderAddress: SENDER_ADDRESS,
          copartyAddress: THIRD_ADDRESS,
          message: {
            conversationId: second.id,
            outbound: true,
            status: 'pending',
            items: [{ type: 'text', text: 'second pending' }],
            serverTime: 60,
            receivedTime: 60,
            outpoints: [],
            senderAddress: SENDER_ADDRESS,
            delivery: { attemptDigest: 'second-attempt' },
          },
        },
      ]
      let state: RestorableState = {
        ...chats.$state,
        // An old participant alias is a derived lookup, not a self conversation.
        chats: { ...chats.chats, [SENDER_ADDRESS]: first },
      }
      for (let reload = 0; reload < 2; reload += 1) {
        mockMessageStore.getIterator.mockResolvedValueOnce(
          (async function* () {
            for (const wrapper of wrappers) yield wrapper
          })(),
        )
        const restored = await rehydrateState(state)
        expect(Object.keys(restored.conversations)).toHaveLength(2)
        expect(conversationFor(restored, SENDER_ADDRESS)).toBeUndefined()
        expect(
          restored.conversations[first.id].messages.map(m => m.payloadDigest),
        ).toEqual(['first-incoming'])
        expect(restored.conversations[first.id].totalUnreadMessages).toBe(1)
        expect(restored.conversations[first.id].deletedAt).toBe(50)
        expect(
          restored.conversations[second.id].messages.map(m => m.payloadDigest),
        ).toEqual(['second-pending'])
        expect(restored.conversations[second.id].totalUnreadMessages).toBe(0)
        expect(restored.conversations[second.id].deletedAt).toBeUndefined()
        expect(restored.messages['second-pending'].status).toBe(
          'payment-pending',
        )
        expect(
          restored.messages['second-pending'].delivery?.attemptDigest,
        ).toBe('second-attempt')
        expect(restored.logicalMessages['first-incoming'].conversationId).toBe(
          first.id,
        )
        expect(restored.logicalMessages['second-pending'].conversationId).toBe(
          second.id,
        )
        state = restored
      }
    })
  })

  describe('ticket #69: conversation-oriented and group-ready storage', () => {
    it('generates deterministic RFC 4122 UUIDv5 identifiers for conversations', () => {
      const uuidv5Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

      // Standard direct conversation without topic
      const id1 = makeConversationId([SENDER_ADDRESS, RECIPIENT_ADDRESS])
      const id2 = makeConversationId([RECIPIENT_ADDRESS, SENDER_ADDRESS])
      expect(id1).toMatch(uuidv5Regex)
      expect(id1).toBe(id2)

      // Direct conversation with topic
      const topicId = makeConversationId(
        [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        'project-x',
      )
      expect(topicId).toMatch(uuidv5Regex)
      expect(topicId).not.toBe(id1)

      // Third party with same topic produces a different UUIDv5
      const thirdPartyId = makeConversationId(
        [THIRD_ADDRESS, RECIPIENT_ADDRESS],
        'project-x',
      )
      expect(thirdPartyId).toMatch(uuidv5Regex)
      expect(thirdPartyId).not.toBe(topicId)
    })

    it('proves two direct conversations with one peer stay separate without address-key collision', async () => {
      const chats = useChatStore()
      const convAlpha = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'topic-alpha',
        name: 'Project Alpha',
      })
      const convBeta = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'topic-beta',
        name: 'Project Beta',
      })

      expect(convAlpha.id).not.toBe(convBeta.id)
      expect(convAlpha.name).toBe('Project Alpha')
      expect(convBeta.name).toBe('Project Beta')

      // Send a message in Alpha
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        conversationId: convAlpha.id,
        senderAddress: SENDER_ADDRESS,
        index: 'msg-alpha-1',
        items: [{ type: 'text', text: 'Hello in Alpha' }],
        outpoints: [],
        stampValueWei: 10n,
        status: 'confirmed',
        previousHash: null,
        timestamp: 100,
      })

      // Send a message in Beta
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        conversationId: convBeta.id,
        senderAddress: SENDER_ADDRESS,
        index: 'msg-beta-1',
        items: [{ type: 'text', text: 'Hello in Beta' }],
        outpoints: [],
        stampValueWei: 10n,
        status: 'confirmed',
        previousHash: null,
        timestamp: 110,
      })

      expect(chats.conversations[convAlpha.id]?.messages).toHaveLength(1)
      expect(chats.conversations[convAlpha.id]?.messages[0].payloadDigest).toBe(
        'msg-alpha-1',
      )
      expect(chats.conversations[convBeta.id]?.messages).toHaveLength(1)
      expect(chats.conversations[convBeta.id]?.messages[0].payloadDigest).toBe(
        'msg-beta-1',
      )

      // Query conversations for the recipient address returns both
      const recipientConvs = chats.getConversationsForAddress(RECIPIENT_ADDRESS)
      expect(recipientConvs.map(c => c.id)).toContain(convAlpha.id)
      expect(recipientConvs.map(c => c.id)).toContain(convBeta.id)
    })

    it('proves a synthetic multi-member group conversation coexists with direct chats without address collisions', async () => {
      const chats = useChatStore()
      // Direct chat with Bob (RECIPIENT_ADDRESS)
      const directBob = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        address: RECIPIENT_ADDRESS,
      })
      // Direct chat with Carol (THIRD_ADDRESS)
      const directCarol = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, THIRD_ADDRESS],
        address: THIRD_ADDRESS,
      })
      // Group chat with Alice, Bob, Carol
      const groupConv = chats.createConversation({
        kind: 'group',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS, THIRD_ADDRESS],
        name: 'Team Frank',
        initialRole: 'member',
        conversationId: '4d3fd7ea-0618-5dff-ae44-03c33ae8d0c0',
      })

      expect(groupConv.kind).toBe('group')
      expect(groupConv.participants).toHaveLength(3)
      expect(groupConv.members?.[SENDER_ADDRESS]?.role).toBe('member')

      // Post to group
      chats.sendMessageLocal({
        address: groupConv.address,
        conversationId: groupConv.id,
        senderAddress: SENDER_ADDRESS,
        index: 'group-msg-1',
        items: [{ type: 'text', text: 'Welcome team!' }],
        outpoints: [],
        stampValueWei: 10n,
        status: 'confirmed',
        previousHash: null,
        timestamp: 100,
      })

      // Group message is recorded in the group conversation only
      expect(chats.conversations[groupConv.id]?.messages).toHaveLength(1)
      expect(chats.conversations[groupConv.id]?.messages[0].payloadDigest).toBe(
        'group-msg-1',
      )
      // Direct chats with Bob and Carol remain empty
      expect(chats.conversations[directBob.id]?.messages).toHaveLength(0)
      expect(chats.conversations[directCarol.id]?.messages).toHaveLength(0)
      expect(chats.chats[RECIPIENT_ADDRESS]).toBeUndefined()
      expect(chats.chats[THIRD_ADDRESS]).toBeUndefined()
    })

    it('rejects legacy ownerless rows without reconstructing ownership from peer aliases', async () => {
      const legacyState = {
        activeChatAddr: RECIPIENT_ADDRESS,
        chats: {
          [RECIPIENT_ADDRESS]: {
            address: RECIPIENT_ADDRESS,
            messages: [],
            totalUnreadMessages: 2,
            totalUnreadValue: 200,
            totalValue: 200,
            lastReceived: 50,
            lastRead: 0,
            stampAmount: 500,
          } as any,
        },
        messages: {},
        lastReceived: 50,
      }

      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* (): AsyncGenerator<MessageWrapper> {
          yield {
            index: 'legacy-msg-1',
            outbound: false,
            senderAddress: RECIPIENT_ADDRESS,
            copartyAddress: RECIPIENT_ADDRESS,
            message: {
              outbound: false,
              status: 'confirmed',
              items: [{ type: 'text', text: 'legacy message' }],
              serverTime: 50,
              receivedTime: 50,
              outpoints: [],
              stampValueWei: 100n,
              senderAddress: RECIPIENT_ADDRESS,
            },
          }
        })(),
      )

      await expect(rehydateChat(legacyState)).rejects.toThrow(
        /Unsupported stored conversation format/,
      )
      expect(mockMessageStore.saveMessage).not.toHaveBeenCalled()
      expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
    })

    it('enforces tombstone deletion semantics: ignores replayed messages and reopens on newer message', async () => {
      const chats = useChatStore()
      const conv = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'f1dab84f-56ba-5cd2-908a-5468b6e3012b',
        name: 'Temporary Thread',
      })

      // Send initial message at time 100
      chats.sendMessageLocal({
        address: RECIPIENT_ADDRESS,
        conversationId: conv.id,
        senderAddress: SENDER_ADDRESS,
        index: 'm1',
        items: [{ type: 'text', text: 'first message' }],
        outpoints: [],
        status: 'confirmed',
        previousHash: null,
        timestamp: 100,
      })
      expect(chats.conversations[conv.id]?.messages).toHaveLength(1)

      // Delete conversation at time 200
      await chats.deleteConversation(conv.id, 200)
      expect(chats.conversations[conv.id]?.deletedAt).toBe(200)
      expect(chats.conversations[conv.id]?.messages).toHaveLength(0)

      // Replayed message with timestamp 100 (<= deletedAt) is ignored
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: RECIPIENT_ADDRESS,
          copartyAddress: RECIPIENT_ADDRESS,
          copartyPubKey: {} as any,
          index: 'm1-replayed',
          stampValue: 10,
          message: {
            conversationId: conv.id,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'replayed message' }],
            serverTime: 100,
            receivedTime: 100,
            outpoints: [],
            senderAddress: RECIPIENT_ADDRESS,
          } as any,
        },
      ])
      expect(chats.conversations[conv.id]?.deletedAt).toBeDefined()
      expect(chats.conversations[conv.id]?.messages).toHaveLength(0)

      // Newer message with timestamp 300 (> deletedAt) reopens the conversation
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: RECIPIENT_ADDRESS,
          copartyAddress: RECIPIENT_ADDRESS,
          copartyPubKey: {} as any,
          index: 'm2-fresh',
          stampValue: 10,
          message: {
            conversationId: conv.id,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'fresh message after delete' }],
            serverTime: 300,
            receivedTime: 300,
            outpoints: [],
            senderAddress: RECIPIENT_ADDRESS,
          } as any,
        },
      ])
      expect(chats.conversations[conv.id]?.deletedAt).toBeUndefined()
      expect(chats.conversations[conv.id]?.messages).toHaveLength(1)
      expect(chats.conversations[conv.id]?.messages[0].payloadDigest).toBe(
        'm2-fresh',
      )
      expect(chats.conversations[conv.id]?.name).toBe('Temporary Thread')
    })

    it('edits the local subject without changing identity or participant routing', () => {
      const chats = useChatStore()
      const conv = chats.createConversation({
        address: RECIPIENT_ADDRESS,
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        name: 'Initial',
      })
      const id = conv.id
      conv.name = 'Renamed'
      expect(chats.conversations[id].name).toBe('Renamed')
      expect(chats.conversations[id].address).toBe(RECIPIENT_ADDRESS)
      expect(chats.getSortedChatOrder.map(c => c.id)).toEqual([id])
    })

    it('activates conversation by ID and updates activeConversationId and activeConversation (ticket #943)', () => {
      const chats = useChatStore()
      const conv = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        name: 'Ticket 943 Thread',
      })

      chats.setActiveConversation(conv.id)
      expect(chats.activeConversationId).toBe(conv.id)
      expect(chats.activeConversation?.id).toBe(conv.id)
      expect(chats.activeConversation?.name).toBe('Ticket 943 Thread')
      expect(chats.activeChatAddr).toBe(conv.address)

      chats.setActiveConversation(null)
      expect(chats.activeConversationId).toBeNull()
      expect(chats.activeChatAddr).toBeNull()
      expect(chats.activeConversation).toBeNull()
    })

    it('activates conversation by contact address for backward compatibility (ticket #943)', () => {
      const chats = useChatStore()
      chats.setActiveConversation(RECIPIENT_ADDRESS)
      expect(chats.activeConversationId).toBeDefined()
      expect(chats.activeChatAddr).toBe(RECIPIENT_ADDRESS)
      expect(chats.activeConversation?.kind).toBe('direct')
      expect(chats.activeConversation?.address).toBe(RECIPIENT_ADDRESS)
      expect(chats.activeConversation?.participants).toContain(
        RECIPIENT_ADDRESS,
      )
    })

    it('creates fresh email roots with equal or blank subjects without changing defaults', () => {
      const chats = useChatStore()
      const direct = chats.openDirectConversation(defaultEmailGatewayAddress)
      const roots = ['Same', 'Same', '', ''].map(subject =>
        chats.createEmailConversation({
          recipientEmail: '  Alice@Example.com  ',
          subject,
        }),
      )
      expect(new Set(roots.map(root => root.id)).size).toBe(4)
      for (const root of roots) {
        expect(root).toMatchObject({
          kind: 'email',
          emailRecipient: 'alice@example.com',
          address: defaultEmailGatewayAddress,
        })
        expect(root.topic).toBeUndefined()
        expect(root.messages).toEqual([])
      }
      expect(chats.chats[defaultEmailGatewayAddress].id).toBe(direct.id)
      expect(roots[0].name).toBe('Same')
      expect(roots[2].name).toBeUndefined()
    })

    it('separates recipients and configured canonical gateways', () => {
      const chats = useChatStore()
      const first = chats.createEmailConversation({
        recipientEmail: 'alice@example.com',
      })
      const other = chats.createEmailConversation({
        recipientEmail: 'bob@example.com',
      })
      const custom = chats.createEmailConversation({
        recipientEmail: 'alice@example.com',
        gatewayAddress: RECIPIENT_ADDRESS.toLowerCase(),
      })
      expect(new Set([first.id, other.id, custom.id]).size).toBe(3)
      expect(custom.address).toBe(RECIPIENT_ADDRESS)
      expect(custom.participants).toEqual([RECIPIENT_ADDRESS])
      expect(chats.getSortedChatOrder).toHaveLength(3)
    })

    it.each([
      { recipientEmail: '' },
      { recipientEmail: '   ' },
      {
        recipientEmail: 'alice@example.com',
        gatewayAddress: 'invalid-gateway',
      },
    ])('rejects invalid email creation before owner mutation: %j', input => {
      const chats = useChatStore()
      const before = JSON.stringify(chats.$state)
      expect(() => chats.createEmailConversation(input)).toThrow()
      expect(JSON.stringify(chats.$state)).toBe(before)
    })
  })

  describe('unverified peer email frames defense (ticket-unverified-peer-email-frames)', () => {
    const UNTRUSTED_PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
    const GATEWAY_ADDRESS = defaultEmailGatewayAddress
    const CUSTOM_GATEWAY = '0x3333333333333333333333333333333333333333'

    const emailPayload: EmailItem = {
      type: 'email',
      messageId: '<spoofed@example.com>',
      from: { address: 'spoofed@google.com', name: 'Google Accounts' },
      to: [{ address: 'me@frank.org' }],
      subject: 'Security Notice',
      textBody: 'Please update your security password immediately.',
    }

    it('classifies incoming email item from verified gateway as verifiedGateway: true', async () => {
      const chats = useChatStore()
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)

      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: GATEWAY_ADDRESS,
          copartyAddress: GATEWAY_ADDRESS,
          copartyPubKey: {} as any,
          index: 'gateway-email-msg-1',
          stampValue: 10,
          message: {
            conversationId: 'ca3a65f8-c175-5e7c-ba37-0274014f305c',
            outbound: false,
            status: 'confirmed',
            items: [emailPayload],
            serverTime: 200,
            receivedTime: 200,
            outpoints: [],
            senderAddress: GATEWAY_ADDRESS,
          } as any,
        },
      ])

      const conv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'gateway-email-msg-1'),
      )
      expect(conv).toBeDefined()
      expect(conv?.kind).toBe('email')
      expect(conv?.verifiedGateway).toBe(true)
    })

    it('classifies incoming email item from untrusted peer as verifiedGateway: false', async () => {
      const chats = useChatStore()
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)

      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: UNTRUSTED_PEER,
          copartyAddress: UNTRUSTED_PEER,
          copartyPubKey: {} as any,
          index: 'peer-email-msg-1',
          stampValue: 10,
          message: {
            conversationId: 'cb9b1cf0-e016-5012-893c-7d85a32f93c8',
            outbound: false,
            status: 'confirmed',
            items: [emailPayload],
            serverTime: 250,
            receivedTime: 250,
            outpoints: [],
            senderAddress: UNTRUSTED_PEER,
          } as any,
        },
      ])

      const conv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'peer-email-msg-1'),
      )
      expect(conv).toBeDefined()
      expect(conv?.kind).toBe('email')
      expect(conv?.verifiedGateway).toBe(false)
    })

    it('respects configured custom email gateway in profile store', async () => {
      const chats = useChatStore()
      const profile = useProfileStore()
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)

      profile.emailBridgeGatewayAddress = CUSTOM_GATEWAY
      expect(getTrustedEmailGatewayAddress()).toBe(CUSTOM_GATEWAY)

      // Message from custom gateway should now be verified
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: CUSTOM_GATEWAY,
          copartyAddress: CUSTOM_GATEWAY,
          copartyPubKey: {} as any,
          index: 'custom-gw-email-1',
          stampValue: 10,
          message: {
            conversationId: 'ff550e12-2d7a-5de0-8276-c513f6bd0dc5',
            outbound: false,
            status: 'confirmed',
            items: [emailPayload],
            serverTime: 300,
            receivedTime: 300,
            outpoints: [],
            senderAddress: CUSTOM_GATEWAY,
          } as any,
        },
      ])

      const customConv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'custom-gw-email-1'),
      )
      expect(customConv).toBeDefined()
      expect(customConv?.verifiedGateway).toBe(true)

      // Message from default gateway is now unverified against custom gateway
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: GATEWAY_ADDRESS,
          copartyAddress: GATEWAY_ADDRESS,
          copartyPubKey: {} as any,
          index: 'old-default-email-1',
          stampValue: 10,
          message: {
            conversationId: 'cda8ca34-fb07-514d-99c0-9767653bf827',
            outbound: false,
            status: 'confirmed',
            items: [emailPayload],
            serverTime: 350,
            receivedTime: 350,
            outpoints: [],
            senderAddress: GATEWAY_ADDRESS,
          } as any,
        },
      ])

      const oldGwConv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'old-default-email-1'),
      )
      expect(oldGwConv).toBeDefined()
      expect(oldGwConv?.verifiedGateway).toBe(false)

      // Reset
      profile.emailBridgeGatewayAddress = undefined
    })

    it('transitions existing direct chat to email and sets verifiedGateway: false on peer email item', async () => {
      const chats = useChatStore()
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)

      // Initial direct text message
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: UNTRUSTED_PEER,
          copartyAddress: UNTRUSTED_PEER,
          copartyPubKey: {} as any,
          index: 'plain-direct-1',
          stampValue: 10,
          message: {
            conversationId: 'f3f37104-782d-57da-b376-d8c85f880515',
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'Hey there' }],
            serverTime: 400,
            receivedTime: 400,
            outpoints: [],
            senderAddress: UNTRUSTED_PEER,
          } as any,
        },
      ])

      let conv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'plain-direct-1'),
      )
      expect(conv?.kind).toBe('direct')

      // Now peer crafts and sends Type 26 email item
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: UNTRUSTED_PEER,
          copartyAddress: UNTRUSTED_PEER,
          copartyPubKey: {} as any,
          index: 'peer-email-in-direct-2',
          stampValue: 10,
          message: {
            conversationId: 'f3f37104-782d-57da-b376-d8c85f880515',
            outbound: false,
            status: 'confirmed',
            items: [emailPayload],
            serverTime: 450,
            receivedTime: 450,
            outpoints: [],
            senderAddress: UNTRUSTED_PEER,
          } as any,
        },
      ])

      conv = Object.values(chats.conversations).find(c =>
        c.messages.some(m => m.payloadDigest === 'plain-direct-1'),
      )
      expect(conv?.kind).toBe('email')
      expect(conv?.verifiedGateway).toBe(false)
    })
  })

  describe('default opening and independent creation (#1237 supersedes #1178/#1186)', () => {
    it('opens one default and creates fresh equal-subject threads without collapsing them', () => {
      const chats = useChatStore()
      const first = chats.openDirectConversation(RECIPIENT_ADDRESS)
      const second = chats.createConversation({
        address: RECIPIENT_ADDRESS,
        participants: [RECIPIENT_ADDRESS],
        name: 'Equal',
      })
      const third = chats.createConversation({
        address: RECIPIENT_ADDRESS,
        participants: [RECIPIENT_ADDRESS],
        name: 'Equal',
      })
      first.name = 'Equal'
      expect(chats.openDirectConversation(RECIPIENT_ADDRESS)).toBe(first)
      expect(new Set([first.id, second.id, third.id]).size).toBe(3)
      expect(chats.getSortedChatOrder).toHaveLength(3)
      expect(chats.chats[RECIPIENT_ADDRESS]).toBe(first)
      expect(chats.chats[second.id]).toBeUndefined()
      chats.setActiveConversation(second.id)
      expect(chats.activeConversation).toBe(second)
      chats.setActiveChat(RECIPIENT_ADDRESS)
      expect(chats.activeConversation).toBe(first)
    })

    it('keeps a default placeholder stable while rejecting a different full participant pair', () => {
      const chats = useChatStore()
      const placeholder = chats.openDirectConversation(RECIPIENT_ADDRESS)
      expect(
        chats.openDirectConversation(RECIPIENT_ADDRESS, [
          SENDER_ADDRESS,
          RECIPIENT_ADDRESS,
        ]).id,
      ).toBe(placeholder.id)
      expect(placeholder.participants).toEqual(
        [SENDER_ADDRESS, RECIPIENT_ADDRESS].sort(),
      )
      expect(() =>
        chats.openDirectConversation(RECIPIENT_ADDRESS, [
          THIRD_ADDRESS,
          RECIPIENT_ADDRESS,
        ]),
      ).toThrow(/different participants/)
      expect(chats.getSortedChatOrder).toHaveLength(1)
    })

    it('does not designate an explicit ID as default merely because it equals a derived peer ID', () => {
      const chats = useChatStore()
      const explicit = chats.createConversation({
        address: RECIPIENT_ADDRESS,
        participants: [RECIPIENT_ADDRESS],
        conversationId: makeConversationId([RECIPIENT_ADDRESS]),
      })
      const defaultThread = chats.openDirectConversation(RECIPIENT_ADDRESS)
      expect(defaultThread.id).not.toBe(explicit.id)
      expect(chats.chats[RECIPIENT_ADDRESS]).toBe(defaultThread)
      expect(explicit.defaultDirect).toBeUndefined()
    })
  })

  describe('ticket #819 / #820: converging geometric stamp suggestion and override lifecycle', () => {
    it('computes geometric stamp suggestion from conversation messages and handles override lifecycle', () => {
      const store = useChatStore()
      const peerAddress = '0x1111111111111111111111111111111111111111'
      const convId = '33333333-3333-4333-8333-000000000002'
      const ONE_MON = 1_000_000_000_000_000_000n

      store.conversations[convId] = {
        id: convId,
        kind: 'direct',
        address: peerAddress,
        participants: [peerAddress],
        messages: [
          // A opened with 5.0 MON
          {
            outbound: true,
            stampValueWei: 5n * ONE_MON,
            status: 'confirmed',
            items: [],
            outpoints: [],
            receivedTime: 100,
            serverTime: 100,
            senderAddress: '0x0000000000000000000000000000000000000001',
            payloadDigest: 'd1',
          },
          // B replied with 0.1 MON
          {
            outbound: false,
            stampValueWei: ONE_MON / 10n,
            status: 'confirmed',
            items: [],
            outpoints: [],
            receivedTime: 200,
            serverTime: 200,
            senderAddress: peerAddress,
            payloadDigest: 'd2',
          },
        ],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 200,
        lastRead: 200,
        stampAmount: 0,
      } as any

      // Expected suggestion is ~0.7071 MON (707106781186547524n)
      const suggestion = store.getPeerStampSuggestion(convId)
      expect(suggestion).toBe(707_106_781_186_547_524n)

      // Override is initially undefined
      expect(store.getStampOverrideWei(convId)).toBeUndefined()

      // Set manual override
      const customOverride = 2n * ONE_MON
      store.setStampOverride({ address: convId, overrideWei: customOverride })
      expect(store.getStampOverrideWei(convId)).toBe(customOverride)

      // Clear override
      store.clearStampOverride(convId)
      expect(store.getStampOverrideWei(convId)).toBeUndefined()
    })

    it('heals corrupted or stale accumulated unread counts and values during hydration', async () => {
      const convId = '33333333-3333-4333-8333-000000000003'
      const peerAddress = '0x4444444444444444444444444444444444444444'
      const singleMessage = {
        conversationId: convId,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text' as const, text: 'Hello!' }],
        serverTime: 500,
        receivedTime: 500,
        outpoints: [],
        stampValueWei: 10_000_000_000_000_000n,
        senderAddress: peerAddress,
        destinationAddress: SENDER_ADDRESS,
      }
      mockMessageStore.getIterator.mockResolvedValue([
        {
          index: 'msg-stale-test',
          senderAddress: peerAddress,
          outbound: false,
          copartyAddress: peerAddress,
          message: singleMessage,
        },
      ])

      const corruptedState: any = {
        conversations: {
          [convId]: {
            id: convId,
            kind: 'direct',
            address: peerAddress,
            participants: [SENDER_ADDRESS, peerAddress],
            members: {
              [SENDER_ADDRESS]: { address: SENDER_ADDRESS, role: 'member' },
              [peerAddress]: { address: peerAddress, role: 'member' },
            },
            messages: [],
            totalUnreadMessages: 52,
            totalUnreadValue: 520_000_000_000_000_000,
            totalValue: 520_000_000_000_000_000,
            lastReceived: 500,
            lastRead: 0,
            stampAmount: 0,
          },
        },
        chats: {},
        lastReceived: 500,
      }

      const rehydrated = await rehydrateState(corruptedState)

      const healed = rehydrated.conversations[convId]
      expect(healed.messages).toHaveLength(1)
      expect(healed.totalUnreadMessages).toBe(1)
      expect(healed.totalUnreadValue).toBe(10_000_000_000_000_000)
      expect(healed.totalValue).toBe(10_000_000_000_000_000)
    })
  })
})
