import { createPinia, setActivePinia } from 'pinia'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type {
  ConversationStateItem,
  JournalCheckpointItem,
  MessageTombstoneItem,
  MessageWrapper,
  OutboxMessageItem,
} from '@frank/cashweb/types/messages'

interface Disk {
  rows: Map<string, MessageWrapper>
  suppressed: Set<string>
}
const mockDisk: Disk = {
  rows: new Map(),
  suppressed: new Set(),
}

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (row: MessageWrapper) => {
      mockDisk.rows.set(
        row.index,
        JSON.parse(
          JSON.stringify(row, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          ),
        ),
      )
    },
    deleteMessage: async (index: string) => {
      mockDisk.rows.delete(index)
    },
    suppressAndDelete: async (
      _recipient: string,
      digests: string[],
      suppressions: Array<{ payloadDigest: string }>,
    ) => {
      for (const digest of digests) mockDisk.rows.delete(digest)
      for (const entry of suppressions)
        mockDisk.suppressed.add(entry.payloadDigest)
    },
    suppressedRelayReceipts: async (
      _recipient: string,
      receipts: Array<{ payloadDigest: string }>,
    ) =>
      new Set(
        receipts
          .map(receipt => receipt.payloadDigest)
          .filter(digest => mockDisk.suppressed.has(digest)),
      ),
    quarantineRelayReceipts: async () => undefined,
    mostRecentMessageTime: async () => 0,
    relayCursor: async () => 0,
    getIterator: async function* () {
      for (const key of [...mockDisk.rows.keys()].sort())
        yield JSON.parse(JSON.stringify(mockDisk.rows.get(key)))
    },
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))

import {
  recordLogicalMessage,
  setConversationIdSalt,
  useChatStore,
} from './chats'
import { useContactStore } from './contacts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

const OWN_ADDRESS = '0x1111111111111111111111111111111111111111'
const PEER_ADDRESS = '0x2222222222222222222222222222222222222222'

function allPermutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()]
  const result: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const head = items[i]!
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of allPermutations(rest)) {
      result.push([head, ...tail])
    }
  }
  return result
}

const CONV_ID = '11111111-1111-4111-8111-111111111111'
const DIGEST_IN_1 = 'a1'.repeat(32)
const DIGEST_IN_2 = 'b2'.repeat(32)
const DIGEST_OUT_1 = 'c3'.repeat(32)
const LOGICAL_OUT_1 = '33333333-3333-4333-8333-333333333333'

function makeInboundWrapper(params: {
  index: string
  serverTime: number
  text: string
  stampValueWei: bigint
  conversationId?: string
  conversationName?: string
}): ReceivedMessageWrapper {
  return {
    outbound: false,
    senderAddress: PEER_ADDRESS,
    copartyAddress: PEER_ADDRESS,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    copartyPubKey: { toBuffer: () => new Uint8Array(33) } as any,
    index: params.index,
    stampValue: Number(params.stampValueWei),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    message: {
      outbound: false,
      status: 'confirmed',
      items: [{ type: 'text', text: params.text }],
      serverTime: params.serverTime,
      receivedTime: params.serverTime,
      outpoints: [],
      stampValueWei: params.stampValueWei,
      senderAddress: PEER_ADDRESS,
      destinationAddress: OWN_ADDRESS,
      ...(params.conversationId
        ? { conversationId: params.conversationId }
        : {}),
      ...(params.conversationName
        ? { conversationName: params.conversationName }
        : {}),
    },
  } as unknown as ReceivedMessageWrapper
}

function makeSelfNoteWrapper(params: {
  index: string
  serverTime: number
  item:
    | OutboxMessageItem
    | ConversationStateItem
    | MessageTombstoneItem
    | JournalCheckpointItem
}): ReceivedMessageWrapper {
  return {
    outbound: false,
    senderAddress: OWN_ADDRESS,
    copartyAddress: OWN_ADDRESS,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    copartyPubKey: { toBuffer: () => new Uint8Array(33) } as any,
    index: params.index,
    stampValue: 0,
    message: {
      outbound: false,
      status: 'confirmed',
      items: [params.item],
      serverTime: params.serverTime,
      receivedTime: params.serverTime,
      outpoints: [],
      stampValueWei: 0n,
      senderAddress: OWN_ADDRESS,
      destinationAddress: OWN_ADDRESS,
    },
  } as unknown as ReceivedMessageWrapper
}

