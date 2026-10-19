import { createPinia, setActivePinia } from 'pinia'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  autoHealDuplicateDirectConversations,
  freshChatState,
  rehydrateState,
  setConversationIdSalt,
  useChatStore,
  type ChatMessage,
  type Conversation,
  type RestorableState,
} from './chats'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import ChatListItem from '../components/chat/ChatListItem.vue'
import ChatPage from '../pages/Chat.vue'

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

const SELF_ADDR = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER_A = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const PEER_B = '0x3333333333333333333333333333333333333333'
const BOT_GATEWAY = '0x4444444444444444444444444444444444444444'
const TEST_SALT = conversationIdSalt(new Uint8Array(32).fill(0x7e))

function makeMessage(
  overrides: Partial<ChatMessage> & { payloadDigest: string },
): ChatMessage {
  return {
    outbound: false,
    status: 'confirmed',
    receivedTime: 1_700_000_000_000,
    serverTime: 1_700_000_000_000,
    items: [{ type: 'text', text: 'hello' }],
    senderAddress: PEER_A,
    outpoints: [],
    ...overrides,
  }
}

function incomingWrapper({
  conversationId,
  senderAddress,
  copartyAddress = senderAddress,
  index,
  time,
  text,
  outbound = false,
}: {
  conversationId: string
  senderAddress: string
  copartyAddress?: string
  index: string
  time: number
  text: string
  outbound?: boolean
}): ReceivedMessageWrapper {
  return {
    conversationId,
    outbound,
    senderAddress,
    copartyAddress,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index,
    stampValue: 0,
    message: {
      conversationId,
      outbound,
      status: 'confirmed',
      senderAddress,
      destinationAddress: outbound ? copartyAddress : SELF_ADDR,
      items: [{ type: 'text', text }],
      serverTime: time,
      receivedTime: time,
      outpoints: [],
    },
  }
}

