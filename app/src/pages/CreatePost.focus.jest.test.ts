/** @jest-environment jsdom */

// TQ-FOCUS-PRODUCTION-BOUNDARY: the stale-arrival focus handoff (`parentMessage` watcher ->
// `handoffResolvedParentFocus`) was previously only exercised against a permissive copied
// `getMessage` getter fed topic-only objects -- data production `forum.getMessage` rejects. These
// regressions drive the exact A1 -> B -> settled A2 -> valid stale A1 ordering through the real
// Pinia forum store (valid `ForumMessage` records only) inside a real routed Quasar page, and
// assert both focus outcomes: the idle Retry hands focus to compose, and a connected non-body
// competitor (an SVG control) keeps focus through the handoff.

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, h, watch } from 'vue'
import type { Pinia } from 'pinia'
import type { VueWrapper } from '@vue/test-utils'

import CreatePost from './CreatePost.vue'
import { useForumStore } from 'src/stores/forum'
import type { ForumMessage } from '@frank/cashweb/types/forum'

const mockFetchOne = jest.fn()

// vue-router's CommonJS build imports this ESM-only diagnostics package. The router behavior is
// the boundary under test here, not its development reporter.
jest.mock('nostics', () => ({
  createConsoleReporter: () => jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock('@vue/devtools-api', () => ({ setupDevtoolsPlugin: jest.fn() }))
const nestedDevtoolsApiPath = require
  .resolve('@vue/devtools-api', { paths: [require.resolve('vue-router')] })
  .replace('index-node.cjs', 'index.cjs')
jest.doMock(nestedDevtoolsApiPath, () => ({
  setupDevtoolsPlugin: jest.fn(),
}))

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 1_000_000_000_000n,
    toDisplayAmount: (amount: bigint) => String(amount),
    fromDisplayAmount: (amount: string) => BigInt(amount),
    topics: {
      post: jest.fn(),
      fetchOne: (...args: unknown[]) => mockFetchOne(...args),
      fetchByTopic: jest.fn(),
      discoverTopics: jest.fn(async () => []),
      vote: jest.fn(),
    },
  },
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { address: { raw: '0xaaa' }, displayAddress: '0xaaa' },
  })),
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: () =>
    jest.requireActual('vue').reactive({ seedPhrase: 'production-focus-test' }),
}))
jest.mock('src/utils/chain-amount', () => ({
  displayToSafeRawAmount: jest.fn(() => 1_000_000),
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('../components/forum/ForumMessage.vue', () => ({
  template: '<div />',
}))
jest.mock('../utils/markdown', () => ({ renderMarkdown: () => '' }))

let createMemoryHistory: typeof import('vue-router').createMemoryHistory
let createRouter: typeof import('vue-router').createRouter
let RouterView: typeof import('vue-router').RouterView

beforeAll(async () => {
  const vueRouter = await import('vue-router')
  createMemoryHistory = vueRouter.createMemoryHistory
  createRouter = vueRouter.createRouter
  RouterView = vueRouter.RouterView
})

// Same UMD loading as CreatePost.jest.test.ts: Jest aliases `quasar` to its SSR build, whose
// form controls do not render; the routed focus regressions need the real components.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadQuasar(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globals = globalThis as any
  globals.Vue = jest.requireActual('vue')
  globals.ResizeObserver ??= class {
    observe = jest.fn()
    unobserve = jest.fn()
    disconnect = jest.fn()
  }
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  return globals.Quasar
}

const $t = (key: string) => key

/** A full production-shaped record: the store's `getMessage` getter rejects partial objects. */
const validMessage = (payloadDigest: string, topic = 'news'): ForumMessage => ({
  poster: '0xposter',
  topic,
  satoshis: 1,
  entries: [{ kind: 'post', message: payloadDigest }],
  payloadDigest,
  timestamp: new Date(),
})

const mounted: VueWrapper[] = []

async function mountRoutedReply(parentDigest: string) {
  // The production `fetchMessage` turns `fetchOne` results into `setMessage` cache writes; the
  // chain seam is the only thing mocked, so pending A1/B/A2 requests are controlled at that
  // boundary exactly as the relay would deliver them. Registered before the mount so the initial
  // A1 request is captured too.
  const pending: Array<{
    digest: string
    resolve(message?: ForumMessage): void
    reject(error: Error): void
  }> = []
  mockFetchOne.mockImplementation((payloadDigest: string) => {
    return new Promise<ForumMessage | undefined>((resolve, reject) => {
      pending.push({
        digest: payloadDigest,
        resolve: message => resolve(message),
        reject,
      })
    })
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/new-post', component: CreatePost },
      { path: '/new-post/:parentDigest', component: CreatePost },
    ],
  })
  await router.push(`/new-post/${parentDigest}`)
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: host,
    global: {
      plugins: [router, pinia, loadQuasar()],
      mocks: { $t },
    },
  })
  mounted.push(wrapper)
  await flushPromises()

  return {
    router,
    pinia,
    page: () => wrapper.findComponent(CreatePost),
    pending,
    forum: () => useForumStore(pinia),
  }
}

