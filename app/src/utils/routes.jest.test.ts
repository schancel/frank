/** @jest-environment jsdom */
/**
 * `utils/routes.ts`: opening a chat or a contact's profile is a page the user asked for, so it
 * is pushed from wherever they are and Back returns there. (It used to replace the page when the
 * current path started with a "settings-family" prefix — /settings, /profile, /send (which also
 * matched /send-contact), /qr, ... — so Back skipped that page: Settings → Profile → Back left
 * Settings behind.)
 */
import type { Router } from 'vue-router'
import { openChat, openContactProfile } from './routes'
import { resetNavigationForTests } from './navigation'
import {
  afterNavigation,
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

const PATHS = [
  '/chat',
  '/chat/:address',
  '/settings',
  '/profile',
  '/send',
  '/send-contact',
  '/qr',
  '/forum',
]

let router: Router
let destroy: () => void = () => undefined

afterEach(() => {
  destroy()
  resetNavigationForTests()
})

describe.each(['/settings', '/profile', '/send-contact', '/qr', '/forum'])(
  'from %s',
  from => {
    beforeEach(async () => {
      ;({ router, destroy } = await openApp(PATHS, from))
    })

    it('openChat pushes the conversation and Back returns to the page it was opened from', async () => {
      const base = historyPosition()
      await openChat(router, '0xabc')
      expect(router.currentRoute.value.fullPath).toBe('/chat/0xabc')
      expect(historyPosition()).toBe(base + 1)
      await userBack(router)
      expect(router.currentRoute.value.path).toBe(from)
      expect(historyPosition()).toBe(base)
    })

    it('openContactProfile pushes the profile and Back returns to the page it was opened from', async () => {
      const base = historyPosition()
      await openContactProfile(router, '0xabc')
      expect(router.currentRoute.value.fullPath).toBe('/chat/0xabc?info=true')
      expect(historyPosition()).toBe(base + 1)
      await userBack(router)
      expect(router.currentRoute.value.path).toBe(from)
    })
  },
)

it('openChat with replace takes the current entry (a finished form, a redirect)', async () => {
  ;({ router, destroy } = await openApp(PATHS, '/forum'))
  await router.push('/send-contact')
  const formPosition = historyPosition()
  void openChat(router, '0xabc', { replace: true })
  await afterNavigation(router)
  expect(router.currentRoute.value.fullPath).toBe('/chat/0xabc')
  expect(historyPosition()).toBe(formPosition)
  await userBack(router)
  expect(router.currentRoute.value.path).toBe('/forum')
})
