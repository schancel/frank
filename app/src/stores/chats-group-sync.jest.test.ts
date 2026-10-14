/** @jest-environment jsdom */
import {
  GROUP_TEST_ACCOUNTS,
  groupTestSigner,
} from '@frank/cashweb/groups/group-test.testutil'
import { accountSession } from '../accounts/session'
import { fetchContactProfile } from '../utils/directory-peer'
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
    getIterator: jest.fn(async () => []),
  }),
}))
jest.mock('../utils/directory-peer', () => ({ fetchContactProfile: jest.fn() }))
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))

const [ALICE, BOB, CHARLIE, DAVE] = GROUP_TEST_ACCOUNTS.map(
  account => account.address,
)

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
const {
  useChatStore,
  rehydrateChat,
  setConversationIdSalt,
} = require('./chats')
const messageStorePromise = require('../adapters/level-message-store').store
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
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epochs$/)
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
              ...body,
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
            versionstamp: serverSeq.toString(16).padStart(20, '0'),
            server_time_ms: 1700000000000 + serverSeq * 1000,
          }
          list.push(row)
          messages.set(groupId, list)
          return {
            data: {
              ...row,
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
        const epochMatch = url.match(/\/groups\/([0-9a-f]{64})\/epochs$/)
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
    setConversationIdSalt(new Uint8Array(16).fill(0x71))
    currentOwnAddress = ALICE
    setActivePinia(createPinia())
    jest
      .spyOn(accountSession, 'getCurvePublicKey')
      .mockImplementation(
        async () =>
          GROUP_TEST_ACCOUNTS.find(
            account => account.address === currentOwnAddress,
          )!.publicKey,
      )
    jest
      .spyOn(accountSession, 'getGroupSigner')
      .mockImplementation(async (groupIdHex, epoch) =>
        groupTestSigner(currentOwnAddress, groupIdHex, epoch),
      )
    jest.mocked(fetchContactProfile).mockImplementation(async address => {
      const account = GROUP_TEST_ACCOUNTS.find(
        account => account.address === address.raw.toLowerCase(),
      )!
      return { address, pubKey: account.publicKey }
    })
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

    const unsolicited = (index: string) => ({
      index,
      conversationId: aliceGroup.id,
      outbound: false,
      senderAddress: DAVE,
      copartyAddress: DAVE,
      copartyPubKey: { toBuffer: () => GROUP_TEST_ACCOUNTS[3].publicKey },
      stampValue: 0,
      message: {
        conversationId: aliceGroup.id,
        outbound: false,
        status: 'confirmed',
        senderAddress: DAVE,
        destinationAddress: BOB,
        items: [{ type: 'text', text: index }],
        stampValueWei: 123n,
        serverTime: 900,
        receivedTime: 900,
        outpoints: [],
      },
    })
    await bobChats.receiveMessages([unsolicited('preemptive-dm')], BOB)
    expect(bobChats.conversations[aliceGroup.id]).toBeUndefined()
    const daveDirect = Object.values(bobChats.conversations).find(
      (conv: any) => conv.address.toLowerCase() === DAVE.toLowerCase(),
    ) as any
    expect(daveDirect.kind).toBe('direct')
    expect(daveDirect.messages[0].stampValueWei).toBe(123n)

    const welcomeItem: GroupWelcomeItem = {
      type: 'group-welcome',
      epochFrame: aliceGroup.groupState!.epochFrame,
      groupId: aliceGroup.groupId!,
      groupPubKey: aliceGroup.groupPubKey!,
      groupName: aliceGroup.name!,
      homeRelay: 'https://relay.frank.test',
      epoch: 0,
      epochSecretHex: aliceGroup.groupEpochSecretHex!,
      memberIndex: 1,
      inviterAddress: ALICE,
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
    await bobChats.receiveMessages([unsolicited('pending-invite-dm')], BOB)
    expect(bobGroup.messages).toHaveLength(0)
    expect(bobGroup.pendingParticipantRequests).toBeUndefined()
    expect(daveDirect.messages).toHaveLength(2)
    bobChats.declineGroupInvite(bobGroup.id)
    await bobChats.receiveMessages([unsolicited('declined-invite-dm')], BOB)
    expect(bobGroup.messages).toHaveLength(0)
    expect(daveDirect.messages).toHaveLength(3)
    // A local decline never turns direct messages into authenticated group messages.
    bobGroup.membershipStatus = 'invited'

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
  async function makeGroup(client = createSharedMockGroupRelay()) {
    currentOwnAddress = ALICE
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', client)
    const group = await chats.createGroupConversation({
      groupName: 'Boundary Test',
      memberAddresses: [BOB],
      relayUrl: 'https://relay.frank.test',
      relayClient: client,
      creatorAddress: ALICE,
    })
    return { chats, group, client }
  }
  async function inviteBob(
    group: ReturnType<typeof useChatStore>['conversations'][string],
    client: GroupRelayClient,
  ) {
    currentOwnAddress = BOB
    setActivePinia(createPinia())
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', client)
    jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
    const item: GroupWelcomeItem = {
      type: 'group-welcome',
      groupId: group.groupId!,
      groupPubKey: group.groupPubKey!,
      groupName: group.name!,
      homeRelay: group.groupRelayUrl!,
      epoch: group.groupState!.epoch,
      epochSecretHex: group.groupState!.epochSecretHex,
      epochFrame: group.groupState!.epochFrame,
      memberIndex: group.groupState!.roster.find(
        member => member.address === BOB,
      )!.index,
      inviterAddress: ALICE,
    }
    await chats.receiveMessages(
      [
        {
          index: 'signed-invite',
          conversationId: '11111111-1111-4111-8111-111111111111',
          outbound: false,
          senderAddress: ALICE,
          copartyAddress: ALICE,
          copartyPubKey: { toBuffer: () => GROUP_TEST_ACCOUNTS[0].publicKey },
          stampValue: 0,
          message: {
            outbound: false,
            status: 'confirmed',
            senderAddress: ALICE,
            destinationAddress: BOB,
            items: [item],
            conversationId: '11111111-1111-4111-8111-111111111111',
            serverTime: 1000,
            receivedTime: 1000,
            outpoints: [],
          },
        },
      ],
      BOB,
    )
    return { chats, group: chats.conversations[group.id] }
  }

  it('persists the original prepared epoch before PUT and reconciles acceptance after restart', async () => {
    const client = createSharedMockGroupRelay()
    const chats = useChatStore()
    let snapshot: Record<string, unknown> | undefined
    chats.flushPersistence = jest.fn(async () => {
      snapshot = JSON.parse(
        JSON.stringify({
          conversations: chats.conversations,
          lastReceived: chats.lastReceived ?? 0,
        }),
      )
    })
    const publish = client.publishEpoch.bind(client)
    jest
      .spyOn(client, 'publishEpoch')
      .mockImplementationOnce(async (...args) => {
        const saved = Object.values(
          snapshot!.conversations as Record<
            string,
            {
              groupState: {
                pendingEpoch: { certificate: { epoch_hash: string } }
              }
            }
          >,
        )[0]
        expect(saved.groupState.pendingEpoch.certificate.epoch_hash).toBe(
          args[1].epoch_hash,
        )
        await publish(...args)
        throw new Error('response interrupted after acceptance')
      })
    jest
      .spyOn(client, 'getLatestEpoch')
      .mockRejectedValueOnce(new Error('temporarily offline'))
    const { group } = await makeGroup(client)
    expect(group.groupState?.pendingEpoch).toBeDefined()
    const originalHash = group.groupState!.epochFrame.epoch_hash
    const originalSecret = group.groupState!.epochSecretHex
    const messageStore = await messageStorePromise
    messageStore.getIterator.mockResolvedValueOnce([])
    const restored = await rehydrateChat(snapshot)
    setActivePinia(createPinia())
    const reopened = useChatStore()
    reopened.$patch(restored)
    await reopened.retryGroupEpochPublication(group.id, client)
    expect(
      reopened.conversations[group.id].groupState.pendingEpoch,
    ).toBeUndefined()
    expect(
      reopened.conversations[group.id].groupState.epochFrame.epoch_hash,
    ).toBe(originalHash)
    expect(reopened.conversations[group.id].groupState.epochSecretHex).toBe(
      originalSecret,
    )
    expect(client.publishEpoch).toHaveBeenCalledTimes(2)
    expect(client.publishEpoch.mock.calls[1][1].epoch_hash).toBe(originalHash)
  })

  it('keeps failed membership deliveries in epoch order and removes the excluded recipient queue', async () => {
    const { chats, group, client } = await makeGroup()
    await chats.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    await chats.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    expect(
      group.groupState.pendingMemberDeliveries[BOB].map(
        delivery => delivery.items[0].epoch,
      ),
    ).toEqual([0, 1, 2])
    expect(group.groupState.pendingMemberDeliveries[CHARLIE]).toBeUndefined()
    const ids = group.groupState.pendingMemberDeliveries[BOB].map(
      delivery => delivery.operationId,
    )
    expect(new Set(ids).size).toBe(3)
  })

  it('does not advance the cursor when durable incoming receipt fails, then safely retries and reopens', async () => {
    const { chats: alice, group, client } = await makeGroup()
    await alice.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Durable content' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    const { chats: bob, group: bobGroup } = await inviteBob(group, client)
    const messageStore = await messageStorePromise
    messageStore.saveMessage.mockRejectedValueOnce(
      new Error('disk interrupted'),
    )
    bob.approveGroupInvite(group.id)
    await expect(
      bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).rejects.toThrow('disk interrupted')
    expect(bobGroup.groupState.lastSyncedSeq).toBe(0)
    expect(bobGroup.messages).toHaveLength(0)
    expect(
      await bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).toBe(1)
    expect(
      await bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).toBe(0)
    const rows = messageStore.saveMessage.mock.calls
      .filter(([row]) => row.message.conversationId === group.id)
      .map(([row]) => row)
    messageStore.getIterator.mockResolvedValueOnce([rows[rows.length - 1]])
    const metadata = JSON.parse(
      JSON.stringify({
        conversations: { [group.id]: { ...bobGroup, messages: [] } },
        lastReceived: bob.lastReceived,
      }),
    )
    jest.mocked(accountSession.getGroupSigner).mockClear()
    const restored = await rehydrateChat(metadata)
    expect(restored.conversations[group.id].messages[0].items).toEqual([
      { type: 'text', text: 'Durable content' },
    ])
    expect(restored.conversations[group.id].groupState.lastSyncedSeq).toBe(1)
    expect(accountSession.getGroupSigner).not.toHaveBeenCalled()
  })

  it('retains the exact signed envelope after an uncertain send and retries it without new encryption', async () => {
    const { chats, group, client } = await makeGroup()
    const send = client.sendGroupMessage.bind(client)
    jest
      .spyOn(client, 'sendGroupMessage')
      .mockImplementationOnce(async (...args) => {
        await send(...args)
        throw new Error('response lost')
      })
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Once' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome.state).toBe('failed')
    const digest = Object.keys(group.groupState.pendingMessages)[0]
    const originalEnvelope = JSON.stringify(
      chats.messages[digest].groupEnvelope,
    )
    const retried = await chats.retryGroupMessage(group.id, digest, client)
    expect(retried.state).toBe('sent')
    expect(JSON.stringify(client.sendGroupMessage.mock.calls[1][1])).toBe(
      originalEnvelope,
    )
    expect(group.messages).toHaveLength(1)
    expect(group.groupState.pendingMessages[digest]).toBeUndefined()
  })

  it('rejects payment intent at the headless group boundary before submission', async () => {
    const { chats, group, client } = await makeGroup()
    const send = jest.spyOn(client, 'sendGroupMessage')
    await expect(
      chats.sendMessage({
        wallet: {},
        address: group.address,
        conversationId: group.id,
        items: [{ type: 'text', text: 'Must not pretend to pay' }],
        stampValue: 1n,
      }),
    ).rejects.toThrow('Group payments are unsupported')
    await expect(
      chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'stealth', amount: 1 }],
        relayClient: client,
        senderAddress: ALICE,
      }),
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects obsolete unsigned saved group metadata without custody access or deletion', async () => {
    const { group } = await makeGroup()
    const saved = JSON.parse(JSON.stringify(group))
    delete saved.groupState.epochFrame
    jest.mocked(accountSession.getGroupSigner).mockClear()
    const messageStore = await messageStorePromise
    messageStore.getIterator.mockResolvedValueOnce([])
    const deletes = messageStore.deleteMessage.mock.calls.length
    await expect(
      rehydrateChat({ conversations: { [group.id]: saved }, lastReceived: 0 }),
    ).rejects.toThrow('Unsupported stored group format')
    expect(accountSession.getGroupSigner).not.toHaveBeenCalled()
    expect(messageStore.deleteMessage.mock.calls.length).toBe(deletes)
  })
})
