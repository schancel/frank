/** @jest-environment jsdom */

// Real routed Quasar/Pinia boundary: stale parent requests never publish; completed current
// requests preserve Retry focus handoff and connected competing focus.

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, h, watch } from 'vue'
import type { Pinia } from 'pinia'
import type { VueWrapper } from '@vue/test-utils'

import CreatePost from './CreatePost.vue'
import { useForumStore } from 'src/stores/forum'
import type { ForumMessage } from '@frank/wallet/forum-model'

const mockFetchOne = jest.fn()

// vue-router's CommonJS build imports this ESM-only diagnostics package. The router behavior is
// the boundary under test here, not its development reporter.
jest.mock('src/accounts/session', () => ({ accountStatus: jest.requireActual('vue').reactive({revision:1,status:'ready'}) }))
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
  displayToRawAmount: jest.fn(() => 1_000_000),
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
  voteWeightWei: '1',
  visibleTimestamp: { seconds: '1', nanoseconds: 0 }, epoch: '00'.repeat(16), revision: '1', transactionHash: '11'.repeat(32), authorBurnTx: '0x01', blockNumber: '1', transactionIndex: '0',
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

describe('CreatePost generation-scoped parent publication', () => {
  it('excludes stale A1 after A2 settles and preserves idle Retry focus', async () => {
    const { router, page, pending, forum } = await mountRoutedReply('parentA')
    await router.push('/new-post/parentB'); await flushPromises()
    await router.push('/new-post/parentA'); await flushPromises()
    // Only A1 may stage while in flight; obsolete queued B is skipped. Its result is
    // discarded under A2's route ownership before the current A2 request begins.
    pending[0]?.resolve(validMessage('parentA')); await flushPromises()
    expect(pending.map(request => request.digest)).toEqual(['parentA','parentA'])
    pending[1]?.resolve(undefined); await flushPromises()
    const retry = page().get('[data-test="retry-parent"]').element
    retry.focus()
    expect(forum().getMessage('parentA')).toBeNull()
    expect(forum().getMessage('parentB')).toBeNull()
    expect(page().vm).toMatchObject({parentDigest:'parentA',parentLoading:false})
    expect(document.activeElement).toBe(retry)
  })
  it('hands Retry focus to compose for a completed current request', async () => {
    const { page, pending, forum } = await mountRoutedReply('parentA')
    pending[0]?.resolve(undefined); await flushPromises()
    const retry = page().get('[data-test="retry-parent"]').element
    retry.focus()
    await page().get('[data-test="retry-parent"]').trigger('click')
    pending[1]?.resolve(validMessage('parentA')); await flushPromises()
    expect(forum().getMessage('parentA')?.topic).toBe('news')
    expect(page().find('[data-test="retry-parent"]').exists()).toBe(false)
    expect(document.activeElement).toBe(page().get('[data-test="compose-focus-target"]').element)
  })
  it('preserves a connected focus competitor on current parent completion', async () => {
    const { page, pending, pinia } = await mountRoutedReply('parentA')
    pending[0]?.resolve(undefined); await flushPromises()
    page().get('[data-test="retry-parent"]').element.focus()
    await page().get('[data-test="retry-parent"]').trigger('click')
    const stop = watch(() => useForumStore(pinia).getMessage('parentA'), () => {
      const competitor = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      competitor.setAttribute('tabindex','0'); document.body.appendChild(competitor); competitor.focus()
    }, {flush:'post'})
    pending[1]?.resolve(validMessage('parentA')); await flushPromises(); stop()
    expect(document.activeElement).toBeInstanceOf(SVGElement)
  })
})
