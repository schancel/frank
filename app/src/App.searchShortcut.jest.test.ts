/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'

import enUS from 'src/i18n/en-us'
import MainLayout from './layouts/MainLayout.vue'
import AppRuntime from './AppRuntime.vue'
import LeftDrawer from './components/panels/LeftDrawer.vue'
import { defineComponent, h, inject, provide } from 'vue'

// Real Quasar components (QLayout, QDrawer, QTabs, QTab, ...). `import 'quasar'` resolves to the
// SSR server build under this Jest config (moduleNameMapper), whose components render nothing
// useful, so this file loads Quasar's UMD build directly instead. UMD expects a global Vue and
// jsdom lacks ResizeObserver (both set in loadQuasar below).

// Stores are plain reactive objects; storeToRefs just needs to turn them into refs.
jest.mock('pinia', () => ({
  defineStore: (_id: string, def: any) => () =>
    typeof def === 'function' ? def() : def,
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
  getActivePinia: () => undefined,
}))
jest.mock('./components/panels/ContactsPanel.vue', () => ({
  template: '<div data-testid="contacts-panel" />',
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    contacts: [],
    getContact: () => ({ profile: { name: 'Avery' } }),
    isContact: () => true,
    replaceCuratedDefaults: jest.fn(),
    addDefaultContact: jest.fn(),
    refreshContacts: jest.fn(),
    clearCuratedDefaults: jest.fn(),
  }),
}))
const mockRouterRef: { current: any } = { current: undefined }
jest.mock('vue-router', () => ({
  useRoute: () => mockRouterRef.current.currentRoute.value,
  useRouter: () => mockRouterRef.current,
}))
const mockUnread = { value: 3 }
jest.mock('src/stores/chats', () => ({
  useChatStore: () =>
    jest.requireActual('vue').reactive({
      totalUnread: mockUnread.value,
      getSortedChatOrder: [
        {
          id: 'first',
          address: 'addr1',
          totalUnreadMessages: 0,
          messages: [
            {
              payloadDigest: 'm1',
              items: [{ type: 'text', text: 'rainforest expedition' }],
            },
          ],
        },
        {
          id: 'second',
          address: 'addr2',
          totalUnreadMessages: 0,
          messages: [],
        },
      ],
      activeChatAddr: undefined,
    }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    topics: { alpha: {} },
    refreshDiscoveredTopics: jest.fn(),
  }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({
    selectedTopic: '',
    setSelectedTopic: jest.fn(),
    refreshMessages: jest.fn(),
  }),
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () =>
    jest.requireActual('vue').reactive({ profile: {}, inbox: {} }),
}))
jest.mock('@frank/wallet/chain', () => ({
  onActiveChainChange: jest.fn(() => () => undefined),
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => amount.toString(),
    nativeTransfers: { getBalance: jest.fn(async () => 0n) },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { displayAddress: 'me' },
  })),
}))
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => false,
}))
jest.mock('./components/chat/ChatListItem.vue', () => ({
  props: ['chatAddress'],
  template: '<div data-testid="chat-item" />',
}))
jest.mock('./components/chat/MailboxStatusIndicator.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/chat/ChatListLink.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/panels/ContactCard.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/panels/BackupReminder.vue', () => ({
  template: '<div />',
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => ({ seedPhrase: null, seedConfirmedAt: null }),
}))
jest.mock('./components/dialogs/RelayConnectDialog.vue', () => ({
  template: '<div />',
}))

type Hook = (to: unknown, from: unknown, failure?: unknown) => void
function createFakeRouter() {
  const hooks: Hook[] = []
  const router = {
    currentRoute: { value: { path: '/chat/first', params: {} } },
    afterEach: (fn: Hook) => {
      hooks.push(fn)
      return () => hooks.splice(hooks.indexOf(fn), 1)
    },
    onError: () => () => undefined,
    push: jest.fn(async (path: string) => {
      const from = router.currentRoute.value
      router.currentRoute.value = { path, params: {} }
      hooks.slice().forEach(fn => fn({ path }, from))
    }),
    replace: jest.fn(),
  }
  return router
}

