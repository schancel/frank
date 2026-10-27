/** @jest-environment jsdom */
/**
 * Going forward and then Back lands where the user was: the app (AppRuntime, the chat layout
 * and pages, the router's own guards) on a real hash-mode router over jsdom's real session
 * history. Each step checks the route and `history.state.position`, the entry's index.
 */
jest.mock('quasar', () => ({
  ...jest.requireActual('quasar'),
  Notify: { create: jest.fn() },
  useQuasar: () => ({ screen: { width: 1024 }, dark: { isActive: false } }),
}))
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { TextDecoder, TextEncoder } from 'util'
import type { Router } from 'vue-router'
import { setConversationIdSalt as installTestConversationIdSalt } from './stores/chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

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
    getIterator: async () => [],
    mostRecentMessageTime: async () => 0,
    suppressedRelayReceipts: async () => new Set(),
  }),
}))
jest.mock('./accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: {
    state: { revision: 0, account: null },
    initialize: jest.fn(async () => undefined),
  },
}))
jest.mock('./router/routes', () => {
  const blank = { template: '<div />' }
  return {
    createRoutes: () => [
      { path: '/forum', component: blank },
      { path: '/contacts', component: blank },
      {
        path: '/new-conversation',
        component: jest.requireActual('./pages/AddContact.vue').default,
      },
      {
        path: '/add-contact',
        component: jest.requireActual('./pages/AddContact.vue').default,
      },
      {
        path: '/chat',
        component: jest.requireActual('./layouts/ChatLayout.vue').default,
        children: [
          { path: '', component: blank },
          {
            path: ':address',
            component: jest.requireActual('./pages/Chat.vue').default,
          },
        ],
      },
    ],
  }
})
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
    refreshPeerProfiles: jest.fn(async () => undefined),
    replaceCuratedDefaults: jest.fn(),
    clearCuratedDefaults: jest.fn(),
    isContact: () => true,
    getNotify: () => true,
    setNotify: jest.fn(),
    getContact: () => ({ notify: true, profile: { name: 'Peer' } }),
    getContactProfile: () => ({ name: 'Peer', avatar: undefined }),
    deleteContact: jest.fn(async () => undefined),
    addContact: jest.fn(),
    // A saved contact the New Conversation form can pick.
    getContacts: {
      '0x3333333333333333333333333333333333333333': {
        profile: { name: 'Other peer', signedName: 'Other peer' },
      },
    },
    contacts: {
      '0x3333333333333333333333333333333333333333': {
        profile: { name: 'Other peer', signedName: 'Other peer' },
      },
    },
  }
  return {
    defaultRelayData: { profile: { name: '', bio: '', avatar: '' } },
    shortAddressLabel: (address: string) => address,
    useContactStore: () => contacts,
  }
})
jest.mock('@frank/wallet/evm-identity', () => ({
  fetchCuratedDefaultContacts: async () => [],
}))
jest.mock('./utils/apply-locale', () => ({ applyLocale: jest.fn() }))
jest.mock('./utils/theme', () => ({ applyTheme: jest.fn() }))
jest.mock('./utils/notifications', () => ({
  desktopNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('./utils/own-address', () => ({
  ...jest.requireActual('./utils/own-address'),
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref('0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a'),
  getOwnCanonicalAddress: async () =>
    '0x1a1A1A1A1a1A1a1a1a1a1a1a1a1a1a1A1A1a1a1a',
}))
jest.mock('./utils/frank-domain-discovery', () => ({
  ...jest.requireActual('./utils/frank-domain-discovery'),
  discoverFrankDomain: jest.fn(async () => []),
}))
jest.mock('./utils/directory-peer', () => ({
  ...jest.requireActual('./utils/directory-peer'),
  fetchContactProfile: jest.fn(async () => undefined),
  contactLookupFailure: () => 'not-found',
}))
jest.mock('./components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('./components/dialogs/IdentityQrDialog.vue', () => ({
  template: '<i />',
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const App = require('./App.vue').default
const ChatLayout = require('./layouts/ChatLayout.vue').default
const AddContact = require('./pages/AddContact.vue').default
const ChatList = require('./components/chat/ChatList.vue').default
const ChatListItem = require('./components/chat/ChatListItem.vue').default
const quasar = require('quasar')
const { setStartupRestoration } = require('./boot/startup-state')
const createAppRouter = require('./router').default
const { useChatStore } = require('./stores/chats')
const { openChat, openContactProfile } = require('./utils/routes')
const en = require('./i18n/en-us').default
/* eslint-enable @typescript-eslint/no-var-requires */

const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const OTHER = '0x3333333333333333333333333333333333333333'

const simple = { template: '<div><slot /></div>' }
const controls: Record<string, unknown> = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, simple]),
)
controls.QBtn = defineComponent({
  props: { label: String, disable: Boolean },
  emits: ['click'],
  setup:
    (props, { slots, emit, attrs }) =>
    () =>
      h(
        'button',
        {
          'disabled': props.disable,
          'data-test': attrs['data-test'],
          'data-testid': attrs['data-testid'],
          'onClick': () => emit('click'),
        },
        [props.label, slots.default?.()],
      ),
})
controls.QInput = defineComponent({
  props: { modelValue: String, label: String },
  emits: ['update:modelValue'],
  methods: {
    focus() {
      ;(this.$el as HTMLInputElement).focus()
    },
  },
  setup:
    (props, { emit }) =>
    () =>
      h('input', {
        'value': props.modelValue,
        'aria-label': props.label,
        'onInput': (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).value),
      }),
})
controls.QDialog = defineComponent({
  props: { modelValue: Boolean },
  setup:
    (props, { slots }) =>
    () =>
      props.modelValue ? h('div', slots.default?.()) : null,
})
// Like QMenu: `open()` stands for the tap that shows it; v-model and show/hide follow. While
// shown it is a `.q-menu` in the page and Escape closes it, as Quasar's does.
const QMenuStub = defineComponent({
  name: 'QMenuStub',
  props: { modelValue: Boolean, anchor: String },
  emits: ['update:modelValue', 'show', 'hide'],
  data: () => ({ shown: false }),
  watch: {
    modelValue(open: boolean) {
      if (open !== this.shown) this.setShown(open)
    },
  },
  beforeUnmount() {
    window.removeEventListener('keyup', this.onKeyup)
  },
  methods: {
    setShown(open: boolean) {
      this.shown = open
      window[open ? 'addEventListener' : 'removeEventListener'](
        'keyup',
        this.onKeyup,
      )
      this.$emit('update:modelValue', open)
      this.$emit(open ? 'show' : 'hide')
    },
    onKeyup(event: KeyboardEvent) {
      if (event.keyCode === 27) this.setShown(false)
    },
    open() {
      this.setShown(true)
    },
  },
  render() {
    return this.shown
      ? h('div', { class: 'q-menu' }, this.$slots.default?.())
      : null
  },
})
controls.QMenu = QMenuStub
controls.QScrollArea = {
  methods: {
    getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 0 }),
    setScrollPosition: () => undefined,
  },
  template: '<div><slot /></div>',
}
const translate = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

