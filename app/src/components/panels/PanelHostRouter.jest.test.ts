/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { Router } from 'vue-router'
let SettingsPanel: typeof import('./SettingsPanel.vue').default
let WalletPanel: typeof import('./WalletPanel.vue').default
beforeAll(async () => {
  SettingsPanel = (await import('./SettingsPanel.vue')).default
  WalletPanel = (await import('./WalletPanel.vue')).default
})

jest.mock('nostics', () => ({
  createConsoleReporter: () => jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock('@vue/devtools-api', () => ({ setupDevtoolsPlugin: jest.fn() }))
const nestedDevtoolsApiPath = require
  .resolve('@vue/devtools-api', { paths: [require.resolve('vue-router')] })
  .replace('index-node.cjs', 'index.cjs')
jest.doMock(nestedDevtoolsApiPath, () => ({ setupDevtoolsPlugin: jest.fn() }))
jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => {
    throw new Error('No wallet needed for host navigation')
  }),
}))
jest.mock('./ContactCard.vue', () => ({ template: '<div />' }))
jest.mock('../../composables/useChainBalance', () => ({
  useMultichainBalance: () => ({
    getPresentation: () => ({ status: 'loading' }),
  }),
}))
let mockWidth = 1024
jest.mock('quasar', () => ({
  useQuasar: () => ({ screen: { width: mockWidth } }),
}))

async function realRouter(path = '/forum') {
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(path)
  await router.isReady()
  return router
}
function panel(
  kind: 'settings' | 'wallet',
  injected?: Router,
  fallback?: Router,
) {
  return mount(kind === 'settings' ? SettingsPanel : WalletPanel, {
    global: {
      plugins: injected ? [createPinia(), injected] : [createPinia()],
      mocks: {
        $t: (key: string) => key,
        ...(fallback ? { $router: fallback } : {}),
      },
      stubs: {
        ContactCard: true,
        MailboxStatusIndicator: true,
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: { template: '<span><slot /></span>' },
        QItemLabel: { template: '<span><slot /></span>' },
        QSeparator: true,
        QIcon: true,
        QBadge: true,
      },
      directives: { ripple: {} },
    },
  })
}

beforeEach(() => {
  mockWidth = 1024
  localStorage.clear()
})

test.each(['settings', 'wallet'] as const)(
  '%s prefers the injected full router over a different fallback',
  async kind => {
    const injected = await realRouter(),
      fallback = await realRouter('/profile')
    const push = jest.spyOn(injected, 'push'),
      fallbackPush = jest.spyOn(fallback, 'push'),
      fallbackReplace = jest.spyOn(fallback, 'replace')
    const view = panel(kind, injected, fallback)
    try {
      await view.get('[data-test="backup-codex32-button"]').trigger('click')
      await flushPromises()
      expect(push).toHaveBeenCalledWith('/backup')
      expect(injected.currentRoute.value.path).toBe('/backup')
      expect(fallback.currentRoute.value.path).toBe('/profile')
      expect(fallbackPush).not.toHaveBeenCalled()
      expect(fallbackReplace).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  },
)

test.each(['settings', 'wallet'] as const)(
  '%s uses a full global fallback when injection is absent',
  async kind => {
    const fallback = await realRouter()
    const push = jest.spyOn(fallback, 'push')
    const view = panel(kind, undefined, fallback)
    try {
      await view.get('[data-test="backup-codex32-button"]').trigger('click')
      await flushPromises()
      expect(push).toHaveBeenCalledWith('/backup')
      expect(fallback.currentRoute.value.path).toBe('/backup')
    } finally {
      view.unmount()
    }
  },
)

test.each(['settings', 'wallet'] as const)(
  '%s remains safe without either router',
  async kind => {
    const view = panel(kind)
    try {
      await view.get('[data-test="backup-codex32-button"]').trigger('click')
      await flushPromises()
      expect(view.emitted('closeDrawer')).toBeUndefined()
    } finally {
      view.unmount()
    }
  },
)

test.each([
  { path: '/forum', width: 390, closes: true, method: 'push' },
  { path: '/forum', width: 1024, closes: false, method: 'push' },
  { path: '/settings', width: 390, closes: false, method: 'replace' },
])(
  'settings preserves drawer and $method navigation from $path at $width',
  async ({ path, width, closes, method }) => {
    mockWidth = width
    const router = await realRouter(path)
    const push = jest.spyOn(router, 'push'),
      replace = jest.spyOn(router, 'replace')
    const view = panel('settings', router)
    try {
      const button = view
        .findAll('button')
        .find(item => item.text() === 'SettingPanel.settings')
      if (!button) throw new Error('Settings navigation button missing')
      await button.trigger('click')
      await flushPromises()
      expect(method === 'push' ? push : replace).toHaveBeenCalledWith(
        '/settings',
      )
      expect(view.emitted('closeDrawer')?.length ?? 0).toBe(closes ? 1 : 0)
      expect(router.currentRoute.value.path).toBe('/settings')
    } finally {
      view.unmount()
    }
  },
)

test('wallet row selection preserves the configured wallet route', async () => {
  const router = await realRouter()
  const view = panel('wallet', router)
  try {
    await view.get('[data-test="bitcoin-wallet-row"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/wallet/bitcoin')
  } finally {
    view.unmount()
  }
})
