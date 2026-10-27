/** @jest-environment jsdom */
/**
 * Finding 18: Android's Back button in the native app. It goes back, closes an open overlay
 * first, and on the start screen (Messages) leaves the app. Before, the boot file registered no
 * handler and Quasar's own one only left the app at #/, which always redirects. The boot file's
 * handler on a real hash-mode router over jsdom's session history.
 */
import type { Router } from 'vue-router'

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
jest.mock('@quasar/app-vite', () => ({ defineBoot: (fn: unknown) => fn }))
const mockListeners: Record<string, () => void> = {}
const mockExitApp = jest.fn()
jest.mock('@capacitor/core', () => ({
  Plugins: {
    Browser: { open: jest.fn() },
    App: {
      addListener: (event: string, listener: () => void) => {
        mockListeners[event] = listener
      },
      exitApp: () => mockExitApp(),
    },
  },
}))
jest.mock('src/composables/useBalance', () => ({ APP_STATE_EVENT: 'x' }))

let router: Router
let destroy: () => void = () => undefined

afterEach(() => {
  destroy()
  resetNavigationForTests()
  mockExitApp.mockClear()
})

async function boot(start: string) {
  ;({ router, destroy } = await openApp(
    ['/chat', '/chat/:id', '/wallet'],
    start,
  ))
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: bootCapacitor } = require('./capacitor')
  bootCapacitor({ app: { config: { globalProperties: {} } }, router })
  expect(typeof mockListeners.backButton).toBe('function')
}

it('goes back, and on Messages leaves the app', async () => {
  await boot('/chat')
  const messages = historyPosition()
  await router.push('/chat/a')
  mockListeners.backButton()
  await flushHistory()
  expect(router.currentRoute.value.path).toBe('/chat')
  expect(historyPosition()).toBe(messages)
  expect(mockExitApp).not.toHaveBeenCalled()
  mockListeners.backButton()
  await flushHistory()
  expect(mockExitApp).toHaveBeenCalledTimes(1)
})

it('on the first screen of the session leaves the app', async () => {
  await boot('/wallet')
  mockListeners.backButton()
  await flushHistory()
  expect(mockExitApp).toHaveBeenCalledTimes(1)
})
