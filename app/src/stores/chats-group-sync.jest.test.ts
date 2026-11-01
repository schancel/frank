/** @jest-environment jsdom */
import type {
  GroupWelcomeItem,
  GroupControlItem,
} from '@frank/group-messaging/types'
import {
  GROUP_TEST_ACCOUNTS,
  groupTestSigner,
  groupTestSigningKey,
  paidSend,
} from '@frank/cashweb/groups/group-test.testutil'
import {
  GROUP_MSG_AEAD_DOMAIN,
  bytesToHex,
  computeOuterWriteSigningHash,
  deriveEpochKeys,
  hexToBytes,
  sealGroupMessage,
  openGroupMessage,
} from '@frank/cashweb/groups/group-crypto'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { encodeGroupItems } from '../utils/group-message-items'
import {
  encodeFrame,
  encodePluginMessageItem,
  encodeCanonical,
  TYPE_MESSAGE_CONTENT_REVISION,
} from '@frank/codec'
import { accountSession } from '../accounts/session'
import type { WalletHandle } from '@frank/wallet/chain'
import { fetchContactProfile } from '../utils/directory-peer'
import { createPinia, setActivePinia } from 'pinia'
import type { AxiosInstance } from 'axios'
import {
  GroupRelayClient,
  GroupWriteDeferredError,
  GroupWritePriceRefusedError,
  GroupWritePriceReplayError,
  GroupWriteRefusedError,
  signGroupWritePrice,
  type StoredGroupMessageWire,
} from '@frank/cashweb/groups'
import { groupWriteTestPayer } from '@frank/group-messaging/groups/write-payment.testutil'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: jest.fn(async () => []),
  }),
}))
jest.mock('../utils/directory-peer', () => ({ fetchContactProfile: jest.fn() }))
// Group writes pay through the messaging wallet's transaction-set capability.
let groupWritePayer: ReturnType<typeof groupWriteTestPayer>
jest.mock('../utils/clients', () => ({ useMonadWallet: () => ({}) }))
jest.mock('../utils/notifications', () => ({
  errorNotify: jest.fn(),
  insufficientStampNotify: jest.fn(),
  desktopNotify: jest.fn(),
}))

/** The lab relays' payee: an ordinary address nobody holds the key to. */
const GROUP_WRITE_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
/** The relay's least price per write; a group with no creator price costs this. */
const RELAY_MIN_PRICE = 1000n

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
  setGroupWritePayerForTest,
} = require('./chats')
const messageStorePromise = require('../adapters/level-message-store').store
const { useContactStore } = require('./contacts')

