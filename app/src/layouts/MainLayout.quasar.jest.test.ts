/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'

import enUS from 'src/i18n/en-us'
import MainLayout from './MainLayout.vue'

// Real Quasar components (QLayout, QDrawer, QTabs, QTab, ...). `import 'quasar'` resolves to the
// SSR server build under this Jest config (moduleNameMapper), whose components render nothing
// useful, so this file loads Quasar's UMD build directly instead. UMD expects a global Vue and
// jsdom lacks ResizeObserver (both set in loadQuasar below).

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

type Hook = (to: unknown, from: unknown, failure?: unknown) => void
function createFakeRouter() {
  const hooks: Hook[] = []
  const router = {
    currentRoute: { value: { path: '/' } },
    afterEach: (fn: Hook) => {
      hooks.push(fn)
      return () => hooks.splice(hooks.indexOf(fn), 1)
    },
    onError: () => () => undefined,
    push: jest.fn(async (path: string) => {
      const from = router.currentRoute.value
      router.currentRoute.value = { path }
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
  const wrapper = mount(MainLayout, {
    attachTo: host,
    global: {
      plugins: [quasarUmd],
      stubs: { RouterView: true },
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

const tabsOf = (root: Element) =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'))
// Quasar keeps the backdrop mounted but `hidden` while the mobile overlay is closed.
const drawerIsOverlayOpen = () => {
  const backdrop = document.querySelector('.q-drawer__backdrop')
  return backdrop !== null && !backdrop.classList.contains('hidden')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('LeftDrawer rail with real Quasar QDrawer/QTabs/QTab', () => {
  it('renders a named vertical tablist whose tabs each control a labelled tabpanel', async () => {
    const { wrapper } = await mountReal(1024)
    const list = document.querySelector('[role="tablist"]')
    expect(list?.getAttribute('aria-label')).toBe('Sidebar sections')
    expect(list?.getAttribute('aria-orientation')).toBe('vertical')
    const tabs = tabsOf(document.body)
    expect(tabs.map(t => t.getAttribute('aria-label'))).toEqual([
      'Settings',
      'Contacts, 3 unread messages',
      'Forum',
    ])
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    // Contacts is the default selection; only its panel is displayed.
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ])
    const shown = tabs.map(
      t =>
        document.getElementById(t.getAttribute('aria-controls')!)!.style
          .display !== 'none',
    )
    expect(shown).toEqual([false, true, false])
    wrapper.unmount()
  })

  it('selecting the Forum tab navigates, moves aria-selected and swaps the panel', async () => {
    const { wrapper, router } = await mountReal(1024)
    const [, , forum] = tabsOf(document.body)
    forum.click()
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/forum')
    const tabs = tabsOf(document.body)
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
    ])
    expect(document.getElementById('rail-panel-forum')!.style.display).not.toBe(
      'none',
    )
    expect(document.getElementById('rail-panel-contacts')!.style.display).toBe(
      'none',
    )
    wrapper.unmount()
  })

  it('opens as an overlay on a narrow screen and stays open across a rail-tab switch', async () => {
    const { wrapper } = await mountReal(390)
    expect(drawerIsOverlayOpen()).toBe(false)
    ;(wrapper.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    expect(drawerIsOverlayOpen()).toBe(true)
    tabsOf(document.body)[2].click()
    await flushPromises()
    expect(drawerIsOverlayOpen()).toBe(true)
    wrapper.unmount()
  })

  it('closes the real overlay after picking a destination and focuses the main region', async () => {
    const { wrapper } = await mountReal(390)
    const main = document.createElement('div')
    main.className = 'q-page-container'
    document.body.appendChild(main)
    ;(wrapper.vm as any).toggleMyDrawerOpen()
    await flushPromises()
    expect(drawerIsOverlayOpen()).toBe(true)
    const profile = Array.from(
      document.querySelectorAll<HTMLElement>('.q-item, div'),
    ).find(el => el.textContent?.trim() === 'Profile')
    profile!.click()
    await flushPromises()
    expect(drawerIsOverlayOpen()).toBe(false)
    expect(document.activeElement).toBe(main)
    wrapper.unmount()
  })

  describe('other ways the overlay closes', () => {
    async function openFrom(wrapper: any, button: HTMLElement) {
      button.focus()
      wrapper.vm.toggleMyDrawerOpen()
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(true)
    }
    function addButton() {
      const b = document.createElement('button')
      document.body.appendChild(b)
      return b
    }

    it('restores focus to the opener after Escape', async () => {
      const { wrapper } = await mountReal(390)
      const button = addButton()
      await openFrom(wrapper, button)
      // Quasar's Escape handling is keydown then keyup on window.
      for (const type of ['keydown', 'keyup']) {
        window.dispatchEvent(
          new KeyboardEvent(type, { key: 'Escape', keyCode: 27 }),
        )
      }
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      expect(document.activeElement).toBe(button)
      wrapper.unmount()
    })

    it('restores focus to the opener after a backdrop click', async () => {
      const { wrapper } = await mountReal(390)
      const button = addButton()
      await openFrom(wrapper, button)
      document.querySelector<HTMLElement>('.q-drawer__backdrop')!.click()
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      expect(document.activeElement).toBe(button)
      wrapper.unmount()
    })

    it('never restores a stale opener from an earlier open', async () => {
      const { wrapper } = await mountReal(390)
      const main = document.createElement('div')
      main.className = 'q-page-container'
      document.body.appendChild(main)
      const stale = addButton()
      await openFrom(wrapper, stale)
      wrapper.vm.myDrawerOpen = false // closed by some path
      await flushPromises()
      expect(document.activeElement).toBe(stale)
      // Reopened by a path other than toggleMyDrawerOpen, with nothing focused.
      ;(document.activeElement as HTMLElement).blur()
      wrapper.vm.myDrawerOpen = true
      await flushPromises()
      wrapper.vm.myDrawerOpen = false
      await flushPromises()
      expect(document.activeElement).toBe(main)
      // Reopened with a different control focused, after the old one is gone.
      stale.remove()
      const fresh = addButton()
      fresh.focus()
      wrapper.vm.myDrawerOpen = true
      await flushPromises()
      wrapper.vm.myDrawerOpen = false
      await flushPromises()
      expect(document.activeElement).toBe(fresh)
      wrapper.unmount()
    })
  })
})
