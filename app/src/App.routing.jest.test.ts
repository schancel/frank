/** @jest-environment jsdom */
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  Notify: { create: jest.fn() },
}))
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { TextDecoder, TextEncoder } from 'util'
import { setConversationIdSalt as installTestConversationIdSalt } from './stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { useContactStore } from './stores/contacts'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

Object.assign(globalThis, { TextEncoder, TextDecoder })

jest.mock('./adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
  }),
}))
jest.mock('./accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: {
    state: { revision: 0, account: null },
    initialize: jest.fn(async () => undefined),
  },
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
jest.mock('./stores/contacts', () => {
  const contacts = {
    refresh: jest.fn(async () => undefined),
    refreshContacts: jest.fn(async () => undefined),
    fetchAndAddContact: jest.fn(async () => undefined),
    replaceCuratedDefaults: jest.fn(),
    clearCuratedDefaults: jest.fn(),
    isContact: () => true,
    getNotify: () => true,
    setNotify: jest.fn(),
    getContact: () => ({ notify: true, profile: { name: 'Peer' } }),
    deleteContact: jest.fn(async () => undefined),
  }
  return { useContactStore: () => contacts }
})
jest.mock('@frank/wallet/evm-identity', () => ({
  fetchCuratedDefaultContacts: async () => [],
}))
jest.mock('./utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('./utils/theme', () => ({ applyTheme: jest.fn() }))
jest.mock('./utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./utils/own-address', () => ({
  ...jest.requireActual('./utils/own-address'),
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref('0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a'),
  getOwnCanonicalAddress: async () =>
    '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a',
}))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))

// Import after installing the encoding globals required by the real chat store.
/* eslint-disable @typescript-eslint/no-var-requires */
const App = require('./App.vue').default
const AppRuntime = require('./AppRuntime.vue').default
const ChatPage = require('./pages/Chat.vue').default
const ChatLayout = require('./layouts/ChatLayout.vue').default
const ChatInfoView = require('./components/panels/ChatInfoView.vue').default
const ClearHistoryDialog =
  require('./components/dialogs/ClearHistoryDialog.vue').default
const DeleteContactDialog =
  require('./components/dialogs/DeleteContactDialog.vue').default
