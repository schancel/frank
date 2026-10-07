/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { resolve } from 'path'

import enUS from 'src/i18n/en-us'
import MainLayout from './MainLayout.vue'

// Real Quasar components (QLayout, QDrawer, QTabs, QTab, ...). `import 'quasar'` resolves to the
// SSR server build under this Jest config (moduleNameMapper), whose components render nothing
// useful, so this file loads Quasar's UMD build directly instead. UMD expects a global Vue and
// jsdom lacks ResizeObserver (both set in loadQuasar below).

// Stores are plain reactive objects; storeToRefs just needs to turn them into refs.
jest.mock('pinia', () => ({
  defineStore: (_id: string, def: any) => () =>
    typeof def === 'function' ? def() : def,
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
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
jest.mock('../components/panels/BackupReminder.vue', () => ({
  template: '<div />',
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () => ({ seedPhrase: null, seedConfirmedAt: null }),
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

function installLeftDrawerStyles() {
  const filename = resolve(__dirname, '../components/panels/LeftDrawer.vue')
  const source = readFileSync(filename, 'utf8')
  // vue-jest intentionally omits styles. Inject the two production rules that form this layout
  // contract so their computed result is checked on Quasar's real internal DOM shape.
  const walletRule = source.match(/\.wallet-rail-tab\s*\{[^}]+\}/)?.[0]
  const settingsRule = source.match(/\.settings-rail-tab\s*\{[^}]+\}/)?.[0]
  const contentRule = source.match(
    /\.icon-rail\s+:deep\(\.settings-pin-content\)\s*\{[^}]+\}/,
  )?.[0]
  if (!walletRule || !contentRule) {
    throw new Error('LeftDrawer rail pin styles are missing')
  }
  const style = document.createElement('style')
  style.dataset.test = 'left-drawer-styles'
  style.textContent = `${walletRule}\n${
    settingsRule || ''
  }\n${contentRule.replace(
    ':deep(.settings-pin-content)',
    '.settings-pin-content',
  )}`
  document.head.appendChild(style)
}
// Quasar keeps the backdrop mounted but `hidden` while the mobile overlay is closed.
const drawerIsOverlayOpen = () => {
  const backdrop = document.querySelector('.q-drawer__backdrop')
  return backdrop !== null && !backdrop.classList.contains('hidden')
}

afterEach(() => {
  document.body.innerHTML = ''
  document
    .querySelectorAll('style[data-test="left-drawer-styles"]')
    .forEach(style => style.remove())
})

describe('LeftDrawer rail with real Quasar QDrawer/QTabs/QTab', () => {
  it('renders a named vertical tablist whose tabs each control a labelled tabpanel', async () => {
    const { wrapper } = await mountReal(1024)
    const list = document.querySelector('[role="tablist"]')
    expect(list?.getAttribute('aria-label')).toBe('Sidebar sections')
    expect(list?.getAttribute('aria-orientation')).toBe('vertical')
    const tabs = tabsOf(document.body)
    expect(tabs.map(t => t.getAttribute('aria-label'))).toEqual([
      'Direct Messages, 3 unread messages',
      'Forum',
      'Contacts',
      'Wallet',
      'Settings',
    ])
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    // Chats is the default selection; only its panel is displayed.
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ])
    const shown = tabs.map(
      t =>
        document.getElementById(t.getAttribute('aria-controls')!)!.style
          .display !== 'none',
    )
    expect(shown).toEqual([true, false, false, false, false])
    wrapper.unmount()
  })

  it('renders the Quasar tab content as a column so Wallet and Settings pin to the bottom', async () => {
    const { wrapper } = await mountReal(1024)
    installLeftDrawerStyles()
    const content = document.querySelector<HTMLElement>(
      '.q-tabs__content.settings-pin-content',
    )
    const wallet = document.getElementById('rail-tab-wallet')!
    const settings = document.getElementById('rail-tab-settings')!

    expect(content).not.toBeNull()
    expect(getComputedStyle(content!).display).toBe('flex')
    expect(getComputedStyle(content!).flexDirection).toBe('column')
    expect(getComputedStyle(content!).overflowY).toBe('auto')
    expect(getComputedStyle(wallet).marginTop).toBe('auto')
    expect(content!.lastElementChild).toBe(settings)
    wrapper.unmount()
  })

  it('selecting Wallet moves aria-selected and swaps the rendered panel', async () => {
    const { wrapper } = await mountReal(1024)
    const wallet = document.getElementById('rail-tab-wallet')!
    wallet.click()
    await flushPromises()

    const tabs = tabsOf(document.body)
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'false',
      'true',
      'false',
    ])
    expect(
      document.getElementById('rail-panel-wallet')!.style.display,
    ).not.toBe('none')
    expect(document.getElementById('rail-panel-chats')!.style.display).toBe(
      'none',
    )
    wrapper.unmount()
  })

  it('selecting the Forum tab navigates, moves aria-selected and swaps the panel', async () => {
    const { wrapper, router } = await mountReal(1024)
    const [, forum] = tabsOf(document.body)
    forum.click()
    await flushPromises()
    expect(router.push).toHaveBeenCalledWith('/forum')
    const tabs = tabsOf(document.body)
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
    ])
    expect(document.getElementById('rail-panel-forum')!.style.display).not.toBe(
      'none',
    )
    expect(document.getElementById('rail-panel-chats')!.style.display).toBe(
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
    tabsOf(document.body)[1].click()
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

  describe('focus and containment while the overlay is open (#277)', () => {
    // Stand-ins for what the routed page contributes to the layout: a header with the opener and
    // the main content, as direct children of the q-layout.
    function addPageChrome(wrapper: any) {
      const header = document.createElement('header')
      const opener = document.createElement('button')
      opener.textContent = 'menu'
      header.appendChild(opener)
      const main = document.createElement('div')
      main.className = 'q-page-container'
      main.innerHTML = '<button>page control</button>'
      wrapper.element.append(header, main)
      return { header, main, opener }
    }
    const inDrawer = (el: Element | null) => !!el?.closest('.q-drawer')

    it('moves focus into the drawer on open, to the selected rail tab', async () => {
      const { wrapper } = await mountReal(390)
      const { opener } = addPageChrome(wrapper)
      opener.focus()
      ;(wrapper.vm as any).toggleMyDrawerOpen()
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(true)
      expect(inDrawer(document.activeElement)).toBe(true)
      expect(document.activeElement?.getAttribute('role')).toBe('tab')
      expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
      wrapper.unmount()
    })

    it('makes the page behind the overlay inert, but not the drawer or its backdrop', async () => {
      const { wrapper } = await mountReal(390)
      const { header, main } = addPageChrome(wrapper)
      ;(wrapper.vm as any).toggleMyDrawerOpen()
      await flushPromises()
      expect(header.hasAttribute('inert')).toBe(true)
      expect(main.hasAttribute('inert')).toBe(true)
      expect(document.querySelector('.q-drawer')!.closest('[inert]')).toBeNull()
      expect(
        document.querySelector('.q-drawer__backdrop')!.closest('[inert]'),
      ).toBeNull()
      wrapper.unmount()
    })

    it('Escape pressed on the focused rail tab closes the overlay and returns focus to the opener', async () => {
      const { wrapper } = await mountReal(390)
      const { header, opener } = addPageChrome(wrapper)
      opener.focus()
      ;(wrapper.vm as any).toggleMyDrawerOpen()
      await flushPromises()
      const tab = document.activeElement as HTMLElement
      expect(tab.getAttribute('role')).toBe('tab')
      // A real browser does not run Quasar's window-level Escape handling with a tab focused, so
      // only the keydown on the focused element itself is dispatched here.
      tab.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
        }),
      )
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      expect(header.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })

    it('closing returns focus to the opener and makes the page interactive again', async () => {
      const { wrapper } = await mountReal(390)
      const { header, main, opener } = addPageChrome(wrapper)
      opener.focus()
      ;(wrapper.vm as any).toggleMyDrawerOpen()
      await flushPromises()
      expect(inDrawer(document.activeElement)).toBe(true)
      for (const type of ['keydown', 'keyup']) {
        window.dispatchEvent(
          new KeyboardEvent(type, { key: 'Escape', keyCode: 27 }),
        )
      }
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      expect(header.hasAttribute('inert')).toBe(false)
      expect(main.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })

    it('does not touch focus or the page when the drawer is a permanent side panel (wide screen)', async () => {
      const { wrapper } = await mountReal(1280)
      const { header, main, opener } = addPageChrome(wrapper)
      opener.focus()
      ;(wrapper.vm as any).myDrawerOpen = false
      ;(wrapper.vm as any).myDrawerOpen = true
      await flushPromises()
      expect(header.hasAttribute('inert')).toBe(false)
      expect(main.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(opener)
      wrapper.unmount()
    })

    it('leaves nothing inert behind when the layout unmounts with the overlay open', async () => {
      const { wrapper } = await mountReal(390)
      const { header } = addPageChrome(wrapper)
      ;(wrapper.vm as any).toggleMyDrawerOpen()
      await flushPromises()
      expect(header.hasAttribute('inert')).toBe(true)
      const detached = header
      wrapper.unmount()
      expect(detached.hasAttribute('inert')).toBe(false)
    })
  })

  describe('setup completion lock (#387)', () => {
    it('never opens the overlay while the lock is active and closes it when the lock engages', async () => {
      const { wrapper } = await mountReal(390)
      const vm = wrapper.vm as unknown as {
        setSetupNavigationLocked(locked: boolean): void
        toggleMyDrawerOpen(): void
      }
      vm.setSetupNavigationLocked(true)
      await flushPromises()
      vm.toggleMyDrawerOpen()
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      // A lock that engages while the overlay is already out (a submit with the drawer open)
      // closes it: the drawer's destinations must not be reachable mid-completion.
      vm.setSetupNavigationLocked(false)
      await flushPromises()
      vm.toggleMyDrawerOpen()
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(true)
      vm.setSetupNavigationLocked(true)
      await flushPromises()
      expect(drawerIsOverlayOpen()).toBe(false)
      wrapper.unmount()
    })
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

    it('restores focus to the opener after a backdrop click that left focus on the layout root', async () => {
      const { wrapper } = await mountReal(390)
      const button = addButton()
      await openFrom(wrapper, button)
      // What a browser does on mousedown over the backdrop: focus the nearest focusable ancestor.
      const layout = wrapper.element as HTMLElement
      layout.setAttribute('tabindex', '-1')
      layout.focus()
      expect(document.activeElement).toBe(layout)
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
