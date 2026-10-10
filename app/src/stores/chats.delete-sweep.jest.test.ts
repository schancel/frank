/**
 * The store's delete paths (one message, clear history, delete chat, and through delete chat,
 * delete contact) delete only what the wallet cleared: a message whose money could not be moved
 * to a seed-derived address stays, and the caller is told why.
 *
 * `sweepBeforeDelete` is stubbed here (it has its own tests, and the wallet operation behind it is
 * tested against the real wallet handle in packages/wallet); what is tested is what the store does
 * with its answer. Same environment notes as `chats.jest.test.ts`.
 */
import { createPinia, setActivePinia } from 'pinia'
;(global as unknown as { document: unknown }).document = {
  hasFocus: () => true,
}

import { useChatStore, type ChatMessage, type Conversation } from './chats'
import { useContactStore } from './contacts'
import { store as messageStorePromise } from '../adapters/level-message-store'
import { MessageFundsNotSweptError } from '../utils/sweep-on-delete'

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
      /* nothing persisted */
    }),
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () => OWN,
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))
const mockKept = new Map<string, string>()
const mockSwept: string[][] = []
const mockSettled: string[] = []
const mockQueueBusyDuringSweep: boolean[] = []
const mockInQueue = { value: false }
jest.mock('../utils/sweep-on-delete', () => ({
  ...jest.requireActual('../utils/sweep-on-delete'),
  settleOutgoingPayments: async (
    messages: readonly { payloadDigest: string; outbound?: boolean }[],
  ) => {
    mockSettled.push(
      ...messages.filter(m => m.outbound).map(message => message.payloadDigest),
    )
  },
  sweepBeforeDelete: async (messages: readonly { payloadDigest: string }[]) => {
    // The sweep reads the chain and may wait for a block: it must never run inside the
    // store's mutation queue, where every send's first save waits.
    mockQueueBusyDuringSweep.push(mockInQueue.value)
    mockSwept.push(messages.map(message => message.payloadDigest))
    return {
      kept: new Map(
        messages.flatMap(message =>
          mockKept.has(message.payloadDigest)
            ? [
                [
                  message.payloadDigest,
                  mockKept.get(message.payloadDigest) as string,
                ] as const,
              ]
            : [],
        ),
      ),
    }
  },
}))

const OWN = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'

const received = (payloadDigest: string): ChatMessage =>
  ({
    outbound: false,
    status: 'confirmed',
    receivedTime: 1000,
    serverTime: 1000,
    items: [{ type: 'text', text: payloadDigest }],
    outpoints: [],
    stampValueWei: 1000n,
    stampPayments: [
      { txHash: '0xtx', destinationAddress: '0xchild', valueWei: 1000n },
    ],
    senderAddress: PEER,
    recipientAddress: OWN,
    payloadDigest,
  } as unknown as ChatMessage)

