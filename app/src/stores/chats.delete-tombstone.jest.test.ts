/**
 * What deleting does at the store: one message, clear history, delete chat and, through delete
 * chat, delete contact.
 *
 * A delete drops the message's content and leaves a tombstone (its payload hash, under this
 * account's own mailbox). It asks the wallet NOTHING: no sweep, no settling of a payment, no
 * chain read, whatever the message brought or carried. So it is instant and cannot be refused
 * for a chain or fee reason. The wallet here is one whose every money operation fails the way an
 * unreachable chain does; no delete may notice.
 *
 * That the money is still there afterwards is the wallet's own subject (its coin list does not
 * depend on the message): packages/wallet/chain/received-payments.anvil.integration.ts. That a
 * tombstoned row handed back by the relay stays deleted across a reload is
 * `chats.reload-property.jest.test.ts`. Same environment notes as `chats.jest.test.ts`.
 */
import { createPinia, setActivePinia } from 'pinia'
;(global as unknown as { document: unknown }).document = {
  hasFocus: () => true,
}

import {
  setConversationIdSalt as installTestConversationIdSalt,
  stripReleasedPayments,
  useChatStore,
  type ChatMessage,
  type Conversation,
} from './chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { useContactStore } from './contacts'
import { store as messageStorePromise } from '../adapters/level-message-store'
import { activeChain, ContactPaymentReleasedError } from '@frank/wallet/chain'

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
// The account's wallet, with its chain unreachable: anything that would read the chain or move
// money rejects. Every call is recorded.
const mockWalletCalls: string[] = []
const mockUnreachable = (name: string) => async () => {
  mockWalletCalls.push(name)
  throw new Error('node unreachable')
}
jest.mock('../accounts/session', () => ({
  accountSession: {
    getWallet: async () => ({
      sweepReceivedCoins: mockUnreachable('sweepReceivedCoins'),
      settleContactPayment: mockUnreachable('settleContactPayment'),
      sendNative: mockUnreachable('sendNative'),
      getBalance: mockUnreachable('getBalance'),
      refreshReceivedPayments: mockUnreachable('refreshReceivedPayments'),
    }),
  },
}))

const OWN = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const OTHER = '0x3333333333333333333333333333333333333333'

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
    destinationAddress: OWN,
    payloadDigest,
  } as unknown as ChatMessage)

