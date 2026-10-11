/** @jest-environment node */

/**
 * Two frontends of one account agree, through the REAL relay binary and real wallets.
 *
 * Nothing between the chat store and the relay is stubbed: each device is a real wallet of the
 * same account (the harness's `openRealWallet`, `packages/bot/demo/real-stack.ts`) with its own
 * empty state directory, and its own copy of the app's chat store. A device's notes to self go
 * out through its wallet's own `directMessages.send`; what it shows comes from its wallet's own
 * `directMessages.fetchSince`, through the app's `toReceivedMessageWrapper` and
 * `receiveMessages`, as the mailbox poll does. A third account plays the peer.
 *
 * Device one acts. Device two was online and held the conversation. Device three is opened
 * afterwards from the same account root with nothing stored ("restored from the seed") and
 * replays the mailbox. Every read here starts from the beginning of the mailbox, so each one is
 * also a repeated application of everything read before.
 *
 * Runs only when `FRANK_LIVE_RELAY_URL` names a running relay (cashwebd):
 *   FRANK_LIVE_RELAY_URL=http://127.0.0.1:<port> \
 *     yarn --cwd app jest src/stores/chats.devices-agree.live-relay.jest.test.ts
 *
 * It spends NOTHING and needs no funded wallet: every message here is free (a note to self, and
 * messages with a zero stamp). The accounts are new each run and never hold money; their state
 * goes under `FRANK_LIVE_STATE_DIR` (default: a new directory under the system temp directory)
 * and may be deleted.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Pinia } from 'pinia'
import type { useChatStore, Conversation } from './chats'
import type { DirectMessageSendResult } from '@frank/wallet/chain'
import type { MessageItem } from '@frank/cashweb/types/messages'
import type { RealWallet } from '../../../packages/bot/demo/real-stack'

const RELAY = process.env.FRANK_LIVE_RELAY_URL
const live = RELAY ? describe : describe.skip

// The chat store's own disk, one per device. The relay and the wallets are real; this is the
// browser database the store keeps its rows in.
interface Disk {
  rows: Map<string, unknown>
  suppressed: Set<string>
}
const mockDisks: { current: Disk } = {
  current: { rows: new Map(), suppressed: new Set() },
}
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: async (row: { index: string }) => {
      mockDisks.current.rows.set(
        row.index,
        JSON.parse(
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
      )
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
      /* a device here is never reloaded */
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

interface Device {
  name: string
  wallet: RealWallet
  pinia: Pinia
  activate: () => void
  disk: Disk
  chats: ReturnType<typeof useChatStore>
  /** Every note to self this device handed its wallet, and what the wallet answered. */
  notes: Array<{ items: MessageItem[]; result: DirectMessageSendResult }>
  toWrapper: (record: unknown) => Promise<unknown>
}