describe('deleting messages that brought money', () => {
  let chats: ReturnType<typeof useChatStore>
  let conv: Conversation
  let deleted: () => string[]

  beforeEach(async () => {
    setActivePinia(createPinia())
    mockKept.clear()
    mockSwept.length = 0
    mockSettled.length = 0
    mockQueueBusyDuringSweep.length = 0
    mockInQueue.value = false
    const messageStore = (await messageStorePromise) as unknown as {
      deleteMessage: jest.Mock
      suppressAndDelete: jest.Mock
    }
    messageStore.deleteMessage.mockClear()
    messageStore.suppressAndDelete.mockClear()
    // The durable deletes are what runs inside the mutation queue.
    for (const write of [
      messageStore.deleteMessage,
      messageStore.suppressAndDelete,
    ])
      write.mockImplementation(async () => {
        mockInQueue.value = true
        await Promise.resolve()
        mockInQueue.value = false
      })
    deleted = () => [
      ...messageStore.deleteMessage.mock.calls.map(call => call[0] as string),
      ...messageStore.suppressAndDelete.mock.calls.flatMap(
        call => call[1] as string[],
      ),
    ]
    jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
    chats = useChatStore()
    conv = chats.openDirectConversation(PEER)
    for (const digest of ['aa', 'bb', 'cc']) {
      const message = received(digest)
      message.conversationId = conv.id
      conv.messages.push(message)
      chats.messages[digest] = message
    }
  })
  const left = () => conv.messages.map(message => message.payloadDigest)

  it('one message: swept first, then deleted', async () => {
    await chats.deleteMessage({ address: PEER, payloadDigest: 'bb' })
    expect(mockSwept).toEqual([['bb']])
    expect(left()).toEqual(['aa', 'cc'])
    expect(deleted()).toContain('bb')
  })

  it('one message whose money could not be moved stays, and the caller gets the reason', async () => {
    mockKept.set('bb', 'node unreachable')
    const refusal = await chats
      .deleteMessage({ address: PEER, payloadDigest: 'bb' })
      .catch(error => error)
    expect(refusal).toBeInstanceOf(MessageFundsNotSweptError)
    expect(refusal.message).toContain('node unreachable')
    expect(left()).toEqual(['aa', 'bb', 'cc'])
    expect(chats.messages.bb).toBeDefined()
    expect(deleted()).toEqual([])
  })

  it('clear history sweeps every message, clears the ones that were cleared, and keeps the rest with the reason', async () => {
    mockKept.set('bb', 'The sweep is broadcast and not in a block yet')
    const refusal = await chats.clearChat(PEER).catch(error => error)
    expect(mockSwept).toEqual([['aa', 'bb', 'cc']])
    expect(refusal).toBeInstanceOf(MessageFundsNotSweptError)
    expect([...refusal.kept.keys()]).toEqual(['bb'])
    expect(left()).toEqual(['bb'])
    expect(chats.messages.bb).toBeDefined()
    expect(chats.messages.aa).toBeUndefined()
    expect(deleted().sort()).toEqual(['aa', 'cc'])

    // Asked again once the sweep is in a block: the rest goes.
    mockKept.clear()
    await chats.clearChat(PEER)
    expect(left()).toEqual([])
  })

  it('delete chat (and so delete contact) does not remove a chat that still holds a kept message', async () => {
    mockKept.set('cc', 'node unreachable')
    await expect(chats.deleteChat(PEER)).rejects.toBeInstanceOf(
      MessageFundsNotSweptError,
    )
    expect(conv.deletedAt).toBeUndefined()
    expect(left()).toEqual(['cc'])

    const contacts = useContactStore()
    await expect(contacts.deleteContact(PEER)).rejects.toBeInstanceOf(
      MessageFundsNotSweptError,
    )
    expect(conv.deletedAt).toBeUndefined()

    mockKept.clear()
    await contacts.deleteContact(PEER)
    expect(conv.deletedAt).toBeDefined()
    expect(left()).toEqual([])
  })

  it('the sweep runs before the mutation queue, never inside it', async () => {
    await chats.deleteMessage({ address: PEER, payloadDigest: 'aa' })
    await chats.clearChat(PEER)
    expect(mockSwept.length).toBe(2)
    expect(mockQueueBusyDuringSweep).toEqual([false, false])
    expect(left()).toEqual([])
  })

  it('a received message that arrived after the sweep looked is not cleared unswept', async () => {
    const clearance = await chats.clearanceToClear(PEER)
    const late = received('dd')
    late.conversationId = conv.id
    conv.messages.push(late)
    chats.messages.dd = late
    await chats.clearChatExclusive(PEER, clearance)
    expect(left()).toEqual(['dd'])
  })

  it('deleting or clearing outgoing messages hands their payments to the wallet to release or finish', async () => {
    const outgoing = {
      ...received('ee'),
      outbound: true,
      senderAddress: OWN,
      items: [{ type: 'stealth', amount: 5, ephemeralPubKey: '02ab' }],
    } as unknown as ChatMessage
    outgoing.conversationId = conv.id
    conv.messages.push(outgoing)
    chats.messages.ee = outgoing
    await chats.deleteMessage({ address: PEER, payloadDigest: 'ee' })
    expect(mockSettled).toEqual(['ee'])
  })
})
