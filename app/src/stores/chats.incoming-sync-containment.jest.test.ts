import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chats'
import { useContactStore } from './contacts'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { store as storePromise } from '../adapters/level-message-store'

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

it.each(['wallet-sync', 'payment-transfer'])(
  'rejects inert incoming %s batches before custody, writes or receipt work',
  async type => {
    const chats = useChatStore()
    const batch = [
      wrapper('ordinary', [{ type: 'text', text: 'ordinary' }]),
      wrapper('unsupported', [{ type } as unknown as MessageItem]),
    ]
    const state = JSON.stringify(chats.$state)
    const retained = [...database.retained]
    const notify = new Set(['ordinary', 'unsupported'])
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(
        chats.storeReceivedMessages(batch, notify),
      ).rejects.toMatchObject({ code: 'unsupported_incoming_wallet_sync' })
    }
    expect(mockOwnAddress).not.toHaveBeenCalled()
    expect(mockRoute).not.toHaveBeenCalled()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(database.saveMessage).not.toHaveBeenCalled()
    expect(database.deleteMessage).not.toHaveBeenCalled()
    expect(database.suppressedRelayReceipts).not.toHaveBeenCalled()
    expect(database.quarantineRelayReceipts).not.toHaveBeenCalled()
    expect(database.suppressAndDelete).not.toHaveBeenCalled()
    expect(database.relayCursor).not.toHaveBeenCalled()
    expect([...database.retained]).toEqual(retained)
    expect(JSON.stringify(chats.$state)).toBe(state)
    expect([...notify]).toEqual(['ordinary', 'unsupported'])
  },
)

it.each(['wallet-sync', 'payment-transfer'])(
  'rechecks %s inside serialized ingestion before suppression or any mutation',
  async type => {
    const chats = useChatStore()
    database.suppressedRelayReceipts.mockResolvedValueOnce(
      new Set(['unsupported']),
    )
    const notify = new Set(['unsupported'])
    await expect(
      chats.storeReceivedMessagesExclusive(
        [wrapper('unsupported', [{ type } as unknown as MessageItem])],
        notify,
        ME,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_incoming_wallet_sync' })
    expect(database.suppressedRelayReceipts).not.toHaveBeenCalled()
    expect(database.saveMessage).not.toHaveBeenCalled()
    expect(mockRoute).not.toHaveBeenCalled()
    expect(mockResolve).not.toHaveBeenCalled()
    expect([...notify]).toEqual(['unsupported'])
  },
)

it('preserves the exclusive cancellation exit without interpreting abandoned items', async () => {
  const result = await useChatStore().storeReceivedMessagesExclusive(
    [wrapper('cancelled', [{ type: 'wallet-sync' } as unknown as MessageItem])],
    new Set(),
    ME,
    { isCancelled: () => true },
  )
  expect(result).toEqual({ suppressedReceipts: [], cancelled: true })
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