live('two devices of one account, through the real relay', () => {
  const stateDir =
    process.env.FRANK_LIVE_STATE_DIR ??
    mkdtempSync(join(tmpdir(), 'frank-devices-agree-'))
  const relayUrl = RELAY as string
  const devices: Device[] = []
  let peer: RealWallet
  let one: Device
  let two: Device

  /** A device of the account: a real wallet with its own state, and its own chat store. The
   * first one creates the account; every later one is given only the account's root. */
  async function openDevice(name: string): Promise<Device> {
    const dir = join(stateDir, name)
    if (devices.length > 0) {
      mkdirSync(join(dir, 'wallets', 'me'), { recursive: true, mode: 0o700 })
      copyFileSync(
        join(stateDir, devices[0].name, 'wallets', 'me', 'account-root.hex'),
        join(dir, 'wallets', 'me', 'account-root.hex'),
      )
    }
    // Everything the device runs is loaded for it alone, the wallet code included: one
    // process may hold an account open once, and two devices are two processes.
    let load: (() => Promise<Device>) | undefined
    // Vue looks at `document` when it is loaded; the store only asks it for focus.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).document
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const {
        openRealWallet,
      } = require('../../../packages/bot/demo/real-stack')
      const {
        conversationIdSaltOf,
      } = require('@frank/wallet/chain/monad-chain')
      const { createPinia, setActivePinia } = require('pinia')
      const { createApp } = require('vue')
      const chatsModule = require('./chats')
      const { useContactStore } = require('./contacts')
      const { activeChain } = require('@frank/wallet/chain')
      const {
        toReceivedMessageWrapper,
      } = require('../adapters/pinia-chain-adapter')
      /* eslint-enable @typescript-eslint/no-var-requires */
      const loadDevice = async (deviceName: string, deviceDir: string) => {
        const wallet: RealWallet = await openRealWallet({
          label: 'me',
          relayUrl,
          stateDir: deviceDir,
        })
        const pinia = createPinia()
        createApp({}).use(pinia)
        setActivePinia(pinia)
        // The account's own salt, from its keys: every device derives the same one.
        chatsModule.setConversationIdSalt(conversationIdSaltOf(wallet.handle))
        Object.assign(useContactStore(pinia), {
          refresh: async () => undefined,
        })
        const notes: Device['notes'] = []
        // The store sends through the app's chain object; this wallet belongs to the harness's
        // own (real) chain object, so the call is passed to it unchanged.
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockImplementation(async (params: any) => {
            const result = await wallet.chain.directMessages.send(params)
            notes.push({ items: params.items, result })
            return result
          })
        const made: Device = {
          name: deviceName,
          wallet,
          pinia,
          activate: () => setActivePinia(pinia),
          disk: { rows: new Map(), suppressed: new Set<string>() },
          chats: chatsModule.useChatStore(pinia),
          notes,
          toWrapper: toReceivedMessageWrapper,
        }
        return made
      }
      load = () => loadDevice(name, dir)
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global as any).document = { hasFocus: () => true }
    if (!load) throw new Error('device was not loaded')
    const made = await load()
    devices.push(made)
    return made
  }

  /** Another account, in its own copy of the wallet code. */
  async function openPeer(): Promise<RealWallet> {
    let open: (() => Promise<RealWallet>) | undefined
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const {
        openRealWallet,
      } = require('../../../packages/bot/demo/real-stack')
      /* eslint-enable @typescript-eslint/no-var-requires */
      open = () =>
        openRealWallet({
          label: 'peer',
          relayUrl,
          stateDir: join(stateDir, 'peer'),
        })
    })
    if (!open) throw new Error('peer was not loaded')
    return open()
  }

  async function on<T>(
    target: Device,
    act: (chats: Device['chats']) => T | Promise<T>,
  ): Promise<T> {
    mockDisks.current = target.disk
    target.activate()
    return act(target.chats)
  }

  /** Reads the device's whole mailbox from the relay into its chat store, as the poll does,
   * then lets it send what it has to note. */
  async function sync(target: Device): Promise<void> {
    const records = await target.wallet.chain.directMessages.fetchSince({
      wallet: target.wallet.handle,
      sinceMs: 0,
    })
    const wrappers = []
    for (const record of records) {
      const wrapper = await target.toWrapper(record)
      if (wrapper !== undefined) wrappers.push(wrapper)
    }
    await on(target, chats =>
      chats.receiveMessages(wrappers as never, target.wallet.address),
    )
    await on(target, chats =>
      chats.noteConversationStates(target.wallet.handle as never),
    )
  }

  const text = (target: Device) =>
    Object.values(target.chats.conversations)
      .filter((c): c is Conversation => c !== undefined)
      .flatMap(c =>
        c.messages.flatMap(m =>
          m.items.flatMap(item => (item.type === 'text' ? [item.text] : [])),
        ),
      )
      .sort()

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
          goneUpTo: Math.max(c.clearedBefore ?? -1, c.deletedAt ?? -1),
          unread: c.totalUnreadMessages,
          subject: c.name,
          messages: c.messages.map(m => m.payloadDigest),
        })),
    }
  }

  const peerSays = (words: string) =>
    peer.send(one.wallet.address, [{ type: 'text', text: words }], 0n)

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    one = await openDevice('device-one')
    two = await openDevice('device-two')
    peer = await openPeer()
    expect(two.wallet.address).toBe(one.wallet.address)
  }, 300_000)

  afterAll(async () => {
    for (const each of devices) await each.wallet.close().catch(() => undefined)
    await peer?.close().catch(() => undefined)
  }, 120_000)

  it('a deleted conversation is deleted on the online device and on one restored later, and comes back for a newer message', async () => {
    await peerSays('first')
    await peerSays('second')
    await sync(one)
    expect(shown(one).listed).toHaveLength(1)
    const [conversationId] = shown(one).listed
    // This account answers in the peer's conversation, as the app does.
    await one.wallet.chain.directMessages.send({
      wallet: one.wallet.handle,
      recipient: { raw: peer.address },
      items: [{ type: 'text', text: 'my reply' }],
      conversationId,
      stampValue: 0n,
    })
    await sync(one)
    await sync(two)
    expect(text(one)).toEqual(['first', 'my reply', 'second'])
    expect(shown(two)).toEqual(shown(one))
    expect(shown(one).listed).toEqual([conversationId])

    // Device one deletes the conversation; its note goes to the account's own mailbox.
    await on(one, chats => chats.deleteConversation(conversationId))
    await on(one, chats =>
      chats.noteConversationStates(one.wallet.handle as never),
    )
    expect(one.notes).toHaveLength(1)
    expect(one.notes[0].items).toMatchObject([
      { type: 'conversation-state', conversationId },
    ])
    // The real relay accepted it, and it cost nothing: no stamp, no payment.
    expect(one.notes[0].result.stampValueWei).toBe(0n)
    expect(one.notes[0].result.stampPayments).toEqual([])
    expect(one.notes[0].result.preparationTxHashes).toEqual([])
    expect(shown(one).listed).toEqual([])

    // The online device reads the note from the relay.
    await sync(two)
    expect(shown(two)).toEqual(shown(one))
    expect(shown(two).listed).toEqual([])
    expect(two.notes).toEqual([])

    // A device restored later from the same account root, with nothing stored.
    const three = await openDevice('device-three')
    await sync(three)
    expect(shown(three)).toEqual(shown(one))
    expect(text(three)).toEqual([])
    expect(three.notes).toEqual([])

    // Reading everything again, on every device, changes nothing and sends nothing.
    for (const each of [one, two, three, three]) await sync(each)
    expect(shown(two)).toEqual(shown(one))
    expect(shown(three)).toEqual(shown(one))
    expect(one.notes).toHaveLength(1)
    expect(two.notes.length + three.notes.length).toBe(0)

    // The peer writes again: the conversation is back everywhere, without its old messages.
    await peerSays('after the deletion')
    for (const each of [one, two, three]) await sync(each)
    expect(text(one)).toEqual(['after the deletion'])
    expect(shown(one).listed).toEqual([conversationId])
    expect(shown(two)).toEqual(shown(one))
    expect(shown(three)).toEqual(shown(one))
    // And for a device restored after all of it.
    const four = await openDevice('device-four')
    await sync(four)
    expect(shown(four)).toEqual(shown(one))
  }, 600_000)

  it('a conversation read on one device is read on the online devices and on one restored later', async () => {
    await peerSays('unread one')
    await peerSays('unread two')
    for (const each of devices) await sync(each)
    const [conversationId] = shown(one).listed
    const unread = (target: Device) =>
      shown(target).conversations.find(c => c.id === conversationId)?.unread
    // Nobody has opened it since it came back: three messages from the peer, all unread.
    expect(unread(one)).toBe(3)
    for (const each of devices) expect(shown(each)).toEqual(shown(one))

    // Device one opens the conversation and leaves it; its read mark goes to the mailbox.
    const notedBefore = one.notes.length
    await on(one, chats => {
      chats.setActiveConversation(conversationId)
      chats.setActiveConversation(null)
    })
    await on(one, chats =>
      chats.noteConversationStates(one.wallet.handle as never),
    )
    expect(one.notes).toHaveLength(notedBefore + 1)
    const mark = one.notes[notedBefore]
    expect(mark.items).toMatchObject([
      { type: 'conversation-state', conversationId },
    ])
    expect((mark.items[0] as { readUpTo?: number }).readUpTo).toBeGreaterThan(0)
    expect(mark.result.stampValueWei).toBe(0n)
    expect(mark.result.stampPayments).toEqual([])
    expect(unread(one)).toBe(0)

    for (const each of devices.slice(1)) {
      await sync(each)
      expect(shown(each)).toEqual(shown(one))
      expect(each.notes).toEqual([])
    }
    const restored = await openDevice('device-five')
    await sync(restored)
    expect(shown(restored)).toEqual(shown(one))
    expect(unread(restored)).toBe(0)

    // A newer message is unread everywhere, also after reading the mailbox again.
    await peerSays('newer')
    for (const each of [...devices, ...devices]) await sync(each)
    expect(unread(one)).toBe(1)
    for (const each of devices) expect(shown(each)).toEqual(shown(one))
    expect(one.notes).toHaveLength(notedBefore + 1)
  }, 600_000)

  it('a subject set on one device, and a conversation created with one, are on the online devices and on one restored later', async () => {
    for (const each of devices) await sync(each)
    const [conversationId] = shown(one).listed
    const subject = (target: Device, id: string) =>
      shown(target).conversations.find(c => c.id === id)?.subject

    // Device one names the conversation; no message is sent in it.
    const notedBefore = one.notes.length
    await on(one, chats =>
      chats.renameConversation(conversationId, 'Audit thread'),
    )
    await on(one, chats =>
      chats.noteConversationStates(one.wallet.handle as never),
    )
    expect(one.notes).toHaveLength(notedBefore + 1)
    expect(one.notes[notedBefore].items).toMatchObject([
      { type: 'conversation-state', conversationId, subject: 'Audit thread' },
    ])
    expect(one.notes[notedBefore].result.stampValueWei).toBe(0n)
    expect(one.notes[notedBefore].result.stampPayments).toEqual([])

    for (const each of devices.slice(1)) {
      await sync(each)
      expect(subject(each, conversationId)).toBe('Audit thread')
      expect(shown(each)).toEqual(shown(one))
      expect(each.notes).toEqual([])
    }

    // A second conversation with the same peer, created with a subject and still empty.
    const created = await on(one, chats =>
      chats.createConversation({
        kind: 'direct',
        name: 'Second thread',
        participants: [peer.address],
        address: peer.address,
      }),
    )
    await on(one, chats =>
      chats.noteConversationStates(one.wallet.handle as never),
    )
    expect(one.notes).toHaveLength(notedBefore + 2)
    for (const each of devices.slice(1)) {
      await sync(each)
      expect(subject(each, created.id)).toBe('Second thread')
      expect(shown(each)).toEqual(shown(one))
    }

    const restored = await openDevice('device-six')
    await sync(restored)
    expect(subject(restored, conversationId)).toBe('Audit thread')
    expect(subject(restored, created.id)).toBe('Second thread')
    expect(shown(restored)).toEqual(shown(one))
    expect(restored.notes).toEqual([])

    // Removing the subject reaches them too, and reading everything again changes nothing.
    await on(one, chats => chats.renameConversation(conversationId, ''))
    await on(one, chats =>
      chats.noteConversationStates(one.wallet.handle as never),
    )
    for (const each of [...devices, ...devices]) await sync(each)
    for (const each of devices) {
      expect(subject(each, conversationId)).toBeUndefined()
      expect(shown(each)).toEqual(shown(one))
    }
    expect(one.notes).toHaveLength(notedBefore + 3)
  }, 600_000)
})
