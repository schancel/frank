/** @jest-environment jsdom */
/**
 * Finding 15: an address no route matches is "Page not found" inside the app's usual chrome
 * (MainLayout), signed in or not, with a way home that replaces the dead entry. It used to match
 * nothing: an endless spinner with no chrome. The app's real routes and guards, on a real
 * hash-mode router over jsdom's session history.
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Router } from 'vue-router'

jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => false,
}))
const mockStatus = { status: 'ready' }
jest.mock('../accounts/session', () => ({
  accountStatus: mockStatus,
  accountSession: { initialize: jest.fn(async () => undefined) },
}))

/* eslint-disable @typescript-eslint/no-var-requires */
const createAppRouter = require('./index').default
const { setStartupRestoration } = require('../boot/startup-state')
/* eslint-enable @typescript-eslint/no-var-requires */

let router: Router

beforeEach(() => {
  setActivePinia(createPinia())
  setStartupRestoration({ phase: 'restored' })
})
afterEach(() => router.options.history.destroy())

async function open(path: string) {
  window.history.pushState(null, '', '#/before-the-app')
  window.history.pushState(null, '', `#${path}`)
  router = createAppRouter()
  await router.push(path)
  await router.isReady()
  await flushPromises()
}

/** The components the current route renders, outermost first. */
async function rendered() {
  return Promise.all(
    router.currentRoute.value.matched.map(async record => {
      const component = record.components?.default as any
      const loaded =
        typeof component === 'function' ? await component() : component
      return (loaded?.default ?? loaded)?.name ?? loaded?.default?.__name
    }),
  )
}

it.each(['ready', 'fresh'])(
  'an unknown address shows Page not found inside the app shell (account %s)',
  async status => {
    mockStatus.status = status
    await open('/no-such-page/deeper')
    expect(router.currentRoute.value.fullPath).toBe('/no-such-page/deeper')
    const components = await rendered()
    expect(components).toHaveLength(2)
    expect(components[1]).toBe('NotFoundPage')
  },
)

it('the way home replaces the dead entry, so Back does not return to it', async () => {
  mockStatus.status = 'ready'
  await open('/no-such-page')
  const deadPosition = (window.history.state as { position: number }).position
  const NotFound = router.currentRoute.value.matched[1]?.components
    ?.default as any
  const page = mount(
    typeof NotFound === 'function' ? (await NotFound()).default : NotFound,
    {
      global: {
        plugins: [router],
        mocks: { $t: (key: string) => key },
        stubs: { QBtn: { template: '<button @click="$attrs.onClick()" />' } },
      },
    },
  )
  await page.get('[data-test="not-found-home"]').trigger('click')
  for (let i = 0; i < 5; i++) await flushPromises()
  expect(router.currentRoute.value.path).toBe('/forum')
  expect((window.history.state as { position: number }).position).toBe(
    deadPosition,
  )
  page.unmount()
})
