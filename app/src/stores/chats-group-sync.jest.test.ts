/** @jest-environment jsdom */
import { createPinia, setActivePinia } from 'pinia'
import type { AxiosInstance } from 'axios'
import {
  GroupRelayClient,
  type StoredGroupMessageWire,
} from '@frank/cashweb/groups'
import type {
  GroupWelcomeItem,
  GroupControlItem,
} from '@frank/cashweb/types/messages'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* empty */
    },
  }),
}))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const CHARLIE = '0x3333333333333333333333333333333333333333'
const DAVE = '0x4444444444444444444444444444444444444444'

let currentOwnAddress = ALICE
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: async () => currentOwnAddress,
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref(currentOwnAddress),
}))

import { TextDecoder, TextEncoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })
/* eslint-disable @typescript-eslint/no-var-requires */
const { useChatStore } = require('./chats')
const { useContactStore } = require('./contacts')

function createSharedMockGroupRelay() {
  const epochs = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, StoredGroupMessageWire[]>()

  const axiosMock = {
    put: jest.fn(
      async (
        url: string,
        body: Record<string, unknown>,
        config?: { headers?: Record<string, string> },
      ) => {
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epoch$/)
        if (epochMatch) {
          const groupId = epochMatch[1]
          const current = epochs.get(groupId)
          const epochNum = Number(body.epoch ?? 0)
          if (epochNum === 0 && current) {
            throw new Error('Group already exists')
          }
          if (epochNum > 0) {
            const ifMatch = config?.headers?.['If-Match']
            if (!current || current.epoch_hash !== ifMatch) {
              throw new Error('CAS mismatch')
            }
          }
          epochs.set(groupId, { ...body, group_id: groupId })
          return {
            data: {
              status: 'ok',
              group_id: groupId,
              epoch: epochNum,
              epoch_hash: String(body.epoch_hash ?? ''),
            },
          }
        }
        const msgMatch = url.match(/\/groups\/([0-9a-f]{64})\/messages$/)
        if (msgMatch) {
          const groupId = msgMatch[1]
          const list = messages.get(groupId) ?? []
          const serverSeq = list.length + 1
          const row: StoredGroupMessageWire = {
            group_id: groupId,
            server_seq: serverSeq,
            epoch: Number(body.epoch),
            nonce: String(body.nonce),
            ciphertext: String(body.ciphertext),
            write_sig: String(body.write_sig),
            received_at_ms: 1700000000000 + serverSeq * 1000,
          }
          list.push(row)
          messages.set(groupId, list)
          return {
            data: {
              status: 'ok',
              group_id: groupId,
              server_seq: serverSeq,
              received_at_ms: row.received_at_ms,
            },
          }
        }
        throw new Error(`Unhandled PUT: ${url}`)
      },
    ),
    get: jest.fn(
      async (
        url: string,
        config?: {
          headers?: Record<string, string>
          params?: Record<string, unknown>
        },
      ) => {
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epoch$/)
        if (epochMatch) {
          const stored = epochs.get(epochMatch[1])
          if (!stored) throw new Error('Group not found')
          return { data: stored }
        }
        const msgMatch = url.match(/\/groups\/([0-9a-f]{64})\/messages$/)
        if (msgMatch) {
          const groupId = msgMatch[1]
          const afterSeq = Number(config?.params?.after_seq ?? 0)
          const list = (messages.get(groupId) ?? []).filter(
            m => m.server_seq > afterSeq,
          )
          return {
            data: {
              group_id: groupId,
              epoch: Number(epochs.get(groupId)?.epoch ?? 0),
              messages: list,
            },
          }
        }
        throw new Error(`Unhandled GET: ${url}`)
      },
    ),
  }

  return new GroupRelayClient('https://relay.frank.test', {
    axiosInstance: axiosMock as unknown as AxiosInstance,
  })
}