function translate(key: string, params: Record<string, unknown> = {}): string {
  const value = key
    .split('.')
    .reduce<any>((node, part) => node?.[part], enUS as any)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
    : key
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadQuasar(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  g.Vue = jest.requireActual('vue')
  g.ResizeObserver ??= class {
    observe = jest.fn()
    unobserve = jest.fn()
    disconnect = jest.fn()
  }
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  return g.Quasar
}

async function mountReal(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  const quasarUmd = loadQuasar()
  // Quasar's Screen plugin is module-level state, so a later test must announce its own width
  // the way a real resize does (Quasar debounces the listener).
  window.dispatchEvent(new Event('resize'))
  await new Promise(resolve => setTimeout(resolve, 120))
  const router = createFakeRouter()
  mockRouterRef.current = router
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(AppRuntime, {
    attachTo: host,
    global: {
      plugins: [quasarUmd],
      stubs: { RouterView: RouteContent },
      mocks: {
        $router: router,
        $t: translate,
        $status: { setup: true },
        $relay: { connected: true },
      },
    },
  })
  await flushPromises()
  return { wrapper, router }
}

jest.mock('src/composables/useOracleFeed', () => ({
  useAppOracleFeed: jest.fn(),
}))
jest.mock('src/composables/useNotificationPermissionOffer', () => ({
  useNotificationPermissionOffer: jest.fn(),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    formattedBalance: '0 SOL',
    exactBalance: '0',
    loaded: true,
    hasError: false,
  }),
}))
jest.mock('./components/panels/SettingsPanel.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/panels/WalletPanel.vue', () => ({
  template: '<div />',
}))
jest.mock('./accounts/session', () => ({ accountStatus: { status: 'ready' } }))
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () =>
    jest
      .requireActual('vue')
      .reactive({ darkMode: false, theme: 'default', locale: 'en-us' }),
}))
jest.mock('src/stores/relay-client', () => ({
  useRelayClientStore: () => ({ token: '' }),
}))
jest.mock('src/stores/settings', () => ({ useSettingsStore: () => ({}) }))
jest.mock('src/stores/tab-coordinator', () => ({
  useTabCoordinatorStore: () => ({ isYielded: false }),
}))
jest.mock('src/stores/persistent-storage', () => ({
  usePersistentStorageStore: () => ({ ensureForAccount: jest.fn() }),
}))
jest.mock('@frank/wallet/evm-identity', () => ({
  fetchCuratedDefaultContacts: async () => [],
}))
jest.mock('src/utils/identity-session', () => ({
  messagingState: { status: 'idle' },
}))
jest.mock('src/utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('src/utils/theme', () => ({ applyTheme: jest.fn() }))

// Keep Runtime -> MainLayout -> LeftDrawer -> ChatList; replace only routed page content.
const RouteContent = defineComponent({
  setup() {
    const nested = inject('shortcut-test-layout', false)
    provide('shortcut-test-layout', true)
    return () =>
      nested
        ? h('main', [h('textarea', { 'data-test': 'composer' })])
        : h(MainLayout)
  },
})
function pressK(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  document.activeElement?.dispatchEvent(event)
  return event
}
const searchInput = () =>
  document.querySelector<HTMLInputElement>('[data-test="chat-search-input"]')!
describe('runtime search shortcut with the real chat drawer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })
  it.each([390, 1024])(
    'reveals Chats and searches messages at %ipx without opening Contacts',
    async width => {
      const { wrapper } = await mountReal(width)
      try {
        const layout = wrapper.getComponent(MainLayout)
        const drawer = layout.getComponent(LeftDrawer)
        drawer.vm.tab = 'contacts'
        layout.vm.myDrawerOpen = false
        await flushPromises()
        const composer = document.querySelector<HTMLTextAreaElement>(
          '[data-test="composer"]',
        )!
        composer.value = 'unfinished draft'
        composer.focus()
        composer.setSelectionRange(3, 8)
        expect(pressK().defaultPrevented).toBe(true)
        await flushPromises()
        expect(wrapper.vm.contactBookOpen).toBe(false)
        expect(layout.vm.myDrawerOpen).toBe(true)
        expect(drawer.vm.tab).toBe('chats')
        expect(document.activeElement).toBe(searchInput())
        expect(composer.value).toBe('unfinished draft')
        searchInput().value = 'rainforest'
        searchInput().dispatchEvent(new Event('input', { bubbles: true }))
        await flushPromises()
        expect(wrapper.findAll('[data-testid="chat-item"]')).toHaveLength(1)
        expect(
          wrapper.get('[data-test="chat-search-snippet"]').text(),
        ).toContain('rainforest')
        searchInput().value = 'Avery'
        searchInput().dispatchEvent(new Event('input', { bubbles: true }))
        await flushPromises()
        expect(wrapper.findAll('[data-testid="chat-item"]')).toHaveLength(2)
        expect(
          pressK({ metaKey: true, ctrlKey: false, key: 'K' }).defaultPrevented,
        ).toBe(true)
        await flushPromises()
        expect(searchInput().selectionStart).toBe(0)
        expect(searchInput().selectionEnd).toBe(5)
      } finally {
        wrapper.unmount()
      }
    },
  )
  it('preserves modal focus and IME, ignores repeats, and removes the owner on unmount', async () => {
    const { wrapper } = await mountReal(1024)
    try {
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[data-test="composer"]',
      )!
      composer.focus()
      expect(pressK({ isComposing: true }).defaultPrevented).toBe(false)
      expect(pressK({ repeat: true }).defaultPrevented).toBe(true)
      const dialog = document.createElement('div')
      dialog.className = 'q-dialog'
      document.body.append(dialog)
      expect(pressK().defaultPrevented).toBe(false)
      await flushPromises()
      expect(document.activeElement).toBe(composer)
      expect(wrapper.vm.contactBookOpen).toBe(false)
      dialog.remove()
      wrapper.unmount()
      expect(pressK().defaultPrevented).toBe(false)
    } finally {
      if (wrapper.exists()) wrapper.unmount()
    }
  })
  it('does not carry search state or pending focus into a reopened runtime', async () => {
    const first = await mountReal(390)
    searchInput().value = 'old account query'
    searchInput().dispatchEvent(new Event('input', { bubbles: true }))
    pressK()
    first.wrapper.unmount()
    await flushPromises()
    const second = await mountReal(390)
    try {
      expect(searchInput().value).toBe('')
      expect(pressK().defaultPrevented).toBe(true)
      await flushPromises()
      expect(document.activeElement).toBe(searchInput())
      expect(second.wrapper.vm.contactBookOpen).toBe(false)
      const account = jest.requireMock('./accounts/session').accountStatus
      account.status = 'locked'
      expect(pressK().defaultPrevented).toBe(false)
      account.status = 'ready'
    } finally {
      second.wrapper.unmount()
    }
  })

  it('opens only Contacts outside Chats and never toggles an existing dialog closed', async () => {
    const { wrapper, router } = await mountReal(1024)
    try {
      router.currentRoute.value.path = '/forum'
      expect(pressK().defaultPrevented).toBe(true)
      await flushPromises()
      expect(wrapper.vm.contactBookOpen).toBe(true)
      pressK()
      expect(wrapper.vm.contactBookOpen).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
})