afterEach(() => {
  while (mounted.length) {
    mounted.pop()?.unmount()
  }
  document.body.innerHTML = ''
})

describe('CreatePost stale-arrival focus at the production boundary', () => {
  it('hands idle Retry focus to compose when a valid stale A1 lands in the production store', async () => {
    const { router, page, pending, forum } = await mountRoutedReply('parentA')

    // A1 issued on parentA; B on parentB; A2 re-issued back on parentA.
    await router.push('/new-post/parentB')
    await flushPromises()
    await router.push('/new-post/parentA')
    await flushPromises()
    expect(pending.map(request => request.digest)).toEqual([
      'parentA',
      'parentB',
      'parentA',
    ])

    // A2 settles with no parent available: the idle Retry button remains.
    pending[2]?.resolve(undefined)
    await flushPromises()
    expect(page().vm).toMatchObject({
      parentDigest: 'parentA',
      parentLoading: false,
    })
    const idleRetry = page().get('[data-test="retry-parent"]').element
    idleRetry.focus()
    expect(document.activeElement).toBe(idleRetry)

    // The stale A1 completion writes a valid record into the shared store.
    pending[0]?.resolve(validMessage('parentA'))
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
    expect(page().find('[data-test="retry-parent"]').exists()).toBe(false)
    expect(page().vm).toMatchObject({
      parentDigest: 'parentA',
      parentLoading: false,
      topic: 'news',
    })
    expect(
      page().get('[data-test="compose-focus-target"]').element.isConnected,
    ).toBe(true)
    expect(document.activeElement).toBe(
      page().get('[data-test="compose-focus-target"]').element,
    )
    expect(forum().getMessage('parentA')?.topic).toBe('news')
  })

  it('preserves a connected SVG competitor through the stale A1 focus handoff', async () => {
    const { router, page, pending, pinia } = await mountRoutedReply('parentA')

    await router.push('/new-post/parentB')
    await flushPromises()
    await router.push('/new-post/parentA')
    await flushPromises()
    expect(pending.map(request => request.digest)).toEqual([
      'parentA',
      'parentB',
      'parentA',
    ])

    // A2 settles with a failure this time: still a settled, idle Retry.
    pending[2]?.reject(new Error('current A retry failed'))
    await flushPromises()
    const idleRetry = page().get('[data-test="retry-parent"]').element
    idleRetry.focus()
    expect(document.activeElement).toBe(idleRetry)

    // While the stale A1 completion renders the resolved parent, a connected
    // non-body element takes focus before the handoff's next-turn check runs.
    // The handoff must leave that competitor alone instead of steering focus.
    const stopCompetitorWatch = watch(
      () => useForumStore(pinia).getMessage('parentA'),
      () => {
        const svgControl = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'svg',
        )
        svgControl.setAttribute('tabindex', '0')
        document.body.appendChild(svgControl)
        svgControl.focus()
      },
      { flush: 'post' },
    )

    pending[0]?.resolve(validMessage('parentA'))
    await flushPromises()
    stopCompetitorWatch()

    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
    expect(page().find('[data-test="retry-parent"]').exists()).toBe(false)
    expect(page().vm).toMatchObject({
      parentDigest: 'parentA',
      parentLoading: false,
      topic: 'news',
    })
    // The connected competitor survived the handoff with focus intact.
    expect(document.activeElement).toBeInstanceOf(SVGElement)
    expect(document.activeElement?.isConnected).toBe(true)
    expect(document.activeElement).not.toBe(
      page().get('[data-test="compose-focus-target"]').element,
    )
  })
})
