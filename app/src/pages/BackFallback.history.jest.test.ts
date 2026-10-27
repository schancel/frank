/** @jest-environment jsdom */
/**
 * Finding 4: a page's back or Cancel, on a page opened directly (a link, a reload: no in-app
 * page before it), gives way to the page's own parent and replaces itself. It used to push '/'
 * (which lands on the forum), so a cancelled Receive or New Topic opened the forum and Back
 * reopened the page. With an in-app page before it, it is Back. Real hash-mode router.
 */
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Router } from 'vue-router'

import AddTopic from './AddTopic.vue'
import Receive from './Receive.vue'
import { resetNavigationForTests } from '../utils/navigation'
import {
  flushHistory,
  historyPosition,
  openApp,
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
jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
}))
jest.mock('qrcode.vue', () => ({ template: '<div />' }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 100n,
    toDisplayAmount: (amount: bigint) => amount.toString(),
    addressToString: ({ raw }: { raw: string }) => raw,
    nativeTransfers: { getBalance: jest.fn(async () => 0n) },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(
    () => new Promise(() => undefined) /* never opens: not needed here */,
  ),
}))

const ROUTES = [
  { path: '/', redirect: '/forum' },
  '/forum',
  '/wallet',
  '/receive',
  '/add-topic',
  '/topic/:topic',
]

let router: Router
let destroy: () => void = () => undefined

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  destroy()
  resetNavigationForTests()
})

const pages = [
  {
    name: 'Receive',
    component: Receive,
    path: '/receive',
    parent: '/wallet',
    leave: (vm: any) => vm.close(),
  },
  {
    name: 'New topic Cancel',
    component: AddTopic,
    path: '/add-topic',
    parent: '/forum',
    leave: (vm: any) => vm.cancel(),
  },
]

describe.each(pages)('$name', ({ component, path, parent, leave }) => {
  function mountPage() {
    return shallowMount(component as any, {
      global: { plugins: [router], mocks: { $t: (key: string) => key } },
    })
  }

  it('opened directly, replaces itself with its parent', async () => {
    ;({ router, destroy } = await openApp(ROUTES, path))
    const pagePosition = historyPosition()
    const wrapper = mountPage()
    leave(wrapper.vm)
    await flushHistory()
    expect(router.currentRoute.value.path).toBe(parent)
    expect(historyPosition()).toBe(pagePosition)
    wrapper.unmount()
  })

  it('opened from another page, goes back to it', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const before = historyPosition()
    await router.push(path)
    const wrapper = mountPage()
    leave(wrapper.vm)
    await flushHistory()
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(before)
    wrapper.unmount()
  })
})
