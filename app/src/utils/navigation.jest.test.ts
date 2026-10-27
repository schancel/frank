/** @jest-environment jsdom */
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import type { Router } from 'vue-router'

import {
  goBack,
  handleHardwareBack,
  resetNavigationForTests,
  returnTo,
  switchTab,
  useBackDismiss,
} from './navigation'
import {
  afterNavigation,
  historyPosition,
  openApp,
  userBack,
  userForward,
} from '../../test/jest/navigation-harness'

// vue-router 5 loads `nostics` and `@vue/devtools-api` (both ESM-only for Jest) just for dev
// warnings and the devtools hook; the tests need the real router's history handling, not those.
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
  '/',
  '/chat',
  '/chat/:id',
  '/forum',
  '/wallet',
  '/send',
  '/settings',
  '/qr',
  '/contacts',
  '/add-contact',
]

let router: Router
let narrow = true
let destroy: () => void = () => undefined

async function start(path: string) {
  ;({ router, destroy } = await openApp(PATHS, path, {
    backClosesOverlays: () => narrow,
  }))
}

beforeEach(() => {
  narrow = true
})
afterEach(() => {
  destroy()
  resetNavigationForTests()
})

describe('goBack: a back arrow is Back', () => {
  it('goes back to the page it was opened from', async () => {
    await start('/wallet')
    const base = historyPosition()
    await router.push('/send')
    goBack(router, '/wallet')
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(base)
    // Forward still reaches the page that was left, like the browser's own Back.
    await userForward(router)
    expect(router.currentRoute.value.path).toBe('/send')
  })

  it('opened directly, replaces itself with its parent instead of pushing it', async () => {
    await start('/send')
    const base = historyPosition()
    goBack(router, '/wallet')
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(base)
  })
})

describe('returnTo: a finished form leaves no entry Back would reopen', () => {
  it('goes back when the target is the page before the form', async () => {
    await start('/contacts')
    const base = historyPosition()
    await router.push('/add-contact')
    returnTo(router, '/contacts')
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/contacts')
    expect(historyPosition()).toBe(base)
  })

  it('replaces the form when the target is elsewhere', async () => {
    await start('/contacts')
    await router.push('/add-contact')
    const formPosition = historyPosition()
    returnTo(router, '/chat')
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(formPosition)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/contacts')
  })
})

describe('switchTab: tabs do not stack (Android/Material)', () => {
  it('Back from any tab lands on Messages, however many tabs were visited', async () => {
    await start('/chat')
    const base = historyPosition()
    await switchTab(router, '/wallet')
    expect(historyPosition()).toBe(base + 1)
    await switchTab(router, '/settings')
    await switchTab(router, '/forum')
    await switchTab(router, '/qr')
    expect(router.currentRoute.value.path).toBe('/qr')
    expect(historyPosition()).toBe(base + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(base)
  })

  it('a tab tapped deep inside another tab replaces that tab, not the page on top', async () => {
    await start('/chat')
    const base = historyPosition()
    await switchTab(router, '/wallet')
    await router.push('/send')
    expect(historyPosition()).toBe(base + 2)
    await switchTab(router, '/settings')
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(historyPosition()).toBe(base + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
  })

  it('the Messages tab goes back to the Messages entry instead of stacking another', async () => {
    await start('/chat')
    const base = historyPosition()
    await switchTab(router, '/wallet')
    await router.push('/send')
    await switchTab(router, '/chat')
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(base)
  })

  it('opened on another screen, Messages takes that entry and the tab opens above it', async () => {
    await start('/forum')
    const base = historyPosition()
    await switchTab(router, '/wallet')
    expect(router.currentRoute.value.path).toBe('/wallet')
    expect(historyPosition()).toBe(base + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(historyPosition()).toBe(base)
  })

  it('remembers the Messages entry across Back and Forward', async () => {
    await start('/chat')
    const base = historyPosition()
    await switchTab(router, '/wallet')
    await router.push('/send')
    await userBack(router)
    await userForward(router)
    expect(router.currentRoute.value.path).toBe('/send')
    await switchTab(router, '/forum')
    expect(historyPosition()).toBe(base + 1)
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
  })
})

describe('useBackDismiss: Back closes an overlay on a phone', () => {
  function mountOverlay() {
    const open = ref(false)
    const Overlay = defineComponent({
      setup() {
        useBackDismiss(
          () => open.value,
          () => {
            open.value = false
          },
        )
        return () => h('div')
      },
    })
    const app = createApp(Overlay)
    app.use(router)
    app.mount(document.createElement('div'))
    return { open, app }
  }

  it('Back closes the open overlay and stays on the page, in the same history entry', async () => {
    await start('/chat')
    await router.push('/chat/a')
    const position = historyPosition()
    const { open, app } = mountOverlay()
    open.value = true
    await nextTick()
    await userBack(router)
    expect(open.value).toBe(false)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    expect(historyPosition()).toBe(position)
    // With nothing open, Back navigates again.
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    app.unmount()
  })

  it('a wide screen keeps Back for navigation', async () => {
    narrow = false
    await start('/chat')
    await router.push('/chat/a')
    const { open, app } = mountOverlay()
    open.value = true
    await nextTick()
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    app.unmount()
  })

  it("the app's own Back (an arrow) is not taken for the user's", async () => {
    await start('/chat')
    await router.push('/chat/a')
    const { open, app } = mountOverlay()
    open.value = true
    await nextTick()
    goBack(router, '/chat')
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    app.unmount()
  })
})

describe('handleHardwareBack: Android Back in the native app', () => {
  it('goes back, and on Messages leaves the app', async () => {
    await start('/chat')
    await router.push('/chat/a')
    const exitApp = jest.fn()
    handleHardwareBack(router, exitApp)
    await afterNavigation(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    expect(exitApp).not.toHaveBeenCalled()
    handleHardwareBack(router, exitApp)
    expect(exitApp).toHaveBeenCalledTimes(1)
  })

  it('closes an open overlay first', async () => {
    await start('/chat')
    await router.push('/chat/a')
    const open = ref(true)
    const app = createApp(
      defineComponent({
        setup() {
          useBackDismiss(
            () => open.value,
            () => {
              open.value = false
            },
          )
          return () => h('div')
        },
      }),
    )
    app.mount(document.createElement('div'))
    const exitApp = jest.fn()
    handleHardwareBack(router, exitApp)
    expect(open.value).toBe(false)
    expect(router.currentRoute.value.path).toBe('/chat/a')
    app.unmount()
  })

  it('on the first screen of the session leaves the app', async () => {
    await start('/wallet')
    const exitApp = jest.fn()
    handleHardwareBack(router, exitApp)
    expect(exitApp).toHaveBeenCalledTimes(1)
  })
})
