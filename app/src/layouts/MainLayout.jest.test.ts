/** @jest-environment jsdom */

import { flushPromises, mount, VueWrapper } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h } from 'vue'

import enUS from 'src/i18n/en-us'
import MainLayout from './MainLayout.vue'

// Stores are plain reactive objects; storeToRefs just needs to turn them into refs.
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
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
      getSortedChatOrder: [{ address: 'addr1', totalUnreadMessages: 0 }],
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
jest.mock('../components/chat/ChatListItem.vue', () => ({
  props: ['chatAddress'],
  template: '<div data-testid="chat-item" />',
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
jest.mock('../components/dialogs/SeedPhraseDialog.vue', () => ({
  template: '<div />',
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
// vue-router's real build is not loadable under this Jest config (ESM-only transitive dep), and
// the sibling suites mock it too. This fake keeps the parts under test real: afterEach hooks
// fire after every push/replace, and currentRoute drives openPage()'s replace-vs-push choice.
function createFakeRouter() {
  type Hook = (to: unknown, from: unknown, failure?: unknown) => void
  const hooks: Hook[] = []
  const errorHandlers: Array<(err: unknown) => void> = []
  const router = {
    currentRoute: { value: { path: '/' } },
    afterEach: (fn: Hook) => {
      hooks.push(fn)
      return () => hooks.splice(hooks.indexOf(fn), 1)
    },
    onError: (fn: (err: unknown) => void) => {
      errorHandlers.push(fn)
      return () => errorHandlers.splice(errorHandlers.indexOf(fn), 1)
    },
    // Like a throwing beforeEach guard: afterEach hooks are skipped, onError handlers run and
    // the navigation promise rejects.
    guardThrowsOnce: false,
    push: jest.fn(async (path: string) => navigate(path)),
    replace: jest.fn(async (path: string) => navigate(path)),
  }
  function navigate(path: string) {
    if (router.guardThrowsOnce) {
      router.guardThrowsOnce = false
      const error = new Error('guard failed')
      errorHandlers.slice().forEach(fn => fn(error))
      throw error
    }
    // Like vue-router: a navigation to the current path is a "duplicated" failure, and
    // afterEach hooks still run with it.
    const failure =
      path === router.currentRoute.value.path
        ? { type: 'duplicated' }
        : undefined
    const from = router.currentRoute.value
    router.currentRoute.value = { path }
    hooks.slice().forEach(fn => fn({ path }, from, failure))
  }
  return router
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

async function mountLayout(width: number, attachTo?: HTMLElement) {
  const $q = { screen: { width } }
  const router = createFakeRouter()
  mockRouterRef.current = router
  const wrapper = mount(MainLayout, {
    attachTo,
    global: {
      // Hand the components a $q carrying just the screen width under test.
      directives: { ripple: {} },
      components: { ...quasarStubs, QLayout: LayoutStub, QDrawer: DrawerStub },
      config: { errorHandler: () => undefined }, // the rejected push of a throwing guard
      provide: { _q_: $q },
      stubs: { RouterView: true },
      mocks: {
        $q,
        $router: router,
        $t: translate,
        $status: { setup: true },
        $relay: { connected: true },
      },
    },
  })
  return { wrapper, router }
}

const drawer = (w: VueWrapper) => w.find('[data-testid="drawer"]')

describe('MainLayout drawer initial state', () => {
  // QDrawer.js: totalWidth <= breakpoint is mobile, so exactly 800 must start closed.
  it.each([
    [390, 'false'],
    [800, 'false'],
    [801, 'true'],
    [1024, 'true'],
  ])('at %ipx starts with open=%s', async (width, expected) => {
    const { wrapper } = await mountLayout(width)
    expect(drawer(wrapper).attributes('data-open')).toBe(expected)
    expect(drawer(wrapper).attributes('data-breakpoint')).toBe('800')
    wrapper.unmount()
  })
})

const open = (w: VueWrapper) => drawer(w).attributes('data-open')
const tabs = (w: VueWrapper) => w.findAll('[role="tab"]')
const byText = (w: VueWrapper, text: string) =>
  w.findAll('div').filter(d => d.text() === text)

async function openDrawer(w: VueWrapper) {
  ;(w.vm as any).toggleMyDrawerOpen()
  await flushPromises()
  expect(open(w)).toBe('true')
}

describe('MainLayout closes the mobile overlay on navigation', () => {
  it('stays open when switching rail tabs (forum, contacts) on a narrow screen', async () => {
    const { wrapper, router } = await mountLayout(390)
    await openDrawer(wrapper)
    await tabs(wrapper)[2].trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/forum')
    expect(open(wrapper)).toBe('true')
    await tabs(wrapper)[1].trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/chat/addr1')
    expect(open(wrapper)).toBe('true')
    // The marker does not leak: the next real destination still closes the overlay.
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('false')
  })

  it('closes after picking a forum topic on a narrow screen', async () => {
    const { wrapper, router } = await mountLayout(390)
    await openDrawer(wrapper)
    await byText(wrapper, 'alpha').slice(-1)[0].trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/forum')
    expect(open(wrapper)).toBe('false')
  })

  it('does not close for a duplicate navigation', async () => {
    const { wrapper } = await mountLayout(390)
    await openDrawer(wrapper)
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('false')
    await openDrawer(wrapper)
    await byText(wrapper, 'Profile')[0].trigger('click') // already on /profile
    await flushPromises()
    expect(open(wrapper)).toBe('true')
  })

  it('closes after a Settings panel item on a narrow screen', async () => {
    const { wrapper, router } = await mountLayout(800)
    await openDrawer(wrapper)
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/profile')
    expect(open(wrapper)).toBe('false')
  })

  it('closes after the balance (receive) item on a narrow screen', async () => {
    const { wrapper } = await mountLayout(390)
    await openDrawer(wrapper)
    await byText(wrapper, 'Balance')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('false')
  })

  it('closes after selecting a chat on a narrow screen', async () => {
    const { wrapper, router } = await mountLayout(390)
    await openDrawer(wrapper)
    await wrapper.find('[data-testid="chat-item"]').trigger('click')
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/chat/addr1')
    expect(open(wrapper)).toBe('false')
  })

  it('leaves the drawer open on a desktop screen', async () => {
    const { wrapper } = await mountLayout(1024)
    await tabs(wrapper)[2].trigger('click')
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('true')
  })
})

describe('LeftDrawer icon rail accessible names', () => {
  // Reset shared state in afterEach so a failing assertion cannot leak it into later tests.
  afterEach(() => {
    mockUnread.value = 3
  })

  it('gives every icon-only tab an aria-label and a tooltip', async () => {
    const { wrapper } = await mountLayout(1024)
    const labels = tabs(wrapper).map(t => t.attributes('aria-label'))
    expect(labels).toEqual(['Settings', 'Contacts, 3 unread messages', 'Forum'])
    for (const [i, name] of ['Settings', 'Contacts', 'Forum'].entries()) {
      expect(tabs(wrapper)[i].find('[data-testid="tooltip"]').text()).toBe(name)
    }
  })

  it('announces the unread count in the Contacts tab label, singular and plural', async () => {
    mockUnread.value = 1
    const one = await mountLayout(1024)
    expect(tabs(one.wrapper)[1].attributes('aria-label')).toBe(
      'Contacts, 1 unread message',
    )
    mockUnread.value = 3
    const many = await mountLayout(1024)
    expect(tabs(many.wrapper)[1].attributes('aria-label')).toBe(
      'Contacts, 3 unread messages',
    )
    mockUnread.value = 0
    const none = await mountLayout(1024)
    expect(tabs(none.wrapper)[1].attributes('aria-label')).toBe('Contacts')
  })
})

describe('MainLayout rail-navigation marker', () => {
  it('is cleared when a router guard throws, so the next navigation still closes the overlay', async () => {
    const { wrapper, router } = await mountLayout(390)
    await openDrawer(wrapper)
    router.guardThrowsOnce = true // e.g. redirectIfNoProfile throwing on the forum tab's push
    await tabs(wrapper)[2].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('true') // nothing navigated
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('false')
  })
})

describe('MainLayout focus after the overlay closes', () => {
  let host: HTMLElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('moves focus to the main content region when the opener is gone', async () => {
    const main = document.createElement('div')
    main.className = 'q-page-container'
    document.body.appendChild(main)
    const { wrapper } = await mountLayout(390, host)
    await openDrawer(wrapper) // nothing focused: no opener to restore
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(open(wrapper)).toBe('false')
    expect(document.activeElement).toBe(main)
    expect(main.getAttribute('tabindex')).toBe('-1')
    wrapper.unmount()
  })

  it('returns focus to the control that opened the drawer when it is still in the page', async () => {
    const main = document.createElement('div')
    main.setAttribute('role', 'main')
    document.body.appendChild(main)
    const menuButton = document.createElement('button')
    document.body.appendChild(menuButton)
    const { wrapper } = await mountLayout(390, host)
    menuButton.focus()
    await openDrawer(wrapper)
    // Focus moves into the drawer while it is open, then the pick closes it.
    const item = byText(wrapper, 'Profile')[0].element as HTMLElement
    item.setAttribute('tabindex', '0')
    item.focus()
    expect(document.activeElement).toBe(item)
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(menuButton)
    wrapper.unmount()
  })

  it('does not steal focus when switching rail tabs (the overlay stays open)', async () => {
    const main = document.createElement('div')
    main.setAttribute('role', 'main')
    document.body.appendChild(main)
    const { wrapper } = await mountLayout(390, host)
    await openDrawer(wrapper)
    await tabs(wrapper)[2].trigger('click')
    await flushPromises()
    expect(document.activeElement).not.toBe(main)
  })

  it('leaves focus alone on desktop, where the drawer never closes', async () => {
    const main = document.createElement('div')
    main.setAttribute('role', 'main')
    document.body.appendChild(main)
    const { wrapper } = await mountLayout(1024, host)
    await byText(wrapper, 'Profile')[0].trigger('click')
    await flushPromises()
    expect(document.activeElement).not.toBe(main)
    wrapper.unmount()
  })
})
