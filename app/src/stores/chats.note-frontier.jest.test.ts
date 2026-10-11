/** @jest-environment node */
/** Actual receipt storage and production Pinia persistence barrier at an interrupted poll. */
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { ConversationStateItem } from '@frank/cashweb/types/messages'

let mockDisk: LevelMessageStore
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve(
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'then') return undefined
          const value = (mockDisk as unknown as Record<PropertyKey, unknown>)[
            key
          ]
          return typeof value === 'function' ? value.bind(mockDisk) : value
        },
      },
    ),
  ),
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../composables/useBalance', () => ({
  useBalance: () => ({ refresh: jest.fn() }),
}))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn().mockResolvedValue(undefined),
}))

import { createStoragePlugin, STORE_SCHEMA_VERSION } from '../boot/pinia'
import { displayNetwork } from '../utils/constants'
import { setConversationIdSalt, useChatStore } from './chats'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const ID = '11111111-1111-4111-8111-111111111111'
const note: ConversationStateItem = {
  type: 'conversation-state',
  conversationId: ID,
  peer: PEER,
  clearedBefore: 50,
  readUpTo: 200,
  subject: 'Shared subject',
  subjectSetAt: 100,
}
function row(
  index: string,
  time: number,
  state?: ConversationStateItem,
): ReceivedMessageWrapper {
  const sender = state ? ME : PEER
  return {
    index,
    outbound: false,
    senderAddress: sender,
    copartyAddress: state ? ME : PEER,
    copartyPubKey: { toBuffer: () => new Uint8Array(33) },
    stampValue: 0,
    ...(state ? {} : { conversationId: ID }),
    message: {
      outbound: false,
      status: 'confirmed',
      senderAddress: sender,
      destinationAddress: ME,
      serverTime: time,
      receivedTime: time,
      outpoints: [],
      ...(state ? {} : { conversationId: ID }),
      items: state ? [state] : [{ type: 'text', text: index }],
    },
  } as unknown as ReceivedMessageWrapper
}
const history = row('history', 50),
  notification = row('note', 100, note),
  later = row('later', 200)
function shown(chats: ReturnType<typeof useChatStore>) {
  const conv = chats.conversations[ID]!
  return {
    name: conv.name,
    read: conv.lastRead,
    cutoff: Math.max(conv.clearedBefore ?? -1, conv.deletedAt ?? -1),
    messages: conv.messages.map(message => message.payloadDigest),
    unread: conv.totalUnreadMessages,
    listed: chats.getSortedChatOrder.map(conv => conv.id),
  }
}
async function open(path: string) {
  mkdirSync(join(path, 'receipts'), { recursive: true })
  mockDisk = new LevelMessageStore(join(path, 'receipts'))
  await mockDisk.Open()
  const metadata = level(join(path, 'chat-metadata'))
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      metadata,
      Promise.resolve({
        networkName: displayNetwork,
        version: STORE_SCHEMA_VERSION,
      }),
    ),
  )
  createApp({}).use(pinia)
  setActivePinia(pinia)
  setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(17)))
  const chats = useChatStore(pinia)
  await chats.restored
  return {
    chats,
    metadata,
    disk: mockDisk,
    close: async () => {
      chats.$dispose()
      await mockDisk.Close()
      await metadata.close()
    },
  }
}

it.each([
  ['batch', 'existing'],
  ['stream', 'existing'],
  ['batch', 'unseen'],
  ['stream', 'unseen'],
] as const)(
  'commits a %s note for an %s conversation before a later durable receipt survives interruption',
  async (mode, target) => {
    ;(global as unknown as { document: unknown }).document = {
      hasFocus: () => true,
    }
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const replay = await open(
      mkdtempSync(join(tmpdir(), 'frank-note-seed-replay-')),
    )
    await replay.chats.receiveMessages([history, notification, later], ME)
    await replay.chats.flushPersistence()
    const expected = shown(replay.chats)
    await replay.close()

    const path = mkdtempSync(join(tmpdir(), 'frank-note-frontier-'))
    let current = await open(path)
    try {
      if (target === 'existing') {
        await current.chats.receiveMessages([history], ME)
        await current.chats.flushPersistence()
      }
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      let started!: () => void
      const metadataStarted = new Promise<void>(resolve => {
        started = resolve
      })
      const put = current.metadata.put.bind(current.metadata)
      const metadataWrite = jest
        .spyOn(current.metadata, 'put')
        .mockImplementation(async (key, value, options) => {
          started()
          await blocked
          return put(key, value, options)
        })
      const save = current.disk.saveMessage.bind(current.disk)
      const receiptWrite = jest
        .spyOn(current.disk, 'saveMessage')
        .mockImplementation(async (wrapper, options) => {
          await save(wrapper, options)
          if (wrapper.index === 'later')
            throw new Error('interruption after durable later receipt')
        })
      let receiving: Promise<unknown>
      if (mode === 'batch')
        receiving = current.chats.receiveMessages([notification, later], ME)
      else {
        // Start both calls without waiting: the production mutation queue owns their ordering.
        const first = current.chats.receiveMessages([notification], ME)
        const second = current.chats.receiveMessages([later], ME)
        receiving = Promise.all([first, second])
      }
      const outcome = receiving.catch(error => error)
      const checkpoint = await Promise.race([
        metadataStarted.then(() => 'metadata'),
        outcome.then(() => 'interrupted'),
      ])
      await nextTick()
      // Let queued filesystem callbacks run while the metadata commit is held. A streamed
      // second receive must remain behind the note's persistence barrier too.
      const finishedBeforeCommit = await Promise.race([
        outcome.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 30)),
      ])
      try {
        expect(checkpoint).toBe('metadata')
        expect(finishedBeforeCommit).toBe(false)
        expect(
          receiptWrite.mock.calls.some(
            ([wrapper]) => wrapper.index === 'later',
          ),
        ).toBe(false)
        expect(await current.disk.relayCursor(ME)).toBeLessThan(200)
      } finally {
        release()
        await outcome
      }
      expect(await outcome).toEqual(
        new Error('interruption after durable later receipt'),
      )
      metadataWrite.mockRestore()
      receiptWrite.mockRestore()
      expect(await current.disk.relayCursor(ME)).toBe(200)
      await current.close()
      current = await open(path)
      // The restart fetch will start at 200, skipping note100. Its effects must already be durable.
      expect(await current.disk.relayCursor(ME)).toBe(200)
      expect(shown(current.chats)).toEqual(expected)
      await current.chats.receiveMessages([later], ME)
      expect(shown(current.chats)).toEqual(expected)
    } finally {
      await current.close()
      jest.restoreAllMocks()
      delete (global as unknown as { document?: unknown }).document
    }
  },
)
