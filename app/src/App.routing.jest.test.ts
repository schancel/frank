/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { TextDecoder, TextEncoder } from 'util'

Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('./adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
  }),
}))
jest.mock('./accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: { initialize: jest.fn(async () => undefined) },
}))
jest.mock('./router/routes', () => ({
  createRoutes: () => [
    { path: '/forum', component: { template: '<div>Forum</div>' } },
    { path: '/chat/:address', component: { template: '<div>Chat</div>' } },
  ],
}))
// Router diagnostics/devtools are ESM-only; keep the actual router and its guards.
jest.mock('nostics', () => ({
  createConsoleReporter: jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: jest.fn() }),
)
jest.mock('vue-router', () => {
  const actual = jest.requireActual('vue-router')
  return {
    ...actual,
    createWebHashHistory: actual.createMemoryHistory,
    createWebHistory: actual.createMemoryHistory,
  }
})
jest.mock('./stores/appearance', () => ({
  useAppearanceStore: jest.requireActual('pinia').defineStore('appearance', {
    state: () => ({ darkMode: false, locale: 'en-us', theme: 'default' }),
  }),
}))
jest.mock('./stores/relay-client', () => ({
  useRelayClientStore: () => ({ token: '' }),
}))
jest.mock('./stores/tab-coordinator', () => ({
  useTabCoordinatorStore: () => ({ isYielded: false }),
}))
jest.mock('./stores/persistent-storage', () => ({
  usePersistentStorageStore: () => ({
    ensureForAccount: jest.fn(async () => undefined),
  }),
}))
jest.mock('./stores/my-profile', () => ({
  useProfileStore: () => ({ inbox: { acceptancePrice: 0 } }),
}))
jest.mock('./stores/contacts', () => ({
  useContactStore: () => ({
    refresh: jest.fn(async () => undefined),
    refreshContacts: jest.fn(async () => undefined),
    fetchAndAddContact: jest.fn(async () => undefined),
    replaceCuratedDefaults: jest.fn(),
    clearCuratedDefaults: jest.fn(),
    isContact: () => true,
    getContact: () => ({ notify: true, profile: { name: 'Peer' } }),
  }),
}))
jest.mock('@frank/wallet/monad-identity', () => ({
  fetchCuratedDefaultContacts: async () => [],
}))
jest.mock('./utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('./utils/theme', () => ({ applyTheme: jest.fn() }))
jest.mock('./utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./utils/own-address', () => ({
  ...jest.requireActual('./utils/own-address'),
  getOwnCanonicalAddress: async () =>
    '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a',
}))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))

// Import after installing the encoding globals required by the real chat store.
/* eslint-disable @typescript-eslint/no-var-requires */
const App = require('./App.vue').default
const { setStartupRestoration } = require('./boot/startup-state')
const createAppRouter = require('./router').default
const { useChatStore } = require('./stores/chats')
const { desktopNotify } = require('./utils/notifications')
const { openChat, openContactProfile } = require('./utils/routes')
/* eslint-enable @typescript-eslint/no-var-requires */
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const OTHER = '0x3333333333333333333333333333333333333333'

async function mountedApp() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chats = useChatStore()
  const first = chats.createConversation({
    address: PEER,
    participants: [PEER],
    name: 'Same',
  })
  const second = chats.createConversation({
    address: PEER,
    participants: [PEER],
    name: 'Same',
  })
  const other = chats.createConversation({
    address: OTHER,
    participants: [OTHER],
  })
  const defaultThread = chats.openDirectConversation(PEER)
  const router = createAppRouter()
  await router.push('/forum')
  await router.isReady()
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
      mocks: {
        $q: { dark: { set: jest.fn() } },
        $status: { setup: true },
        $t: (key: string) => key,
      },
      stubs: {
        QBtn: true,
        QDialog: true,
        QCard: true,
        QCardSection: true,
        QAvatar: true,
        QCardActions: true,
      },
    },
  })
  await flushPromises()
  return { chats, first, second, other, defaultThread, router, wrapper }
}

async function settleNavigation() {
  await nextTick()
  await flushPromises()
}

