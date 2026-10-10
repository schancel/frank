import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chats'
import { useContactStore } from './contacts'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { store as storePromise } from '../adapters/level-message-store'
import { setConversationIdSalt as installTestConversationIdSalt } from './chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

Object.defineProperty(globalThis, 'document', {
  value: { hasFocus: () => true },
  configurable: true,
})
const mockOwnAddress = jest.fn()
const mockRoute = jest.fn(async () => ({}))
const mockResolve = jest.fn()
jest.mock('../utils/own-address', () => ({
  ...jest.requireActual('../utils/own-address'),
  getOwnCanonicalAddress: () => mockOwnAddress(),
}))
jest.mock('@frank/wallet/sync-router', () => ({
  routeWalletSyncItem: (...args: unknown[]) => mockRoute(...args),
}))
jest.mock('../accounts/sync-router', () => ({
  appMultiChainResolver: {
    resolve: (...args: unknown[]) => mockResolve(...args),
  },
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('../utils/directory-peer', () => ({
  fetchContactProfile: jest.fn(async () => undefined),
}))
jest.mock('../adapters/level-message-store', () => {
  const retained = new Map<string, string>()
  return {
    store: Promise.resolve({
      retained,
      saveMessage: jest.fn(async (wrapper: ReceivedMessageWrapper) => {
        retained.set(wrapper.index, JSON.stringify(wrapper))
      }),
      deleteMessage: jest.fn(async () => undefined),
      relayCursor: jest.fn(async () => 10),
      mostRecentMessageTime: jest.fn(async () => 10),
      quarantineRelayReceipts: jest.fn(async () => undefined),
      suppressAndDelete: jest.fn(async () => undefined),
      suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
      getIterator: jest.fn(async function* () {
        // This isolated fixture has no restored rows.
      }),
    }),
  }
})
const ME = '0x2222222222222222222222222222222222222222'
const PEER = '0x1111111111111111111111111111111111111111'
function wrapper(index: string, items: MessageItem[]): ReceivedMessageWrapper {
  return {
    index,
    outbound: false,
    senderAddress: PEER,
    copartyAddress: PEER,
    copartyPubKey: null as never,
    stampValue: 0,
    message: {
      outbound: false,
      status: 'confirmed',
      senderAddress: PEER,
      destinationAddress: ME,
      receivedTime: 20,
      serverTime: 20,
      items,
      outpoints: [],
      conversationId: '11111111-1111-1111-1111-111111111111',
    },
  }
}
type FixtureStore = {
  retained: Map<string, string>
  saveMessage: jest.Mock
  deleteMessage: jest.Mock
  relayCursor: jest.Mock
  mostRecentMessageTime: jest.Mock
  quarantineRelayReceipts: jest.Mock
  suppressAndDelete: jest.Mock
  suppressedRelayReceipts: jest.Mock
}
let database: FixtureStore
beforeEach(async () => {
  setActivePinia(createPinia())
  database = (await storePromise) as unknown as FixtureStore
  database.retained.clear()
  database.retained.set(
    'retained-operation',
    'original pending operation bytes',
  )
  jest.clearAllMocks()
  database.suppressedRelayReceipts
    .mockReset()
    .mockResolvedValue(new Set<string>())
  mockOwnAddress.mockResolvedValue(ME)
})

// The wallet's receive rule keeps these item types from reaching the store as such. If one does,
// that row alone is refused, uninterpreted: it must not stop the rows around it.
it.each(['wallet-sync', 'payment-transfer'])(
  'skips an incoming %s row without interpreting or saving it, and delivers the row beside it',
  async type => {
    const chats = useChatStore()
    useContactStore().addContact({
      address: PEER,
      contact: {
        profile: { name: 'Fixture', bio: '', avatar: '', pubKey: null },
      },
    })
    const batch = [
      wrapper(`ordinary-${type}`, [{ type: 'text', text: 'ordinary' }]),
      wrapper(`unsupported-${type}`, [{ type } as unknown as MessageItem]),
    ]
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
      /* the refused row is reported here */
    })
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        await chats.storeReceivedMessagesExclusive(
          batch,
          new Set([`ordinary-${type}`, `unsupported-${type}`]),
          ME,
        )
      }
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
    expect(mockRoute).not.toHaveBeenCalled()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(
      database.saveMessage.mock.calls.map(([row]) => row.index),
    ).not.toContain(`unsupported-${type}`)
    expect(database.saveMessage.mock.calls[0][0].index).toBe(`ordinary-${type}`)
    expect(chats.messages[`ordinary-${type}`]).toBeDefined()
    expect(chats.messages[`unsupported-${type}`]).toBeUndefined()
    expect(database.quarantineRelayReceipts).toHaveBeenCalledTimes(1)
    expect(database.quarantineRelayReceipts).toHaveBeenCalledWith(ME, [
      { payloadDigest: `unsupported-${type}`, receivedTime: 20 },
    ])
    expect(database.retained.get('retained-operation')).toBe(
      'original pending operation bytes',
    )
    expect(database.retained.has(`unsupported-${type}`)).toBe(false)
  },
)

it('preserves the exclusive cancellation exit without interpreting abandoned items', async () => {
  const result = await useChatStore().storeReceivedMessagesExclusive(
    [wrapper('cancelled', [{ type: 'wallet-sync' } as unknown as MessageItem])],
    new Set(),
    ME,
    { isCancelled: () => true },
  )
  expect(result).toEqual({
    suppressedReceipts: [],
    cancelled: true,
  })
  expect(database.saveMessage).not.toHaveBeenCalled()
  expect(mockRoute).not.toHaveBeenCalled()
})

it('stores ordinary JSON-shaped text verbatim without sync routing', async () => {
  useContactStore().addContact({
    address: PEER,
    contact: {
      profile: { name: 'Fixture', bio: '', avatar: '', pubKey: null },
    },
  })
  const text = '{"note":"ordinary text remains text"}'
  const result = await useChatStore().storeReceivedMessagesExclusive(
    [wrapper('ordinary', [{ type: 'text', text }])],
    new Set(['ordinary']),
    ME,
  )
  expect(result.cancelled).toBe(false)
  expect(database.saveMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.objectContaining({ items: [{ type: 'text', text }] }),
    }),
    { advanceCursor: false },
  )
  expect(mockRoute).not.toHaveBeenCalled()
  expect(mockResolve).not.toHaveBeenCalled()
  expect(database.retained.get('retained-operation')).toBe(
    'original pending operation bytes',
  )
})
