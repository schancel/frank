/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, type App } from 'vue'
import { legacyLotusModeForFlag } from 'src/utils/legacy-mode'

let mockLegacyFlag: string | undefined
const mockDeleteMessage = jest.fn()

jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => legacyLotusModeForFlag(mockLegacyFlag),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ deleteMessage: mockDeleteMessage }),
}))
jest.mock('src/utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('nostics', () => ({
  createConsoleReporter: () => jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock('@vue/devtools-api', () => ({ setupDevtoolsPlugin: jest.fn() }))
const nestedDevtoolsApiPath = require
  .resolve('@vue/devtools-api', { paths: [require.resolve('vue-router')] })
  .replace('index-node.cjs', 'index.cjs')
jest.doMock(nestedDevtoolsApiPath, () => ({ setupDevtoolsPlugin: jest.fn() }))
jest.mock('layouts/MainLayout.vue', () =>
  defineComponent({ setup: () => () => h(RouterView) }),
)
jest.mock('pages/Settings.vue', () => ({
  template: '<h1>Settings</h1>',
}))

import WipeWallet from './WipeWallet.vue'
import { createRoutes } from 'src/router/routes'
import { errorNotify } from 'src/utils/notifications'
import enUS from 'src/i18n/en-us'

let createMemoryHistory: typeof import('vue-router').createMemoryHistory
let createRouter: typeof import('vue-router').createRouter
let RouterView: typeof import('vue-router').RouterView

beforeAll(async () => {
  const router = await import('vue-router')
  createMemoryHistory = router.createMemoryHistory
  createRouter = router.createRouter
  RouterView = router.RouterView
})

function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  return typeof value === 'string' ? value : key
}

function mountOptions(wipeWallet = jest.fn().mockResolvedValue(undefined)) {
  const loading = { show: jest.fn(), hide: jest.fn() }
  return {
    loading,
    wipeWallet,
    global: {
      mocks: {
        $t: t,
        $q: { loading },
        $relayClient: { wipeWallet },
      },
      stubs: {
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label'],
          template: '<button>{{ label }}</button>',
        },
      },
    },
  }
}

beforeEach(() => {
  mockLegacyFlag = undefined
  mockDeleteMessage.mockReset()
  jest.mocked(errorNotify).mockClear()
})

it('redirects a default Monad direct route before mounting legacy confirmation', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createRoutes(),
  })
  const options = mountOptions()
  const relayAccess = jest.fn(() => {
    throw new Error('Monad must not access the legacy relay client')
  })
  // Like Monad boot, there is no legacy client; a getter also catches attempted reads.
  await router.push('/wipe-wallet')
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: {
      ...options.global,
      mocks: { $t: t, $q: { loading: options.loading } },
      plugins: [
        router,
        {
          install(app: App) {
            Object.defineProperty(app.config.globalProperties, '$relayClient', {
              get: relayAccess,
            })
          },
        },
      ],
    },
  })
  await flushPromises()

  expect(router.currentRoute.value.path).toBe('/settings')
  expect(wrapper.get('h1').text()).toBe('Settings')
  expect(wrapper.text()).not.toContain(t('wipeWallet.warning'))
  expect(wrapper.findAll('button')).toHaveLength(0)
  expect(relayAccess).not.toHaveBeenCalled()
  expect(options.loading.show).not.toHaveBeenCalled()
  expect(mockDeleteMessage).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('does not expose confirmation or call the legacy client if mounted in Monad mode', async () => {
  const options = mountOptions()
  const wrapper = mount(WipeWallet, { global: options.global })
  expect(wrapper.findAll('button')).toHaveLength(0)
  await wrapper.vm.wipeWallet()
  expect(options.wipeWallet).not.toHaveBeenCalled()
  expect(options.loading.show).not.toHaveBeenCalled()
  wrapper.unmount()
})

it('preserves Lotus confirmation and waits for relay completion before clearing loading', async () => {
  mockLegacyFlag = 'false'
  let complete!: () => void
  const options = mountOptions(
    jest.fn(
      () =>
        new Promise<void>(resolve => {
          complete = resolve
        }),
    ),
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createRoutes(),
  })
  await router.push('/wipe-wallet')
  await router.isReady()
  const wrapper = mount(RouterView, {
    global: { ...options.global, plugins: [router] },
  })
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/wipe-wallet')
  expect(wrapper.text()).toContain(t('wipeWallet.warning'))
  expect(options.wipeWallet).not.toHaveBeenCalled()
  await wrapper
    .findAll('button')
    .find(button => button.text() === t('wipeWallet.wipe'))!
    .trigger('click')
  expect(options.loading.show).toHaveBeenCalledTimes(1)
  expect(options.wipeWallet).toHaveBeenCalledTimes(1)
  expect(options.loading.hide).not.toHaveBeenCalled()
  complete()
  await flushPromises()
  expect(options.loading.hide).toHaveBeenCalledTimes(1)
  expect(errorNotify).not.toHaveBeenCalled()
  wrapper.unmount()
})

it.each(['reject', 'throw'])(
  'clears loading once and reports a Lotus client %s',
  async failure => {
    mockLegacyFlag = 'false'
    const error = new Error('relay unavailable')
    const options = mountOptions(
      jest.fn(() => {
        if (failure === 'throw') throw error
        return Promise.reject(error)
      }),
    )
    const wrapper = mount(WipeWallet, { global: options.global })
    await wrapper.vm.wipeWallet()
    await flushPromises()
    expect(options.loading.show).toHaveBeenCalledTimes(1)
    expect(options.loading.hide).toHaveBeenCalledTimes(1)
    expect(errorNotify).toHaveBeenCalledWith(error)
    expect(mockDeleteMessage).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(t('wipeWallet.warning'))
    wrapper.unmount()
  },
)
