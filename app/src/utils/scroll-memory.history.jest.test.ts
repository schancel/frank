/** @jest-environment jsdom */
/**
 * Finding 11: Back and Forward return to where the user had scrolled, in the element that
 * scrolls (Frank's pages scroll in their own elements, not the window); a new page starts at
 * the top; a conversation's own scroll is left alone. Real hash-mode router on jsdom's session
 * history; jsdom has no layout, so an element's scroll range is given by `data-max`.
 */
import { createApp, defineComponent, h, ref, type App } from 'vue'
import { RouterView, type Router } from 'vue-router'

import { formStart, resetNavigationForTests, settleForm } from './navigation'
import {
  installScrollMemory,
  resetScrollMemoryForTests,
  SCROLL_STORAGE_KEY,
} from './scroll-memory'
import {
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

// An element scrolls within 0..data-max (unlimited without it), as a browser clamps it.
const offsets = new WeakMap<Element, number>()
const descriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollTop',
)
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      const max = Number(this.dataset?.max ?? Infinity)
      offsets.set(this, Math.max(0, Math.min(value, max)))
    },
  })
})
afterAll(() => {
  if (descriptor)
    Object.defineProperty(Element.prototype, 'scrollTop', descriptor)
})

/** How far each page's list can scroll (its content so far); unlimited when unset. */
const contentHeight = ref<Record<string, number>>({})
/** A banner shown above the named list (it moves the list among its siblings). */
const banner = ref(false)

const page = (name: string) =>
  defineComponent({
    render: () =>
      h('div', { class: `page ${name}` }, [
        h('div', {
          'class': 'scroller',
          'data-page': name,
          'data-max': contentHeight.value[name],
        }),
        // A conversation's own scroll (Chat.vue).
        h('div', { 'data-scroll-restore': 'off' }, [
          h('div', { 'class': 'own', 'data-page': name }),
        ]),
      ]),
  })

/** A layout whose scroll area outlives its pages, as ForumLayout's does. */
const Layout = defineComponent({
  render: () => h('div', { class: 'layout' }, [h(RouterView)]),
})

/** A page whose list is named (`data-scroll-key`) and may have a banner above it. */
const NamedPage = defineComponent({
  render: () =>
    h('div', { class: 'page named' }, [
      banner.value ? h('div', { class: 'banner' }) : null,
      h('div', {
        'class': 'scroller',
        'data-page': 'named',
        'data-scroll-key': 'named-list',
      }),
    ]),
})

const ROUTES = [
  { path: '/list', component: page('list') },
  { path: '/named', component: NamedPage },
  { path: '/detail', component: page('detail') },
  { path: '/other', component: page('other') },
]

let router: Router
let destroy: () => void = () => undefined
let app: App | undefined
const options = {
  backClosesOverlays: () => false,
  install: installScrollMemory,
}

function mountApp() {
  document.body.innerHTML = '<div id="q-app"></div>'
  app = createApp(Layout)
  app.use(router)
  app.mount('#q-app')
}

function scroller(): HTMLElement {
  return document.querySelector('.scroller') as HTMLElement
}
function layout(): HTMLElement {
  return document.querySelector('.layout') as HTMLElement
}

/** The user scrolls `element` to `top`. */
function scrollTo(element: Element, top: number) {
  element.scrollTop = top
  element.dispatchEvent(new Event('scroll'))
}

/** Lets animation frames (jsdom: every ~16ms) and the router settle. */
async function frames(ms = 80) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function start(path = '/list') {
  ;({ router, destroy } = await openApp(ROUTES, path, options))
  mountApp()
  await frames()
}

beforeEach(() => {
  sessionStorage.clear()
  contentHeight.value = {}
  banner.value = false
})
afterEach(() => {
  app?.unmount()
  app = undefined
  destroy()
  resetNavigationForTests()
  resetScrollMemoryForTests()
})