async function settle() {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** `history.state.position`: the index of the current entry. */
function position(): number {
  return (window.history.state as { position: number }).position
}

async function back() {
  window.history.back()
  await settle()
}
async function forward() {
  window.history.forward()
  await settle()
}

let router: Router
let wrapper: ReturnType<typeof mount> | undefined

async function openFrank(start: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chats = useChatStore()
  const a = chats.openDirectConversation(PEER)
  const b = chats.openDirectConversation(OTHER)
  // Conversations that had messages: the list shows them.
  a.lastReceived = 1
  b.lastReceived = 2
  // A page from before the app, so that leaving the app is a real entry.
  window.history.pushState(null, '', '#/before-the-app')
  window.history.pushState(null, '', `#${start}`)
  router = createAppRouter()
  await router.push(start)
  await router.isReady()
  wrapper = mount(App, {
    global: {
      plugins: [pinia, router],
      components: controls,
      stubs: {
        ChatInput: simple,
        ChatMessageComponent: simple,
        ChatMessageReply: simple,
        ChatBannerStack: simple,
        QResizeObserver: simple,
      },
      mocks: {
        $q: { dark: { set: jest.fn(), isActive: false }, screen: {} },
        $status: { setup: true },
        $t: translate,
      },
    },
  })
  // The page under the app's root, as in MainLayout.
  await settle()
  return { chats, a, b }
}

function mountPage(withList = false) {
  return mount(
    defineComponent({
      components: { ChatList },
      template: withList
        ? '<div><ChatList :compact="false" /><router-view /></div>'
        : '<router-view />',
    }),
    {
      // In the document, as the app is: overlays are found in the page.
      attachTo: document.body,
      global: {
        plugins: [router],
        components: controls,
        stubs: {
          ChatInput: simple,
          ChatMessageComponent: simple,
          ChatMessageReply: simple,
          ChatBannerStack: simple,
          QResizeObserver: simple,
        },
        mocks: {
          $q: { dark: { isActive: false }, screen: {} },
          $status: { setup: true },
          $t: translate,
        },
      },
    },
  )
}

beforeEach(() => {
  setStartupRestoration({ phase: 'restored' })
  jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  router.options.history.destroy()
  jest.restoreAllMocks()
})

describe('finding 2: Back between two conversations', () => {
  it('goes back one conversation per press and keeps Forward', async () => {
    const { chats, a, b } = await openFrank('/forum')
    const page = mountPage()
    try {
      const start = position()
      await openChat(router, a.id)
      await settle()
      await openChat(router, b.id)
      await settle()
      expect(router.currentRoute.value.params.address).toBe(b.id)
      expect(position()).toBe(start + 2)
      await back()
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(position()).toBe(start + 1)
      expect(chats.activeConversationId).toBe(a.id)
      await back()
      expect(router.currentRoute.value.path).toBe('/forum')
      expect(position()).toBe(start)
      await forward()
      expect(router.currentRoute.value.params.address).toBe(a.id)
      await forward()
      expect(router.currentRoute.value.params.address).toBe(b.id)
      expect(position()).toBe(start + 2)
    } finally {
      page.unmount()
    }
  })

  it('picking a conversation in the list adds one entry, and Back returns to the last', async () => {
    const { chats, a, b } = await openFrank('/forum')
    const page = mountPage(true)
    try {
      const start = position()
      const pick = async (id: string) => {
        const item = page
          .findAllComponents(ChatListItem)
          .find(item => item.props('conversationId') === id)
        expect(item).toBeDefined()
        await item!.trigger('click')
        await settle()
      }
      await pick(a.id)
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(position()).toBe(start + 1)
      await pick(b.id)
      expect(router.currentRoute.value.params.address).toBe(b.id)
      expect(position()).toBe(start + 2)
      expect(chats.activeConversationId).toBe(b.id)
      await back()
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(chats.activeConversationId).toBe(a.id)
      expect(position()).toBe(start + 1)
    } finally {
      page.unmount()
    }
  })
})

describe('finding 3: New Contact leaves no entry Back would reopen', () => {
  it('Cancel goes back to the page it was opened from', async () => {
    await openFrank('/contacts')
    const page = mountPage()
    try {
      const start = position()
      await router.push({ path: '/add-contact', query: { from: '/contacts' } })
      await settle()
      await page.getComponent(AddContact).vm.cancel()
      await settle()
      expect(router.currentRoute.value.path).toBe('/contacts')
      expect(position()).toBe(start)
    } finally {
      page.unmount()
    }
  })
})

describe('finding 3: Add Contact returns to where it was opened', () => {
  it('Add on Contacts returns to Contacts, and Back does not reopen the form', async () => {
    await openFrank('/contacts')
    const page = mountPage()
    try {
      const contacts = position()
      await router.push({ path: '/add-contact', query: { from: '/contacts' } })
      await settle()
      const form = page.getComponent(AddContact)
      await form.get('[data-test="address-input"]').setValue(OTHER)
      await settle()
      await form.get('[data-test="add-contact-btn"]').trigger('click')
      await settle()
      expect(router.currentRoute.value.path).toBe('/contacts')
      expect(position()).toBe(contacts)
    } finally {
      page.unmount()
    }
  })
})

describe('finding 3: Start Conversation replaces its form with the conversation', () => {
  it('Back from the new conversation returns to the list, not to the finished form', async () => {
    const { chats } = await openFrank('/chat')
    const page = mountPage()
    try {
      const list = position()
      await router.push('/new-conversation')
      await settle()
      const form = page.getComponent(AddContact)
      await form.get('[data-test="address-input"]').setValue(OTHER)
      await settle()
      await form.get('[data-test="topic-input"]').setValue('Plans')
      await form.get('[data-test="start-conversation-btn"]').trigger('click')
      await settle()
      expect(router.currentRoute.value.params.address).toBe(
        chats.activeConversationId,
      )
      expect(position()).toBe(list + 1)
      await back()
      expect(router.currentRoute.value.path).toBe('/chat')
      expect(position()).toBe(list)
    } finally {
      page.unmount()
    }
  })
})

describe('finding 6: contact info is a page above its conversation', () => {
  it('X and Back both return to the conversation, opened from the chat menu', async () => {
    const { a } = await openFrank('/forum')
    const page = mountPage()
    try {
      await openChat(router, a.id)
      await settle()
      const chatPosition = position()
      const layout = page.getComponent(ChatLayout)
      layout.vm.openInfo()
      await settle()
      expect(router.currentRoute.value.query.info).toBe('true')
      expect(position()).toBe(chatPosition + 1)
      await back()
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(router.currentRoute.value.query.info).toBeUndefined()
      expect(position()).toBe(chatPosition)
      await forward()
      expect(router.currentRoute.value.query.info).toBe('true')
      page.getComponent(ChatLayout).vm.closeInfo()
      await settle()
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(router.currentRoute.value.query.info).toBeUndefined()
      expect(position()).toBe(chatPosition)
    } finally {
      page.unmount()
    }
  })

  it('X returns to Contacts when the profile was opened from Contacts', async () => {
    await openFrank('/contacts')
    const page = mountPage()
    try {
      const start = position()
      await openContactProfile(router, PEER)
      await settle()
      expect(position()).toBe(start + 1)
      page.getComponent(ChatLayout).vm.closeInfo()
      await settle()
      expect(router.currentRoute.value.path).toBe('/contacts')
      expect(position()).toBe(start)
    } finally {
      page.unmount()
    }
  })
})

describe('finding 13: Back closes the chat menu on a phone', () => {
  const width = window.innerWidth
  afterEach(() => {
    window.innerWidth = width
  })

  it('Back closes the open chat menu and stays in the conversation, in the same entry', async () => {
    window.innerWidth = 390
    const { a } = await openFrank('/forum')
    const page = mountPage()
    try {
      await openChat(router, a.id)
      await settle()
      const chatPosition = position()
      const menu = page
        .getComponent(ChatLayout)
        .findAllComponents(QMenuStub)
        .find(menu => menu.props('anchor') === 'bottom right')!
      ;(menu.vm as any).open()
      await settle()
      expect((menu.vm as any).shown).toBe(true)
      await back()
      expect((menu.vm as any).shown).toBe(false)
      expect(router.currentRoute.value.params.address).toBe(a.id)
      expect(position()).toBe(chatPosition)
      await back()
      expect(router.currentRoute.value.path).toBe('/forum')
    } finally {
      page.unmount()
    }
  })
})

describe('finding 7: the conversation back arrow is Back', () => {
  it('opened from Contacts, the arrow returns to Contacts like Back', async () => {
    await openFrank('/contacts')
    const page = mountPage()
    try {
      const start = position()
      await openChat(router, PEER)
      await settle()
      expect(position()).toBe(start + 1)
      page.getComponent(ChatLayout).vm.backToChats()
      await settle()
      expect(router.currentRoute.value.path).toBe('/contacts')
      expect(position()).toBe(start)
    } finally {
      page.unmount()
    }
  })
})