const quasar = require('quasar')
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
        QBtn: {
          emits: ['click'],
          methods: {
            click() {
              this.$emit('click')
            },
          },
          template: '<button @click="$emit(\'click\')"><slot /></button>',
        },
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

  it('never requests notification permission during contact-book updates or navigation', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
    const requestPermission = jest.fn(async () => 'default')
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission },
    })
    jest.spyOn(quasar.Notify, 'create').mockReturnValue(jest.fn())
    const { wrapper, router } = await mountedApp()
    try {
      const instance = wrapper.getComponent(AppRuntime)
      instance.vm.contactBookOpen = true
      await nextTick()
      instance.vm.contactBookOpen = false
      await nextTick()
      await router.push('/forum?search=peer')
      await flushPromises()
      expect(requestPermission).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      if (original) Object.defineProperty(globalThis, 'Notification', original)
      else Reflect.deleteProperty(globalThis, 'Notification')
    }
  })

  it.each([
    'lowercase peer',
    'checksum peer',
    'first ID',
    'second ID',
    'other peer ID',
  ])(
    'renders only the selected conversation for a %s route',
    async destination => {
      const { chats, first, second, other, defaultThread, router, wrapper } =
        await mountedApp()
      const selected =
        destination === 'first ID'
          ? first
          : destination === 'second ID'
          ? second
          : destination === 'other peer ID'
          ? other
          : defaultThread
      const routeAddress =
        destination === 'lowercase peer'
          ? PEER.toLowerCase()
          : destination === 'checksum peer'
          ? PEER
          : selected.id
      for (const owner of [first, second, other, defaultThread]) {
        owner.messages = [
          {
            payloadDigest: `visible-${owner.id}`,
            outbound: false,
            receivedTime: 1,
            items: [],
            senderAddress: owner.address,
          },
        ]
      }
      const simple = { template: '<div><slot /></div>' }
      const components = Object.fromEntries(
        Object.keys(quasar)
          .filter(name => /^Q[A-Z]/.test(name))
          .map(name => [name, simple]),
      )
      components.QScrollArea = {
        methods: {
          getScrollTarget: () => ({ scrollTop: 0 }),
          setScrollPosition: () => undefined,
        },
        template: '<div><slot /></div>',
      }
      let page: ReturnType<typeof mount> | undefined
      try {
        await openChat(router, routeAddress)
        await settleNavigation()
        expect(router.currentRoute.value.params.address).toBe(routeAddress)
        expect(chats.activeConversationId).toBe(selected.id)
        expect(chats.chats[PEER].id).toBe(defaultThread.id)
        expect(chats.chats[PEER.toLowerCase()]).toBeUndefined()
        page = mount(ChatPage, {
          global: {
            plugins: [router],
            components,
            stubs: {
              ChatInput: simple,
              ChatMessageComponent: simple,
              ChatMessageReply: simple,
              ChatBannerStack: simple,
              QResizeObserver: simple,
            },
            mocks: {
              $q: { dark: { isActive: false } },
              $t: (key: string) => key,
            },
          },
        })
        await flushPromises()
        expect(page.vm.address).toBe(routeAddress)
        expect(page.vm.conversation?.id).toBe(selected.id)
        expect(page.vm.messages.map(message => message.payloadDigest)).toEqual([
          `visible-${selected.id}`,
        ])
      } finally {
        page?.unmount()
        wrapper.unmount()
      }
    },
  )

  describe.each(['lowercase peer', 'checksum peer', 'explicit ID'])(
    'mounted info actions for a %s route',
    destination => {
      it.each(['clear', 'delete'])(
        'keeps %s confirmation scoped to its intended authority',
        async action => {
          const { chats, first, second, defaultThread, router, wrapper } =
            await mountedApp()
          const selected =
            destination === 'explicit ID' ? second : defaultThread
          const routeAddress =
            destination === 'lowercase peer'
              ? PEER.toLowerCase()
              : destination === 'checksum peer'
              ? PEER
              : selected.id
          const clear = jest
            .spyOn(chats, 'clearChat')
            .mockResolvedValue(undefined)
          const remove = useContactStore().deleteContact as jest.Mock
          remove.mockClear()
          const removeThread = jest
            .spyOn(chats, 'deleteChat')
            .mockResolvedValue(undefined)
          const simple = { template: '<div><slot /></div>' }
          const components = Object.fromEntries(
            Object.keys(quasar)
              .filter(name => /^Q[A-Z]/.test(name))
              .map(name => [name, simple]),
          )
          components.QDialog = defineComponent({
            props: { modelValue: Boolean },
            setup:
              (props, { slots }) =>
              () =>
                props.modelValue ? h('div', slots.default?.()) : null,
          })
          components.QItem = defineComponent({
            props: { disable: Boolean },
            setup:
              (props, { slots }) =>
              () =>
                h('button', { disabled: props.disable }, slots.default?.()),
          })
          let layout: ReturnType<typeof mount> | undefined
          try {
            await openChat(router, first.id)
            await settleNavigation()
            await router.push({
              path: `/chat/${routeAddress}`,
              query: { info: 'true' },
            })
            await settleNavigation()
            expect(router.currentRoute.value.params.address).toBe(routeAddress)
            expect(router.currentRoute.value.query).toEqual({ info: 'true' })
            expect(chats.activeConversationId).toBe(first.id)
            layout = mount(ChatLayout, {
              global: {
                plugins: [router],
                components,
                mocks: {
                  $t: (key: string) => key,
                  $q: { dark: { isActive: false } },
                },
              },
            })
            await flushPromises()
            const info = layout.getComponent(ChatInfoView)
            expect(info.props('conversationId')).toBe(selected.id)
            expect(info.props('address')).toBe(PEER)
            const actionKey =
              action === 'clear'
                ? 'chatRightDrawer.clearHistory'
                : 'chatRightDrawer.deleteContactAndConversations'
            const actionButton = info
              .findAll('button')
              .find(button => button.text() === actionKey)!
            expect(actionButton.element.disabled).toBe(false)
            await actionButton.trigger('click')
            const dialog = info.getComponent(
              action === 'clear' ? ClearHistoryDialog : DeleteContactDialog,
            )
            expect(dialog.props('address')).toBe(
              action === 'clear' ? selected.id : PEER,
            )
            const label =
              action === 'clear'
                ? 'clearHistoryDialog.clear'
                : 'deleteContactDialog.delete'
            await dialog.get(`[label="${label}"]`).trigger('click')
            await flushPromises()
            expect(action === 'clear' ? clear : remove).toHaveBeenCalledWith(
              action === 'clear' ? selected.id : PEER,
            )
            expect(removeThread).not.toHaveBeenCalled()
            expect(action === 'clear' ? clear : remove).toHaveBeenCalledTimes(1)
            expect(action === 'clear' ? remove : clear).not.toHaveBeenCalled()
          } finally {
            layout?.unmount()
            wrapper.unmount()
          }
        },
      )
    },
  )

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

      // Even if activeConversationId is already set (e.g. restored from storage while on /forum)
      // or when a mobile Service Worker notificationclick dispatches frank:blind-wakeup-sync,
      // clicking the notification navigates to the target conversation.
      chats.activeConversationId = second.id
      await desktopNotify.mock.calls.at(-1)[3]()
      await settleNavigation()
      expect(router.currentRoute.value.path).toBe(`/chat/${second.id}`)
      expect(router.currentRoute.value.params.address).toBe(second.id)

      await router.push('/forum')
      await settleNavigation()
      expect(router.currentRoute.value.path).toBe('/forum')

      window.dispatchEvent(
        new CustomEvent('frank:blind-wakeup-sync', {
          detail: {
            type: 'FRANK_BLIND_WAKEUP_SYNC',
            payload: {
              type: 'sync',
              notificationClick: true,
              tag: 'notification-receipt',
            },
          },
        }),
      )
      await settleNavigation()
      expect(router.currentRoute.value.path).toBe(`/chat/${second.id}`)
      expect(chats.activeConversationId).toBe(second.id)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([PEER, OTHER, '0x4444444444444444444444444444444444444444'])(
    'views profile %s without selecting, allocating or reading its conversation',
    async peer => {
      const { chats, first, other, defaultThread, router, wrapper } =
        await mountedApp()
      try {
        await openChat(router, first.id)
        await settleNavigation()
        other.totalUnreadMessages = 2
        defaultThread.totalUnreadMessages = 3
        const inventory = Object.keys(chats.conversations)
        const read = jest.spyOn(chats, 'readAll')
        for (const target of [peer, PEER, peer]) {
          await openContactProfile(router, target)
          await settleNavigation()
          expect(router.currentRoute.value.query).toEqual({ info: 'true' })
          expect(router.currentRoute.value.params.address).toBe(target)
          expect(chats.activeConversationId).toBe(first.id)
          expect(Object.keys(chats.conversations)).toEqual(inventory)
          expect(other.totalUnreadMessages).toBe(2)
          expect(defaultThread.totalUnreadMessages).toBe(3)
          expect(read).not.toHaveBeenCalled()
        }
        // The profile's explicit chat action removes info on the same peer path.
        await router.replace({ query: {} })
        await settleNavigation()
        expect(chats.activeConversationId).toBe(chats.chats[peer].id)
        expect(read).toHaveBeenCalled()
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

  it.each([
    ['empty contacts map', {}],
    [
      'existing contacts map',
      { [PEER]: { notify: true, profile: { name: 'Peer' } } },
    ],
  ])(
    'mounts AppRuntime in extMode=popup with ready account (%s) without throwing in created()',
    async (_label, contactsRecord) => {
      const contactStore = useContactStore() as unknown as {
        contacts?: Record<string, unknown>
      }
      const prevContacts = contactStore.contacts
      window.history.replaceState({}, '', '/?extMode=popup#/forum')
      contactStore.contacts = contactsRecord
      let wrapper: Awaited<ReturnType<typeof mountedApp>>['wrapper'] | undefined
      try {
        const mounted = await mountedApp()
        wrapper = mounted.wrapper
        const runtime = wrapper.getComponent(AppRuntime)
        expect(runtime.exists()).toBe(true)
        expect(() => runtime.vm.setupConnections()).not.toThrow()
      } finally {
        wrapper?.unmount()
        contactStore.contacts = prevContacts
        window.history.replaceState({}, '', '/')
      }
    },
  )
})
