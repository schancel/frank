/** @jest-environment jsdom */
/**
 * Profile's tab is in the address (`?tab=identity`), written in place. A tab change that lands
 * while the user's Back is under way waits for it: it never undoes the Back. Real hash-mode
 * router on jsdom's session history.
 */
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Router } from 'vue-router'

import ProfileComponent from './Profile.vue'
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
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))

const defaultStubs = {
  'q-splitter': {
    template: '<div><slot name="before" /><slot name="after" /></div>',
  },
  'q-tabs': { template: '<div><slot /></div>' },
  'q-tab': {
    props: ['name'],
    template: '<div :data-tab="name"><slot /></div>',
  },
  'q-tab-panels': {
    props: ['modelValue'],
    template: '<div data-test="tab-panels"><slot /></div>',
  },
  'q-tab-panel': {
    props: ['name'],
    template: '<div :data-panel="name"><slot /></div>',
  },
  'q-input': {
    props: ['modelValue'],
    template:
      '<div><input :value="modelValue" /><slot name="append" /><slot name="prepend" /></div>',
  },
  'q-toolbar': { template: '<div><slot /></div>' },
  'q-toolbar-title': { template: '<div><slot /></div>' },
  'q-file': { template: '<input type="file" />' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-img': { template: '<img />' },
  'q-select': { template: '<div><slot /></div>' },
  'q-icon': { template: '<i />' },
  'q-card': { template: '<div><slot /></div>' },
  'q-skeleton': { template: '<div />' },
  'qrcode-vue': {
    props: ['value'],
    template: '<div data-test="mock-qrcode" :data-value="value" />',
  },
}

const ROUTES = ['/wallet', '/profile']

let router: Router
let destroy: () => void = () => undefined
let wrapper: VueWrapper | undefined

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  destroy()
  resetNavigationForTests()
})

async function openProfile() {
  ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
  const wallet = historyPosition()
  await router.push('/profile')
  wrapper = mount(ProfileComponent, {
    global: {
      plugins: [router],
      mocks: { $t: (key: string) => key },
      stubs: defaultStubs,
    },
  })
  await flushPromises()
  return wallet
}

const tab = () => wrapper!.vm as unknown as { tab: string }

describe("Profile's tab in the address", () => {
  it('is written in place: no history entry', async () => {
    await openProfile()
    const profile = historyPosition()
    tab().tab = 'identity'
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/profile?tab=identity')
    expect(historyPosition()).toBe(profile)
  })

  it("a tab change landing while the user's Back is under way does not undo the Back", async () => {
    const wallet = await openProfile()
    // The change lands after the browser has moved, before the router has followed.
    window.addEventListener('popstate', () => (tab().tab = 'identity'), {
      once: true,
    })
    await userBack(router)
    await flushHistory()
    await new Promise(resolve => setTimeout(resolve, 50))
    await flushPromises()
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/wallet')
    expect(historyPosition()).toBe(wallet)
  })
})
