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
  useChatStore,
} from './chats'
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
          }),
        }),
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

  describe('readAll (ticket #368)', () => {
    it('opening a chat that has no messages yet is not an error-level console event', () => {
      const chats = useChatStore()
      const errorSpy = jest.spyOn(console, 'error').mockImplementation()
      jest.spyOn(console, 'debug').mockImplementation()

      chats.readAll(RECIPIENT_ADDRESS)

      expect(errorSpy).not.toHaveBeenCalled()
    })
  })
})
