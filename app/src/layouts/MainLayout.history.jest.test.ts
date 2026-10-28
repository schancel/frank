/** @jest-environment jsdom */
/**
 * The app shell on a real hash-mode router over jsdom's session history, at phone width:
 * - finding 17: bottom tabs do not stack; Back from any tab lands on Messages;
 * - finding 16: the drawer's Messages icon opens the conversation list, and picking a forum
 *   topic closes the drawer even when the forum is already open;
 * - finding 13: Back closes the open drawer and stays on the page, in the same entry;
 * - finding 8: Settings -> drawer -> Profile is a page above Settings: Back returns there.
 * `history.state.position` is the entry's index.
 */
import { flushPromises, mount, VueWrapper } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'
import type { Router } from 'vue-router'

import enUS from 'src/i18n/en-us'
import MainLayout from './MainLayout.vue'
import { resetNavigationForTests } from '../utils/navigation'
import {
  flushHistory,
  historyPosition,
  openApp,
  userBack,
} from '../../test/jest/navigation-harness'

jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('../accounts/backup-status', () => ({
  ...jest.requireActual('../accounts/backup-status'),
  isAccountBackedUp: () => true,
}))
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))
// Stores are plain reactive objects; storeToRefs just needs to turn them into refs.
jest.mock('pinia', () => ({
  defineStore: (_id: string, def: any) => () =>
    typeof def === 'function' ? def() : def,
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
  getActivePinia: () => undefined,
}))
jest.mock('../components/panels/ContactsPanel.vue', () => ({
  template: '<div data-testid="contacts-panel" />',
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => ({
    contacts: [],
    getContact: jest.fn(),
  }),
}))
const mockUnread = { value: 3 }
const mockConversationId = '11111111-1111-4111-8111-111111111111'
const mockSetActiveConversation = jest.fn()
jest.mock('src/stores/chats', () => ({
  useChatStore: () =>
    jest.requireActual('vue').reactive({
      totalUnread: mockUnread.value,
      getSortedChatOrder: [
        { id: mockConversationId, address: 'addr1', totalUnreadMessages: 0 },
      ],
      setActiveConversation: mockSetActiveConversation,
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
    chainIdentifier: 'monad-testnet',
    isTestnet: true,
    unit: 'MONT',
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
jest.mock('../components/chat/ChatListItem.vue', () => ({
  props: ['chatAddress'],
  template: '<div data-testid="chat-item" />',
}))
jest.mock('../components/chat/MailboxStatusIndicator.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/chat/ChatListLink.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/panels/ContactCard.vue', () => ({
  template: '<div />',
}))
jest.mock('../components/dialogs/ContactBookDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => ({ seedPhrase: null, seedConfirmedAt: null }),
}))
jest.mock('../components/dialogs/RelayConnectDialog.vue', () => ({
  template: '<div />',
}))

// Records the drawer's v-model (its open state) without Quasar's own resize logic, so what is
// under test is exactly what MainLayout hands to it.
const DrawerStub = defineComponent({
  props: { modelValue: Boolean, breakpoint: Number },
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        {
          'data-testid': 'drawer',
          'class': 'q-drawer',
          'data-open': String(props.modelValue),
          'data-breakpoint': String(props.breakpoint),
        },
        slots.default?.(),
      )
  },
})
const LayoutStub = defineComponent({
  setup(_p, { slots }) {
    return () => h('div', slots.default?.())
  },
})
// Resolves real en-us strings (vue-i18n's ESM build is not loadable under this Jest config).
function translate(key: string, params: Record<string, unknown> = {}): string {
  const value = key
    .split('.')
    .reduce<any>((node, part) => node?.[part], enUS as any)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
    : key
}
// Quasar's real components render nothing under the SSR server build Jest is aliased to, so
// every Q* element becomes a plain element that keeps the attributes/listeners/slots the app
// puts on it (aria-label, @click, content). QTab keeps its role, QTooltip is always rendered.
function passthrough(tag: string, extra: Record<string, string> = {}) {
  return defineComponent({
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, extra, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(name => /^Q[A-Z]/.test(name))
    .map(name => [name, passthrough('div')]),
)
quasarStubs.QTab = passthrough('div', { role: 'tab' })
quasarStubs.QTooltip = passthrough('span', { 'data-testid': 'tooltip' })
quasarStubs.QBtn = passthrough('button')
quasarStubs.QDialog = passthrough('div', { 'data-testid': 'dialog' })

const ROUTES = [
  '/chat',
  '/chat/:address',
  '/forum',
  '/contacts',
  '/wallet',
  '/qr',
  '/settings',
  '/profile',
]

let router: Router
let destroy: () => void = () => undefined
let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  destroy()
  resetNavigationForTests()
})

async function phone(start: string) {
  ;({ router, destroy } = await openApp(ROUTES, start))
  const $q = { screen: { width: 390 }, platform: { is: { mobile: true } } }
  wrapper = mount(MainLayout, {
    global: {
      plugins: [router],
      directives: { ripple: {} },
      components: { ...quasarStubs, QLayout: LayoutStub, QDrawer: DrawerStub },
      provide: { _q_: $q },
      stubs: { RouterView: true },
      mocks: {
        $q,
        $t: translate,
        $status: { setup: true },
        $relay: { connected: true },
      },
    },
  })
  await flushPromises()
  return wrapper
}

const drawerOpen = (w: VueWrapper) =>
  w.get('[data-testid="drawer"]').attributes('data-open')

async function tap(w: VueWrapper, selector: string) {
  await w.get(selector).trigger('click')
  await flushHistory()
}

describe('finding 17: bottom tabs do not stack', () => {
  it('Back from any tab, however many were tapped, lands on Messages', async () => {
    const w = await phone('/chat')
    const messages = historyPosition()
    await tap(w, '[data-testid="mobile-nav-wallet"]')
    expect(router.currentRoute.value.path).toBe('/wallet')
    await tap(w, '[data-testid="mobile-nav-contacts"]')
    await tap(w, '[data-testid="mobile-nav-forum"]')
    await tap(w, '[data-testid="mobile-nav-settings"]')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(historyPosition()).toBe(messages + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(messages)
  })

  it('the Messages tab returns to the Messages entry instead of stacking another', async () => {
    const w = await phone('/chat')
    const messages = historyPosition()
    await tap(w, '[data-testid="mobile-nav-wallet"]')
    await tap(w, '[data-testid="mobile-nav-chats"]')
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(messages)
  })
})

describe('the Messages tab from a conversation returns to the list as the user left it', () => {
  async function searchedThenOpened() {
    const w = await phone('/chat')
    await router.replace('/chat?q=al')
    const list = historyPosition()
    await router.push('/chat/abc')
    await flushHistory()
    return { w, list }
  }

  it('the bottom tab: Back to the searched list, no new entry', async () => {
    const { w, list } = await searchedThenOpened()
    // The bottom bar hides inside a conversation; its Messages tab's own handler.
    ;(w.vm as any).openMobileChatsTab()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/chat?q=al')
    expect(historyPosition()).toBe(list)
  })

  it('the rail: Back to the searched list, no new entry', async () => {
    const { w, list } = await searchedThenOpened()
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    await tap(w, '#rail-tab-chats')
    expect(router.currentRoute.value.fullPath).toBe('/chat?q=al')
    expect(historyPosition()).toBe(list)
  })
})

describe('finding 16: the drawer', () => {
  it("the drawer's Messages icon opens the conversation list, not the last conversation", async () => {
    const w = await phone('/forum')
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    await tap(w, '#rail-tab-chats')
    expect(router.currentRoute.value.path).toBe('/chat')
  })

  it('picking a forum topic while on the forum closes the drawer', async () => {
    const w = await phone('/forum')
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    expect(drawerOpen(w)).toBe('true')
    const topic = w.findAll('div').filter(d => d.text() === 'alpha')
    await topic[topic.length - 1].trigger('click')
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/forum')
    expect(drawerOpen(w)).toBe('false')
  })
})

describe('finding 13: Back closes the drawer on a phone', () => {
  it('Back closes the open drawer and stays on the page, in the same entry', async () => {
    const w = await phone('/chat')
    await tap(w, '[data-testid="mobile-nav-wallet"]')
    const wallet = historyPosition()
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    expect(drawerOpen(w)).toBe('true')
    await userBack(router)
    expect(drawerOpen(w)).toBe('false')
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(wallet)
    // With nothing open, Back navigates again.
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
  })
})

describe('finding 8: Profile from the drawer is a page above Settings', () => {
  it('Settings -> drawer -> Profile, then Back, returns to Settings', async () => {
    const w = await phone('/chat')
    await tap(w, '[data-testid="mobile-nav-settings"]')
    const settings = historyPosition()
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    const profile = w.findAll('div').filter(d => d.text() === 'Profile')
    await profile[0].trigger('click')
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/profile')
    expect(historyPosition()).toBe(settings + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(historyPosition()).toBe(settings)
  })
})

describe("the drawer's balance opens the Wallet tab", () => {
  it('as a tab: Back from it lands on Messages', async () => {
    const w = await phone('/chat')
    const messages = historyPosition()
    ;(w.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    await tap(
      w,
      '.drawer-balance-item .q-item__section, .drawer-balance-item > *',
    )
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(messages + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
  })
})