describe('App exact conversation route authority (#1237)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setStartupRestoration({ phase: 'restored' })
    jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it.each(['sidebar', 'direct URL'])(
    'keeps the explicit conversation selected after %s navigation',
    async source => {
      const { chats, first, defaultThread, router, wrapper } =
        await mountedApp()
      try {
        if (source === 'sidebar') chats.setActiveConversation(first.id)
        await openChat(router, first.id)
        await settleNavigation()
        expect(router.currentRoute.value.params.address).toBe(first.id)
        expect(chats.activeConversationId).toBe(first.id)
        expect(chats.conversations[defaultThread.id].messages).toHaveLength(0)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('routes a real notification callback to a same-peer sibling and preserves other-peer IDs', async () => {
    const { chats, first, second, other, router, wrapper } = await mountedApp()
    try {
      await openChat(router, first.id)
      await settleNavigation()
      jest.spyOn(document, 'hasFocus').mockReturnValue(false)
      await chats.receiveMessages([
        {
          index: 'notification-receipt',
          conversationId: second.id,
          outbound: false,
          senderAddress: PEER,
          copartyAddress: PEER,
          copartyPubKey: { toBuffer: () => new Uint8Array(33) },
          stampValue: 0,
          message: {
            conversationId: second.id,
            outbound: false,
            status: 'confirmed',
            senderAddress: PEER,
            items: [{ type: 'text', text: 'Sibling message' }],
            serverTime: 100,
            receivedTime: 100,
            outpoints: [],
          },
        },
      ])
      expect(desktopNotify).toHaveBeenCalled()
      await desktopNotify.mock.calls.at(-1)[3]()
      await settleNavigation()
      expect(router.currentRoute.value.params.address).toBe(second.id)
      expect(chats.activeConversationId).toBe(second.id)
      expect(first.messages).toHaveLength(0)
      expect(second.messages).toHaveLength(1)

      chats.setActiveConversation(other.id)
      await settleNavigation()
      expect(router.currentRoute.value.params.address).toBe(other.id)
      expect(chats.activeConversationId).toBe(other.id)
      await router.push('/forum')
      await settleNavigation()
      expect(router.currentRoute.value.path).toBe('/forum')
      expect(chats.activeConversationId).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it.each([PEER, OTHER])(
    'preserves the committed profile query for %s when leaving an explicit thread',
    async peer => {
      const { chats, first, router, wrapper } = await mountedApp()
      try {
        await openChat(router, first.id)
        await settleNavigation()
        openContactProfile(router, peer)
        await settleNavigation()
        expect(router.currentRoute.value.query).toEqual({ info: 'true' })
        expect(router.currentRoute.value.params.address).toBe(peer)
        expect(chats.activeConversationId).toBe(chats.chats[peer]?.id)

        // A later selection is a new navigation, not an instruction to copy profile state.
        chats.setActiveConversation(first.id)
        await settleNavigation()
        expect(router.currentRoute.value.params.address).toBe(first.id)
        expect(router.currentRoute.value.query).toEqual({})
      } finally {
        wrapper.unmount()
      }
    },
  )

  it.each(['other conversation', 'profile', 'Forum'])(
    'does not publish selection or read state for canceled %s navigation',
    async destination => {
      const { chats, first, other, defaultThread, router, wrapper } =
        await mountedApp()
      try {
        await openChat(router, first.id)
        await settleNavigation()
        other.totalUnreadMessages = 2
        defaultThread.totalUnreadMessages = 3
        const before = JSON.parse(JSON.stringify(chats.$state))
        const target =
          destination === 'profile'
            ? `/chat/${PEER}?info=true`
            : destination === 'Forum'
            ? '/forum'
            : `/chat/${other.id}`
        router.beforeEach(to => (to.fullPath === target ? false : undefined))
        await router.push(target)
        await settleNavigation()
        expect(router.currentRoute.value.params.address).toBe(first.id)
        expect(chats.$state).toEqual(before)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('does not publish an earlier navigation after a later route commits', async () => {
    const { chats, first, other, router, wrapper } = await mountedApp()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const reached = new Promise<void>(resolve => {
      entered = resolve
    })
    try {
      await openChat(router, first.id)
      await settleNavigation()
      other.totalUnreadMessages = 2
      router.beforeEach(async to => {
        if (to.params.address === other.id) {
          entered()
          await blocked
        }
      })
      const earlierNavigation = router.push(`/chat/${other.id}`)
      await reached
      expect(chats.activeConversationId).toBe(first.id)
      expect(other.totalUnreadMessages).toBe(2)
      await router.push('/forum')
      release()
      await earlierNavigation
      await settleNavigation()
      expect(router.currentRoute.value.path).toBe('/forum')
      expect(chats.activeConversationId).toBeNull()
      expect(other.totalUnreadMessages).toBe(2)
    } finally {
      release()
      wrapper.unmount()
    }
  })

  it('opens the peer route as its default without an extra navigation', async () => {
    const { chats, defaultThread, router, wrapper } = await mountedApp()
    try {
      await openChat(router, PEER)
      await settleNavigation()
      expect(chats.activeConversationId).toBe(defaultThread.id)
      expect(router.currentRoute.value.params.address).toBe(PEER)
    } finally {
      wrapper.unmount()
    }
  })
})
