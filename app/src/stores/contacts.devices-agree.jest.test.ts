/**
 * Two frontends of one account end with the same contacts (F5).
 *
 * A contact the user adds or removes on one device is noted to the account's own mailbox as a
 * free message to self carrying a `contact-state` item. The account's other devices read the
 * note through the chat store's receive path, and so does a device restored later from the seed,
 * which replays the whole mailbox. Each "device" here is its own Pinia (its own contact and chat
 * stores); the note it sends is taken at the wallet's send call (the one seam stubbed here) and
 * handed, as the mailbox row it becomes, to the others in the relay's order, in other orders, and
 * more than once.
 *
 * Also: a sender is never made a contact by writing (the screener decides that), and opening
 * a conversation with someone looks them up without making them one.
 */
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageItem } from '@frank/cashweb/types/messages'
import type { WalletHandle } from '@frank/wallet/chain'

jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    suppressedRelayReceipts: jest.fn(async () => new Set()),
    quarantineRelayReceipts: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    relayCursor: jest.fn(async () => 0),
    getIterator: async function* () {
      /* nothing persisted */
    },
  }),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
  fetchContactProfileResult: jest
    .fn()
    .mockResolvedValue({ profile: undefined, failure: 'not-published' }),
}))
jest.mock('../utils/webpush-sync', () => ({
  ...jest.requireActual('../utils/webpush-sync'),
  syncRelayNotificationPolicy: jest.fn(async () => undefined),
  requestRelayNotificationPolicySync: jest.fn(async () => undefined),
}))
jest.mock('../utils/contact-username', () => ({
  relayHandleOf: jest.fn().mockResolvedValue(undefined),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { activeChain } from '@frank/wallet/chain'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { setConversationIdSalt, useChatStore } from './chats'
import { useContactStore } from './contacts'

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const FAUCET = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const STRANGER = '0x5555555555555555555555555555555555555555'
const ANOTHER = '0x6666666666666666666666666666666666666666'

const WALLET = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle

let relayClock = 0
let sent: Array<{ by: Pinia; row: ReceivedMessageWrapper }> = []
let acting: Pinia
let sendFails = false

/** A mailbox row of the account: a note to self, or a message from someone. */
function row(options: {
  digest: string
  time: number
  from?: string
  items: MessageItem[]
}): ReceivedMessageWrapper {
  const sender = options.from ?? ME
  return {
    outbound: false,
    senderAddress: sender,
    copartyAddress: sender,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index: options.digest,
    stampValue: 0,
    message: {
      outbound: false,
      status: 'confirmed',
      senderAddress: sender,
      destinationAddress: ME,
      items: options.items,
      serverTime: options.time,
      receivedTime: options.time,
      outpoints: [],
    },
  } as unknown as ReceivedMessageWrapper
}

function device(): Pinia {
  const pinia = createPinia()
  setActivePinia(pinia)
  // The directory is not asked here: a contact's profile lookup is the contact store's own test.
  Object.assign(useContactStore(pinia), { refresh: async () => undefined })
  return pinia
}

async function on<T>(
  pinia: Pinia,
  act: (stores: {
    contacts: ReturnType<typeof useContactStore>
    chats: ReturnType<typeof useChatStore>
  }) => T | Promise<T>,
): Promise<T> {
  setActivePinia(pinia)
  acting = pinia
  return act({ contacts: useContactStore(pinia), chats: useChatStore(pinia) })
}

/** One pass of the device's contact notes; returns the mailbox rows they became. */
async function notes(pinia: Pinia): Promise<ReceivedMessageWrapper[]> {
  const before = sent.length
  await on(pinia, ({ contacts }) => contacts.noteContactStates(WALLET))
  return sent
    .slice(before)
    .filter(entry => entry.by === pinia)
    .map(entry => entry.row)
}

async function deliver(
  pinia: Pinia,
  ...batches: ReceivedMessageWrapper[][]
): Promise<void> {
  for (const batch of batches)
    await on(pinia, ({ chats }) => chats.receiveMessages(batch, ME))
}

const contactsOf = (pinia: Pinia) =>
  Object.keys(useContactStore(pinia).contacts).sort()

function addFaucet(pinia: Pinia) {
  return on(pinia, ({ contacts }) =>
    contacts.addContact({
      address: FAUCET,
      contact: { profile: { name: 'Faucet' } as never },
    }),
  )
}

beforeEach(() => {
  relayClock = 10_000
  sent = []
  sendFails = false
  setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x11)))
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(console, 'debug').mockImplementation(() => undefined)
  jest
    .spyOn(activeChain.directMessages, 'send')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockImplementation(async (params: any) => {
      if (sendFails) throw new Error('relay unreachable')
      // A note to self, and free.
      expect(params.recipient).toEqual({ raw: ME })
      expect(params.stampValue).toBe(0n)
      relayClock += 1
      const digest = `note-${Buffer.from(params.messageId).toString('hex')}`
      sent.push({
        by: acting,
        row: row({
          digest,
          time: relayClock,
          items: JSON.parse(JSON.stringify(params.items)),
        }),
      })
      return {
        payloadDigest: digest,
        stampValueWei: 0n,
        stampPayments: [],
        preparationTxHashes: [],
      }
    })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('a contact added on one device', () => {
  it('is noted to self once, as a free message saying who and when', async () => {
    const one = device()
    jest.spyOn(Date, 'now').mockReturnValue(5000)
    await addFaucet(one)
    const note = await notes(one)
    expect(note).toHaveLength(1)
    expect(note[0].message.items).toEqual([
      {
        type: 'contact-state',
        address: FAUCET.toLowerCase(),
        present: true,
        setAt: 5000,
      },
    ])
    // Nothing is left to say.
    expect(await notes(one)).toEqual([])
  })

  it('is a contact on a device that was online and on one restored later', async () => {
    const one = device()
    const online = device()
    await addFaucet(one)
    const note = await notes(one)
    await deliver(online, note)
    expect(contactsOf(online)).toEqual([FAUCET])
    const restored = device()
    await deliver(restored, note, note)
    expect(contactsOf(restored)).toEqual(contactsOf(one))
    // The note is a record, never a conversation with oneself.
    expect(Object.keys(useChatStore(restored).conversations)).toEqual([])
    // A device that only applied the note has nothing of its own to note.
    expect(await notes(restored)).toEqual([])
  })

  it('removed later on the other device, it is removed on every device, in any order', async () => {
    const one = device()
    const two = device()
    const now = jest.spyOn(Date, 'now').mockReturnValue(5000)
    await addFaucet(one)
    const added = await notes(one)
    await deliver(two, added)
    now.mockReturnValue(6000)
    await on(two, ({ contacts }) => contacts.deleteContact(FAUCET))
    const removed = await notes(two)
    expect(removed[0].message.items).toEqual([
      {
        type: 'contact-state',
        address: FAUCET.toLowerCase(),
        present: false,
        setAt: 6000,
      },
    ])
    await deliver(one, removed)
    expect(contactsOf(one)).toEqual([])
    for (const order of [
      [added, removed],
      [removed, added],
      [removed, added, removed, added],
    ]) {
      const restored = device()
      await deliver(restored, ...order)
      expect(useContactStore(restored).contactDecisions[FAUCET]).toEqual({
        present: false,
        setAt: 6000,
      })
      expect(contactsOf(restored)).toEqual([])
      // A removed contact is not brought back as a curated default either.
      await on(restored, ({ contacts }) =>
        contacts.addDefaultContact({ address: FAUCET, name: 'Faucet' }),
      )
      expect(contactsOf(restored)).toEqual([])
    }
  })

  it('added again after a removal, it is a contact again everywhere', async () => {
    const one = device()
    const now = jest.spyOn(Date, 'now').mockReturnValue(5000)
    await addFaucet(one)
    const mailbox = await notes(one)
    now.mockReturnValue(6000)
    await on(one, ({ contacts }) => contacts.deleteContact(FAUCET))
    mailbox.push(...(await notes(one)))
    now.mockReturnValue(7000)
    await addFaucet(one)
    mailbox.push(...(await notes(one)))
    expect(contactsOf(one)).toEqual([FAUCET])
    now.mockRestore()
    for (const order of [mailbox, [...mailbox].reverse()]) {
      const restored = device()
      // Each row as its own read of the mailbox, in this order.
      await deliver(restored, ...order.map(each => [each]))
      expect(contactsOf(restored)).toEqual([FAUCET])
    }
  })

  it('a note that could not be sent is sent by a later pass', async () => {
    const one = device()
    await addFaucet(one)
    sendFails = true
    expect(await notes(one)).toEqual([])
    sendFails = false
    expect(await notes(one)).toHaveLength(1)
  })

  it('a curated default the app adds is not noted', async () => {
    const one = device()
    await on(one, ({ contacts }) =>
      contacts.addDefaultContact({ address: ANOTHER, name: 'Helper bot' }),
    )
    expect(contactsOf(one)).toEqual([ANOTHER])
    expect(await notes(one)).toEqual([])
  })

  it('nobody else can add a contact to this account: a note in another sender’s row does nothing', async () => {
    const one = device()
    await deliver(one, [
      row({
        digest: 'forged',
        time: 1,
        from: STRANGER,
        items: [
          {
            type: 'contact-state',
            address: ANOTHER.toLowerCase(),
            present: true,
            setAt: 1,
          },
        ],
      }),
    ])
    expect(useContactStore(one).isContact(ANOTHER)).toBe(false)
  })
})

describe('someone who writes', () => {
  it('is not made a contact by writing, and stays for the screener', async () => {
    const one = device()
    await deliver(one, [
      row({
        digest: 'hello',
        time: 1,
        from: STRANGER,
        items: [{ type: 'text', text: 'hello' }],
      }),
    ])
    await new Promise(resolve => setImmediate(resolve))
    expect(Object.values(useChatStore(one).conversations)).toHaveLength(1)
    expect(useContactStore(one).isContact(STRANGER)).toBe(false)
    expect(await notes(one)).toEqual([])
  })

  it('is looked up, not added, when their conversation is opened', async () => {
    const one = device()
    await on(one, async ({ chats, contacts }) => {
      chats.setActiveChat(STRANGER)
      await new Promise(resolve => setImmediate(resolve))
      expect(contacts.isContact(STRANGER)).toBe(false)
    })
  })
})
