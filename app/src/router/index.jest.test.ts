const mockStatus = { status: 'fresh' }
let mockGuard: (to: any, from: any) => Promise<unknown>
let mockAfter: (to: any, from: any, failure?: unknown) => void
jest.mock('../accounts/session', () => ({
  accountStatus: mockStatus,
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
jest.mock('vue-router', () => ({
  createRouter: () => ({
    beforeEach: (guard: typeof mockGuard) => {
      mockGuard = guard
    },
    afterEach: (hook: typeof mockAfter) => {
      mockAfter = hook
    },
    currentRoute: { value: { path: '/', params: {}, query: {} } },
    onError: jest.fn(),
  }),
  // The router listens to its history for Back (utils/navigation).
  createMemoryHistory: jest.fn(() => ({ listen: jest.fn() })),
  createWebHistory: jest.fn(() => ({ listen: jest.fn() })),
  createWebHashHistory: jest.fn(() => ({ listen: jest.fn() })),
}))
jest.mock('./routes', () => ({ createRoutes: () => [] }))
jest.mock('src/stores/chats', () => ({
  hasConversationIdSalt: () => true,
  resolveConversation: () => undefined,
  useChatStore: () => ({
    conversations: {},
    setActiveConversation: jest.fn(),
    setActiveChat: jest.fn(),
  }),
}))
const mockContacts = {
  fetchAndAddContact: jest.fn(),
  refreshPeerProfiles: jest.fn(async () => undefined),
}
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => mockContacts,
}))
import router from './index'
import { isPersistableExtensionRoute } from './extension-route-persistence'
import { setStartupRestoration } from '../boot/startup-state'
beforeEach(() => {
  setStartupRestoration({ phase: 'restored' })
  router()
})
test.each(['fresh', 'pending', 'locked', 'unavailable', 'loading'])(
  '%s account opens setup status without gaining protected access',
  async status => {
    mockStatus.status = status
    expect(
      await mockGuard({ path: '/wallet', fullPath: '/wallet', params: {} }, {}),
    ).toBe('/setup')
    expect(
      await mockGuard({ path: '/setup', fullPath: '/setup', params: {} }, {}),
    ).toBeUndefined()
  },
)
test('only a ready custody session unlocks normal wallet/forum routes', async () => {
  mockStatus.status = 'ready'
  expect(
    await mockGuard({ path: '/forum', fullPath: '/forum', params: {} }, {}),
  ).toBeUndefined()
})

test('documentation is readable without an account', async () => {
  mockStatus.status = 'fresh'
  expect(
    await mockGuard({ path: '/docs', fullPath: '/docs', params: {} }, {}),
  ).toBeUndefined()
  expect(
    await mockGuard(
      { path: '/docs/guide', fullPath: '/docs/guide', params: {} },
      {},
    ),
  ).toBeUndefined()
})

test('welcome landing page is readable without an account', async () => {
  mockStatus.status = 'fresh'
  expect(
    await mockGuard({ path: '/welcome', fullPath: '/welcome', params: {} }, {}),
  ).toBeUndefined()
})

test('root redirects to /welcome when not logged in, and /forum when ready', async () => {
  mockStatus.status = 'fresh'
  expect(await mockGuard({ path: '/', fullPath: '/', params: {} }, {})).toBe(
    '/welcome',
  )

  mockStatus.status = 'ready'
  expect(await mockGuard({ path: '/', fullPath: '/', params: {} }, {})).toBe(
    '/forum',
  )
})

test.each(['/', '/welcome', '/forum', '/onboard', '/chat/peer', '/wallet'])(
  'standby account opens the existing-account takeover screen from %s',
  async path => {
    mockStatus.status = 'standby'
    expect(await mockGuard({ path, fullPath: path, params: {} }, {})).toBe(
      '/setup',
    )
  },
)

describe.each(['unavailable', 'locked'])(
  'a saved account that did not open (%s)',
  status => {
    test.each(['/', '/welcome', '/onboard', '/onboard/profile'])(
      'shows the failure on setup instead of the signup page at %s',
      async path => {
        mockStatus.status = status
        expect(await mockGuard({ path, fullPath: path, params: {} }, {})).toBe(
          '/setup',
        )
      },
    )
    test.each(['/setup', '/forum', '/docs', '/about'])(
      'can still read %s',
      async path => {
        mockStatus.status = status
        expect(
          await mockGuard({ path, fullPath: path, params: {} }, {}),
        ).toBeUndefined()
      },
    )
  },
)

test('a fresh device still lands on the welcome page and can sign up', async () => {
  mockStatus.status = 'fresh'
  expect(await mockGuard({ path: '/', fullPath: '/', params: {} }, {})).toBe(
    '/welcome',
  )
  expect(
    await mockGuard({ path: '/onboard', fullPath: '/onboard', params: {} }, {}),
  ).toBeUndefined()
})

test.each(['/setup', '/docs', '/docs/guide', '/about', '/changelog'])(
  'standby account can read %s without taking custody',
  async path => {
    mockStatus.status = 'standby'
    expect(
      await mockGuard({ path, fullPath: path, params: {} }, {}),
    ).toBeUndefined()
  },
)

test('reopens extension popup/sidepanel/window to the last visited route when account is ready', async () => {
  mockStatus.status = 'ready'
  const store = new Map<string, string>([
    [
      'frank:ext-last-route',
      '/chat/0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    ],
  ])
  const prevWin = (globalThis as any).window
  ;(globalThis as any).window = {
    location: {
      search: '?extMode=popup',
      protocol: 'chrome-extension:',
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
    },
  }
  try {
    expect(await mockGuard({ path: '/', fullPath: '/', params: {} }, {})).toBe(
      '/chat/0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    )

    // Non-persistable routes (e.g. /setup or /welcome) fall back to /forum
    store.set('frank:ext-last-route', '/setup')
    expect(await mockGuard({ path: '/', fullPath: '/', params: {} }, {})).toBe(
      '/forum',
    )
  } finally {
    ;(globalThis as any).window = prevWin
  }
})

test('fresh devices can open only the receiving sync route, and sending still requires ready custody', async () => {
  mockStatus.status = 'fresh'
  expect(
    await mockGuard({ path: '/account-sync/receive', params: {} }, {}),
  ).toBeUndefined()
  expect(await mockGuard({ path: '/account-sync/send', params: {} }, {})).toBe(
    '/setup',
  )
  mockStatus.status = 'ready'
  expect(
    await mockGuard({ path: '/account-sync/send', params: {} }, {}),
  ).toBeUndefined()
})

test('temporary pairing pages cannot become the extension landing page', () => {
  expect(isPersistableExtensionRoute('/account-sync/send')).toBe(false)
  expect(isPersistableExtensionRoute('/account-sync/receive')).toBe(false)
  expect(isPersistableExtensionRoute('/profile')).toBe(true)
})

test('opening a chat with an address looks the peer up without making them a contact', async () => {
  const peer = '0x5555555555555555555555555555555555555555'
  mockAfter(
    {
      path: `/chat/${peer}`,
      fullPath: `/chat/${peer}`,
      params: { address: peer },
      query: {},
    },
    {},
  )
  await new Promise(resolve => setImmediate(resolve))
  expect(mockContacts.refreshPeerProfiles).toHaveBeenCalledWith([peer])
  expect(mockContacts.fetchAndAddContact).not.toHaveBeenCalled()
})
