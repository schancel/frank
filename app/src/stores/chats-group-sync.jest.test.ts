/** @jest-environment jsdom */
import type {
  GroupWelcomeItem,
  GroupControlItem,
} from '@frank/group-messaging/types'
import {
  GROUP_TEST_ACCOUNTS,
  groupTestSigner,
  groupTestSigningKey,
} from '@frank/cashweb/groups/group-test.testutil'
import {
  GROUP_MSG_AEAD_DOMAIN,
  bytesToHex,
  computeOuterWriteSigningHash,
  deriveEpochKeys,
  hexToBytes,
  sealGroupMessage,
} from '@frank/cashweb/groups/group-crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { encodeGroupItems } from '../utils/group-message-items'
import { accountSession } from '../accounts/session'
import { fetchContactProfile } from '../utils/directory-peer'
import { createPinia, setActivePinia } from 'pinia'
import type { AxiosInstance } from 'axios'
import {
  GroupRelayClient,
  type StoredGroupMessageWire,
} from '@frank/cashweb/groups'

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
  const history = new Map<string, Record<string, unknown>>()
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
          history.set(`${groupId}:${epochNum}`, { ...body, group_id: groupId })
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
          const requested = config?.params?.epoch
          const stored =
            requested === undefined
              ? epochs.get(epochMatch[1])
              : history.get(`${epochMatch[1]}:${requested}`)
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
    recipient = BOB,
    existingChats?: ReturnType<typeof useChatStore>,
  ) {
    currentOwnAddress = recipient
    setActivePinia(createPinia())
    const chats = existingChats ?? useChatStore()
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
        member => member.address === recipient,
      )!.index,
      inviterAddress: ALICE,
    }
    await chats.receiveMessages(
      [
        {
          index: `signed-invite-${group.groupState!.epoch}`,
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
            destinationAddress: recipient,
            items: [item],
            conversationId: '11111111-1111-4111-8111-111111111111',
            serverTime: 1000 + group.groupState!.epoch,
            receivedTime: 1000 + group.groupState!.epoch,
            outpoints: [],
          },
        },
      ],
      recipient,
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

  it('rejects direction-control names before persistence and restores valid Unicode names exactly', async () => {
    const client = createSharedMockGroupRelay()
    const chats = useChatStore()
    const publish = jest.spyOn(client, 'publishEpoch')
    for (const groupName of ['A\u202eB', 'A\u2066B']) {
      await expect(
        chats.createGroupConversation({
          groupName,
          memberAddresses: [BOB],
          relayUrl: client.relayUrl,
          relayClient: client,
          creatorAddress: ALICE,
        }),
      ).rejects.toThrow(/group.*name/i)
    }
    expect(Object.keys(chats.conversations)).toHaveLength(0)
    expect(publish).not.toHaveBeenCalled()
    const group = await chats.createGroupConversation({
      groupName: '  Équipe العربية  ',
      memberAddresses: [BOB],
      relayUrl: client.relayUrl,
      relayClient: client,
      creatorAddress: ALICE,
    })
    expect(group.name).toBe('Équipe العربية')
    const store = await messageStorePromise
    store.getIterator.mockResolvedValueOnce([])
    const restored = await rehydrateChat(chats.$state)
    expect(restored.conversations[group.id].name).toBe(group.name)
  })

  it('rejects unsupported relay origins before signing or persisting a group', async () => {
    const chats = useChatStore()
    expect(() =>
      chats.configureGroupHomeRelay('https://home.example/api'),
    ).toThrow(/relay URL/)
    chats.configureGroupHomeRelay('https://home.example')
    chats.flushPersistence = jest.fn(async () => undefined)
    await expect(
      chats.createGroupConversation({
        groupName: 'Invalid origin',
        memberAddresses: [BOB],
        relayUrl: 'https://relay.example/api',
        creatorAddress: ALICE,
      }),
    ).rejects.toThrow(/relay URL/)
    expect(Object.keys(chats.conversations)).toEqual([])
    expect(chats.flushPersistence).not.toHaveBeenCalled()
  })

  it('never publishes an epoch while its durable persistence barrier is rejected', async () => {
    const client = createSharedMockGroupRelay()
    const chats = useChatStore()
    const publish = jest.spyOn(client, 'publishEpoch')
    chats.flushPersistence = jest.fn(async () => {
      throw new Error('disk unavailable')
    })
    await expect(
      chats.createGroupConversation({
        groupName: 'Durability',
        memberAddresses: [BOB],
        relayUrl: client.relayUrl,
        relayClient: client,
        creatorAddress: ALICE,
      }),
    ).rejects.toThrow('disk unavailable')
    const group = Object.values(chats.conversations).find(
      (conv: any) => conv.kind === 'group',
    ) as any
    expect(group.groupState.pendingEpoch).toBeDefined()
    await expect(
      chats.retryGroupEpochPublication(group.id, client),
    ).rejects.toThrow('disk unavailable')
    expect(publish).not.toHaveBeenCalled()
    chats.flushPersistence = jest.fn(async () => undefined)
    await chats.retryGroupEpochPublication(group.id, client)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('requires the original message receipt to be durable before every retry', async () => {
    const { chats, group, client } = await makeGroup()
    const store = await messageStorePromise
    const send = jest.spyOn(client, 'sendGroupMessage')
    store.saveMessage.mockRejectedValueOnce(
      new Error('receipt disk unavailable'),
    )
    await expect(
      chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Original' }],
        relayClient: client,
        senderAddress: ALICE,
      }),
    ).rejects.toThrow('receipt disk unavailable')
    const digest = Object.keys(group.groupState.pendingMessages)[0]
    const original = JSON.stringify(chats.messages[digest].groupEnvelope)
    store.saveMessage.mockRejectedValueOnce(
      new Error('receipt still unavailable'),
    )
    await expect(
      chats.retryGroupMessage(group.id, digest, client),
    ).rejects.toThrow('receipt still unavailable')
    expect(send).not.toHaveBeenCalled()
    await chats.retryGroupMessage(group.id, digest, client)
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(send.mock.calls[0][1])).toBe(original)
  })

  it('rejects unsigned generic subject edits for certificate-owned group names', async () => {
    const { chats, group } = await makeGroup()
    expect(() =>
      chats.renameConversation(group.id, 'Unsigned replacement'),
    ).toThrow(/group/i)
    expect(group.name).toBe('Boundary Test')
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

  it('rebuilds pending retry references from durable signed receipts after interrupted metadata persistence', async () => {
    const { chats, group, client } = await makeGroup()
    const metadata = JSON.parse(JSON.stringify(chats.$state))
    const store = await messageStorePromise
    const rows: any[] = []
    store.saveMessage.mockImplementation(async (row: any) => {
      rows.push(
        JSON.parse(
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
      )
    })
    chats.flushPersistence = jest.fn(async () => {
      throw new Error('metadata unavailable')
    })
    await expect(
      chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Recover original' }],
        relayClient: client,
        senderAddress: ALICE,
      }),
    ).rejects.toThrow('metadata unavailable')
    const digest = Object.keys(group.groupState.pendingMessages)[0]
    const original = JSON.stringify(chats.messages[digest].groupEnvelope)
    const send = jest.spyOn(client, 'sendGroupMessage')
    expect(send).not.toHaveBeenCalled()
    store.getIterator.mockResolvedValueOnce(rows)
    const restored = await rehydrateChat(metadata)
    expect(
      restored.conversations[group.id].groupState.pendingMessages[digest],
    ).toBe(true)
    setActivePinia(createPinia())
    const reopened = useChatStore()
    reopened.$patch(restored)
    await reopened.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(send.mock.calls[0][1])).toBe(original)
    expect(reopened.messages[digest].status).toBe('confirmed')
    await reopened.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    expect(send).toHaveBeenCalledTimes(1)
    store.saveMessage.mockImplementation(async () => undefined)
  })

  it('validates opaque pre-join history before reaching new messages and preserves the join boundary on restart', async () => {
    const { chats: alice, group, client } = await makeGroup()
    const { chats: bob, group: bobGroup } = await inviteBob(group, client)
    bob.approveGroupInvite(group.id)
    currentOwnAddress = ALICE
    await alice.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Before join' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    await alice.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    await alice.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'After join' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    await inviteBob(group, client, BOB, bob)
    expect(
      await bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).toBe(2)
    expect(
      bobGroup.messages.map((message: any) => message.items[0].text),
    ).toEqual(['Before join', 'After join'])
    expect(bobGroup.groupState.epochHistory[0]).toBeDefined()
    const { chats: charlie, group: joined } = await inviteBob(
      group,
      client,
      CHARLIE,
    )
    charlie.approveGroupInvite(group.id)
    const fetch = client.fetchGroupMessages.bind(client)
    jest
      .spyOn(client, 'fetchGroupMessages')
      .mockImplementationOnce(async (...args) => {
        const batch = await fetch(...args)
        return {
          ...batch,
          messages: batch.messages.map((row, index) =>
            index ? row : { ...row, write_sig: '00'.repeat(64) },
          ),
        }
      })
    await expect(
      charlie.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: CHARLIE,
      }),
    ).rejects.toThrow()
    expect(joined.groupState.lastSyncedSeq).toBe(0)
    expect(
      await charlie.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: CHARLIE,
      }),
    ).toBe(1)
    expect(
      joined.messages.map((message: any) => message.items[0].text),
    ).toEqual(['After join'])
    expect(joined.groupState.epochHistory[0]).toBeUndefined()
    expect(joined.groupState.lastSyncedSeq).toBe(2)
    const store = await messageStorePromise
    store.getIterator.mockResolvedValueOnce([
      {
        message: joined.messages[0],
        index: joined.messages[0].payloadDigest,
        outbound: false,
        senderAddress: ALICE,
        copartyAddress: joined.address,
      },
    ])
    const restored = await rehydrateChat(charlie.$state)
    expect(restored.conversations[group.id].groupState.lastSyncedSeq).toBe(2)
    expect(restored.conversations[group.id].messages).toHaveLength(1)
    expect(
      restored.conversations[group.id].groupState.epochHistory[0],
    ).toBeUndefined()
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
  it('adopts the winning epoch when another administrator device wins the rotation race', async () => {
    const { chats: laptop, group, client } = await makeGroup()
    // A second device of the same administrator account starts from the same saved state.
    const saved = JSON.parse(JSON.stringify(laptop.$state))
    setActivePinia(createPinia())
    const phone = useChatStore()
    phone.$patch(saved)
    const relayPublish = client.publishEpoch.bind(client)
    jest
      .spyOn(client, 'publishEpoch')
      .mockImplementationOnce(async (...args) => {
        // The phone publishes a different successor between the laptop's read and its CAS.
        await phone.inviteMemberToGroup({
          conversationId: group.id,
          memberAddress: DAVE,
          relayClient: client,
        })
        return relayPublish(...args)
      })
    const getLatest = jest.spyOn(client, 'getLatestEpoch')
    await expect(
      laptop.inviteMemberToGroup({
        conversationId: group.id,
        memberAddress: CHARLIE,
        relayClient: client,
      }),
    ).rejects.toThrow('Group membership changed on another device; try again')
    expect(getLatest).toHaveBeenCalled()
    const winner = phone.conversations[group.id].groupState
    const state = laptop.conversations[group.id].groupState
    expect(state.epoch).toBe(1)
    expect(state.epochFrame.epoch_hash).toBe(winner.epochFrame.epoch_hash)
    expect(state.epochSecretHex).toBe(winner.epochSecretHex)
    expect(state.roster.map((member: any) => member.address)).toEqual(
      winner.roster.map((member: any) => member.address),
    )
    expect(state.roster.some((member: any) => member.address === DAVE)).toBe(
      true,
    )
    expect(state.pendingEpoch).toBeUndefined()
    // The losing roster's deliveries were never sent and are dropped with it.
    expect(state.pendingMemberDeliveries[CHARLIE]).toBeUndefined()
    expect(
      state.pendingMemberDeliveries[BOB].map(
        (delivery: any) => delivery.items[0].epoch,
      ),
    ).toEqual([0])
    // Sync and send work again.
    await expect(
      laptop.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: ALICE,
      }),
    ).resolves.toBe(0)
    const sent = await laptop.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'After the race' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(sent.state).toBe('sent')
    // The winner's own group-control reaches this device later and applies idempotently.
    const control = winner.pendingMemberDeliveries[ALICE].at(-1).items[0]
    expect(control.type).toBe('group-control')
    await laptop.receiveMessages(
      [
        {
          index: 'winner-control',
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
            destinationAddress: ALICE,
            items: [control],
            conversationId: '11111111-1111-4111-8111-111111111111',
            serverTime: 5000,
            receivedTime: 5000,
            outpoints: [],
          },
        },
      ],
      ALICE,
    )
    expect(laptop.messages['winner-control'].items[0].type).toBe(
      'group-control',
    )
    expect(
      laptop.conversations[group.id].groupState.epochFrame.epoch_hash,
    ).toBe(winner.epochFrame.epoch_hash)
    // Retrying the user's action applies it on top of the adopted epoch.
    await laptop.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    expect(laptop.conversations[group.id].groupState.epoch).toBe(2)
    expect(
      laptop.conversations[group.id].groupState.roster.map(
        (member: any) => member.address,
      ),
    ).toEqual(expect.arrayContaining([ALICE, BOB, CHARLIE, DAVE]))
  })

  it('keeps a rotation whose publication response was lost pending, then commits it once the relay shows it', async () => {
    const { chats, group, client } = await makeGroup()
    const relayPublish = client.publishEpoch.bind(client)
    jest
      .spyOn(client, 'publishEpoch')
      .mockImplementationOnce(async (...args) => {
        await relayPublish(...args)
        throw new Error('response interrupted after acceptance')
      })
    const latest = client.getLatestEpoch.bind(client)
    jest
      .spyOn(client, 'getLatestEpoch')
      // The rotation reads the relay's epoch first, then reconciliation is offline.
      .mockImplementationOnce(latest)
      .mockImplementationOnce(async () => {
        throw new Error('temporarily offline')
      })
    await chats.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    const state = chats.conversations[group.id].groupState
    // A timeout is not proof of failure: the prepared epoch stays pending, uncommitted.
    expect(state.epoch).toBe(0)
    const prepared = state.pendingEpoch.certificate.epoch_hash
    expect(state.pendingMemberDeliveries[CHARLIE]).toBeUndefined()
    await expect(
      chats.retryGroupEpochPublication(group.id, client),
    ).resolves.toBe('published')
    const committed = chats.conversations[group.id].groupState
    expect(committed.epoch).toBe(1)
    expect(committed.epochFrame.epoch_hash).toBe(prepared)
    expect(committed.pendingEpoch).toBeUndefined()
    expect(committed.pendingMemberDeliveries[CHARLIE][0].items[0].type).toBe(
      'group-welcome',
    )
  })

  it('collapses a member re-encryption of another member signed message into the original', async () => {
    const client = createSharedMockGroupRelay()
    const alice = useChatStore()
    const group = await alice.createGroupConversation({
      groupName: 'Replay',
      memberAddresses: [BOB, CHARLIE],
      relayUrl: client.relayUrl,
      relayClient: client,
      creatorAddress: ALICE,
    })
    await alice.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Signed once by Alice' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    const original = Object.values(alice.messages)[0] as any
    const { chats: bob, group: bobGroup } = await inviteBob(group, client)
    bob.approveGroupInvite(group.id)
    expect(
      await bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).toBe(1)
    // Bob, a member, re-encrypts Alice's signed inner frame under a fresh nonce and appends it.
    const keys = deriveEpochKeys(
      hexToBytes(bobGroup.groupState.epochSecretHex),
      group.groupId!,
      0,
    )
    const aad = new Uint8Array([
      ...new TextEncoder().encode(GROUP_MSG_AEAD_DOMAIN),
      ...hexToBytes(group.groupId!),
      ...new Uint8Array(8),
    ])
    const inner = xchacha20poly1305(
      keys.encryptionKey,
      hexToBytes(original.groupEnvelope.nonce),
      aad,
    ).decrypt(hexToBytes(original.groupEnvelope.ciphertext))
    const nonce = new Uint8Array(24).fill(0x5a)
    const ciphertext = xchacha20poly1305(
      keys.encryptionKey,
      nonce,
      aad,
    ).encrypt(inner)
    const writeSig = secp256k1
      .sign(
        computeOuterWriteSigningHash({
          groupIdHex: group.groupId!,
          epoch: 0,
          nonce,
          ciphertext,
        }),
        keys.writeKeyPair.privateKey,
        { lowS: true },
      )
      .toCompactRawBytes()
    await client.sendGroupMessage(group.groupId!, {
      epoch: 0,
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
      write_sig: bytesToHex(writeSig),
    })
    const { chats: charlie, group: charlieGroup } = await inviteBob(
      group,
      client,
      CHARLIE,
    )
    charlie.approveGroupInvite(group.id)
    // A member who sees both rows, the original sender, and a third member all show one message.
    expect(
      await bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).toBe(0)
    expect(bobGroup.messages).toHaveLength(1)
    currentOwnAddress = ALICE
    await alice.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    expect(alice.conversations[group.id].messages).toHaveLength(1)
    currentOwnAddress = CHARLIE
    await charlie.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: CHARLIE,
    })
    expect(charlieGroup.groupState.lastSyncedSeq).toBe(2)
    expect(charlieGroup.messages).toHaveLength(1)
    // The first accepted row's relay time is used; the replayed copy changes nothing.
    expect(charlieGroup.messages[0].serverTime).toBe(original.serverTime)
    expect(bobGroup.messages[0].serverTime).toBe(original.serverTime)
  })

  it('orders and reads group messages by relay time, never by a member clock', async () => {
    const client = createSharedMockGroupRelay()
    const alice = useChatStore()
    alice.setGroupRelayClient('https://relay.frank.test', client)
    const group = await alice.createGroupConversation({
      groupName: 'Clocks',
      memberAddresses: [BOB, CHARLIE],
      relayUrl: client.relayUrl,
      relayClient: client,
      creatorAddress: ALICE,
    })
    const { chats: bob } = await inviteBob(group, client)
    bob.approveGroupInvite(group.id)
    await bob.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: BOB,
    })
    const keys = deriveEpochKeys(
      hexToBytes(group.groupState!.epochSecretHex),
      group.groupId!,
      0,
    )
    const post = (sender: string, text: string, timestampMs: number) =>
      client.sendGroupMessage(
        group.groupId!,
        sealGroupMessage({
          epochKeys: keys,
          senderIndex: group.groupState!.roster.find(
            member => member.address === sender,
          )!.index,
          senderEpochKeyPair: groupTestSigningKey(sender, group.groupId!, 0),
          payload: encodeGroupItems([{ type: 'text', text }]),
          timestampMs,
        }),
      )
    const now = Date.now()
    // Charlie's clock runs a day fast. Bob has the group open when it arrives.
    const fast = await post(CHARLIE, 'Fast clock', now + 86_400_000)
    bob.activeConversationId = group.id
    await bob.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: BOB,
    })
    bob.activeConversationId = null
    // Alice writes later, with an accurate clock, while Bob is elsewhere.
    const later = await post(ALICE, 'Accurate clock', now)
    await bob.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: BOB,
    })
    const conv = bob.conversations[group.id]
    expect(
      conv.messages.map((message: any) => [
        message.items[0].text,
        message.serverTime,
      ]),
    ).toEqual([
      ['Fast clock', fast.server_time_ms],
      ['Accurate clock', later.server_time_ms],
    ])
    expect(conv.lastRead).toBe(fast.server_time_ms)
    expect(conv.totalUnreadMessages).toBe(1)
  })

  it('gives our own group message the relay time in place of this device clock', async () => {
    const { chats, group, client } = await makeGroup()
    const sendRow = jest.spyOn(client, 'sendGroupMessage')
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 86_400_000)
    try {
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'From a fast clock' }],
        relayClient: client,
        senderAddress: ALICE,
      })
    } finally {
      clock.mockRestore()
    }
    const row = await sendRow.mock.results[0].value
    const [message] = chats.conversations[group.id].messages
    expect(message.localTime).toBe(false)
    expect(message.serverTime).toBe(row.server_time_ms)
    await chats.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    expect(chats.conversations[group.id].messages).toHaveLength(1)
    expect(chats.conversations[group.id].messages[0].serverTime).toBe(
      row.server_time_ms,
    )
  })

  it('shows a removal superseded after a timeout instead of dropping it, and the user retries it', async () => {
    const { chats: laptop, group, client } = await makeGroup()
    const saved = JSON.parse(JSON.stringify(laptop.$state))
    setActivePinia(createPinia())
    const phone = useChatStore()
    phone.$patch(saved)
    jest.spyOn(client, 'publishEpoch').mockImplementationOnce(async () => {
      // The phone's change wins while the laptop's publication times out unanswered.
      await phone.inviteMemberToGroup({
        conversationId: group.id,
        memberAddress: CHARLIE,
        relayClient: client,
      })
      throw new Error('timeout')
    })
    const latest = client.getLatestEpoch.bind(client)
    jest
      .spyOn(client, 'getLatestEpoch')
      // Both rotations read the relay's epoch first; the laptop's reconciliation is offline.
      .mockImplementationOnce(latest)
      .mockImplementationOnce(latest)
      .mockImplementationOnce(async () => {
        throw new Error('temporarily offline')
      })
    await laptop.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: BOB,
      relayClient: client,
    })
    expect(laptop.conversations[group.id].groupState.pendingEpoch).toBeDefined()
    await laptop.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    const state = laptop.conversations[group.id].groupState
    expect(state.pendingEpoch).toBeUndefined()
    expect(state.epochFrame.epoch_hash).toBe(
      phone.conversations[group.id].groupState.epochFrame.epoch_hash,
    )
    // Bob is still a member, and the user is told so; nothing retried it unasked.
    expect(state.roster.some((member: any) => member.address === BOB)).toBe(
      true,
    )
    expect(state.supersededMemberChange.action).toBe('remove-member')
    expect(state.supersededMemberChange.address.toLowerCase()).toBe(BOB)
    await laptop.retrySupersededMemberChange(group.id, client)
    const retried = laptop.conversations[group.id].groupState
    expect(retried.epoch).toBe(2)
    expect(retried.roster.some((member: any) => member.address === BOB)).toBe(
      false,
    )
    expect(retried.supersededMemberChange).toBeUndefined()
  })

  it('does not accept an older-epoch row after a row of a later epoch', async () => {
    const { chats: alice, group, client } = await makeGroup()
    await alice.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: BOB,
      relayClient: client,
    })
    const state = alice.conversations[group.id].groupState
    expect(state.epoch).toBe(1)
    await alice.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Epoch 1' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    // A colluding relay appends a message the removed member signed in epoch 0.
    const epoch0 = state.epochHistory[0]
    const bobIndex = epoch0.roster.find(
      (member: any) => member.address === BOB,
    ).index
    await client.sendGroupMessage(
      group.groupId!,
      sealGroupMessage({
        epochKeys: deriveEpochKeys(
          hexToBytes(epoch0.epochSecretHex),
          group.groupId!,
          0,
        ),
        senderIndex: bobIndex,
        senderEpochKeyPair: groupTestSigningKey(BOB, group.groupId!, 0),
        payload: encodeGroupItems([{ type: 'text', text: 'After removal' }]),
      }),
    )
    await alice.syncGroupConversation(group.id, {
      relayClient: client,
      ownAddress: ALICE,
    })
    expect(
      alice.conversations[group.id].messages.map(
        (message: any) => message.items[0].text,
      ),
    ).toEqual(['Epoch 1'])
    expect(alice.conversations[group.id].groupState.lastSyncedSeq).toBe(2)
  })

  it('replays our own outbound membership deliveries on hydration as ourselves, not as the recipient', async () => {
    const { chats, group, client } = await makeGroup()
    const metadata = JSON.parse(JSON.stringify(chats.$state))
    await chats.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: CHARLIE,
      relayClient: client,
    })
    const control =
      chats.conversations[group.id].groupState.pendingMemberDeliveries[BOB].at(
        -1,
      ).items[0]
    expect(control.type).toBe('group-control')
    const conversationId = '22222222-2222-4222-8222-222222222222'
    const store = await messageStorePromise
    store.getIterator.mockResolvedValueOnce([
      {
        index: 'sent-control',
        outbound: true,
        senderAddress: ALICE,
        copartyAddress: BOB,
        message: {
          outbound: true,
          status: 'confirmed',
          senderAddress: ALICE,
          destinationAddress: BOB,
          conversationId,
          items: [control],
          serverTime: 3000,
          receivedTime: 3000,
          outpoints: [],
        },
      },
    ])
    const restored = await rehydrateChat(metadata)
    const restoredGroup = restored.conversations[group.id]
    expect(restoredGroup.groupState.epoch).toBe(1)
    expect(restoredGroup.groupState.memberIndex).toBe(0)
    expect(restoredGroup.groupMemberIndex).toBe(0)
  })
})
