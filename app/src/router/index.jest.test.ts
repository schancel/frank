const mockStatus = { status: 'fresh' }
let mockGuard: (to: any, from: any) => Promise<unknown>
jest.mock('../accounts/session', () => ({
  accountStatus: mockStatus,
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
jest.mock('vue-router', () => ({
  createRouter: () => ({
    beforeEach: (guard: typeof mockGuard) => {
      mockGuard = guard
    },
  }),
  createMemoryHistory: jest.fn(),
  createWebHistory: jest.fn(),
  createWebHashHistory: jest.fn(),
}))
jest.mock('./routes', () => ({ createRoutes: () => [] }))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ setActiveChat: jest.fn() }),
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({ fetchAndAddContact: jest.fn() }),
}))
import router from './index'
beforeEach(() => {
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
  expect(
    await mockGuard({ path: '/', fullPath: '/', params: {} }, {}),
  ).toBe('/welcome')

  mockStatus.status = 'ready'
  expect(
    await mockGuard({ path: '/', fullPath: '/', params: {} }, {}),
  ).toBe('/forum')
})

