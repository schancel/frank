/**
 * Two frontends of one account end with the same conversation list.
 *
 * What one device does to a conversation (deletes it, reads it) is noted to the account's own mailbox as a
 * free message to self carrying a `conversation-state` item. The account's other devices read
 * the note, and so does a device restored later from the seed, which replays the whole mailbox.
 *
 * Each "device" here is its own chat store with its own message disk. Device one acts; the note
 * it sends is taken at the wallet's send call (the one seam stubbed here) and handed, as the
 * mailbox row it becomes, to the other devices: one that already holds the conversation
 * ("online"), and one that starts empty and is given the account's whole mailbox ("restored"),
 * in the order the relay keeps it, in other orders, and more than once. All must show what
 * device one shows.
 *
 * The same notes through the real relay binary and real wallets: see
 * `chats.devices-agree.live-relay.jest.test.ts`. Plain `node` environment; see
 * `chats.jest.test.ts`'s header for why.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import type { Pinia } from 'pinia'
import type { useChatStore, Conversation } from './chats'
import type { WalletHandle } from '@frank/wallet/chain'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type {
  ConversationStateItem,
  MessageItem,
  MessageWrapper,
} from '@frank/cashweb/types/messages'

// One message disk per device; `mockDisks.current` is the device acting now.
interface Disk {
  rows: Map<string, MessageWrapper>
  suppressed: Set<string>
}
const mockDisks: { current: Disk } = {
  current: { rows: new Map(), suppressed: new Set() },
}
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (row: MessageWrapper) => {
      mockDisks.current.rows.set(row.index, JSON.parse(JSON.stringify(row)))
    },
    deleteMessage: async (index: string) => {
      mockDisks.current.rows.delete(index)
    },
    suppressAndDelete: async (
      _recipient: string,
      digests: string[],
      suppressions: Array<{ payloadDigest: string }>,
    ) => {
      for (const digest of digests) mockDisks.current.rows.delete(digest)
      for (const entry of suppressions)
        mockDisks.current.suppressed.add(entry.payloadDigest)
    },
    suppressedRelayReceipts: async (
      _recipient: string,
      receipts: Array<{ payloadDigest: string }>,
    ) =>
      new Set(
        receipts
          .map(receipt => receipt.payloadDigest)
          .filter(digest => mockDisks.current.suppressed.has(digest)),
      ),
    quarantineRelayReceipts: async () => undefined,
    mostRecentMessageTime: async () => 0,
    relayCursor: async () => 0,
    getIterator: async function* () {
      for (const key of [...mockDisks.current.rows.keys()].sort())
        yield JSON.parse(JSON.stringify(mockDisks.current.rows.get(key)))
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

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const STRANGER = '0x5555555555555555555555555555555555555555'
const WITH_PEER = '11111111-1111-4111-8111-111111111111'

const WALLET = {
  identity: { address: { raw: ME } },
} as unknown as WalletHandle

/** A mailbox row of the account: a message from or to the peer, or a note to self. */
function row(options: {
  digest: string
  time: number
  from?: string
  conversationId?: string
  items?: MessageItem[]
  subject?: string
}): ReceivedMessageWrapper {
  const sender = options.from ?? PEER
  const outbound = sender === ME && !options.items
  const coparty = options.items ? ME : outbound ? PEER : sender
  const conversationId = options.items
    ? undefined
    : options.conversationId ?? WITH_PEER
  return {
    ...(conversationId === undefined ? {} : { conversationId }),
    outbound,
    senderAddress: sender,
    copartyAddress: coparty,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    index: options.digest,
    stampValue: 0,
    message: {
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(options.subject === undefined
        ? {}
        : { conversationName: options.subject }),
      outbound,
      status: 'confirmed',
      senderAddress: sender,
      destinationAddress: outbound ? coparty : ME,
      items: options.items ?? [{ type: 'text', text: options.digest }],
      serverTime: options.time,
      receivedTime: options.time,
      outpoints: [],
    },
  } as unknown as ReceivedMessageWrapper
}

interface Device {
  name: string
  pinia: Pinia
  activate: () => void
  disk: Disk
  chats: ReturnType<typeof useChatStore>
}

const opened: Device[] = []

// The notes devices send, taken at the wallet's send call and timed as the relay would.
let relayClock = 0
let sent: Array<{ by: string; row: ReceivedMessageWrapper }> = []
let sendFails = false
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/**
 * A device: its own copy of the chat store module (and of everything that module keeps for one
 * app session), its own store and its own disk. Nothing is shared between two devices but the
 * account.
 */