describe('Canonical Conversation Identity & Multi-Thread Preservation (#1237)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setConversationIdSalt(TEST_SALT)
    jest.clearAllMocks()
    mockOwnAddress.mockReturnValue(SELF_ADDR)
  })

  describe('overlapping participant sets ([self, peerA] and [self, peerB])', () => {
    it('does not collide or alias self to another peer conversation', () => {
      const store = useChatStore()

      const convA = store.createConversation({
        conversationId: '11111111-1111-4111-8111-111111111111',
        address: PEER_A,
        participants: [SELF_ADDR, PEER_A],
        topic: 'Thread with Peer A',
      })
      const convB = store.createConversation({
        conversationId: '22222222-2222-4222-8222-222222222222',
        address: PEER_B,
        participants: [SELF_ADDR, PEER_B],
        topic: 'Thread with Peer B',
      })

      expect(convA.id).not.toBe(convB.id)
      expect(store.conversations[convA.id]).toBeDefined()
      expect(store.conversations[convB.id]).toBeDefined()
      expect(store.conversations[convA.id].address).toBe(PEER_A)
      expect(store.conversations[convB.id].address).toBe(PEER_B)

      // Self must never be aliased to a remote peer's conversation in store.chats
      expect(store.chats[SELF_ADDR]).toBeUndefined()

      // Running auto-heal must keep both conversations distinct and never alias self
      store.autoHealDuplicateDirectConversations()
      expect(store.conversations[convA.id].address).toBe(PEER_A)
      expect(store.conversations[convB.id].address).toBe(PEER_B)
      expect(store.chats[SELF_ADDR]).toBeUndefined()
    })

    it('keeps self conversation distinct from [self, peer] conversations across activation and reload', async () => {
      const store = useChatStore()

      const convPeer = store.openDirectConversation(PEER_A, [SELF_ADDR, PEER_A])
      const convSelf = store.openDirectConversation(SELF_ADDR, [SELF_ADDR])

      expect(convSelf.id).not.toBe(convPeer.id)
      expect(store.chats[SELF_ADDR]?.id).toBe(convSelf.id)
      expect(store.chats[PEER_A]?.id).toBe(convPeer.id)

      await store.receiveMessages([
        incomingWrapper({
          conversationId: convPeer.id,
          senderAddress: PEER_A,
          index: 'digest-peer-1',
          time: 1_700_000_001_000,
          text: 'from peer A',
        }),
        incomingWrapper({
          conversationId: convSelf.id,
          senderAddress: SELF_ADDR,
          copartyAddress: SELF_ADDR,
          index: 'digest-self-1',
          time: 1_700_000_002_000,
          text: 'note to self',
          outbound: true,
        }),
      ])

      expect(store.conversations[convPeer.id].messages).toHaveLength(1)
      expect(store.conversations[convSelf.id].messages).toHaveLength(1)

      // Persist & rehydrate
      const snapshot: RestorableState = JSON.parse(
        JSON.stringify({
          conversations: store.conversations,
          activeConversationId: store.activeConversationId,
          lastReceived: store.lastReceived,
        }),
      )
      const rehydrated = await rehydrateState(snapshot)

      expect(rehydrated.conversations[convPeer.id]).toBeDefined()
      expect(rehydrated.conversations[convSelf.id]).toBeDefined()
      expect(rehydrated.conversations[convPeer.id].address).toBe(PEER_A)
      expect(rehydrated.conversations[convSelf.id].address).toBe(SELF_ADDR)
    })
  })

  describe('multiple independent conversations with the same peer / bot / gateway', () => {
    it('preserves multiple threads with the same peer across message receipt, unread accounting, auto-heal, and rehydrateState', async () => {
      const store = useChatStore()

      const thread1Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const thread2Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const thread3Id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

      const thread1 = store.createConversation({
        conversationId: thread1Id,
        address: BOT_GATEWAY,
        participants: [SELF_ADDR, BOT_GATEWAY],
        topic: 'Support Ticket #101',
      })
      const thread2 = store.createConversation({
        conversationId: thread2Id,
        address: BOT_GATEWAY,
        participants: [SELF_ADDR, BOT_GATEWAY],
        topic: 'Support Ticket #102',
      })
      const thread3 = store.createConversation({
        conversationId: thread3Id,
        address: BOT_GATEWAY,
        participants: [SELF_ADDR, BOT_GATEWAY],
        name: 'Bot Command Thread',
      })

      expect(Object.keys(store.conversations)).toEqual(
        expect.arrayContaining([thread1.id, thread2.id, thread3.id]),
      )

      // Deliver messages to each thread independently
      await store.receiveMessages([
        incomingWrapper({
          conversationId: thread1.id,
          senderAddress: BOT_GATEWAY,
          index: 'digest-t1',
          time: 1_700_000_001_000,
          text: 'Reply for #101',
        }),
        incomingWrapper({
          conversationId: thread2.id,
          senderAddress: BOT_GATEWAY,
          index: 'digest-t2-a',
          time: 1_700_000_002_000,
          text: 'Reply 1 for #102',
        }),
        incomingWrapper({
          conversationId: thread2.id,
          senderAddress: BOT_GATEWAY,
          index: 'digest-t2-b',
          time: 1_700_000_003_000,
          text: 'Reply 2 for #102',
        }),
      ])

      expect(store.conversations[thread1.id].messages).toHaveLength(1)
      expect(store.conversations[thread2.id].messages).toHaveLength(2)
      expect(store.conversations[thread3.id].messages).toHaveLength(0)
      expect(store.conversations[thread1.id].totalUnreadMessages).toBe(1)
      expect(store.conversations[thread2.id].totalUnreadMessages).toBe(2)
      expect(store.conversations[thread3.id].totalUnreadMessages).toBe(0)

      // Activate thread 2 and verify only thread 2's unread count clears
      store.setActiveConversation(thread2.id)
      expect(store.conversations[thread2.id].totalUnreadMessages).toBe(0)
      expect(store.conversations[thread1.id].totalUnreadMessages).toBe(1)

      // Auto-heal must NOT collapse distinct canonical threads for the same peer
      store.autoHealDuplicateDirectConversations()
      expect(store.conversations[thread1.id]).toBeDefined()
      expect(store.conversations[thread2.id]).toBeDefined()
      expect(store.conversations[thread3.id]).toBeDefined()
      expect(store.conversations[thread1.id].messages).toHaveLength(1)
      expect(store.conversations[thread2.id].messages).toHaveLength(2)

      // Rehydrate from storage must also keep all three threads intact
      const persisted: RestorableState = JSON.parse(
        JSON.stringify({
          conversations: store.conversations,
          activeConversationId: store.activeConversationId,
          lastReceived: store.lastReceived,
        }),
      )
      const rehydrated = await rehydrateState(persisted)

      expect(rehydrated.conversations[thread1.id]).toBeDefined()
      expect(rehydrated.conversations[thread2.id]).toBeDefined()
      expect(rehydrated.conversations[thread3.id]).toBeDefined()
      expect(rehydrated.conversations[thread1.id].topic).toBe(
        'Support Ticket #101',
      )
      expect(rehydrated.conversations[thread2.id].topic).toBe(
        'Support Ticket #102',
      )
      expect(rehydrated.conversations[thread3.id].name).toBe(
        'Bot Command Thread',
      )
    })

    it('preserves two unnamed UUIDv4 conversations with the same peer as separate threads', () => {
      const store = useChatStore()
      const idA = '12121212-1212-4212-8212-121212121212'
      const idB = '34343434-3434-4434-8434-343434343434'

      store.createConversation({
        conversationId: idA,
        address: PEER_A,
        participants: [PEER_A],
      })
      store.createConversation({
        conversationId: idB,
        address: PEER_A,
        participants: [PEER_A],
      })

      store.autoHealDuplicateDirectConversations()

      expect(store.conversations[idA]).toBeDefined()
      expect(store.conversations[idB]).toBeDefined()
    })

    it('heals genuine legacy address-keyed duplicate records into the canonical default conversation without touching topical threads', () => {
      const canonicalId = '55555555-5555-5555-8555-555555555555'
      const topicThreadId = '66666666-6666-4666-8666-666666666666'

      const conversations: Record<string, Conversation> = {
        [canonicalId]: {
          id: canonicalId,
          kind: 'direct',
          address: PEER_A,
          participants: [PEER_A],
          messages: [
            {
              ...makeMessage({
                payloadDigest: 'digest-1',
                serverTime: 1000,
                items: [{ type: 'text', text: 'first' }],
              }),
              id: 'tx-1',
            },
          ],
          createdAt: 1000,
          updatedAt: 1000,
          lastRead: 0,
          totalUnreadMessages: 1,
          totalUnreadValue: 0,
          totalValue: 0,
        },
        [PEER_A]: {
          id: PEER_A,
          kind: 'direct',
          address: PEER_A,
          participants: [PEER_A],
          messages: [
            {
              ...makeMessage({
                payloadDigest: 'digest-2',
                serverTime: 2000,
                items: [{ type: 'text', text: 'second (legacy duplicate)' }],
              }),
              id: 'tx-2',
            },
          ],
          createdAt: 2000,
          updatedAt: 2000,
          lastRead: 0,
          totalUnreadMessages: 1,
          totalUnreadValue: 0,
          totalValue: 0,
        },
        [topicThreadId]: {
          id: topicThreadId,
          kind: 'direct',
          address: PEER_A,
          participants: [PEER_A],
          topic: 'Separate Topic',
          name: 'Separate Topic',
          messages: [
            {
              ...makeMessage({
                payloadDigest: 'digest-3',
                serverTime: 3000,
                items: [{ type: 'text', text: 'in topic thread' }],
              }),
              id: 'tx-3',
            },
          ],
          createdAt: 3000,
          updatedAt: 3000,
          lastRead: 0,
          totalUnreadMessages: 1,
          totalUnreadValue: 0,
          totalValue: 0,
        },
      }

      autoHealDuplicateDirectConversations(conversations, {}, null)

      // Legacy address-keyed duplicate was merged into canonicalId and removed
      expect(conversations[PEER_A]).toBeUndefined()
      expect(conversations[canonicalId]).toBeDefined()
      expect(conversations[canonicalId].messages).toHaveLength(2)

      // Separate topical thread with the same peer was preserved untouched
      expect(conversations[topicThreadId]).toBeDefined()
      expect(conversations[topicThreadId].messages).toHaveLength(1)
      expect(conversations[topicThreadId].topic).toBe('Separate Topic')
    })
  })

  describe('UI topic & participant resolution in ChatListItem.vue and Chat.vue', () => {
    it('ChatListItem resolves effectiveName from topic and effectiveAddress from non-self participant', () => {
      const vm = {
        conversation: {
          id: '77777777-7777-4777-8777-777777777777',
          kind: 'direct',
          address: '',
          topic: 'Project X Discussion',
          participants: [SELF_ADDR, PEER_A],
        },
        chatAddress: '',
        conversationName: '',
        ownAddress: SELF_ADDR,
      }

      const effectiveName = (
        ChatListItem as unknown as {
          computed: {
            effectiveName: (this: typeof vm) => string
            effectiveAddress: (this: typeof vm) => string
          }
        }
      ).computed.effectiveName.call(vm)
      const effectiveAddress = (
        ChatListItem as unknown as {
          computed: {
            effectiveName: (this: typeof vm) => string
            effectiveAddress: (this: typeof vm) => string
          }
        }
      ).computed.effectiveAddress.call(vm)

      expect(effectiveName).toBe('Project X Discussion')
      expect(effectiveAddress).toBe(PEER_A)
    })

    it('Chat.vue resolves peerName and conversationTopic from topic and recipientAddress from non-self participant', () => {
      const vm = {
        conversation: {
          id: '88888888-8888-4888-8888-888888888888',
          kind: 'direct',
          address: '',
          topic: 'Atomic Swap Thread',
          participants: [SELF_ADDR, PEER_B],
        },
        address: '88888888-8888-4888-8888-888888888888',
        ownAddress: SELF_ADDR,
        isEmailThread: false,
        getContactVuex: () => ({ profile: { name: 'Bob' } }),
      }

      const computed = (
        ChatPage as unknown as {
          computed: {
            recipientAddress: (this: typeof vm) => string
            peerName: (this: typeof vm) => string
            conversationTopic: (this: typeof vm) => string
          }
        }
      ).computed

      expect(computed.recipientAddress.call(vm)).toBe(PEER_B)
      expect(computed.conversationTopic.call(vm)).toBe('Atomic Swap Thread')
      expect(computed.peerName.call(vm)).toBe('Atomic Swap Thread')
    })
  })
})
