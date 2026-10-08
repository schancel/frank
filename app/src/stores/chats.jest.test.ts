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

import {
  indexOutboundDeliveryOwners,
  rehydateChat,
  rehydrateState,
  useChatStore,
  makeConversationId,
  uuidv5,
  NULL_CONVERSATION_NAMESPACE,
  getTrustedEmailGatewayAddress,
  type RestorableState,
  type ChatMessage,
} from './chats'
import { defaultEmailGatewayAddress } from '../utils/constants'
import { useProfileStore } from './my-profile'
import { useContactStore } from './contacts'
import { store as messageStorePromise } from '../adapters/level-message-store'
import {
  activeChain,
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
      chats.chats[SENDER_ADDRESS] = {
        address: SENDER_ADDRESS,
        messages: history,
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: historySize,
        lastRead: 0,
        stampAmount: 1,
      }
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
      expect(restored.chats[SENDER_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'self-digest',
          outbound: true,
          stampValueWei: 7000n,
        }),
      ])
      expect(restored.chats[SENDER_ADDRESS]?.totalValue).toBe(7000)
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
      expect(restored.chats[SENDER_ADDRESS]?.messages).toEqual([
        expect.objectContaining({
          payloadDigest: 'race-digest',
          outbound: true,
          stampValueWei: 9000n,
        }),
      ])
      expect(restored.chats[SENDER_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(restored.chats[SENDER_ADDRESS]?.totalUnreadValue).toBe(0)
      expect(restored.chats[SENDER_ADDRESS]?.totalValue).toBe(9000)
      expect(restored.messages['race-digest']).toBe(
        restored.chats[SENDER_ADDRESS]?.messages[0],
      )
      expect(restored.messages[pendingIndex]).toBeUndefined()
      mockMessageStore.deleteMessage.mockResolvedValue(undefined)
      await Promise.resolve()
      warning.mockRestore()
    })

    it('reaccounts and resorts a rehydrated old-account digest collision as inbound', async () => {
      const chats = useChatStore()
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
      chats.$patch(
        await rehydateChat({
          activeChatAddr: null,
          chats: {},
          messages: {},
          lastReceived: 0,
        }),
      )
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
      chats.chats[RECIPIENT_ADDRESS] = {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      }
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
      chats.chats[RECIPIENT_ADDRESS] = {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      }
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
      expect(restored.chats[SENDER_ADDRESS]?.messages).toHaveLength(1)
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
        chats.chats[SENDER_ADDRESS] = {
          address: SENDER_ADDRESS,
          messages: [],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: 0,
          lastRead: 0,
          stampAmount: 1,
        }
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
        chats.chats[SENDER_ADDRESS] = {
          address: SENDER_ADDRESS,
          messages: [],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: 0,
          lastRead: 0,
          stampAmount: 1,
        }
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

      chats.chats[RECIPIENT_ADDRESS] = {
        address: RECIPIENT_ADDRESS,
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        lastReceived: 0,
        lastRead: 0,
        stampAmount: 1,
      }
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
      expect(restored.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(1)
      expect(restored.chats[RECIPIENT_ADDRESS]?.totalUnreadValue).toBe(5000)
    })

    it('persists an active-chat receipt as read across navigation and reload', async () => {
      const chats = useChatStore()
      useContactStore().addContact({
        address: RECIPIENT_ADDRESS,
        contact: {
          profile: { name: 'Bob', bio: '', avatar: '', pubKey: null },
        },
      })
      chats.activeChatAddr = RECIPIENT_ADDRESS
      const wrapper = makeWrapper()

      await chats.receiveMessages([wrapper])
      expect(chats.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(chats.chats[RECIPIENT_ADDRESS]?.lastRead).toBe(
        wrapper.message.serverTime,
      )
      chats.activeChatAddr = THIRD_ADDRESS

      const persisted = mockMessageStore.saveMessage.mock.calls.at(-1)?.[0]
      mockMessageStore.getIterator.mockResolvedValueOnce(
        (async function* () {
          yield persisted
        })(),
      )
      const restored = await rehydateChat({
        activeChatAddr: THIRD_ADDRESS,
        chats: {
          [RECIPIENT_ADDRESS]: {
            ...chats.chats[RECIPIENT_ADDRESS]!,
            messages: [],
          },
        },
        messages: {},
        lastReceived: chats.lastReceived,
      })

      expect(restored.chats[RECIPIENT_ADDRESS]?.totalUnreadMessages).toBe(0)
      expect(restored.chats[RECIPIENT_ADDRESS]?.totalUnreadValue).toBe(0)
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

  it('keeps durable receipt suppression for an outbound self-route', async () => {
    const chats = useChatStore()
    chats.chats[SENDER_ADDRESS] = {
      address: SENDER_ADDRESS,
      messages: [],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 0,
      lastRead: 0,
      stampAmount: 0,
    }
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
      [{ payloadDigest: 'delete-self' }],
    )
    expect(mockMessageStore.deleteMessage).not.toHaveBeenCalled()
  })

  it('clears ordinary outbound history without growing sender-mailbox suppression', async () => {
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
        conversationId: 'group-team-frank',
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
      expect(chats.chats[RECIPIENT_ADDRESS]?.messages).toHaveLength(0)
      expect(chats.chats[THIRD_ADDRESS]?.messages).toHaveLength(0)
    })

    it('migrates legacy direct-message fixtures into conversations and logical messages', async () => {
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

      const rehydrated = await rehydateChat(legacyState)
      expect(rehydrated.conversations).toBeDefined()
      const convs = Object.values(rehydrated.conversations)
      expect(convs.length).toBeGreaterThanOrEqual(1)
      const conv = convs[0]
      expect(conv.kind).toBe('direct')
      expect(conv.participants).toContain(RECIPIENT_ADDRESS)
      expect(conv.messages).toHaveLength(1)
      expect(conv.messages[0].payloadDigest).toBe('legacy-msg-1')
      expect(conv.messages[0].conversationId).toBe(conv.id)

      // Verified logical message indexing
      expect(rehydrated.logicalMessages).toBeDefined()
      expect(rehydrated.logicalMessages['legacy-msg-1']).toBeDefined()
      expect(rehydrated.logicalMessages['legacy-msg-1']?.conversationId).toBe(
        conv.id,
      )
      expect(
        rehydrated.logicalMessages['legacy-msg-1']?.revisions[0].deliveries[0]
          .deliveryDigest,
      ).toBe('legacy-msg-1')

      // Chats map alias points to the same conversation
      expect(rehydrated.chats[RECIPIENT_ADDRESS]).toBe(conv)
    })

    it('enforces tombstone deletion semantics: ignores replayed messages and reopens on newer message', async () => {
      const chats = useChatStore()
      const conv = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'thread-delete',
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
            conversationId: 'thread-delete',
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
            conversationId: 'thread-delete',
            conversationName: 'Reopened Thread',
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
      expect(chats.conversations[conv.id]?.name).toBe('Reopened Thread')
    })

    it('updates conversation name when newer message carries a new conversation name (rename semantics)', async () => {
      const chats = useChatStore()
      const conv = chats.createConversation({
        kind: 'direct',
        participants: [SENDER_ADDRESS, RECIPIENT_ADDRESS],
        topic: 'topic-rename',
        name: 'Initial Name',
      })
      expect(chats.conversations[conv.id]?.name).toBe('Initial Name')

      // Receive message with a new conversation name
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: RECIPIENT_ADDRESS,
          copartyAddress: RECIPIENT_ADDRESS,
          copartyPubKey: {} as any,
          index: 'rename-msg',
          stampValue: 10,
          message: {
            conversationId: 'topic-rename',
            conversationName: 'Renamed Topic',
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'Renaming this' }],
            serverTime: 150,
            receivedTime: 150,
            outpoints: [],
            senderAddress: RECIPIENT_ADDRESS,
          } as any,
        },
      ])

      expect(chats.conversations[conv.id]?.name).toBe('Renamed Topic')
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

    it('creates or reuses email conversations with createOrOpenEmailConversation', () => {
      const chats = useChatStore()
      const conv1 = chats.createOrOpenEmailConversation({
        recipientEmail: 'Alice@Example.com',
        subject: 'First Discussion',
      })

      expect(conv1.kind).toBe('email')
      expect(conv1.emailRecipient).toBe('Alice@Example.com')
      expect(conv1.name).toBe('First Discussion')
      expect(conv1.topic).toBe('Alice@Example.com')
      expect(conv1.address).toBe(defaultEmailGatewayAddress)
      expect(conv1.participants).toContain(defaultEmailGatewayAddress)
      expect(conv1.messages).toEqual([])

      // Calling again with same email returns existing conversation
      const conv2 = chats.createOrOpenEmailConversation({
        recipientEmail: 'alice@example.com',
      })
      expect(conv2.id).toBe(conv1.id)

      // Calling with new subject updates conversation name if it was empty/fallback
      const convNoSubject = chats.createOrOpenEmailConversation({
        recipientEmail: 'bob@example.com',
      })
      expect(convNoSubject.name).toBe('bob@example.com')

      const convUpdatedSubject = chats.createOrOpenEmailConversation({
        recipientEmail: 'bob@example.com',
        subject: 'Updated Subject',
      })
      expect(convUpdatedSubject.id).toBe(convNoSubject.id)
      expect(convUpdatedSubject.name).toBe('Updated Subject')
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
            conversationId: 'email-thread-gw-1',
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
            conversationId: 'email-thread-peer-1',
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
            conversationId: 'email-custom-gw-1',
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
            conversationId: 'email-old-default-1',
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
            conversationId: 'plain-direct-conv',
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
            conversationId: 'plain-direct-conv',
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

  describe('ticket #1178: collapse 1-on-1 direct messages into canonical peer conversation thread', () => {
    it('collapses multiple incoming direct messages with different conversationId UUIDs from the same sender into a single canonical thread (fixes #1178)', async () => {
      const chats = useChatStore()
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)

      const peerAddress = RECIPIENT_ADDRESS
      const uuid1 = '11111111-1111-4111-8111-111111111111'
      const uuid2 = '22222222-2222-4222-8222-222222222222'
      const uuid3 = '33333333-3333-4333-8333-333333333333'

      // First incoming message with UUID-1
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: peerAddress,
          copartyAddress: peerAddress,
          copartyPubKey: {} as any,
          index: 'msg-uuid-1',
          stampValue: 10,
          message: {
            conversationId: uuid1,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'Hello from Qwen (message 1)' }],
            serverTime: 1000,
            receivedTime: 1000,
            outpoints: [],
            senderAddress: peerAddress,
          } as any,
        },
      ])

      // Second incoming message from same sender with UUID-2
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: peerAddress,
          copartyAddress: peerAddress,
          copartyPubKey: {} as any,
          index: 'msg-uuid-2',
          stampValue: 10,
          message: {
            conversationId: uuid2,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'Hello from Qwen (message 2)' }],
            serverTime: 2000,
            receivedTime: 2000,
            outpoints: [],
            senderAddress: peerAddress,
          } as any,
        },
      ])

      // Third incoming message from same sender with UUID-3
      await chats.receiveMessages([
        {
          outbound: false,
          senderAddress: peerAddress,
          copartyAddress: peerAddress,
          copartyPubKey: {} as any,
          index: 'msg-uuid-3',
          stampValue: 10,
          message: {
            conversationId: uuid3,
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'Hello from Qwen (message 3)' }],
            serverTime: 3000,
            receivedTime: 3000,
            outpoints: [],
            senderAddress: peerAddress,
          } as any,
        },
      ])

      // Verify only ONE direct conversation exists for this peer
      const peerConversations = Object.values(chats.conversations).filter(
        c =>
          c.kind === 'direct' &&
          c.participants.some(p => sameCanonicalAddress(p, peerAddress)),
      )
      expect(peerConversations).toHaveLength(1)

      const canonicalConv = peerConversations[0]
      expect(chats.chats[peerAddress]).toBe(canonicalConv)
      expect(canonicalConv.messages).toHaveLength(3)
      expect(canonicalConv.messages.map(m => m.payloadDigest)).toEqual([
        'msg-uuid-1',
        'msg-uuid-2',
        'msg-uuid-3',
      ])
      // All messages should have conversationId assigned to the canonical conversation id
      for (const msg of canonicalConv.messages) {
        expect(msg.conversationId).toBe(canonicalConv.id)
      }
    })

    it('rehydrateState auto-heals pre-existing duplicate direct conversation records with the same peer into a single consolidated thread with all messages preserved (fixes #1178)', async () => {
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)
      const peerAddress = RECIPIENT_ADDRESS

      const dupId1 = 'dup-thread-1'
      const dupId2 = 'dup-thread-2'
      const canonicalParticipants = [SENDER_ADDRESS, peerAddress].sort()

      const msg1: ChatMessage = {
        payloadDigest: 'dup-msg-1',
        conversationId: dupId1,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Message in thread 1' }],
        serverTime: 100,
        receivedTime: 100,
        outpoints: [],
        stampValueWei: 100n,
      } as any

      const msg2: ChatMessage = {
        payloadDigest: 'dup-msg-2',
        conversationId: dupId2,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Message in thread 2' }],
        serverTime: 200,
        receivedTime: 200,
        outpoints: [],
        stampValueWei: 200n,
      } as any

      const duplicateState: RestorableState = {
        activeChatAddr: null,
        activeConversationId: null,
        conversations: {
          [dupId1]: {
            id: dupId1,
            kind: 'direct',
            address: peerAddress,
            participants: canonicalParticipants,
            messages: [msg1],
            lastReceived: 100,
            lastRead: 50,
            totalUnreadMessages: 1,
            totalUnreadValue: 100,
            totalValue: 100,
          } as any,
          [dupId2]: {
            id: dupId2,
            kind: 'direct',
            address: peerAddress,
            participants: canonicalParticipants,
            messages: [msg2],
            lastReceived: 200,
            lastRead: 150,
            totalUnreadMessages: 1,
            totalUnreadValue: 200,
            totalValue: 200,
          } as any,
        },
        chats: {
          [peerAddress]: {
            id: dupId2,
            address: peerAddress,
            messages: [],
          } as any,
        },
        lastReceived: 200,
      }

      const rehydrated = await rehydrateState(duplicateState)

      // Duplicate conversation keys should be collapsed into a single thread
      const peerConvs = Object.values(rehydrated.conversations).filter(
        c =>
          c.kind === 'direct' &&
          c.participants.some(p => sameCanonicalAddress(p, peerAddress)),
      )
      expect(peerConvs).toHaveLength(1)

      const consolidatedConv = peerConvs[0]
      // chats[peerAddress] must point to consolidated conversation
      expect(rehydrated.chats[peerAddress]).toBe(consolidatedConv)

      // The orphaned duplicate conversation key must be deleted
      const orphanedKey = consolidatedConv.id === dupId1 ? dupId2 : dupId1
      expect(rehydrated.conversations[orphanedKey]).toBeUndefined()

      // All messages must be preserved, sorted, and re-keyed to the consolidated conversation
      expect(consolidatedConv.messages).toHaveLength(2)
      expect(consolidatedConv.messages[0].payloadDigest).toBe('dup-msg-1')
      expect(consolidatedConv.messages[1].payloadDigest).toBe('dup-msg-2')
      expect(consolidatedConv.messages[0].conversationId).toBe(
        consolidatedConv.id,
      )
      expect(consolidatedConv.messages[1].conversationId).toBe(
        consolidatedConv.id,
      )

      // Accounting must be recomputed
      expect(consolidatedConv.lastReceived).toBe(200)
      expect(consolidatedConv.lastRead).toBe(150)
      // msg1 (serverTime 100) <= lastRead 150 -> read; msg2 (serverTime 200) > lastRead 150 -> unread
      expect(consolidatedConv.totalUnreadMessages).toBe(1)
      expect(consolidatedConv.totalUnreadValue).toBe(200)
      expect(consolidatedConv.totalValue).toBe(300)
    })
  })

  describe('ticket #1186: deduplicate direct chats and suppress empty peer placeholders', () => {
    it('getSortedChatOrder suppresses empty placeholder when an active conversation with messages exists for the same direct peer (fixes #1186)', () => {
      const chats = useChatStore()
      const peerAddress = RECIPIENT_ADDRESS
      const emptyId = peerAddress
      const canonicalId = 'canonical-conv-123'

      const msg1: ChatMessage = {
        payloadDigest: 'msg-1',
        conversationId: canonicalId,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'You alive?' }],
        serverTime: 500,
        receivedTime: 500,
        outpoints: [],
        stampValueWei: 1000n,
      } as any

      // Two entries exist in state: an empty placeholder and the active conversation with messages
      chats.conversations[emptyId] = {
        id: emptyId,
        kind: 'direct',
        address: peerAddress,
        participants: [peerAddress],
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        createdAt: 100,
      } as any

      chats.conversations[canonicalId] = {
        id: canonicalId,
        kind: 'direct',
        address: peerAddress,
        participants: [SENDER_ADDRESS, peerAddress],
        messages: [msg1],
        totalUnreadMessages: 1,
        totalUnreadValue: 1000,
        totalValue: 1000,
        lastReceived: 500,
        createdAt: 200,
      } as any

      chats.chats[peerAddress] = chats.conversations[emptyId] as any

      // getSortedChatOrder should deduplicate by peer and suppress the empty placeholder
      const sorted = chats.getSortedChatOrder
      const peerEntries = sorted.filter(
        c =>
          c.kind === 'direct' &&
          c.participants?.some(p => sameCanonicalAddress(p, peerAddress)),
      )
      expect(peerEntries).toHaveLength(1)
      expect(peerEntries[0].id).toBe(canonicalId)
      expect(peerEntries[0].messages).toHaveLength(1)

      // totalUnread should also not double count
      expect(chats.totalUnread).toBe(1)
    })

    it('getSortedChatOrder retains a freshly opened direct chat when no conversation with messages exists yet', () => {
      const chats = useChatStore()
      const peerAddress = THIRD_ADDRESS

      chats.conversations['fresh-conv'] = {
        id: 'fresh-conv',
        kind: 'direct',
        address: peerAddress,
        participants: [peerAddress],
        messages: [],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
        createdAt: 100,
      } as any

      const sorted = chats.getSortedChatOrder
      const peerEntries = sorted.filter(
        c =>
          c.kind === 'direct' &&
          c.participants?.some(p => sameCanonicalAddress(p, peerAddress)),
      )
      expect(peerEntries).toHaveLength(1)
      expect(peerEntries[0].id).toBe('fresh-conv')
    })

    it('setActiveChat reuses existing conversation with messages instead of creating an empty duplicate (fixes #1186)', () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      jest.spyOn(contacts, 'refresh').mockResolvedValue(undefined as any)
      const peerAddress = RECIPIENT_ADDRESS
      const canonicalId = 'canonical-conv-reuse'

      const msg: ChatMessage = {
        payloadDigest: 'msg-reuse',
        conversationId: canonicalId,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Hello' }],
        serverTime: 100,
        receivedTime: 100,
        outpoints: [],
      } as any

      chats.conversations[canonicalId] = {
        id: canonicalId,
        kind: 'direct',
        address: peerAddress,
        participants: [SENDER_ADDRESS, peerAddress],
        messages: [msg],
        totalUnreadMessages: 0,
        totalUnreadValue: 0,
        totalValue: 0,
      } as any

      // chats[peerAddress] is not set yet
      expect(chats.chats[peerAddress]).toBeUndefined()

      chats.setActiveChat(peerAddress)

      expect(chats.activeConversationId).toBe(canonicalId)
      expect(chats.chats[peerAddress]).toBe(chats.conversations[canonicalId])
      // No extra conversation should be created in conversations
      expect(Object.keys(chats.conversations)).toHaveLength(1)
    })

    it('setActiveConversation reuses conversation with messages when passed peer address instead of an empty placeholder (fixes #1186)', () => {
      const chats = useChatStore()
      const contacts = useContactStore()
      jest.spyOn(contacts, 'refresh').mockResolvedValue(undefined as any)
      const peerAddress = RECIPIENT_ADDRESS
      const canonicalId = 'canonical-conv-nav'

      const msg: ChatMessage = {
        payloadDigest: 'msg-nav',
        conversationId: canonicalId,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Active message' }],
        serverTime: 100,
        receivedTime: 100,
        outpoints: [],
      } as any

      // Placeholder exists at peerAddress key, but canonicalId has the actual messages
      chats.conversations[peerAddress] = {
        id: peerAddress,
        kind: 'direct',
        address: peerAddress,
        participants: [peerAddress],
        messages: [],
      } as any

      chats.conversations[canonicalId] = {
        id: canonicalId,
        kind: 'direct',
        address: peerAddress,
        participants: [SENDER_ADDRESS, peerAddress],
        messages: [msg],
      } as any

      chats.setActiveConversation(peerAddress)

      expect(chats.activeConversationId).toBe(canonicalId)
      expect(chats.chats[peerAddress]).toBe(chats.conversations[canonicalId])
    })

    it('rehydrateState auto-heals when chatState.chats has an empty contact and conversations has the active thread (fixes #1186)', async () => {
      mockOwnAddress.mockReturnValue(SENDER_ADDRESS)
      const peerAddress = RECIPIENT_ADDRESS
      const canonicalId = 'canonical-conv-rehydrate'

      const msg: ChatMessage = {
        payloadDigest: 'msg-rehydrate',
        conversationId: canonicalId,
        senderAddress: peerAddress,
        outbound: false,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Rehydrated message' }],
        serverTime: 300,
        receivedTime: 300,
        outpoints: [],
        stampValueWei: 500n,
      } as any

      const stateWithEmptyChatAndActiveConv: RestorableState = {
        activeChatAddr: null,
        activeConversationId: null,
        conversations: {
          [canonicalId]: {
            id: canonicalId,
            kind: 'direct',
            address: peerAddress,
            participants: [SENDER_ADDRESS, peerAddress],
            messages: [msg],
            lastReceived: 300,
            lastRead: 100,
            totalUnreadMessages: 1,
            totalUnreadValue: 500,
            totalValue: 500,
          } as any,
        },
        chats: {
          [peerAddress]: {
            id: peerAddress,
            address: peerAddress,
            messages: [],
          } as any,
        },
        lastReceived: 300,
      }

      const rehydrated = await rehydrateState(stateWithEmptyChatAndActiveConv)

      // Only ONE conversation for this peer should exist in rehydrated.conversations
      const peerConvs = Object.values(rehydrated.conversations).filter(
        c =>
          c.kind === 'direct' &&
          c.participants?.some(p => sameCanonicalAddress(p, peerAddress)),
      )
      expect(peerConvs).toHaveLength(1)
      expect(peerConvs[0].id).toBe(canonicalId)
      expect(peerConvs[0].messages).toHaveLength(1)

      // The placeholder peerAddress key should not exist in conversations
      expect(rehydrated.conversations[peerAddress]).toBeUndefined()
      // chats[peerAddress] should point to the active conversation
      expect(rehydrated.chats[peerAddress]).toBe(peerConvs[0])
    })
  })
  describe('ticket #819 / #820: converging geometric stamp suggestion and override lifecycle', () => {
    it('computes geometric stamp suggestion from conversation messages and handles override lifecycle', () => {
      const store = useChatStore()
      const peerAddress = '0x1111111111111111111111111111111111111111'
      const convId = 'conv-geometric-test'
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
  })
})