describe('deleting messages leaves tombstones and asks the wallet nothing', () => {
  let chats: ReturnType<typeof useChatStore>
  let conv: Conversation
  let messageStore: { deleteMessage: jest.Mock; suppressAndDelete: jest.Mock }
  /** Every tombstone written: whose mailbox, which payload hash, and the relay time if any. */
  const tombstones = () =>
    messageStore.suppressAndDelete.mock.calls.flatMap(call =>
      (call[2] as Array<{ payloadDigest: string; receivedTime?: number }>).map(
        entry => ({ mailbox: call[0] as string, ...entry }),
      ),
    )
  /** Every row whose content was dropped from the disk. */
  const dropped = () => [
    ...messageStore.deleteMessage.mock.calls.map(call => call[0] as string),
    ...messageStore.suppressAndDelete.mock.calls.flatMap(
      call => call[1] as string[],
    ),
  ]

  beforeEach(async () => {
    // A chat can be opened only once the account's conversation-ID salt is installed.
    installTestConversationIdSalt(
      testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
    )
    setActivePinia(createPinia())
    mockWalletCalls.length = 0
    messageStore = (await messageStorePromise) as unknown as typeof messageStore
    messageStore.deleteMessage.mockClear()
    messageStore.suppressAndDelete.mockClear()
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
  afterEach(() => jest.restoreAllMocks())
  const left = () => conv.messages.map(message => message.payloadDigest)
  const add = (message: ChatMessage) => {
    message.conversationId = conv.id
    conv.messages.push(message)
    chats.messages[message.payloadDigest] = message
    return message
  }
  /** A message of ours carrying a payment to the contact (its signed transfer in the item). */
  const sentWithPayment = (
    payloadDigest: string,
    extra: Partial<ChatMessage> = {},
  ) =>
    add({
      ...received(payloadDigest),
      outbound: true,
      senderAddress: OWN,
      destinationAddress: PEER,
      stampPayments: [],
      items: [
        {
          type: 'stealth',
          amount: 5,
          ephemeralPubKey: '02ab',
          transactions: ['02f8signedtransfer'],
        },
      ],
      ...extra,
    } as unknown as ChatMessage)

  it('one message that brought money: deleted at once with the chain unreachable; its content is dropped and a tombstone is left under our own mailbox', async () => {
    await chats.deleteMessage({ address: PEER, payloadDigest: 'bb' })
    expect(left()).toEqual(['aa', 'cc'])
    expect(chats.messages.bb).toBeUndefined()
    expect(dropped()).toContain('bb')
    expect(tombstones()).toEqual([
      { mailbox: OWN, payloadDigest: 'bb', receivedTime: 1000 },
    ])
    expect(mockWalletCalls).toEqual([])
  })

  it('clear history: every message goes, each with its tombstone; the chat stays', async () => {
    await chats.clearChat(PEER)
    expect(left()).toEqual([])
    expect(conv.deletedAt).toBeUndefined()
    expect(dropped().sort()).toEqual(['aa', 'bb', 'cc'])
    expect(
      tombstones()
        .map(t => t.payloadDigest)
        .sort(),
    ).toEqual(['aa', 'bb', 'cc'])
    expect(tombstones().every(t => t.mailbox === OWN)).toBe(true)
    expect(mockWalletCalls).toEqual([])
  })

  it('delete chat and delete contact: the chat is gone at once, whatever its messages brought', async () => {
    await chats.deleteChat(PEER)
    expect(conv.deletedAt).toBeDefined()
    expect(left()).toEqual([])

    const other = chats.openDirectConversation(OTHER)
    const message = received('dd')
    message.conversationId = other.id
    other.messages.push(message)
    chats.messages.dd = message
    await useContactStore().deleteContact(OTHER)
    expect(other.deletedAt).toBeDefined()
    expect(other.messages).toEqual([])
    expect(
      tombstones()
        .map(t => t.payloadDigest)
        .sort(),
    ).toEqual(['aa', 'bb', 'cc', 'dd'])
    expect(mockWalletCalls).toEqual([])
  })

  it('a message of ours is tombstoned under our own mailbox too; one not read back from the relay yet anchors no relay time', async () => {
    // Sent from this device and confirmed: its time is this device's, not the relay's.
    sentWithPayment('ee', { status: 'confirmed' } as never)
    await chats.deleteMessage({ address: PEER, payloadDigest: 'ee' })
    expect(left()).not.toContain('ee')
    expect(tombstones()).toEqual([{ mailbox: OWN, payloadDigest: 'ee' }])
  })

  it("deleting or clearing a message that carries an unfinished payment to a contact does not settle it: the payment stays the wallet's, and the bubble cannot be sent again", async () => {
    const wallet = {
      identity: { address: { raw: OWN }, displayAddress: OWN },
    } as never
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockResolvedValue({} as never)
    sentWithPayment('ee', {
      status: 'error',
      delivery: { failureReason: 'unreachable' },
    } as never)
    sentWithPayment('ff', {
      status: 'error',
      delivery: { failureReason: 'unreachable' },
    } as never)

    await chats.deleteMessage({ address: PEER, payloadDigest: 'ee' })
    await chats.clearChat(PEER)
    expect(left()).toEqual([])
    // The wallet was not told to release or finish anything.
    expect(mockWalletCalls).toEqual([])

    // Nothing is left to retry: a retry of either bubble sends nothing, and neither does the
    // store's own pass over unfinished messages.
    for (const payloadDigest of ['ee', 'ff'])
      expect(
        await chats.retryOutgoing({ wallet, address: PEER, payloadDigest }),
      ).toEqual({ state: 'busy' })
    await chats.reconcileOutgoing({ wallet }).catch(() => undefined)
    expect(send).not.toHaveBeenCalled()
    expect(JSON.stringify(chats.$state)).not.toContain('signedtransfer')
  })

  it('a message whose payment the wallet released is saved without its signed transfer and cannot go out on a retry', async () => {
    const wallet = {
      identity: { address: { raw: OWN }, displayAddress: OWN },
    } as never
    const item = {
      type: 'stealth',
      amount: 5,
      ephemeralPubKey: '02ab',
      transactions: ['02f8signedtransfer'],
    }
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockRejectedValue(new ContactPaymentReleasedError())
    const outcome = await chats.sendMessage({
      wallet,
      address: PEER,
      items: [item as never],
    })
    expect(outcome.state).toBe('failed')
    const saved = conv.messages.find(m => m.outbound)!
    expect(saved.status).toBe('error')
    expect(saved.items).toEqual([{ ...item, transactions: [] }])
    expect(JSON.stringify(saved.items)).not.toContain('signedtransfer')
    // What a retry hands the wallet no longer contains the transfer.
    send.mockClear()
    await chats
      .retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: saved.payloadDigest,
      })
      .catch(() => undefined)
    for (const call of send.mock.calls)
      expect(JSON.stringify(call[0].items)).not.toContain('signedtransfer')
  })

  it('stripReleasedPayments keeps the amount and memo of a payment and drops its signed transfer', () => {
    const released = {
      items: [
        { type: 'text', text: 'here you go' },
        {
          type: 'stealth',
          amount: 5,
          memo: 'lunch',
          ephemeralPubKey: '02ab',
          transactions: ['02f8signedtransfer'],
        },
      ],
    } as unknown as ChatMessage
    stripReleasedPayments(released)
    expect(released.items).toEqual([
      { type: 'text', text: 'here you go' },
      {
        type: 'stealth',
        amount: 5,
        memo: 'lunch',
        ephemeralPubKey: '02ab',
        transactions: [],
      },
    ])
  })
})