function initFreshStore() {
  mockDisk.rows.clear()
  mockDisk.suppressed.clear()
  setActivePinia(createPinia())
  setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x11)))
  const contacts = useContactStore()
  contacts.addContact({
    address: PEER_ADDRESS,
    contact: {
      profile: { name: 'Peer', avatar: '', bio: '' },
      inbox: { acceptancePrice: 0 },
    },
  })
  return useChatStore()
}

describe('chats store semilattice convergence & outbox/tombstone/checkpoint notes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('converges identically across all 4! = 24 delivery permutations of inbound messages, outbox-message, and conversation-state notes', async () => {
    const wIn1 = makeInboundWrapper({
      index: DIGEST_IN_1,
      serverTime: 1_000,
      text: 'Early cleared message',
      stampValueWei: 200n,
      conversationId: CONV_ID,
    })
    const wIn2 = makeInboundWrapper({
      index: DIGEST_IN_2,
      serverTime: 2_000,
      text: 'Surviving unread message',
      stampValueWei: 450n,
      conversationId: CONV_ID,
    })
    const wOutbox = makeSelfNoteWrapper({
      index: 'e5'.repeat(32),
      serverTime: 2_500,
      item: {
        type: 'outbox-message',
        payloadDigest: DIGEST_OUT_1,
        recipientAddress: PEER_ADDRESS,
        sentAt: 2_500,
        conversationId: CONV_ID,
        conversationName: 'Outbox Subject',
        messageId: LOGICAL_OUT_1,
        stampValueWei: '100',
        text: 'Sent from other device',
      },
    })
    const wConvState = makeSelfNoteWrapper({
      index: 'f6'.repeat(32),
      serverTime: 3_000,
      item: {
        type: 'conversation-state',
        conversationId: CONV_ID,
        peer: PEER_ADDRESS,
        clearedBefore: 1_500,
        readUpTo: 1_500,
        subject: 'Note Subject',
        subjectSetAt: 3_000,
      },
    })

    const perms = allPermutations([wIn1, wIn2, wOutbox, wConvState])
    expect(perms).toHaveLength(24)

    interface Snapshot {
      messageDigests: string[]
      name: string | undefined
      nameSetAt: number | undefined
      clearedBefore: number | undefined
      lastRead: number
      lastReceived: number
      totalUnreadMessages: number
      totalUnreadValue: number
      totalValue: number
      storeLastReceived: number | null
      outboxMessage: {
        outbound: boolean
        status: string
        serverTime: number
        destinationAddress: string | undefined
        logicalMessageId: string | undefined
      }
    }

    let reference: Snapshot | undefined

    for (const perm of perms) {
      const chats = initFreshStore()
      for (const wrapper of perm) {
        await chats.receiveMessages([wrapper], OWN_ADDRESS)
      }
      const conv = chats.conversations[CONV_ID]!
      expect(conv).toBeDefined()
      const outMsg = chats.messages[DIGEST_OUT_1]!
      expect(outMsg).toBeDefined()

      const snap: Snapshot = {
        messageDigests: conv.messages.map(m => m.payloadDigest),
        name: conv.name,
        nameSetAt: conv.nameSetAt,
        clearedBefore: conv.clearedBefore,
        lastRead: conv.lastRead,
        lastReceived: conv.lastReceived,
        totalUnreadMessages: conv.totalUnreadMessages,
        totalUnreadValue: conv.totalUnreadValue,
        totalValue: conv.totalValue,
        storeLastReceived: chats.lastReceived,
        outboxMessage: {
          outbound: outMsg.outbound,
          status: outMsg.status,
          serverTime: outMsg.serverTime,
          destinationAddress: outMsg.destinationAddress,
          logicalMessageId: outMsg.logicalMessageId,
        },
      }

      if (!reference) {
        reference = snap
      } else {
        expect(snap).toEqual(reference)
      }
    }

    expect(reference).toEqual({
      messageDigests: [DIGEST_IN_2, DIGEST_OUT_1],
      name: 'Note Subject',
      nameSetAt: 3_000,
      clearedBefore: 1_500,
      lastRead: 1_500,
      lastReceived: 2_500,
      totalUnreadMessages: 1,
      totalUnreadValue: 450,
      totalValue: 550,
      storeLastReceived: 2_500,
      outboxMessage: {
        outbound: true,
        status: 'confirmed',
        serverTime: 2_500,
        destinationAddress: PEER_ADDRESS,
        logicalMessageId: LOGICAL_OUT_1,
      },
    })
  })

  it('converges identically across all 4! = 24 permutations with message-tombstone and journal-checkpoint notes', async () => {
    const wIn1 = makeInboundWrapper({
      index: DIGEST_IN_1,
      serverTime: 1_000,
      text: 'Message to be tombstoned',
      stampValueWei: 200n,
      conversationId: CONV_ID,
    })
    const wIn2 = makeInboundWrapper({
      index: DIGEST_IN_2,
      serverTime: 2_000,
      text: 'Surviving message',
      stampValueWei: 350n,
      conversationId: CONV_ID,
    })
    const wTombstone = makeSelfNoteWrapper({
      index: 'd4'.repeat(32),
      serverTime: 2_200,
      item: {
        type: 'message-tombstone',
        conversationId: CONV_ID,
        peer: PEER_ADDRESS,
        payloadDigest: DIGEST_IN_1,
        deletedAt: 2_200,
      },
    })
    const wCheckpoint = makeSelfNoteWrapper({
      index: 'c8'.repeat(32),
      serverTime: 2_500,
      item: {
        type: 'journal-checkpoint',
        checkpointTimestamp: 2_500,
        conversations: [
          {
            conversationId: CONV_ID,
            peer: PEER_ADDRESS,
            readUpTo: 2_000,
            subject: 'Checkpoint Topic',
            subjectSetAt: 2_400,
          },
        ],
      },
    })

    const perms = allPermutations([wIn1, wIn2, wTombstone, wCheckpoint])
    expect(perms).toHaveLength(24)

    let refSnap: unknown
    for (const perm of perms) {
      const chats = initFreshStore()
      for (const wrapper of perm) {
        await chats.receiveMessages([wrapper], OWN_ADDRESS)
      }
      const conv = chats.conversations[CONV_ID]!
      const snap = {
        messageDigests: conv.messages.map(m => m.payloadDigest),
        name: conv.name,
        nameSetAt: conv.nameSetAt,
        lastRead: conv.lastRead,
        totalUnreadMessages: conv.totalUnreadMessages,
        totalUnreadValue: conv.totalUnreadValue,
        totalValue: conv.totalValue,
        storeLastReceived: chats.lastReceived,
      }
      if (!refSnap) {
        refSnap = snap
      } else {
        expect(snap).toEqual(refSnap)
      }
    }

    expect(refSnap).toEqual({
      messageDigests: [DIGEST_IN_2],
      name: 'Checkpoint Topic',
      nameSetAt: 2_400,
      lastRead: 2_000,
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 350,
      storeLastReceived: 2_500,
    })
  })

  it('converges identically when local send (sendMessageLocal) and relay confirmation (receiveMessages) race in either order', async () => {
    const relayEcho: ReceivedMessageWrapper = {
      outbound: true,
      senderAddress: OWN_ADDRESS,
      copartyAddress: PEER_ADDRESS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      copartyPubKey: { toBuffer: () => new Uint8Array(33) } as any,
      index: DIGEST_OUT_1,
      stampValue: 100,
      conversationId: CONV_ID,
      message: {
        outbound: true,
        status: 'confirmed',
        items: [{ type: 'text', text: 'Race message' }],
        serverTime: 1_500,
        receivedTime: 1_500,
        outpoints: [],
        stampValueWei: 100n,
        senderAddress: OWN_ADDRESS,
        destinationAddress: PEER_ADDRESS,
        conversationId: CONV_ID,
        logicalMessageId: LOGICAL_OUT_1,
      },
    } as unknown as ReceivedMessageWrapper

    // Order A: sendMessageLocal first (with local clock 999_999, status 'sending'), then receiveMessages
    const chatsA = initFreshStore()
    chatsA.sendMessageLocal({
      address: PEER_ADDRESS,
      senderAddress: OWN_ADDRESS,
      index: DIGEST_OUT_1,
      items: [{ type: 'text', text: 'Race message' }],
      outpoints: [],
      previousHash: null,
      timestamp: 999_999,
      status: 'sending',
      stampValueWei: 100n,
      conversationId: CONV_ID,
      logicalMessageId: LOGICAL_OUT_1,
    })
    await chatsA.receiveMessages([relayEcho], OWN_ADDRESS)

    // Order B: receiveMessages first (relay echo at t=1500, status 'confirmed'), then sendMessageLocal
    const chatsB = initFreshStore()
    await chatsB.receiveMessages([relayEcho], OWN_ADDRESS)
    chatsB.sendMessageLocal({
      address: PEER_ADDRESS,
      senderAddress: OWN_ADDRESS,
      index: DIGEST_OUT_1,
      items: [{ type: 'text', text: 'Race message' }],
      outpoints: [],
      previousHash: null,
      timestamp: 999_999,
      status: 'sending',
      stampValueWei: 100n,
      conversationId: CONV_ID,
      logicalMessageId: LOGICAL_OUT_1,
    })

    const msgA = chatsA.messages[DIGEST_OUT_1]!
    const msgB = chatsB.messages[DIGEST_OUT_1]!

    expect(msgA.status).toBe('confirmed')
    expect(msgB.status).toBe('confirmed')
    expect(msgA.serverTime).toBe(1_500)
    expect(msgB.serverTime).toBe(1_500)
    expect(msgA.localTime).toBe(false)
    expect(msgB.localTime).toBe(false)
    expect(chatsA.logicalMessages[LOGICAL_OUT_1]).toEqual(
      chatsB.logicalMessages[LOGICAL_OUT_1],
    )
  })

  it('recordLogicalMessage is commutative, associative, idempotent, and independent of Date.now()', () => {
    const rev1 = '11'.repeat(32)
    const rev2 = '22'.repeat(32)
    const m1 = {
      outbound: true,
      status: 'sending' as const,
      items: [{ type: 'text' as const, text: 'v1' }],
      serverTime: 2_000,
      receivedTime: 2_000,
      outpoints: [],
      senderAddress: OWN_ADDRESS,
      destinationAddress: PEER_ADDRESS,
      payloadDigest: rev1,
      conversationId: CONV_ID,
      logicalMessageId: LOGICAL_OUT_1,
      revisionDigest: rev1,
      deliveryDigest: rev1,
    }
    const m2 = {
      outbound: true,
      status: 'confirmed' as const,
      items: [{ type: 'text' as const, text: 'v1' }],
      serverTime: 1_000,
      receivedTime: 1_000,
      outpoints: [],
      senderAddress: OWN_ADDRESS,
      destinationAddress: PEER_ADDRESS,
      payloadDigest: rev1,
      conversationId: CONV_ID,
      logicalMessageId: LOGICAL_OUT_1,
      revisionDigest: rev1,
      deliveryDigest: rev1,
    }
    const m3 = {
      outbound: true,
      status: 'confirmed' as const,
      items: [{ type: 'text' as const, text: 'v2' }],
      serverTime: 1_500,
      receivedTime: 1_500,
      outpoints: [],
      senderAddress: OWN_ADDRESS,
      destinationAddress: PEER_ADDRESS,
      payloadDigest: rev2,
      conversationId: CONV_ID,
      logicalMessageId: LOGICAL_OUT_1,
      revisionDigest: rev2,
      deliveryDigest: rev2,
    }

    const perms = allPermutations([m1, m2, m3])
    let refRecord: unknown
    for (const perm of perms) {
      const map: Record<string, never> = {}
      for (const msg of perm) {
        recordLogicalMessage(map, msg, CONV_ID)
        // Idempotence: applying the same message twice does not change the state
        recordLogicalMessage(map, msg, CONV_ID)
      }
      if (!refRecord) {
        refRecord = map[LOGICAL_OUT_1]
      } else {
        expect(map[LOGICAL_OUT_1]).toEqual(refRecord)
      }
    }
  })
})
