/** @jest-environment jsdom */
/**
 * Finding 17: switching the Wallet screen's network replaces the entry instead of stacking one
 * per network, so Back leaves the Wallet. Real hash-mode router over jsdom's session history.
 */
import { flushPromises, mount } from '@vue/test-utils'
import type { Router } from 'vue-router'

import WalletNetworkSwitcher from './WalletNetworkSwitcher.vue'
import { resetNavigationForTests } from '../../utils/navigation'
import {
  flushHistory,
  historyPosition,
  openApp,
  userBack,
} from '../../../test/jest/navigation-harness'

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

let router: Router
let destroy: () => void = () => undefined

afterEach(() => {
  destroy()
  resetNavigationForTests()
})

it('picking networks one after another keeps one Wallet entry; Back leaves the Wallet', async () => {
  ;({ router, destroy } = await openApp(['/chat', '/wallet/:wallet?'], '/chat'))
  const before = historyPosition()
  await router.push('/wallet')
  const wallet = historyPosition()
  const box = { template: '<div><slot /></div>' }
  const wrapper = mount(WalletNetworkSwitcher, {
    global: {
      plugins: [router],
      mocks: { $t: (key: string) => key },
      stubs: {
        QBtn: box,
        QMenu: box,
        QList: box,
        QItemSection: box,
        QItemLabel: box,
        QIcon: true,
        QBadge: true,
        QSeparator: true,
        QItem: {
          template:
            '<div class="network-item" @click="$attrs.onClick?.()"><slot /></div>',
        },
      },
    },
  })
  await flushPromises()
  const items = wrapper.findAll('.network-item')
  expect(items.length).toBeGreaterThan(1)
  for (const item of items.slice(0, Math.min(items.length, 3))) {
    await item.trigger('click')
    await flushHistory()
  }
  expect(router.currentRoute.value.path.startsWith('/wallet/')).toBe(true)
  expect(historyPosition()).toBe(wallet)
  await userBack(router)
  expect(router.currentRoute.value.path).toBe('/chat')
  expect(historyPosition()).toBe(before)
  wrapper.unmount()
})