function device(name: string): Device {
  let made: Device | undefined
  // Vue looks at `document` when it is loaded, and the stand-in above is not a DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globals = global as any
  const standIn = globals.document
  delete globals.document
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { createPinia, setActivePinia } = require('pinia')
    const { createApp } = require('vue')
    const chatsModule = require('./chats')
    const { useContactStore } = require('./contacts')
    const { activeChain } = require('@frank/wallet/chain')
    const {
      conversationIdSalt,
    } = require('@frank/cashweb/relay/conversation-id')
    /* eslint-enable @typescript-eslint/no-var-requires */
    const pinia = createPinia()
    createApp({}).use(pinia)
    setActivePinia(pinia)
    // The account's salt: the same on every device of the account.
    chatsModule.setConversationIdSalt(
      conversationIdSalt(new Uint8Array(32).fill(0x11)),
    )
    Object.assign(useContactStore(pinia), { refresh: async () => undefined })
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async (params: any) => {
        if (sendFails) throw new Error('relay unreachable')
        // A note to self, and free.
        expect(params.wallet).toBe(WALLET)
        expect(params.recipient).toEqual({ raw: ME })
        expect(params.stampValue).toBe(0n)
        relayClock += 1
        const digest = `note-${hex(params.messageId as Uint8Array)}`
        sent.push({
          by: name,
          row: row({
            digest,
            time: relayClock,
            from: ME,
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
    made = {
      name,
      pinia,
      activate: () => setActivePinia(pinia),
      disk: { rows: new Map(), suppressed: new Set<string>() },
      chats: chatsModule.useChatStore(pinia),
    }
  })
  globals.document = standIn
  if (!made) throw new Error('device was not opened')
  opened.push(made)
  return made
}

/** Runs `act` as this device: its store, its disk. */
async function on<T>(
  target: Device,
  act: (chats: Device['chats']) => T | Promise<T>,
): Promise<T> {
  mockDisks.current = target.disk
  target.activate()
  return act(target.chats)
}

/** The relay hands these rows to the device, each array as one read of the mailbox. */
async function deliver(
  target: Device,
  ...batches: ReceivedMessageWrapper[][]
): Promise<void> {
  for (const batch of batches)
    await on(target, chats => chats.receiveMessages(batch, ME))
}

/** One pass of the device's notes to self; returns the mailbox rows they became. */
async function notes(target: Device): Promise<ReceivedMessageWrapper[]> {
  const before = sent.length
  await on(target, chats => chats.noteConversationStates(WALLET))
  return sent
    .slice(before)
    .filter(entry => entry.by === target.name)
    .map(entry => entry.row)
}

/** What a user sees of the chats, and what decides what they will see next. */
function shown(target: Device) {
  const conversations = Object.values(target.chats.conversations).filter(
    (c): c is Conversation => c !== undefined,
  )
  return {
    listed: target.chats.getSortedChatOrder.map(c => c.id).sort(),
    conversations: conversations
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(c => ({
        id: c.id,
        peer: c.address,
        deleted: c.deletedAt !== undefined,
        // Messages no newer than this never come back.
        goneUpTo: Math.max(c.clearedBefore ?? -1, c.deletedAt ?? -1),
        unread: c.totalUnreadMessages,
        messages: c.messages.map(m => m.payloadDigest),
      })),
    onDisk: [...target.disk.rows.keys()].sort(),
  }
}

beforeEach(() => {
  relayClock = 10_000
  sent = []
  sendFails = false
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(console, 'debug').mockImplementation(() => undefined)
})

afterEach(() => {
  for (const each of opened.splice(0)) each.chats.$dispose()
  jest.restoreAllMocks()
})

/** The conversation with the peer as the account's mailbox holds it: two messages from the
 * peer and one of ours between them. */
const HISTORY = [
  row({ digest: 'peer-1', time: 1000 }),
  row({ digest: 'mine-1', time: 1500, from: ME }),
  row({ digest: 'peer-2', time: 2000 }),
]

describe('a conversation deleted on one device', () => {
  /** Device one holds the conversation, deletes it, and notes that. */
  async function deletedOnDeviceOne(deletedAt = 5000) {
    const one = device('one')
    await deliver(one, HISTORY)
    await on(one, chats => chats.deleteConversation(WITH_PEER, deletedAt))
    const note = await notes(one)
    expect(note).toHaveLength(1)
    return { one, note }
  }

  it('is noted to self once, as a free message that says up to when it was deleted', async () => {
    const { one, note } = await deletedOnDeviceOne()
    expect(note[0].message.items).toEqual([
      {
        type: 'conversation-state',
        conversationId: WITH_PEER,
        peer: PEER,
        clearedBefore: 5000,
      },
    ])
    // Another pass, and reading its own note back, sends nothing more and changes nothing.
    const before = shown(one)
    expect(await notes(one)).toEqual([])
    await deliver(one, note, note)
    expect(await notes(one)).toEqual([])
    expect(shown(one)).toEqual(before)
    expect(before.listed).toEqual([])
  })

  it('is deleted on a device that was online and held it', async () => {
    const two = device('two')
    await deliver(two, HISTORY)
    expect(shown(two).listed).toEqual([WITH_PEER])
    const { one, note } = await deletedOnDeviceOne()

    await deliver(two, note)
    expect(shown(two)).toEqual(shown(one))
    expect(shown(two).listed).toEqual([])
    expect(shown(two).onDisk).toEqual([])
    // It read the note; it does not write one of its own.
    expect(await notes(two)).toEqual([])
  })

  it('is deleted on a device restored later, which replays the whole mailbox', async () => {
    const { one, note } = await deletedOnDeviceOne()
    const mailbox = [...HISTORY, ...note]

    const inOneRead = device('restored, one read')
    await deliver(inOneRead, mailbox)
    expect(shown(inOneRead)).toEqual(shown(one))

    const rowByRow = device('restored, row by row')
    await deliver(rowByRow, ...mailbox.map(each => [each]))
    expect(shown(rowByRow)).toEqual(shown(one))
    expect(await notes(rowByRow)).toEqual([])
  })

  it('stays deleted however often the note and the old messages are handed back', async () => {
    const { one, note } = await deletedOnDeviceOne()
    const two = device('two')
    await deliver(two, HISTORY, note, note, HISTORY, note, [
      ...note,
      ...HISTORY,
    ])
    expect(shown(two)).toEqual(shown(one))
    // And on the device that deleted it.
    await deliver(one, HISTORY, note)
    expect(shown(two)).toEqual(shown(one))
    expect(shown(one).listed).toEqual([])
  })

  it('is deleted whatever order the note and the messages are read in', async () => {
    const { one, note } = await deletedOnDeviceOne()
    const orders: ReceivedMessageWrapper[][][] = [
      [note, HISTORY],
      [[...note, ...HISTORY]],
      [[HISTORY[2]], note, [HISTORY[0], HISTORY[1]]],
      [[HISTORY[1]], [HISTORY[0]], note, [HISTORY[2]]],
    ]
    for (const [n, batches] of orders.entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
    }
  })

  it('comes back, without its old messages, when the peer writes after the deletion', async () => {
    const { one, note } = await deletedOnDeviceOne()
    const after = row({ digest: 'peer-3', time: 6000 })
    await deliver(one, [after])
    expect(shown(one).listed).toEqual([WITH_PEER])
    expect(shown(one).conversations[0].messages).toEqual(['peer-3'])

    const orders: ReceivedMessageWrapper[][][] = [
      [HISTORY, note, [after]],
      [[...HISTORY, ...note, after]],
      [[after], HISTORY, note],
      [note, [after], HISTORY],
      [[after], note, HISTORY, note],
      [[...HISTORY, after], note],
    ]
    for (const [n, batches] of orders.entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
      expect(await notes(other)).toEqual([])
    }
  })

  it('deleted twice: the later deletion decides, in either order', async () => {
    const { one, note: first } = await deletedOnDeviceOne(5000)
    const between = row({ digest: 'peer-3', time: 6000 })
    await deliver(one, [between])
    await on(one, chats => chats.deleteConversation(WITH_PEER, 7000))
    const second = await notes(one)
    expect(second).toHaveLength(1)
    expect(
      (second[0].message.items[0] as ConversationStateItem).clearedBefore,
    ).toBe(7000)
    const later = row({ digest: 'peer-4', time: 8000 })
    await deliver(one, [later])
    expect(shown(one).conversations[0].messages).toEqual(['peer-4'])

    const everything = [...HISTORY, between, later]
    const orders: ReceivedMessageWrapper[][][] = [
      [everything, first, second],
      [everything, second, first],
      [second, first, everything],
      [first, [between], second, HISTORY, [later]],
      [[later], second, [between], first, HISTORY],
    ]
    for (const [n, batches] of orders.entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
    }
  })

  it('covers a message the relay timed later than this device’s clock', async () => {
    // The device's clock runs behind the relay: it deletes "at 1800" a conversation whose
    // newest message the relay timed 2000. That message was on screen and is deleted too.
    const { one, note } = await deletedOnDeviceOne(1800)
    expect(
      (note[0].message.items[0] as ConversationStateItem).clearedBefore,
    ).toBe(2000)
    const restored = device('restored')
    await deliver(restored, [...HISTORY, ...note])
    expect(shown(restored)).toEqual(shown(one))
    expect(shown(restored).listed).toEqual([])
  })

  it('a note that could not be sent is sent by a later pass, once', async () => {
    const one = device('one')
    await deliver(one, HISTORY)
    sendFails = true
    await on(one, chats => chats.deleteConversation(WITH_PEER, 5000))
    expect(await notes(one)).toEqual([])
    expect(await notes(one)).toEqual([])
    sendFails = false
    const note = await notes(one)
    expect(note).toHaveLength(1)
    expect(await notes(one)).toEqual([])

    const two = device('two')
    await deliver(two, HISTORY, note)
    expect(shown(two)).toEqual(shown(one))
  })

  it('nobody else can delete a conversation: a note in another sender’s message does nothing', async () => {
    const one = device('one')
    await deliver(one, HISTORY)
    const forged: MessageItem = {
      type: 'conversation-state',
      conversationId: WITH_PEER,
      peer: PEER,
      clearedBefore: 9000,
    }
    for (const from of [PEER, STRANGER]) {
      const fromOther = row({ digest: `forged-${from}`, time: 3000, from })
      fromOther.message.items = [forged]
      await deliver(one, [fromOther])
    }
    expect(shown(one).listed).toEqual([WITH_PEER])
    expect(shown(one).conversations[0].messages).toEqual([
      'peer-1',
      'mine-1',
      'peer-2',
    ])
  })

  it('a message of ours still on its way is not deleted by a note from elsewhere', async () => {
    const two = device('two')
    await deliver(two, HISTORY)
    // Device two is sending; the relay has not timed the message yet.
    await on(two, chats =>
      chats.sendMessageLocal({
        address: PEER,
        conversationId: WITH_PEER,
        senderAddress: ME,
        index: 'pending:1',
        items: [{ type: 'text', text: 'on its way' }],
        outpoints: [],
        status: 'pending',
        previousHash: null,
        timestamp: 4000,
      }),
    )
    const { note } = await deletedOnDeviceOne(5000)
    await deliver(two, note)
    expect(shown(two).listed).toEqual([WITH_PEER])
    expect(shown(two).conversations[0].messages).toEqual(['pending:1'])
  })
})

describe('a conversation read on one device', () => {
  const readNote = (rows: ReceivedMessageWrapper[]) =>
    rows.map(each => each.message.items[0] as ConversationStateItem)

  /** Device one holds the conversation, opens it (which reads it) and leaves it again. */
  async function readOnDeviceOne() {
    const one = device('one')
    await deliver(one, HISTORY)
    expect(shown(one).conversations[0].unread).toBe(2)
    await on(one, chats => {
      chats.setActiveConversation(WITH_PEER)
      chats.setActiveConversation(null)
    })
    const note = await notes(one)
    expect(shown(one).conversations[0].unread).toBe(0)
    return { one, note }
  }

  it('is noted to self once, as one mark: the relay time of the newest message read', async () => {
    const { one, note } = await readOnDeviceOne()
    expect(readNote(note)).toEqual([
      {
        type: 'conversation-state',
        conversationId: WITH_PEER,
        peer: PEER,
        readUpTo: 2000,
      },
    ])
    // Opening it again with nothing new, and reading the note back, sends nothing.
    await on(one, chats => {
      chats.setActiveConversation(WITH_PEER)
      chats.setActiveConversation(null)
    })
    expect(await notes(one)).toEqual([])
    await deliver(one, note)
    expect(await notes(one)).toEqual([])
    expect(shown(one).conversations[0].unread).toBe(0)
  })

  it('is read on a device that was online, and on one restored later', async () => {
    const two = device('two')
    await deliver(two, HISTORY)
    expect(shown(two).conversations[0].unread).toBe(2)
    const { one, note } = await readOnDeviceOne()

    await deliver(two, note)
    expect(shown(two)).toEqual(shown(one))
    expect(await notes(two)).toEqual([])

    const restored = device('restored')
    await deliver(restored, [...HISTORY, ...note])
    expect(shown(restored)).toEqual(shown(one))
    expect(await notes(restored)).toEqual([])
  })

  it('is read whatever order the mark and the messages arrive in, and however often', async () => {
    const { one, note } = await readOnDeviceOne()
    const orders: ReceivedMessageWrapper[][][] = [
      [note, HISTORY],
      [HISTORY, note, note, HISTORY],
      [[HISTORY[2]], note, [HISTORY[0], HISTORY[1]], note],
      [[...note, ...HISTORY]],
      ...HISTORY.map((_, i) => [HISTORY.slice(0, i), note, HISTORY.slice(i)]),
    ]
    for (const [n, batches] of orders.entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
    }
  })

  it('a message after the mark is unread on every device', async () => {
    const { one, note } = await readOnDeviceOne()
    const newer = row({ digest: 'peer-3', time: 3000 })
    await deliver(one, [newer])
    expect(shown(one).conversations[0].unread).toBe(1)
    for (const [n, batches] of [
      [HISTORY, note, [newer]],
      [[...HISTORY, newer], note],
      [note, [newer], HISTORY],
    ].entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
      // It has read nothing itself: it has nothing to note.
      expect(await notes(other)).toEqual([])
    }
  })

  it('two marks: the higher one decides, in either order', async () => {
    const { one, note: first } = await readOnDeviceOne()
    const newer = [
      row({ digest: 'peer-3', time: 3000 }),
      row({ digest: 'peer-4', time: 4000 }),
    ]
    await deliver(one, [newer[0]])
    await on(one, chats => {
      chats.setActiveConversation(WITH_PEER)
      chats.setActiveConversation(null)
    })
    const second = await notes(one)
    expect(readNote(second).map(each => each.readUpTo)).toEqual([3000])
    await deliver(one, [newer[1]])
    expect(shown(one).conversations[0].unread).toBe(1)

    const everything = [...HISTORY, ...newer]
    for (const [n, batches] of [
      [everything, first, second],
      [everything, second, first],
      [second, everything, first],
      [first, second, everything],
    ].entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
    }
  })

  it('a message read as it arrives in the open conversation is noted by the next pass', async () => {
    const one = device('one')
    await deliver(one, HISTORY)
    await on(one, chats => chats.setActiveConversation(WITH_PEER))
    await notes(one)
    await deliver(one, [row({ digest: 'peer-3', time: 3000 })])
    const note = await notes(one)
    expect(readNote(note).map(each => each.readUpTo)).toEqual([3000])

    const two = device('two')
    await deliver(two, [...HISTORY, row({ digest: 'peer-3', time: 3000 })])
    expect(shown(two).conversations[0].unread).toBe(3)
    await deliver(two, note)
    expect(shown(two).conversations[0].unread).toBe(0)
  })

  it('the mark is a relay time: a message of ours on its way does not move it', async () => {
    const one = device('one')
    await deliver(one, HISTORY)
    // Our own message, timed by this device's clock, far ahead of the relay's.
    await on(one, chats =>
      chats.sendMessageLocal({
        address: PEER,
        conversationId: WITH_PEER,
        senderAddress: ME,
        index: 'pending:1',
        items: [{ type: 'text', text: 'on its way' }],
        outpoints: [],
        status: 'pending',
        previousHash: null,
        timestamp: 9_000_000,
      }),
    )
    await on(one, chats => {
      chats.setActiveConversation(WITH_PEER)
      chats.setActiveConversation(null)
    })
    const note = await notes(one)
    expect(readNote(note).map(each => each.readUpTo)).toEqual([2000])

    // On another device a later message from the peer is unread, as it is here.
    const later = row({ digest: 'peer-3', time: 3000 })
    const two = device('two')
    await deliver(two, HISTORY, note, [later])
    expect(shown(two).conversations[0].unread).toBe(1)
  })

  it('reading and deleting are noted together and applied together', async () => {
    const { one } = await readOnDeviceOne()
    await on(one, chats => chats.deleteConversation(WITH_PEER, 5000))
    const deletion = await notes(one)
    const after = row({ digest: 'peer-3', time: 6000 })
    await deliver(one, [after])
    expect(shown(one).conversations[0]).toMatchObject({
      messages: ['peer-3'],
      unread: 1,
    })
    const mailbox = [...HISTORY, ...sent.map(entry => entry.row), after]
    expect(deletion).toHaveLength(1)
    for (const [n, batches] of [
      [mailbox],
      [[...mailbox].reverse()],
      mailbox.map(each => [each]),
      [...mailbox].reverse().map(each => [each]),
    ].entries()) {
      const other = device(`order ${n}`)
      await deliver(other, ...batches)
      expect(shown(other)).toEqual(shown(one))
    }
  })
})