function createSharedMockGroupRelay() {
  const epochs = new Map<string, Record<string, unknown>>()
  const history = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, StoredGroupMessageWire[]>()
  // Creator price records as the relay stored them. The relay's own checks of a record
  // (signature, version order, minimum) are tested against the real relay; here it is held.
  const prices = new Map<string, Record<string, unknown>>()

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
        const priceMatch = url.match(/\/groups\/([0-9a-f]{64})\/write-price$/)
        if (priceMatch) {
          prices.set(priceMatch[1], body)
          return { data: body }
        }
        const msgMatch = url.match(/\/groups\/([0-9a-f]{64})\/messages$/)
        if (msgMatch) {
          const groupId = msgMatch[1]
          // The relay's checks are tested against the real relay; here only that one is sent.
          const payment = body.payment as Record<string, unknown> | undefined
          if (
            payment?.network !== 'monad-testnet' ||
            typeof payment.raw_transaction !== 'string'
          )
            throw new Error('Group write without payment')
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
        const policyMatch = url.match(/\/groups\/([0-9a-f]{64})\/write-policy$/)
        if (policyMatch) {
          const record = prices.get(policyMatch[1])
          return {
            data: {
              network: 'monad-testnet',
              price_wei: record?.price_wei ?? RELAY_MIN_PRICE.toString(),
              price_version: record?.version ?? 0,
              price_record: record ?? null,
              min_price_wei: RELAY_MIN_PRICE.toString(),
              host_origin: 'https://relay.frank.test',
              payee: GROUP_WRITE_BURN_ADDRESS.toLowerCase(),
            },
          }
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
  afterEach(() => setGroupWritePayerForTest())
  beforeEach(() => {
    groupWritePayer = groupWriteTestPayer()
    setGroupWritePayerForTest(() => groupWritePayer.wallet)
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

  it('shares group runtime ownership across per-action proxies and isolates stale cleanup', () => {
    const chats = useChatStore()
    const first = new Proxy(chats, {})
    const second = new Proxy(chats, {})
    const removeOld = first.configureGroupHomeRelay('https://home.example')
    expect(second.getGroupHomeRelay()).toBe('https://home.example')
    const foreign = first.getGroupRelayClient('https://foreign.example')
    expect(second.getGroupRelayClient('https://foreign.example')).toBe(foreign)
    expect(second.getGroupHomeRelay()).toBe('https://home.example')
    const removeNew = second.configureGroupHomeRelay('https://next.example')
    removeOld()
    expect(first.getGroupHomeRelay()).toBe('https://next.example')
    expect(first.getGroupRelayClient('https://foreign.example')).not.toBe(
      foreign,
    )
    removeNew()
    expect(() => second.getGroupHomeRelay()).toThrow(
      'Group messaging is not configured',
    )
  })

  it('excludes a duplicate group creation through a different action proxy', async () => {
    const chats = useChatStore()
    let finish!: (value: unknown) => void
    const once = jest
      .spyOn(chats, 'createGroupConversationOnce')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          }),
      )
    const first = new Proxy(chats, {})
    const second = new Proxy(chats, {})
    const pending = first.createGroupConversation({
      groupName: 'one',
      memberAddresses: [],
    })
    await Promise.resolve()
    await expect(
      second.createGroupConversation({ groupName: 'two', memberAddresses: [] }),
    ).rejects.toThrow('Group operation already in progress')
    expect(once).toHaveBeenCalledTimes(1)
    finish({ id: 'existing-operation' })
    await pending
    once.mockRestore()
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
    await bobChats.declineGroupInvite(bobGroup.id)
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
    await bobChats.approveGroupInvite(bobGroup.id)
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

    // 5. Bob replies in the group and Alice syncs via syncAllJoinedGroups. Opening the group
    // shows Bob its price (Chat.vue), which his write may pay.
    await bobChats.refreshGroupWritePrice(bobGroup.id, relayClient)
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
    await chats.leaveGroupConversation(groupConv.id)
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
    // The member opens the group, as Chat.vue does: the composer shows its price.
    if (chats.conversations[group.id]?.groupState)
      await chats.refreshGroupWritePrice(group.id, client)
    return { chats, group: chats.conversations[group.id] }
  }

  it('a group the relay refuses to read (403) is not asked again on every poll, and is again later', async () => {
    const relayClient = createSharedMockGroupRelay()
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', relayClient)
    const group = await chats.createGroupConversation({
      groupName: 'Stale Group',
      memberAddresses: [BOB],
      relayUrl: 'https://relay.frank.test',
      relayClient,
      creatorAddress: ALICE,
    })
    const refused = Object.assign(new Error('forbidden'), {
      response: { status: 403 },
    })
    const sync = jest
      .spyOn(chats, 'syncGroupConversation')
      .mockRejectedValue(refused)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const options = { relayClient, ownAddress: ALICE }
      await chats.syncAllJoinedGroups(options)
      await chats.syncAllJoinedGroups(options)
      await chats.syncAllJoinedGroups(options)
      const asked = () =>
        sync.mock.calls.filter(([id]) => id === group.id).length
      expect(asked()).toBe(1)
      // After the wait it is asked once more, then left for twice as long.
      now.mockReturnValue(1_000_000 + 60_001)
      await chats.syncAllJoinedGroups(options)
      await chats.syncAllJoinedGroups(options)
      expect(asked()).toBe(2)
      now.mockReturnValue(1_000_000 + 60_001 + 60_001)
      await chats.syncAllJoinedGroups(options)
      expect(asked()).toBe(2)
      // A read that succeeds again ends the wait.
      sync.mockResolvedValue(0)
      now.mockReturnValue(1_000_000 + 60_001 + 120_002)
      await chats.syncAllJoinedGroups(options)
      await chats.syncAllJoinedGroups(options)
      expect(asked()).toBe(4)
    } finally {
      now.mockRestore()
    }
  })

  it('live wakeups persist each authenticated receipt once and stop after leaving', async () => {
    const alice = await makeGroup()
    const bob = await inviteBob(alice.group, alice.client)
    let wake!: () => Promise<void>
    const close = jest.fn()
    const subscribe = jest
      .spyOn(alice.client, 'subscribeGroupMessages')
      .mockImplementation((_id, _epoch, _token, callback) => {
        wake = callback
        return { close }
      })
    const stop = bob.chats.startGroupLiveDelivery()
    expect(subscribe).not.toHaveBeenCalled()
    await bob.chats.approveGroupInvite(bob.group.id)
    expect(subscribe).toHaveBeenCalledTimes(1)
    currentOwnAddress = ALICE
    await alice.chats.sendGroupMessage({
      conversationId: alice.group.id,
      items: [{ type: 'text', text: 'live receipt' }],
      relayClient: alice.client,
      senderAddress: ALICE,
    })
    currentOwnAddress = BOB
    const messageStore = await messageStorePromise
    messageStore.saveMessage.mockClear()
    try {
      await Promise.all([wake(), wake(), wake()])
      await wake()
      expect(bob.group.messages).toHaveLength(1)
      expect(bob.group.groupState.lastSyncedSeq).toBe(1)
      expect(messageStore.saveMessage).toHaveBeenCalledTimes(1)
      await bob.chats.leaveGroupConversation(bob.group.id)
      expect(close).toHaveBeenCalledTimes(1)
      await wake()
      expect(messageStore.saveMessage).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('closes old epoch callbacks on rotation and closes all subscriptions on session cleanup', async () => {
    const { chats, group, client } = await makeGroup()
    const callbacks: Array<() => Promise<void>> = []
    const closes: Array<jest.Mock> = []
    jest
      .spyOn(client, 'subscribeGroupMessages')
      .mockImplementation((_id, _epoch, _token, callback) => {
        callbacks.push(callback)
        const close = jest.fn()
        closes.push(close)
        return { close }
      })
    const stop = chats.startGroupLiveDelivery()
    const sync = jest.spyOn(chats, 'syncGroupConversation')
    group.groupState.epochSecretHex = '42'.repeat(32)
    expect(closes[0]).toHaveBeenCalledTimes(1)
    expect(callbacks).toHaveLength(2)
    await callbacks[0]()
    expect(sync).not.toHaveBeenCalled()
    stop()
    expect(closes[1]).toHaveBeenCalledTimes(1)
    await callbacks[1]()
    expect(sync).not.toHaveBeenCalled()
  })

  it('cancels an in-flight durable read before persistence when stop-following wins', async () => {
    const alice = await makeGroup()
    const bob = await inviteBob(alice.group, alice.client)
    await bob.chats.approveGroupInvite(bob.group.id)
    currentOwnAddress = ALICE
    await alice.chats.sendGroupMessage({
      conversationId: alice.group.id,
      items: [{ type: 'text', text: 'cancelled read' }],
      relayClient: alice.client,
      senderAddress: ALICE,
    })
    currentOwnAddress = BOB
    let wake!: () => Promise<void>
    jest
      .spyOn(alice.client, 'subscribeGroupMessages')
      .mockImplementation((_id, _epoch, _token, callback) => {
        wake = callback
        return { close: jest.fn() }
      })
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const reading = new Promise<void>(resolve => {
      entered = resolve
    })
    const fetch = alice.client.fetchGroupMessages.bind(alice.client)
    jest
      .spyOn(alice.client, 'fetchGroupMessages')
      .mockImplementation(async (...args) => {
        const response = await fetch(...args)
        entered()
        await blocked
        return response
      })
    const stop = bob.chats.startGroupLiveDelivery()
    const messageStore = await messageStorePromise
    messageStore.saveMessage.mockClear()
    const pending = wake()
    await reading
    await bob.chats.leaveGroupConversation(bob.group.id)
    release()
    await expect(pending).rejects.toThrow(/subscription changed/)
    expect(messageStore.saveMessage).not.toHaveBeenCalled()
    expect(bob.group.messages).toHaveLength(0)
    expect(bob.group.groupState.lastSyncedSeq).toBe(0)
    stop()
  })

  it('closes subscriptions on account revision change without reopening old conversation secrets', async () => {
    const { chats, client } = await makeGroup()
    const close = jest.fn()
    const subscribe = jest
      .spyOn(client, 'subscribeGroupMessages')
      .mockReturnValue({ close })
    const stop = chats.startGroupLiveDelivery()
    // Unwrap the readonly view once, retaining the underlying reactive proxy for a custody publish.
    const session = Reflect.get(accountSession.state, '__v_raw') as {
      revision: number
    }
    const revision = session.revision
    try {
      session.revision++
      expect(close).toHaveBeenCalledTimes(1)
      expect(subscribe).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      session.revision = revision
    }
  })

  it('bounds browser subscriptions and releases every handle on teardown', async () => {
    const { chats, group, client } = await makeGroup()
    const closes: Array<jest.Mock> = []
    jest.spyOn(client, 'subscribeGroupMessages').mockImplementation(() => {
      const close = jest.fn()
      closes.push(close)
      return { close }
    })
    for (let index = 0; index < 40; index++) {
      const id = `bounded-group-${index}`
      chats.conversations[id] = { ...group, id }
    }
    const stop = chats.startGroupLiveDelivery()
    expect(closes).toHaveLength(32)
    stop()
    expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
  })

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
    // The invitation never sent to Charlie is dropped; Charlie is only told of the removal.
    expect(
      group.groupState.pendingMemberDeliveries[CHARLIE].map(
        delivery => delivery.items,
      ),
    ).toEqual([
      [
        expect.objectContaining({
          type: 'group-control',
          action: 'remove-member',
          epoch: 2,
          targetAddress: expect.stringMatching(new RegExp(`^${CHARLIE}$`, 'i')),
        }),
      ],
    ])
    expect(
      group.groupState.pendingMemberDeliveries[CHARLIE][0].items[0],
    ).not.toHaveProperty('epochSecretHex')
    const ids = group.groupState.pendingMemberDeliveries[BOB].map(
      delivery => delivery.operationId,
    )
    expect(new Set(ids).size).toBe(3)
  })

  it('a removed member is told: the group shows the removal and is no longer polled or retried', async () => {
    const { chats: alice, group, client } = await makeGroup()
    const { chats: bob } = await inviteBob(group, client)
    const bobGroup = bob.conversations[group.id]
    await bob.approveGroupInvite(group.id)
    expect(bobGroup.membershipStatus).toBe('joined')

    currentOwnAddress = ALICE
    await alice.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: BOB,
      relayClient: client,
    })
    const notice = group.groupState.pendingMemberDeliveries[BOB]
    expect(notice).toHaveLength(1)
    const noticeItem = notice[0].items[0] as GroupControlItem
    // The notice never carries the epoch the member was left out of.
    expect(noticeItem.epochSecretHex).toBeUndefined()

    // Before the notice, Bob's poll finds an epoch it cannot open and fails, as before.
    currentOwnAddress = BOB
    await expect(
      bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).rejects.toThrow(/membership update required/)
    expect(bobGroup.groupState.syncFailed).toBe(true)

    const deliver = (index: string, item: GroupControlItem, from = ALICE) =>
      bob.receiveMessages(
        [
          {
            index,
            conversationId: '11111111-1111-4111-8111-111111111111',
            outbound: false,
            senderAddress: from,
            copartyAddress: from,
            copartyPubKey: {
              toBuffer: () =>
                GROUP_TEST_ACCOUNTS.find(a => a.address === from)!.publicKey,
            },
            stampValue: 0,
            message: {
              outbound: false,
              status: 'confirmed',
              senderAddress: from,
              destinationAddress: BOB,
              items: [item],
              conversationId: '11111111-1111-4111-8111-111111111111',
              serverTime: 5000,
              receivedTime: 5000,
              outpoints: [],
            },
          },
        ],
        BOB,
      )
    // A notice from anyone but the administrator changes nothing.
    await deliver('forged-removal', noticeItem, CHARLIE)
    expect(bobGroup.membershipStatus).toBe('joined')

    await deliver('removal-notice', noticeItem)
    expect(bobGroup.membershipStatus).toBe('removed')
    expect(bobGroup.groupState.syncFailed).toBe(false)
    expect(bobGroup.participants).not.toContain(BOB)
    expect(bob.shouldPollGroupMailbox(group.id)).toBe(false)
    // Polling stops: no more failed retries.
    await expect(
      bob.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: BOB,
      }),
    ).resolves.toBe(0)
  })

  it.each([false, true])(
    'validates signed native blob history after actual close/reopen, optional MIME reply=%s',
    async withReply => {
      const { chats, group, client } = await makeGroup()
      const blob = {
        type: 'blob' as const,
        mimeType: 'application/octet-stream',
        data: Uint8Array.of(0, 255, 128),
      }
      const items = withReply
        ? [
            blob,
            {
              mimeType: 'application/x-reference',
              type: 'reply' as const,
              payloadDigest: 'ab'.repeat(32),
            },
          ]
        : [blob]
      const outcome = await chats.sendGroupMessage({
        conversationId: group.id,
        items,
        relayClient: client,
        senderAddress: ALICE,
      })
      const mockedStore = await messageStorePromise
      const rows = mockedStore.saveMessage.mock.calls.filter(
        ([row]) => row.message.conversationId === group.id,
      )
      const row = rows[rows.length - 1][0]
      const { LevelMessageStore } = jest.requireActual(
        '@frank/cashweb/relay/storage/level-storage',
      )
      const { mkdtempSync, rmSync } = require('fs')
      const { tmpdir } = require('os')
      const { join } = require('path')
      const location = mkdtempSync(
        join(tmpdir(), 'frank-group-binary-history-'),
      )
      let history = new LevelMessageStore(location)
      try {
        await history.Open()
        await history.saveMessage(row)
        await history.Close()
        history = new LevelMessageStore(location)
        await history.Open()
        const saved = await history.getMessage(row.index)
        await history.Close()
        mockedStore.getIterator.mockResolvedValueOnce([saved])
        const metadata = JSON.parse(
          JSON.stringify({
            conversations: { [group.id]: { ...group, messages: [] } },
            lastReceived: chats.lastReceived,
          }),
        )
        setActivePinia(createPinia())
        const restored = await rehydrateChat(metadata)
        expect(restored.conversations[group.id].messages[0].items).toEqual(
          items,
        )
        expect(
          restored.conversations[group.id].messages[0].items[0].data,
        ).toBeInstanceOf(Uint8Array)
      } finally {
        await history.Close()
        rmSync(location, { recursive: true, force: true })
      }
    },
  )

  it.each([
    'retired-image',
    'cached-text',
    'cipher',
    'sender',
    'digest',
    'roster',
    'malformed-blob',
  ] as const)(
    'restores verified signed content read-only, projection case=%s',
    async mode => {
      const { chats, group, client } = await makeGroup()
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'signed original' }],
        relayClient: client,
        senderAddress: ALICE,
      })
      const mockedStore = await messageStorePromise
      const rows = mockedStore.saveMessage.mock.calls.filter(
        ([row]) => row.message.conversationId === group.id,
      )
      const original = rows[rows.length - 1][0]
      let row = {
        ...original,
        message: {
          ...original.message,
          items: [{ type: 'text', text: 'tampered cache' }],
        },
      }
      const state = group.groupState!
      const epochKeys = deriveEpochKeys(
        hexToBytes(state.epochSecretHex),
        group.groupId!,
        state.epoch,
      )
      let unsupportedFrame: string | undefined
      if (mode === 'retired-image' || mode === 'malformed-blob') {
        // Valid unknown historical plugin versus malformed current known plugin: no old codec.
        const child = encodePluginMessageItem(
          mode === 'retired-image'
            ? {
                itemType: 'image',
                data: encodeCanonical(
                  new Map([[0, 'data:image/png;base64,AA==']]),
                ),
              }
            : { itemType: 'blob', data: Uint8Array.of(0, 255) },
        )
        unsupportedFrame = bytesToHex(child)
        const payload = encodeFrame(
          {
            typeId: TYPE_MESSAGE_CONTENT_REVISION,
            schemaVersion: 1,
            minReaderVersion: 1,
          },
          new Map<number, string | Uint8Array[]>([
            [0, 'frank'],
            [1, [child]],
          ]),
        )
        const envelope = sealGroupMessage({
          epochKeys,
          senderIndex: state.roster.find(member => member.address === ALICE)!
            .index,
          senderEpochKeyPair: groupTestSigningKey(
            ALICE,
            group.groupId!,
            state.epoch,
          ),
          payload,
        })
        const opened = openGroupMessage({
          envelope,
          epochKeys,
          roster: state.roster,
        })
        row = {
          ...row,
          index: opened.innerDigestHex,
          message: {
            ...row.message,
            groupEnvelope: envelope,
            items:
              mode === 'retired-image'
                ? [{ type: 'image', image: 'data:image/png;base64,AA==' }]
                : row.message.items,
          },
        }
      }
      if (mode === 'cipher')
        row.message.groupEnvelope = {
          ...row.message.groupEnvelope!,
          ciphertext:
            (row.message.groupEnvelope!.ciphertext.startsWith('00')
              ? 'ff'
              : '00') + row.message.groupEnvelope!.ciphertext.slice(2),
        }
      if (mode === 'sender') row.message.senderAddress = BOB
      if (mode === 'digest') row.index = '00'.repeat(32)
      const metadata = JSON.parse(
        JSON.stringify({
          conversations: { [group.id]: { ...group, messages: [] } },
          lastReceived: chats.lastReceived,
        }),
      )
      if (mode === 'roster')
        metadata.conversations[group.id].groupState.roster = []
      const metadataSnapshot = JSON.stringify(metadata)
      const { LevelMessageStore } = jest.requireActual(
        '@frank/cashweb/relay/storage/level-storage',
      )
      const { mkdtempSync, rmSync } = require('fs')
      const { tmpdir } = require('os')
      const { join } = require('path')
      const location = mkdtempSync(join(tmpdir(), 'frank-group-projection-'))
      let history = new LevelMessageStore(location)
      try {
        await history.Open()
        await history.saveMessage(row)
        const snapshot = async () =>
          Promise.all(
            [history.db, history.metadataDb].map(
              db =>
                new Promise((resolve, reject) => {
                  const rows: unknown[] = []
                  db.createReadStream()
                    .on('data', (entry: { key: string; value: string }) =>
                      rows.push(entry),
                    )
                    .on('error', reject)
                    .on('end', () => resolve(rows))
                }),
            ),
          )
        const storedSnapshot = await snapshot()
        await history.Close()
        history = new LevelMessageStore(location)
        await history.Open()
        const saved = await history.getMessage(row.index)
        mockedStore.getIterator.mockResolvedValueOnce([saved])
        setActivePinia(createPinia())
        if (
          mode === 'retired-image' ||
          mode === 'cached-text' ||
          mode === 'malformed-blob'
        ) {
          const restored = await rehydrateChat(metadata)
          const projected = restored.conversations[group.id].messages[0].items
          expect(projected).toEqual(
            mode === 'cached-text'
              ? [{ type: 'text', text: 'signed original' }]
              : [
                  expect.objectContaining({
                    type: 'unsupported',
                    itemType: mode === 'retired-image' ? 'image' : 'blob',
                    reason:
                      mode === 'retired-image' ? 'unknown-type' : 'malformed',
                    frame: unsupportedFrame,
                  }),
                ],
          )
          expect(saved.message.items).toEqual(row.message.items)
        } else await expect(rehydrateChat(metadata)).rejects.toThrow()
        expect(await snapshot()).toEqual(storedSnapshot)
        expect(JSON.stringify(metadata)).toBe(metadataSnapshot)
      } finally {
        await history.Close()
        rmSync(location, { recursive: true, force: true })
      }
    },
  )

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
    await bob.approveGroupInvite(group.id)
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

  it.each(['group', 'outgoing'] as const)(
    'retains the exact signed envelope after an uncertain send through the %s retry entry',
    async entry => {
      const { chats, group, client } = await makeGroup()
      const send = client.sendGroupMessage.bind(client)
      const sending = jest
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
      const direct = jest.spyOn(chats, 'runOutgoing')
      // Group retry owns its signer and journal. The generic UI entry must dispatch before
      // looking at a direct wallet or attempting direct-message preparation.
      const unusedWallet = new Proxy({} as WalletHandle, {
        get() {
          throw new Error('Group retry must not inspect a direct wallet')
        },
      })
      const retried =
        entry === 'group'
          ? await chats.retryGroupMessage(group.id, digest, client)
          : await chats.retryOutgoing({
              wallet: unusedWallet,
              address: BOB,
              payloadDigest: digest,
            })
      expect(retried.state).toBe('sent')
      expect(direct).not.toHaveBeenCalled()
      expect(sending.mock.calls[1][0]).toBe(group.groupId)
      expect(JSON.stringify(sending.mock.calls[1][1])).toBe(originalEnvelope)
      // The retry carries the first attempt's payment: one signed transaction, never a second.
      const stored = chats.messages[digest].groupWritePayment
      expect(sending.mock.calls[0][2]).toEqual({
        network: 'monad-testnet',
        raw_transaction: stored.rawTransaction,
      })
      expect(sending.mock.calls[1][2]).toEqual(sending.mock.calls[0][2])
      expect(groupWritePayer.sets.size).toBe(1)
      // The first answer was lost, so the wallet did not broadcast; the retry's delivery did.
      expect(groupWritePayer.events).toEqual([
        'construct:1',
        'construct:1',
        `send:${stored.operationId}`,
      ])
      expect(group.messages).toHaveLength(1)
      expect(group.groupState.pendingMessages[digest]).toBeUndefined()
      direct.mockRestore()
    },
  )

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
    await bob.approveGroupInvite(group.id)
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
    await charlie.approveGroupInvite(group.id)
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

  it("signs the creator's price at creation, puts it on the host once the group exists, shows it, and the next write pays it", async () => {
    currentOwnAddress = ALICE
    const client = createSharedMockGroupRelay()
    const order: string[] = []
    const publish = client.publishEpoch.bind(client)
    jest.spyOn(client, 'publishEpoch').mockImplementation(async (...args) => {
      order.push('epoch')
      return publish(...args)
    })
    const setPrice = client.setWritePrice.bind(client)
    jest.spyOn(client, 'setWritePrice').mockImplementation(async (...args) => {
      order.push(`price:${args[1].version}:${args[1].price_wei}`)
      return setPrice(...args)
    })
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', client)
    const group = await chats.createGroupConversation({
      groupName: 'Priced',
      memberAddresses: [BOB],
      relayUrl: 'https://relay.frank.test',
      relayClient: client,
      creatorAddress: ALICE,
      writePriceWei: 5000n,
    })
    expect(order).toEqual(['epoch', 'price:1:5000'])
    expect(group.groupState.pendingWritePrice).toBeUndefined()
    expect(group.groupState.writePrice).toMatchObject({
      network: 'monad-testnet',
      priceWei: '5000',
      minPriceWei: '1000',
      version: 1,
    })
    await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'At the group price' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    const sent = Object.values(chats.messages).find(
      m => m.groupWritePayment?.amountWei,
    )
    expect(sent.groupWritePayment).toMatchObject({
      amountWei: '5000',
      destination: GROUP_WRITE_BURN_ADDRESS,
    })
  })

  it("refuses a creator price below the relay's minimum before anything is created or signed", async () => {
    currentOwnAddress = ALICE
    const client = createSharedMockGroupRelay()
    const publishing = jest.spyOn(client, 'publishEpoch')
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', client)
    await expect(
      chats.createGroupConversation({
        groupName: 'Too cheap',
        memberAddresses: [BOB],
        relayUrl: 'https://relay.frank.test',
        relayClient: client,
        creatorAddress: ALICE,
        writePriceWei: RELAY_MIN_PRICE - 1n,
      }),
    ).rejects.toMatchObject({
      name: 'GroupWritePriceRefusedError',
      reason: 'below_minimum',
      minPriceWei: RELAY_MIN_PRICE,
    })
    expect(publishing).not.toHaveBeenCalled()
    expect(Object.keys(chats.conversations)).toEqual([])
  })

  it('an administrator changes the price: the signed record is kept until the host holds it, and only an administrator can sign one', async () => {
    const { chats, group, client } = await makeGroup()
    // No price chosen: the creator is shown the relay's minimum.
    expect(group.groupState.writePrice).toMatchObject({
      priceWei: RELAY_MIN_PRICE.toString(),
      version: 0,
    })
    const setPrice = client.setWritePrice.bind(client)
    const sending = jest
      .spyOn(client, 'setWritePrice')
      .mockRejectedValueOnce(new Error('Network Error'))
    await expect(
      chats.setGroupWritePrice(group.id, 7000n, client),
    ).rejects.toThrow('Network Error')
    // Signed and kept: a sync sends the same record, not a new one.
    const pending = group.groupState.pendingWritePrice
    expect(pending).toMatchObject({ version: 1, price_wei: '7000' })
    // A sync sends it beside reading messages: a stuck PUT holds up only member invitations.
    let unstick!: () => void
    sending.mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          unstick = () => setPrice(...args).then(resolve, reject)
        }),
    )
    const reading = jest.spyOn(client, 'fetchGroupMessages')
    const delivering = jest.spyOn(chats, 'retryGroupMemberDeliveries')
    await chats.syncGroupConversation(group.id, { relayClient: client })
    expect(reading).toHaveBeenCalled()
    expect(delivering).not.toHaveBeenCalled()
    expect(group.groupState.pendingWritePrice).toBe(pending)
    unstick()
    await chats.retryGroupWritePrice(group.id, client)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(delivering).toHaveBeenCalledWith(group.id)
    expect(sending).toHaveBeenLastCalledWith(
      group.groupState.groupIdHex,
      pending,
    )
    expect(group.groupState.pendingWritePrice).toBeUndefined()
    expect(group.groupState.writePrice).toMatchObject({
      priceWei: '7000',
      version: 1,
    })
    // The next change is the next version.
    await chats.setGroupWritePrice(group.id, 9000n, client)
    expect(sending).toHaveBeenLastCalledWith(
      group.groupState.groupIdHex,
      expect.objectContaining({ version: 2, price_wei: '9000' }),
    )
    expect(group.groupState.writePrice).toMatchObject({
      priceWei: '9000',
      version: 2,
    })
    // Below the relay's minimum: refused here, nothing signed or sent.
    sending.mockClear()
    await expect(
      chats.setGroupWritePrice(group.id, RELAY_MIN_PRICE - 1n, client),
    ).rejects.toMatchObject({ reason: 'below_minimum' })
    expect(sending).not.toHaveBeenCalled()
    expect(group.groupState.pendingWritePrice).toBeUndefined()

    // A member who is not the administrator holds no root key and signs nothing.
    const { chats: bobChats, group: bobGroup } = await inviteBob(group, client)
    await expect(
      bobChats.setGroupWritePrice(bobGroup.id, 9000n, client),
    ).rejects.toThrow('Only the group administrator sets its write price')
    // The member sees the price.
    await bobChats.refreshGroupWritePrice(bobGroup.id, client)
    expect(bobGroup.groupState.writePrice).toMatchObject({ priceWei: '9000' })
  })

  it('a member never pays more than the price shown: a raise refuses the write before anything is claimed, shows the new price, and Retry pays it', async () => {
    const { chats, group, client } = await makeGroup()
    // The member was shown the relay's minimum; the administrator then raises it 1000-fold.
    expect(group.groupState.writePrice.priceWei).toBe('1000')
    await chats.setGroupWritePrice(group.id, 1_000_000n, client)
    group.groupState.writePrice = {
      ...group.groupState.writePrice,
      priceWei: '1000',
      version: 0,
    }
    const sending = jest.spyOn(client, 'sendGroupMessage')
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'At the price I saw' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome).toEqual({ state: 'failed', reason: 'group-price-changed' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWriteShownPriceWei,
    )!
    expect(chats.messages[digest].delivery).toEqual({
      failureReason: 'group-price-changed',
      detail: '1000000',
    })
    // Nothing planned, claimed, signed or sent.
    expect(chats.messages[digest].groupWritePayment).toBeUndefined()
    expect(groupWritePayer.events).toEqual([])
    expect(sending).not.toHaveBeenCalled()
    // The new price is shown.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(group.groupState.writePrice.priceWei).toBe('1000000')
    // An automatic retry still refuses it.
    expect(
      (await chats.retryGroupMessage(group.id, digest, client)).state,
    ).toBe('failed')
    expect(groupWritePayer.events).toEqual([])
    // The user's Retry, with the new price shown, pays it.
    expect(
      (await chats.retryGroupMessage(group.id, digest, client, undefined, true))
        .state,
    ).toBe('sent')
    expect(chats.messages[digest].groupWritePayment).toMatchObject({
      amountWei: '1000000',
    })
  })

  /** Another administrator device of the creator puts `priceWei` on the host as `version`. */
  async function priceFromAnotherDevice(
    group: ReturnType<typeof useChatStore>['conversations'][string],
    client: GroupRelayClient,
    version: number,
    priceWei: bigint,
  ) {
    await client.setWritePrice(
      group.groupState.groupIdHex,
      signGroupWritePrice({
        network: 'monad-testnet',
        groupIdHex: group.groupState.groupIdHex,
        version,
        priceWei,
        rootSecretKey: hexToBytes(group.groupState.groupSecretKeyHex),
      }),
    )
  }

  it('Retry pays the price named on the refused write, kept current as the price is read again, and never more', async () => {
    const { chats, group, client } = await makeGroup()
    expect(group.groupState.writePrice.priceWei).toBe('1000')
    await priceFromAnotherDevice(group, client, 1, 2000n)
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Named price' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome).toEqual({ state: 'failed', reason: 'group-price-changed' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWriteShownPriceWei,
    )!
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chats.messages[digest].delivery).toEqual({
      failureReason: 'group-price-changed',
      detail: '2000',
    })
    // The message says 2000; the price then rises to 20000 before this device reads it again.
    await priceFromAnotherDevice(group, client, 2, 20_000n)
    expect(
      await chats.retryGroupMessage(group.id, digest, client, undefined, true),
    ).toEqual({ state: 'failed', reason: 'group-price-changed' })
    // Nothing paid at a price the message did not name; it now names the new one.
    expect(groupWritePayer.events).toEqual([])
    expect(chats.messages[digest].groupWritePayment).toBeUndefined()
    expect(chats.messages[digest].delivery).toEqual({
      failureReason: 'group-price-changed',
      detail: '20000',
    })
    // A read of the price updates the number shown beside Retry.
    await priceFromAnotherDevice(group, client, 3, 1500n)
    await chats.refreshGroupWritePrice(group.id, client)
    expect(chats.messages[digest].delivery).toEqual({
      failureReason: 'group-price-changed',
      detail: '1500',
    })
    expect(
      (await chats.retryGroupMessage(group.id, digest, client, undefined, true))
        .state,
    ).toBe('sent')
    expect(chats.messages[digest].groupWritePayment).toMatchObject({
      amountWei: '1500',
    })
  })

  it('a Retry after an unreachable host keeps the price shown when the write was sent', async () => {
    const { chats, group, client } = await makeGroup()
    expect(group.groupState.writePrice.priceWei).toBe('1000')
    jest
      .spyOn(client, 'getWritePolicy')
      .mockRejectedValueOnce(new Error('Network Error'))
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Unreachable first' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome).toEqual({ state: 'failed', reason: 'unreachable' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWriteShownPriceWei,
    )!
    // The price rises, and this device shows it, but the write was sent at 1000.
    await priceFromAnotherDevice(group, client, 1, 5000n)
    await chats.refreshGroupWritePrice(group.id, client)
    expect(group.groupState.writePrice.priceWei).toBe('5000')
    expect(
      await chats.retryGroupMessage(group.id, digest, client, undefined, true),
    ).toEqual({ state: 'failed', reason: 'group-price-changed' })
    expect(groupWritePayer.events).toEqual([])
    expect(chats.messages[digest].delivery).toEqual({
      failureReason: 'group-price-changed',
      detail: '5000',
    })
    // Retry from the message naming 5000 pays it.
    expect(
      (await chats.retryGroupMessage(group.id, digest, client, undefined, true))
        .state,
    ).toBe('sent')
    expect(chats.messages[digest].groupWritePayment).toMatchObject({
      amountWei: '5000',
    })
  })

  it('a price PUT that fails in transit sends no member invitations until the host answers it', async () => {
    const { chats, group, client } = await makeGroup()
    const sending = jest
      .spyOn(client, 'setWritePrice')
      .mockRejectedValueOnce(new Error('Network Error'))
    await expect(
      chats.setGroupWritePrice(group.id, 7000n, client),
    ).rejects.toThrow('Network Error')
    const pending = group.groupState.pendingWritePrice
    expect(pending).toBeDefined()
    const delivering = jest.spyOn(chats, 'retryGroupMemberDeliveries')
    sending.mockRejectedValueOnce(new Error('Network Error'))
    await chats.syncGroupConversation(group.id, { relayClient: client })
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(delivering).not.toHaveBeenCalled()
    expect(group.groupState.pendingWritePrice).toBe(pending)
    // The next sync's PUT is held: invitations follow it.
    await chats.syncGroupConversation(group.id, { relayClient: client })
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(group.groupState.pendingWritePrice).toBeUndefined()
    expect(delivering).toHaveBeenCalledWith(group.id)
  })

  it("refuses a host's older price record than one already verified, across a restart", async () => {
    const { chats, group, client } = await makeGroup()
    await chats.setGroupWritePrice(group.id, 7000n, client)
    await chats.setGroupWritePrice(group.id, 9000n, client)
    expect(group.groupState.writePriceVersionSeen).toBe(2)
    const restored = await rehydrateChat(chats.$state)
    expect(
      restored.conversations[group.id].groupState.writePriceVersionSeen,
    ).toBe(2)
    // The host answers with the replaced version 1 record (or with none at all).
    const current = await client.getWritePolicy(
      group.groupState.groupIdHex,
      group.groupState.groupPubKeyHex,
    )
    const replay = jest
      .spyOn(client, 'getWritePolicy')
      .mockResolvedValue({ ...current, priceVersion: 1, priceWei: 7000n })
    await expect(
      chats.refreshGroupWritePrice(group.id, client),
    ).rejects.toBeInstanceOf(GroupWritePriceReplayError)
    expect(group.groupState.writePrice).toMatchObject({
      priceWei: '9000',
      version: 2,
    })
    // A write reads the same policy: nothing is planned or paid.
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Against a replay' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome.state).toBe('failed')
    expect(groupWritePayer.events).toEqual([])
    replay.mockResolvedValue({
      ...current,
      priceVersion: 0,
      priceWei: 1000n,
      priceRecord: undefined,
    })
    await expect(
      chats.refreshGroupWritePrice(group.id, client),
    ).rejects.toBeInstanceOf(GroupWritePriceReplayError)
    expect(group.groupState.writePrice.priceWei).toBe('9000')
  })

  it('a price read answered after a later one never replaces it', async () => {
    const { chats, group, client } = await makeGroup()
    const current = await client.getWritePolicy(
      group.groupState.groupIdHex,
      group.groupState.groupPubKeyHex,
    )
    let answerFirst!: () => void
    jest
      .spyOn(client, 'getWritePolicy')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            answerFirst = () => resolve({ ...current, priceWei: 1000n })
          }),
      )
      .mockResolvedValueOnce({
        ...current,
        priceWei: 3000n,
        minPriceWei: 3000n,
      })
    // The host raised its floor between the two reads; the first is answered last.
    const first = chats.refreshGroupWritePrice(group.id, client)
    await chats.refreshGroupWritePrice(group.id, client)
    expect(group.groupState.writePrice.priceWei).toBe('3000')
    answerFirst()
    await first
    expect(group.groupState.writePrice.priceWei).toBe('3000')
  })

  it("tells the creator when the relay refused the group's price at creation", async () => {
    currentOwnAddress = ALICE
    const client = createSharedMockGroupRelay()
    jest
      .spyOn(client, 'setWritePrice')
      .mockRejectedValue(new GroupWritePriceRefusedError('refused', 403))
    const chats = useChatStore()
    chats.setGroupRelayClient('https://relay.frank.test', client)
    const group = await chats.createGroupConversation({
      groupName: 'Refused price',
      memberAddresses: [BOB],
      relayUrl: 'https://relay.frank.test',
      relayClient: client,
      creatorAddress: ALICE,
      writePriceWei: 5000n,
    })
    expect(group.groupState.pendingWritePrice).toBeUndefined()
    expect(group.groupState.writePriceRefusal).toEqual({ reason: 'refused' })
    // What members pay is shown: the relay's minimum.
    expect(group.groupState.writePrice).toMatchObject({ priceWei: '1000' })
  })

  it('a write refused as underpaid after a price change shows the new price', async () => {
    const { chats, group, client } = await makeGroup()
    const refreshing = jest.spyOn(chats, 'refreshGroupWritePrice')
    jest
      .spyOn(client, 'sendGroupMessage')
      .mockRejectedValueOnce(
        new GroupWriteRefusedError(402, 'group_payment_invalid', 'underpaid'),
      )
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'At the old price' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome).toEqual({ state: 'failed', reason: 'rejected' })
    expect(refreshing).toHaveBeenCalledWith(group.id, client)
  })

  it('signs a group write payment before the relay sees it, and only on the host network', async () => {
    const { chats, group, client } = await makeGroup()
    const sending = jest.spyOn(client, 'sendGroupMessage')
    groupWritePayer = groupWriteTestPayer('ethereum-sepolia')
    const refused = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Paid for' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(refused).toEqual({ state: 'failed', reason: 'unavailable' })
    expect(sending).not.toHaveBeenCalled()
    expect(groupWritePayer.sets.size).toBe(0)
    const digest = Object.keys(group.groupState.pendingMessages)[0]
    // The host's terms are kept with the message, so a later retry pays exactly them.
    expect(chats.messages[digest].groupWritePayment).toMatchObject({
      network: 'monad-testnet',
      amountWei: '1000',
      destination: GROUP_WRITE_BURN_ADDRESS,
    })
    expect(chats.messages[digest].groupWritePayment.rawTransaction).toBe(
      undefined,
    )
    groupWritePayer = groupWriteTestPayer()
    expect(
      (await chats.retryGroupMessage(group.id, digest, client)).state,
    ).toBe('sent')
    expect(groupWritePayer.events).toEqual([
      'construct:1',
      `send:${chats.messages[digest].groupWritePayment.operationId}`,
    ])
    expect(sending).toHaveBeenCalledTimes(1)
    expect(sending.mock.calls[0][2].raw_transaction).toBe(
      chats.messages[digest].groupWritePayment.rawTransaction,
    )
  })

  it('a write the relay refuses is never broadcast and its payment is released', async () => {
    const { chats, group, client } = await makeGroup()
    jest
      .spyOn(client, 'sendGroupMessage')
      .mockRejectedValueOnce(
        new GroupWriteRefusedError(402, 'group_payment_invalid', 'underpaid'),
      )
    const outcome = await chats.sendGroupMessage({
      conversationId: group.id,
      items: [{ type: 'text', text: 'Refused' }],
      relayClient: client,
      senderAddress: ALICE,
    })
    expect(outcome).toEqual({ state: 'failed', reason: 'rejected' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWritePayment,
    )!
    expect(chats.messages[digest].groupWritePayment.released).toBe(true)
    expect(group.groupState.pendingMessages?.[digest]).toBeUndefined()
    expect(groupWritePayer.events).toEqual([
      'construct:1',
      `release:${chats.messages[digest].groupWritePayment.operationId}`,
    ])
  })

  it('a refusal after an attempt without an answer keeps the write and its coin until the chain shows the payment', async () => {
    const { chats, group, client } = await makeGroup()
    const send = jest
      .spyOn(client, 'sendGroupMessage')
      .mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'))
      .mockRejectedValue(
        new GroupWriteRefusedError(
          402,
          'group_payment_invalid',
          'wrong_commitment',
        ),
      )
    expect(
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Unclear' }],
        relayClient: client,
        senderAddress: ALICE,
      }),
    ).toEqual({ state: 'failed', reason: 'unreachable' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWritePayment,
    )!
    // The bytes may be out: the refusal neither releases nor ends the write.
    expect(await chats.retryGroupMessage(group.id, digest, client)).toEqual({
      state: 'failed',
      reason: 'unverified',
    })
    expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    expect(
      groupWritePayer.events.some(event => event.startsWith('release')),
    ).toBe(false)
    // The chain shows the payment: the wallet tracks it, and the paid write stays to retry.
    const operationId = chats.messages[digest].groupWritePayment.operationId
    groupWritePayer.seenOnChain.add(operationId)
    expect(await chats.retryGroupMessage(group.id, digest, client)).toEqual({
      state: 'failed',
      reason: 'rejected-paid',
    })
    expect(chats.messages[digest].groupWritePayment.spent).toBe(true)
    expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    expect(groupWritePayer.events.at(-1)).toBe(`send:${operationId}`)
    // The relay now holds it: delivered with the same bytes, and the old reason is gone.
    send.mockRestore()
    expect(await chats.retryGroupMessage(group.id, digest, client)).toEqual({
      state: 'sent',
      payloadDigest: digest,
    })
    expect(chats.messages[digest].status).toBe('confirmed')
    expect(chats.messages[digest].delivery).toBeUndefined()
    expect(group.groupState.pendingMessages?.[digest]).toBeUndefined()
    expect(
      groupWritePayer.events.some(event => event.startsWith('release')),
    ).toBe(false)
  })

  it('a payment the host cannot accept yet keeps the write pending with the same bytes', async () => {
    const { chats, group, client } = await makeGroup()
    const payments: string[] = []
    const real = client.sendGroupMessage.bind(client)
    const send = jest
      .spyOn(client, 'sendGroupMessage')
      .mockImplementationOnce(async (_id, _envelope, payment) => {
        payments.push(payment.raw_transaction)
        throw new GroupWriteDeferredError(
          'group_payment_not_ready',
          'nonce_gap',
        )
      })
      .mockImplementationOnce(async (_id, _envelope, payment) => {
        payments.push(payment.raw_transaction)
        throw new GroupWriteDeferredError(
          'group_payment_not_ready',
          'insufficient_balance',
        )
      })
      .mockImplementation(async (id, envelope, payment) => {
        payments.push(payment.raw_transaction)
        return real(id, envelope, payment)
      })
    expect(
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Not yet' }],
        relayClient: client,
        senderAddress: ALICE,
      }),
    ).toEqual({ state: 'failed', reason: 'waiting-funds-or-chain' })
    const digest = Object.keys(chats.messages).find(
      key => chats.messages[key].groupWritePayment,
    )!
    // Waiting for funds or the chain, not "unreachable" (owner ruling 2026-10-27).
    expect(chats.messages[digest].delivery?.failureReason).toBe(
      'waiting-funds-or-chain',
    )
    expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    expect(await chats.retryGroupMessage(group.id, digest, client)).toEqual({
      state: 'failed',
      reason: 'waiting-funds-or-chain',
    })
    expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    expect(chats.messages[digest].groupWritePayment.uncertain).toBeUndefined()
    expect(await chats.retryGroupMessage(group.id, digest, client)).toEqual({
      state: 'sent',
      payloadDigest: digest,
    })
    expect(send).toHaveBeenCalledTimes(3)
    expect(new Set(payments).size).toBe(1)
    expect(chats.messages[digest].delivery).toBeUndefined()
    expect(
      groupWritePayer.events.some(event => event.startsWith('release')),
    ).toBe(false)
  })

  describe('discarding a group write', () => {
    async function waitingWrite(first: 'gap' | 'timeout' = 'gap'): Promise<{
      chats: ReturnType<typeof useChatStore>
      group: Awaited<ReturnType<typeof makeGroup>>['group']
      client: GroupRelayClient
      digest: string
      send: jest.SpyInstance
    }> {
      const { chats, group, client } = await makeGroup()
      const send = jest
        .spyOn(client, 'sendGroupMessage')
        .mockImplementationOnce(async () => {
          if (first === 'timeout')
            throw new Error('timeout of 15000ms exceeded')
          throw new GroupWriteDeferredError(
            'group_payment_not_ready',
            'nonce_gap',
          )
        })
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Waiting' }],
        relayClient: client,
        senderAddress: ALICE,
      })
      const digest = Object.keys(chats.messages).find(
        key => chats.messages[key].groupWritePayment,
      )!
      return { chats, group, client, digest, send }
    }

    it('gives the coin back once the chain shows nothing, removes the write, and is safe to repeat', async () => {
      const { chats, group, client, digest, send } = await waitingWrite()
      const operationId = chats.messages[digest].groupWritePayment.operationId
      expect(await chats.discardGroupMessage(group.id, digest)).toEqual({
        state: 'discarded',
      })
      expect(
        groupWritePayer.events.filter(event => event.startsWith('release')),
      ).toEqual([`release:${operationId}`])
      expect(
        groupWritePayer.events.some(event => event.startsWith('send')),
      ).toBe(false)
      expect(chats.messages[digest]).toBeUndefined()
      expect(group.messages.some(m => m.payloadDigest === digest)).toBe(false)
      expect(group.groupState.pendingMessages?.[digest]).toBeUndefined()
      // Repeated: nothing more is released.
      expect(await chats.discardGroupMessage(group.id, digest)).toEqual({
        state: 'discarded',
      })
      expect(
        groupWritePayer.events.filter(event => event.startsWith('release')),
      ).toHaveLength(1)
      // The next sync sends nothing for it.
      await chats.syncGroupConversation(group.id, {
        relayClient: client,
        ownAddress: ALICE,
      })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('after an attempt without an answer, keeps the write and its reservation', async () => {
      const { chats, group, digest } = await waitingWrite('timeout')
      expect(await chats.discardGroupMessage(group.id, digest)).toEqual({
        state: 'kept',
        reason: 'uncertain',
      })
      expect(
        groupWritePayer.events.some(event => event.startsWith('release')),
      ).toBe(false)
      expect(groupWritePayer.sets.size).toBe(1)
      expect(chats.messages[digest]).toBeDefined()
      expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    })

    it('keeps the write when the chain shows its payment', async () => {
      const { chats, group, digest } = await waitingWrite()
      groupWritePayer.seenOnChain.add(
        chats.messages[digest].groupWritePayment.operationId,
      )
      expect(await chats.discardGroupMessage(group.id, digest)).toEqual({
        state: 'kept',
        reason: 'paid',
      })
      expect(chats.messages[digest].groupWritePayment.released).toBeUndefined()
      expect(
        chats.messages[digest].groupWritePayment.discarding,
      ).toBeUndefined()
      expect(group.groupState.pendingMessages?.[digest]).toBe(true)
    })

    it('a waiting write stays waiting, with its payment, across a restart, and can be discarded then', async () => {
      const { chats, group, digest } = await waitingWrite()
      const messageStore = await messageStorePromise
      const rows = messageStore.saveMessage.mock.calls
        .filter(([row]) => row.index === digest)
        .map(([row]) => row)
      const saved = JSON.parse(JSON.stringify(rows[rows.length - 1]))
      expect(saved.message.delivery.failureReason).toBe(
        'waiting-funds-or-chain',
      )
      messageStore.getIterator.mockResolvedValueOnce([saved])
      const restored = await rehydrateChat(
        JSON.parse(
          JSON.stringify({
            conversations: { [group.id]: { ...group, messages: [] } },
            lastReceived: chats.lastReceived,
          }),
        ),
      )
      setActivePinia(createPinia())
      const reopened = useChatStore()
      reopened.$patch(restored)
      const conv = reopened.conversations[group.id]
      expect(conv.groupState.pendingMessages?.[digest]).toBe(true)
      expect(reopened.messages[digest].delivery?.failureReason).toBe(
        'waiting-funds-or-chain',
      )
      expect(reopened.messages[digest].groupWritePayment).toEqual(
        chats.messages[digest].groupWritePayment,
      )
      expect(await reopened.discardGroupMessage(group.id, digest)).toEqual({
        state: 'discarded',
      })
      expect(reopened.messages[digest]).toBeUndefined()
    })

    it('a delivered write is not discarded', async () => {
      const { chats, group, client } = await makeGroup()
      await chats.sendGroupMessage({
        conversationId: group.id,
        items: [{ type: 'text', text: 'Delivered' }],
        relayClient: client,
        senderAddress: ALICE,
      })
      const digest = Object.keys(chats.messages).find(
        key => chats.messages[key].groupWritePayment,
      )!
      expect(await chats.discardGroupMessage(group.id, digest)).toEqual({
        state: 'kept',
        reason: 'delivered',
      })
      expect(chats.messages[digest].status).toBe('confirmed')
    })
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
    // The user was told by the error; no banner repeats it.
    expect(state.supersededMemberChange).toBeUndefined()
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
    // A note to self: applied to the group, never a message in a conversation with oneself.
    expect(laptop.messages['winner-control']).toBeUndefined()
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
    await paidSend(client, group.groupId!, {
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
      paidSend(
        client,
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

  /** The laptop's change times out unanswered while the phone, another device of the same
   * administrator, publishes "add Charlie"; the laptop's next sync finds the phone won. */
  async function supersededOnLaptop(change: 'add-member' | 'remove-member') {
    const { chats: laptop, group, client } = await makeGroup()
    const saved = JSON.parse(JSON.stringify(laptop.$state))
    setActivePinia(createPinia())
    const phone = useChatStore()
    phone.$patch(saved)
    jest.spyOn(client, 'publishEpoch').mockImplementationOnce(async () => {
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
    const input = {
      conversationId: group.id,
      memberAddress: change === 'add-member' ? DAVE : BOB,
      relayClient: client,
    }
    await (change === 'add-member'
      ? laptop.inviteMemberToGroup(input)
      : laptop.removeMemberFromGroup(input))
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
    expect(state.supersededMemberChange.action).toBe(change)
    expect(state.supersededMemberChange.address.toLowerCase()).toBe(
      input.memberAddress,
    )
    return { laptop, phone, group, client }
  }
  const rosterOf = (chats: any, id: string) =>
    chats.conversations[id].groupState.roster.map((member: any) =>
      member.address.toLowerCase(),
    )

  it('shows a removal superseded after a timeout instead of dropping it, and the user retries it', async () => {
    const { laptop, group, client } = await supersededOnLaptop('remove-member')
    // Bob is still a member, and the user is told so; nothing retried it unasked.
    expect(rosterOf(laptop, group.id)).toContain(BOB)
    await laptop.retrySupersededMemberChange(group.id, client)
    const retried = laptop.conversations[group.id].groupState
    expect(retried.epoch).toBe(2)
    expect(rosterOf(laptop, group.id)).not.toContain(BOB)
    // The winning epoch's change is kept underneath the retried one.
    expect(rosterOf(laptop, group.id)).toContain(CHARLIE)
    expect(retried.supersededMemberChange).toBeUndefined()
  })

  it('does not re-add a member through a stale retry after another device added and removed them', async () => {
    const { laptop, phone, group, client } = await supersededOnLaptop(
      'add-member',
    )
    await phone.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: DAVE,
      relayClient: client,
    })
    await phone.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: DAVE,
      relayClient: client,
    })
    await laptop.retrySupersededMemberChange(group.id, client)
    const state = laptop.conversations[group.id].groupState
    expect(state.epoch).toBe(3)
    expect(rosterOf(laptop, group.id)).not.toContain(DAVE)
    expect(rosterOf(laptop, group.id)).toContain(CHARLIE)
    expect(state.supersededMemberChange).toBeUndefined()
  })

  it('does not re-remove a member through a stale retry after another device removed and re-added them', async () => {
    const { laptop, phone, group, client } = await supersededOnLaptop(
      'remove-member',
    )
    await phone.removeMemberFromGroup({
      conversationId: group.id,
      memberAddress: BOB,
      relayClient: client,
    })
    await phone.inviteMemberToGroup({
      conversationId: group.id,
      memberAddress: BOB,
      relayClient: client,
    })
    await laptop.retrySupersededMemberChange(group.id, client)
    const state = laptop.conversations[group.id].groupState
    expect(state.epoch).toBe(3)
    expect(rosterOf(laptop, group.id)).toContain(BOB)
    expect(rosterOf(laptop, group.id)).toContain(CHARLIE)
    expect(state.supersededMemberChange).toBeUndefined()
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
    await paidSend(
      client,
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

  describe('an invitation, on every device of the inviter and the invitee (F7)', () => {
    const OTHER_THREAD = '33333333-3333-4333-8333-333333333333'
    function walletOf(address: string) {
      return {
        identity: { displayAddress: address, address: { raw: address } },
      } as unknown as WalletHandle
    }
    /** Alice's group, its deliveries sent: the note to self is taken at the wallet's send
     * call, the invitations to members at the chat store's. */
    async function deliveredGroup() {
      const { chats, group, client } = await makeGroup()
      const { activeChain } = require('@frank/wallet/chain')
      const selfNotes: any[] = []
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async (params: any) => {
          selfNotes.push(params)
          return {
            payloadDigest: 'ab'.repeat(32),
            stampValueWei: 0n,
            stampPayments: [],
            preparationTxHashes: [],
          }
        })
      const invited: any[] = []
      jest
        .spyOn(chats, 'sendMessage')
        .mockImplementation(async (params: any) => {
          invited.push(params)
          return { state: 'sent', payloadDigest: 'cd'.repeat(32) } as any
        })
      await chats.retryGroupMemberDeliveries(group.id, walletOf(ALICE))
      return { chats, group, client, selfNotes, invited }
    }
    function selfRow(items: unknown[], index = 'self-welcome') {
      return {
        index,
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
          items,
          serverTime: 2000,
          receivedTime: 2000,
          outpoints: [],
        },
      }
    }
    function sentInvitationRow(item: unknown, conversationId: string) {
      return {
        index: 'sent-invitation',
        conversationId,
        outbound: true,
        senderAddress: ALICE,
        copartyAddress: BOB,
        copartyPubKey: { toBuffer: () => GROUP_TEST_ACCOUNTS[1].publicKey },
        stampValue: 0,
        message: {
          conversationId,
          outbound: true,
          status: 'confirmed',
          senderAddress: ALICE,
          destinationAddress: BOB,
          items: [item],
          serverTime: 2100,
          receivedTime: 2100,
          outpoints: [],
        },
      }
    }

    it('tells the inviter’s own devices in a free note to self, never in a conversation with oneself', async () => {
      const { chats, group, selfNotes, invited } = await deliveredGroup()
      expect(selfNotes).toHaveLength(1)
      expect(selfNotes[0].recipient).toEqual({ raw: ALICE })
      expect(selfNotes[0].stampValue).toBe(0n)
      expect(selfNotes[0].items[0].type).toBe('group-welcome')
      expect(selfNotes[0].items[0].adminSecretKeyHex).toBeDefined()
      // Only the member is sent an invitation through the conversation.
      expect(invited.map(params => params.address)).toEqual([BOB])
      expect(group.groupState.pendingMemberDeliveries).toEqual({})
      const own = Object.values(chats.conversations).filter(
        (conv: any) =>
          conv.kind !== 'group' && conv.address.toLowerCase() === ALICE,
      )
      expect(own).toEqual([])
      expect(useContactStore().isContact(ALICE)).toBe(false)
    })

    it('the inviter’s other device joins the group from the note and shows no conversation with itself', async () => {
      const { group, selfNotes } = await deliveredGroup()
      currentOwnAddress = ALICE
      setActivePinia(createPinia())
      const laptop = useChatStore()
      jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
      const note = JSON.parse(JSON.stringify(selfNotes[0].items))
      // Read once, then again with the whole mailbox: the same end.
      await laptop.receiveMessages([selfRow(note)], ALICE)
      await laptop.receiveMessages([selfRow(note)], ALICE)
      const joined = laptop.conversations[group.id]
      expect(joined.kind).toBe('group')
      expect(joined.membershipStatus).toBe('joined')
      expect(joined.groupState.groupSecretKeyHex).toBe(
        group.groupState.groupSecretKeyHex,
      )
      expect(
        Object.values(laptop.conversations).filter(
          (conv: any) => conv.kind !== 'group',
        ),
      ).toEqual([])
      expect(laptop.messages['self-welcome']).toBeUndefined()
      expect(useContactStore().isContact(ALICE)).toBe(false)
    })

    it('shows the invitation sent to the member as one, on the sending device after a reload and on the other device', async () => {
      const { invited, group } = await deliveredGroup()
      const invitation = JSON.parse(JSON.stringify(invited[0].items[0]))
      expect(invitation.type).toBe('group-welcome')
      // The other device reads the sent invitation back from the account's mailbox.
      currentOwnAddress = ALICE
      setActivePinia(createPinia())
      const laptop = useChatStore()
      jest.spyOn(useContactStore(), 'refresh').mockResolvedValue(undefined)
      await laptop.receiveMessages(
        [sentInvitationRow(invitation, OTHER_THREAD)],
        ALICE,
      )
      const thread = laptop.conversations[OTHER_THREAD]
      expect(thread.address.toLowerCase()).toBe(BOB)
      expect(thread.messages.map((m: any) => m.items[0].type)).toEqual([
        'group-welcome',
      ])
      // An invitation for someone else never makes this account a member of a group.
      expect(laptop.conversations[group.id]).toBeUndefined()
      // A reload rebuilds the same view from the saved row.
      const store = await messageStorePromise
      store.getIterator.mockResolvedValueOnce([
        {
          ...sentInvitationRow(invitation, OTHER_THREAD),
        },
      ])
      const restored = await rehydrateChat(
        JSON.parse(JSON.stringify(laptop.$state)),
      )
      expect(
        restored.conversations[OTHER_THREAD].messages.map(
          (m: any) => m.items[0].type,
        ),
      ).toEqual(['group-welcome'])
    })
  })
})

describe('durable local group decisions', () => {
  it.each([
    'approveGroupInvite',
    'declineGroupInvite',
    'leaveGroupConversation',
  ])(
    '%s completes after a successful write and ignores missing conversations',
    async action => {
      setActivePinia(createPinia())
      const chats = useChatStore()
      let resolve!: () => void
      chats.flushPersistence = jest.fn(
        () =>
          new Promise<void>(done => {
            resolve = done
          }),
      )
      expect(await chats[action]('missing')).toBeUndefined()
      expect(chats.flushPersistence).not.toHaveBeenCalled()
      const conv = chats.createConversation({
        participants: [ALICE, BOB],
        address: BOB,
        conversationId: '11111111-1111-4111-8111-111111111111',
      })
      conv.kind = 'group'
      conv.membershipStatus =
        action === 'leaveGroupConversation' ? 'joined' : 'invited'
      const sync = jest
        .spyOn(chats, 'syncGroupConversation')
        .mockResolvedValue(0)
      let complete = false
      const result = chats[action](conv.id).then(value => {
        complete = true
        return value
      })
      await Promise.resolve()
      expect(complete).toBe(false)
      expect(sync).not.toHaveBeenCalled()
      resolve()
      expect(await result).toBe(conv)
      expect(sync).toHaveBeenCalledTimes(
        action === 'approveGroupInvite' ? 1 : 0,
      )
    },
  )

  it.each([
    ['approveGroupInvite', 'invited', 'joined'],
    ['declineGroupInvite', 'invited', 'declined'],
    ['leaveGroupConversation', 'joined', 'left'],
  ])(
    '%s waits for persistence and retains state on failure',
    async (action, initial, final) => {
      setActivePinia(createPinia())
      const chats = useChatStore()
      const conv = chats.createConversation({
        participants: [ALICE, BOB],
        address: BOB,
        conversationId: '11111111-1111-4111-8111-111111111111',
      })
      conv.kind = 'group'
      conv.membershipStatus = initial
      const sync = jest
        .spyOn(chats, 'syncGroupConversation')
        .mockResolvedValue(0)
      let reject!: (error: Error) => void
      chats.flushPersistence = jest.fn(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail
          }),
      )
      let complete = false
      const result = Promise.resolve(chats[action](conv.id)).then(() => {
        complete = true
      })
      const failure = expect(result).rejects.toThrow('disk failed')
      expect(conv.membershipStatus).toBe(final)
      if (final !== 'joined')
        expect(chats.shouldPollGroupMailbox(conv.id)).toBe(false)
      await Promise.resolve()
      expect(complete).toBe(false)
      expect(sync).not.toHaveBeenCalled()
      reject(new Error('disk failed'))
      await failure
      expect(conv.membershipStatus).toBe(final)
      expect(sync).not.toHaveBeenCalled()
    },
  )
})