describe('scroll positions per history entry', () => {
  it('Back and Forward return to each page where it was scrolled; a new page starts at the top', async () => {
    await start()
    scrollTo(scroller(), 300)
    scrollTo(layout(), 120)
    await frames()

    await router.push('/detail')
    await frames()
    expect(scroller().dataset.page).toBe('detail')
    expect(scroller().scrollTop).toBe(0)
    // The layout's own scroll area outlived the navigation: the new page is at its top.
    expect(layout().scrollTop).toBe(0)
    scrollTo(scroller(), 50)
    await frames()

    await userBack(router)
    await frames()
    expect(scroller().dataset.page).toBe('list')
    expect(scroller().scrollTop).toBe(300)
    expect(layout().scrollTop).toBe(120)

    await userForward(router)
    await frames()
    expect(scroller().dataset.page).toBe('detail')
    expect(scroller().scrollTop).toBe(50)
    expect(layout().scrollTop).toBe(0)
  })

  it('a page opened again after Back is a new page: it starts at the top', async () => {
    await start()
    await router.push('/detail')
    await frames()
    scrollTo(scroller(), 50)
    await frames()
    await userBack(router)
    await frames()
    await router.push('/detail')
    await frames()
    expect(scroller().scrollTop).toBe(0)
  })

  it('waits for the page to be long enough again, then scrolls it', async () => {
    await start()
    scrollTo(scroller(), 300)
    await frames()
    await router.push('/detail')
    await frames()
    // The list's content is still loading when Back shows it: only 100px of it.
    contentHeight.value = { list: 100 }
    await userBack(router)
    await frames(40)
    expect(scroller().scrollTop).toBe(100)
    contentHeight.value = { list: 1000 }
    await frames()
    expect(scroller().scrollTop).toBe(300)
  })

  it("the user's own scrolling wins over a restore still waiting", async () => {
    await start()
    scrollTo(scroller(), 300)
    await frames()
    await router.push('/detail')
    await frames()
    contentHeight.value = { list: 100 }
    await userBack(router)
    await frames(40)
    window.dispatchEvent(new Event('wheel'))
    scrollTo(scroller(), 20)
    contentHeight.value = { list: 1000 }
    await frames()
    expect(scroller().scrollTop).toBe(20)
  })

  it("leaves a conversation's own scroll alone", async () => {
    await start()
    const own = () => document.querySelector('.own') as HTMLElement
    scrollTo(own(), 500)
    await frames()
    await router.push('/detail')
    await frames()
    await userBack(router)
    await frames()
    expect(own().scrollTop).toBe(0)
  })

  it('a change in place (a tab, a search) keeps the scroll', async () => {
    await start()
    scrollTo(layout(), 120)
    await frames()
    await router.replace('/list?tab=history')
    await frames()
    expect(layout().scrollTop).toBe(120)
  })

  it('a reload returns to where the page was scrolled', async () => {
    await start()
    await router.push('/detail')
    await frames()
    scrollTo(scroller(), 75)
    await frames()
    const position = historyPosition()
    window.dispatchEvent(new Event('pagehide'))
    expect(sessionStorage.getItem(SCROLL_STORAGE_KEY)).toContain('/detail')
    app?.unmount()
    destroy()
    resetNavigationForTests()
    resetScrollMemoryForTests()
    ;({ router, destroy } = await reloadApp(ROUTES, options))
    mountApp()
    await frames()
    expect(historyPosition()).toBe(position)
    expect(scroller().dataset.page).toBe('detail')
    expect(scroller().scrollTop).toBe(75)
  })

  it('a named list is found again though the page around it changed', async () => {
    await start('/named')
    scrollTo(scroller(), 240)
    await frames()
    await router.push('/detail')
    await frames()
    // Back: a banner now shows above the list.
    banner.value = true
    await userBack(router)
    await frames()
    expect(scroller().dataset.page).toBe('named')
    expect(scroller().scrollTop).toBe(240)
  })

  it("a finished form's entries folded into one: what was kept for the entries gone is dropped", async () => {
    await start()
    scrollTo(scroller(), 300)
    await frames()
    await router.push('/detail')
    await frames()
    const form = formStart()
    scrollTo(scroller(), 50)
    await frames()
    await router.push('/other')
    await frames()
    scrollTo(scroller(), 70)
    await frames()
    // The outcome (/other) takes the form's place above the list; the entry after it is gone.
    await settleForm(router, form)
    await frames()
    window.dispatchEvent(new Event('pagehide'))
    const kept = JSON.parse(
      sessionStorage.getItem(SCROLL_STORAGE_KEY) ?? '[]',
    ) as [number, { path: string }][]
    const here = historyPosition()
    expect(kept.filter(([position]) => position > here)).toEqual([])
    expect(
      kept.filter(
        ([position, entry]) => position === here && entry.path !== '/other',
      ),
    ).toEqual([])

    await userBack(router)
    await frames()
    expect(scroller().dataset.page).toBe('list')
    expect(scroller().scrollTop).toBe(300)
  })
})
