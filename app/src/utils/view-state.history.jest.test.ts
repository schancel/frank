/** @jest-environment jsdom */
/**
 * Finding 10: view state is in the address. A tab, a search or a filter changed in place is a
 * replace (no history entry), and Back, Forward, a reload and a link show it again. The forum's
 * topic is one screen with one address: `/topic/<name>` and picking a topic both show
 * `/forum?topic=<name>`. Real hash-mode router on jsdom's session history.
 */
import { createApp, defineComponent, h, nextTick } from 'vue'
import type { Router } from 'vue-router'

import { useQueryState } from '../composables/useQueryState'
import { createRoutes } from '../router/routes'
import { resetNavigationForTests } from './navigation'
import { showForumTopic } from './forum-topic'
import {
  afterNavigation,
  flushHistory,
  historyPosition,
  openApp,
  reloadApp,
  userBack,
  userForward,
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
  accountStatus: { status: 'ready' },
}))
jest.mock('../pages/AvuDetails.vue', () => ({ render: () => null }))

const ROUTES = ['/wallet', '/chat', '/chat/:id', '/forum', '/settings']

let router: Router
let destroy: () => void = () => undefined
const apps: { unmount(): void }[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  destroy()
  resetNavigationForTests()
})

/** A page's tab, kept in `?tab=` on /wallet. */
function mountTabs() {
  let tab!: { value: string }
  const Page = defineComponent({
    setup() {
      tab = useQueryState('tab', {
        fallback: 'balance',
        allowed: ['balance', 'history'] as const,
        owns: route => route.path === '/wallet',
      })
      return () => h('div')
    },
  })
  const app = createApp(Page)
  app.use(router)
  app.mount(document.createElement('div'))
  apps.push(app)
  return {
    get value() {
      return tab.value
    },
    set value(next: string) {
      tab.value = next
    },
  }
}

describe('a tab in the address', () => {
  it('is a replace: no history entry; Back, Forward and a reload show it again', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const tab = mountTabs()
    const wallet = historyPosition()
    tab.value = 'history'
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/wallet?tab=history')
    expect(historyPosition()).toBe(wallet)

    await router.push('/settings')
    await userBack(router)
    expect(router.currentRoute.value.fullPath).toBe('/wallet?tab=history')
    expect(tab.value).toBe('history')
    await userForward(router)
    expect(router.currentRoute.value.path).toBe('/settings')
    await userBack(router)

    // A reload: a new router and a new page on the same entry.
    for (const app of apps.splice(0)) app.unmount()
    destroy()
    resetNavigationForTests()
    ;({ router, destroy } = await reloadApp(ROUTES))
    expect(mountTabs().value).toBe('history')
    expect(historyPosition()).toBe(wallet)
  })

  it('a link opens on the tab; an unknown value is the default', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet?tab=history'))
    expect(mountTabs().value).toBe('history')
    await router.replace('/wallet?tab=nonsense')
    const tab = mountTabs()
    expect(tab.value).toBe('balance')
  })

  it('the default tab leaves the address bare', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet?tab=history'))
    const tab = mountTabs()
    tab.value = 'balance'
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/wallet')
  })
})

describe('a search in the address', () => {
  function mountSearch() {
    let query!: { value: string }
    const List = defineComponent({
      setup() {
        query = useQueryState<string>('q', {
          fallback: '',
          owns: route => route.path.startsWith('/chat'),
        })
        return () => h('div')
      },
    })
    const app = createApp(List)
    app.use(router)
    app.mount(document.createElement('div'))
    apps.push(app)
    return {
      get value() {
        return query.value
      },
      set value(next: string) {
        query.value = next
      },
    }
  }

  it('keeps every typed character, and two lists on screen agree', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/chat'))
    const page = mountSearch()
    const sidebar = mountSearch()
    const position = historyPosition()
    // Typed faster than the router commits.
    page.value = 'a'
    await nextTick()
    page.value = 'al'
    await nextTick()
    page.value = 'ali'
    await flushHistory()
    expect(page.value).toBe('ali')
    expect(sidebar.value).toBe('ali')
    expect(router.currentRoute.value.fullPath).toBe('/chat?q=ali')
    expect(historyPosition()).toBe(position)
  })

  it('a list rebuilt (a phone turned wide) keeps the search; Back from a conversation restores it', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/chat'))
    const page = mountSearch()
    page.value = 'bob'
    await flushHistory()
    await router.push('/chat/abc')
    await userBack(router)
    expect(router.currentRoute.value.fullPath).toBe('/chat?q=bob')
    // The phone's list gives way to the wide layout's (the router stays installed).
    const phone = apps.splice(0)
    const rebuilt = mountSearch()
    for (const app of phone) app.unmount()
    expect(rebuilt.value).toBe('bob')
  })

  it('off its own pages the state stays in the component and the address is left alone', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/wallet'))
    const list = mountSearch()
    list.value = 'x'
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/wallet')
    expect(list.value).toBe('x')
  })
})

describe('the forum topic is one screen with one address', () => {
  const topicRecord = () => {
    const children = createRoutes()[0]?.children ?? []
    const record = children.find(child => child.path === 'topic/:topic')
    if (!record) throw new Error('no topic route')
    return { ...record, path: '/topic/:topic' }
  }

  it('/topic/<name> shows the forum filtered to that topic', async () => {
    ;({ router, destroy } = await openApp(
      [...ROUTES, topicRecord()],
      '/wallet',
    ))
    await router.push('/topic/games')
    expect(router.currentRoute.value.fullPath).toBe('/forum?topic=games')
  })

  it('picking a topic on the forum is in place; from elsewhere it opens the forum; Back and Forward follow', async () => {
    ;({ router, destroy } = await openApp(ROUTES, '/chat'))
    const chat = historyPosition()
    await showForumTopic(router, 'games')
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/forum?topic=games')
    expect(historyPosition()).toBe(chat + 1)
    await showForumTopic(router, 'news')
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/forum?topic=news')
    expect(historyPosition()).toBe(chat + 1)
    await showForumTopic(router, '')
    await flushHistory()
    expect(router.currentRoute.value.fullPath).toBe('/forum')
    await showForumTopic(router, 'news')
    await flushHistory()
    await userBack(router)
    expect(router.currentRoute.value.path).toBe('/chat')
    const done = afterNavigation(router)
    window.history.forward()
    await done
    expect(router.currentRoute.value.fullPath).toBe('/forum?topic=news')
  })
})