describe('stores/chats.ts — End-to-End Group Chat Sync & Roster Rotation (#70, #1365)', () => {
  beforeEach(() => {
    currentOwnAddress = ALICE
    setActivePinia(createPinia())
    const contacts = useContactStore()
    jest.spyOn(contacts, 'refresh').mockResolvedValue(undefined)
  })

  it('creates a group on relay, quarantines welcome invite for Bob until approved, and syncs sealed multi-sender messages', async () => {
    const relayClient = createSharedMockGroupRelay()

    // 1. Alice creates the group with Bob and Charlie
    const alicePinia = createPinia()
    setActivePinia(alicePinia)
    const aliceChats = useChatStore()
    aliceChats.setGroupRelayClient('https://relay.frank.test', relayClient)

    const aliceGroup = await aliceChats.createGroupConversation({
      groupName: 'Frank Protocol Working Group',
      memberAddresses: [BOB, CHARLIE],
      relayUrl: 'https://relay.frank.test',
      relayClient,
      creatorAddress: ALICE,
    })

    expect(aliceGroup.kind).toBe('group')
    expect(aliceGroup.membershipStatus).toBe('joined')
    expect(aliceGroup.name).toBe('Frank Protocol Working Group')
    expect(aliceGroup.address).toMatch(/^group:[0-9a-f]{64}$/)
    expect(aliceGroup.groupState?.epoch).toBe(0)
    expect(aliceGroup.groupState?.roster).toHaveLength(3)
    expect(aliceChats.shouldPollGroupMailbox(aliceGroup.id)).toBe(true)

    // 2. Alice sends an encrypted group message to the shared mailbox
    const sendOutcome = await aliceChats.sendGroupMessage({
      conversationId: aliceGroup.id,
      items: [{ type: 'text', text: 'Welcome to epoch 0!' }],
      relayClient,
      senderAddress: ALICE,
    })
    expect(sendOutcome.state).toBe('sent')
    expect(aliceGroup.messages).toHaveLength(1)
    expect(aliceGroup.messages[0]?.status).toBe('confirmed')

    // 3. Bob receives the GroupWelcomeItem DM on his device
    currentOwnAddress = BOB
    const bobPinia = createPinia()
    setActivePinia(bobPinia)
    const bobChats = useChatStore()
    bobChats.setGroupRelayClient('https://relay.frank.test', relayClient)
    jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)

    const welcomeItem: GroupWelcomeItem = {
      type: 'group-welcome',
      groupId: aliceGroup.groupId!,
      groupPubKey: aliceGroup.groupPubKey!,
      groupName: aliceGroup.name!,
      homeRelay: 'https://relay.frank.test',
      epoch: 0,
      epochSecretHex: aliceGroup.groupEpochSecretHex!,
      memberIndex: 1,
      inviterAddress: ALICE,
      rosterMembers: aliceGroup.groupState!.roster.map(m => ({ ...m })),
    }

    await bobChats.receiveMessages(
      [
        {
          index: 'welcome-dm-1',
          conversationId: '11111111-1111-4111-8111-111111111111',
          outbound: false,
          senderAddress: ALICE,
          copartyAddress: ALICE,
          copartyPubKey: { toBuffer: () => new Uint8Array(33).fill(2) },
          stampValue: 0,
          message: {
            conversationId: '11111111-1111-4111-8111-111111111111',
            outbound: false,
            status: 'confirmed',
            senderAddress: ALICE,
            destinationAddress: BOB,
            items: [welcomeItem],
            serverTime: 1000,
            receivedTime: 1000,
            outpoints: [],
          },
        },
      ],
      BOB,
    )

    const bobGroup = bobChats.conversations[aliceGroup.id]
    expect(bobGroup).toBeDefined()
    expect(bobGroup.kind).toBe('group')
    expect(bobGroup.membershipStatus).toBe('invited')
    expect(bobGroup.invitedBy.toLowerCase()).toBe(ALICE.toLowerCase())
    // While quarantined in 'invited' status, Bob MUST NOT poll the group mailbox
    expect(bobChats.shouldPollGroupMailbox(bobGroup.id)).toBe(false)
    expect(
      await bobChats.syncGroupConversation(bobGroup.id, {
        relayClient,
        ownAddress: BOB,
      }),
    ).toBe(0)

    // 4. Bob approves the group invitation and syncs the shared mailbox
    bobChats.approveGroupInvite(bobGroup.id)
    expect(bobGroup.membershipStatus).toBe('joined')
    expect(bobChats.shouldPollGroupMailbox(bobGroup.id)).toBe(true)

    await bobChats.syncGroupConversation(bobGroup.id, {
      relayClient,
      ownAddress: BOB,
    })
    expect(bobGroup.messages).toHaveLength(1)
    expect(bobGroup.messages[0]?.senderAddress.toLowerCase()).toBe(
      ALICE.toLowerCase(),
    )
    expect(bobGroup.messages[0]?.outbound).toBe(false)
    expect(bobGroup.messages[0]?.items).toEqual([
      { type: 'text', text: 'Welcome to epoch 0!' },
    ])

    // 5. Bob replies in the group and Alice syncs via syncAllJoinedGroups
    const bobReply = await bobChats.sendGroupMessage({
      conversationId: bobGroup.id,
      items: [{ type: 'text', text: 'Hi Alice, Bob here!' }],
      relayClient,
      senderAddress: BOB,
    })
    expect(bobReply.state).toBe('sent')

    currentOwnAddress = ALICE
    setActivePinia(alicePinia)
    const syncedCount = await aliceChats.syncAllJoinedGroups({
      relayClient,
      ownAddress: ALICE,
    })
    expect(syncedCount).toBe(1)
    expect(aliceGroup.messages).toHaveLength(2)
    expect(aliceGroup.messages[1]?.senderAddress.toLowerCase()).toBe(
      BOB.toLowerCase(),
    )
    expect(aliceGroup.messages[1]?.outbound).toBe(false)
    expect(aliceGroup.messages[1]?.items).toEqual([
      { type: 'text', text: 'Hi Alice, Bob here!' },
    ])
  })

  it('invites a new member and removes a member with forward-secret epoch rotation', async () => {
    const relayClient = createSharedMockGroupRelay()
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', relayClient)

    const groupConv = await chats.createGroupConversation({
      groupName: 'Epoch Rotation Group',
      memberAddresses: [BOB, CHARLIE],
      relayUrl: 'https://relay.frank.test',
      relayClient,
      creatorAddress: ALICE,
    })
    const epoch0Secret = groupConv.groupEpochSecretHex!
    expect(groupConv.groupState?.epoch).toBe(0)

    // Invite Dave -> ratchets to epoch 1
    await chats.inviteMemberToGroup({
      conversationId: groupConv.id,
      memberAddress: DAVE,
      relayClient,
    })
    expect(groupConv.groupState?.epoch).toBe(1)
    expect(groupConv.epoch?.generation).toBe(1)
    expect(groupConv.groupEpochSecretHex).not.toBe(epoch0Secret)
    expect(
      groupConv.participants.some(p => p.toLowerCase() === DAVE.toLowerCase()),
    ).toBe(true)

    // Remove Charlie -> rotates to epoch 2 with fresh entropy
    const epoch1Secret = groupConv.groupEpochSecretHex!
    await chats.removeMemberFromGroup({
      conversationId: groupConv.id,
      memberAddress: CHARLIE,
      relayClient,
    })
    expect(groupConv.groupState?.epoch).toBe(2)
    expect(groupConv.epoch?.generation).toBe(2)
    expect(groupConv.groupEpochSecretHex).not.toBe(epoch1Secret)
    expect(
      groupConv.participants.some(
        p => p.toLowerCase() === CHARLIE.toLowerCase(),
      ),
    ).toBe(false)

    // Send a message in epoch 2 and verify it seals & confirms cleanly
    const postKickMsg = await chats.sendGroupMessage({
      conversationId: groupConv.id,
      items: [{ type: 'text', text: 'Post-rotation message in epoch 2' }],
      relayClient,
      senderAddress: ALICE,
    })
    expect(postKickMsg.state).toBe('sent')
    expect(groupConv.messages).toHaveLength(1)

    // Leave group locally
    chats.leaveGroupConversation(groupConv.id)
    expect(groupConv.membershipStatus).toBe('left')
    expect(chats.shouldPollGroupMailbox(groupConv.id)).toBe(false)
  })
})
