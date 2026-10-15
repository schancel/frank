/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { ForumMessage } from '@frank/wallet/forum-model'
import ForumPost from './ForumPost.vue'
import { useForumStore } from 'src/stores/forum'

const mockFetchOne = jest.fn<Promise<ForumMessage | undefined>, [string]>()
const mockPost = jest.fn()
const mockVote = jest.fn()

jest.mock('src/accounts/session', () => ({
  accountStatus: { revision: 1, status: 'ready' },
}))
jest.mock('nostics', () => ({
  createConsoleReporter: () => jest.fn(),
  defineDiagnostics: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock('@vue/devtools-api', () => ({ setupDevtoolsPlugin: jest.fn() }))
const nestedDevtoolsApiPath = require
  .resolve('@vue/devtools-api', { paths: [require.resolve('vue-router')] })
  .replace('index-node.cjs', 'index.cjs')
jest.doMock(nestedDevtoolsApiPath, () => ({ setupDevtoolsPlugin: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    topics: {
      fetchOne: (digest: string) => mockFetchOne(digest),
      post: (...args: unknown[]) => mockPost(...args),
      vote: (...args: unknown[]) => mockVote(...args),
    },
  },
}))
jest.mock('../components/forum/ForumMessage.vue', () => ({
  props: ['message', 'showReplies'],
  emits: ['set-topic'],
  template:
    '<article data-test="visible-post">{{ message.payloadDigest }}<button @click="$emit(\'set-topic\', \'news\')">topic</button></article>',
}))

function record(payloadDigest: string): ForumMessage {
  return {
    poster: '0xposter',
    topic: 'news',
    voteWeightWei: '1',
    visibleTimestamp: { seconds: '1', nanoseconds: 0 },
    epoch: '00'.repeat(16),
    revision: '1',
    transactionHash: '11'.repeat(32),
    authorBurnTx: '0x01',
    blockNumber: '1',
    transactionIndex: '0',
    entries: [{ kind: 'post', message: payloadDigest }],
    payloadDigest,
    timestamp: new Date(1000),
  }
}
function deferred() {
  let resolve!: (message: ForumMessage | undefined) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ForumMessage | undefined>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function routedPage() {
  const { createRouter, createMemoryHistory, RouterView } = await import(
    'vue-router'
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/forum/:payloadDigest', component: ForumPost }],
  })
  await router.push('/forum/a')
  await router.isReady()
  const pinia = createPinia()
  const page = mount(defineComponent({ render: () => h(RouterView) }), {
    attrs: { 'data-forwarded': 'preserved' },
    global: { plugins: [router, pinia] },
  })
  await flushPromises()
  return { router, page, forum: useForumStore(pinia) }
}

beforeEach(() => {
  jest.clearAllMocks()
})

afterEach(() => {
  expect(mockPost).not.toHaveBeenCalled()
  expect(mockVote).not.toHaveBeenCalled()
})

test('missing initial post renders no child', async () => {
  mockFetchOne.mockResolvedValue(undefined)
  const { page } = await routedPage()
  try {
    expect(page.find('[data-test="visible-post"]').exists()).toBe(false)
  } finally {
    page.unmount()
  }
})

test('A to missing B never displays A under committed B', async () => {
  mockFetchOne.mockImplementation(async digest =>
    digest === 'a' ? record('a') : undefined,
  )
  const { router, page, forum } = await routedPage()
  try {
    expect(page.get('[data-test="visible-post"]').text()).toContain('a')
    await router.push('/forum/b')
    await flushPromises()
    expect(router.currentRoute.value.params.payloadDigest).toBe('b')
    expect(forum.getMessage('b')).toBeNull()
    expect(page.find('[data-test="visible-post"]').exists()).toBe(false)
  } finally {
    page.unmount()
  }
})

test('pending B preserves committed A, then passes the full B record and replies', async () => {
  const b = deferred()
  mockFetchOne.mockImplementation(digest =>
    digest === 'a' ? Promise.resolve(record('a')) : b.promise,
  )
  const { router, page, forum } = await routedPage()
  try {
    forum.setMessage({ ...record('reply'), parentDigest: 'b' })
    const navigation = router.push('/forum/b')
    await flushPromises()
    expect(router.currentRoute.value.params.payloadDigest).toBe('a')
    expect(page.findComponent({ name: 'AMessage' }).exists()).toBe(true)
    expect(page.get('[data-test="visible-post"]').text()).toContain('a')
    b.resolve(record('b'))
    await navigation
    await flushPromises()
    expect(router.currentRoute.value.params.payloadDigest).toBe('b')
    const child = page.findComponent({ name: 'AMessage' })
    expect(child.props('message')).toBe(forum.getMessage('b'))
    expect(child.props('message')).toMatchObject({
      ...record('b'),
      replies: [{ ...record('reply'), parentDigest: 'b', replies: [] }],
    })
    expect(child.props('showReplies')).toBe(true)
    expect(child.attributes('data-forwarded')).toBe('preserved')
    await child.get('button').trigger('click')
    expect(page.findComponent(ForumPost).emitted('set-topic')).toEqual([
      ['news'],
    ])
  } finally {
    page.unmount()
  }
})

test('a current-digest authoritative update replaces the displayed record', async () => {
  mockFetchOne.mockResolvedValue(record('a'))
  const { page, forum } = await routedPage()
  try {
    forum.setMessage({ ...record('a'), poster: 'updated-author' })
    await flushPromises()
    const child = page.findComponent({ name: 'AMessage' })
    expect(child.props('message')).toBe(forum.getMessage('a'))
    expect(child.props('message').poster).toBe('updated-author')
  } finally {
    page.unmount()
  }
})

test('failed B rejects observably and preserves committed A', async () => {
  const error = new Error('public read failed')
  mockFetchOne.mockImplementation(async digest => {
    if (digest === 'a') return record('a')
    throw error
  })
  const { router, page } = await routedPage()
  const onError = jest.fn()
  router.onError(onError)
  try {
    await expect(router.push('/forum/b')).rejects.toBe(error)
    await flushPromises()
    expect(onError).toHaveBeenCalledWith(
      error,
      expect.anything(),
      expect.anything(),
    )
    expect(router.currentRoute.value.params.payloadDigest).toBe('a')
    expect(
      page.findComponent({ name: 'AMessage' }).props('message').payloadDigest,
    ).toBe('a')
  } finally {
    page.unmount()
  }
})

test('a cancelled B navigation retains A even after B was fetched into the store', async () => {
  mockFetchOne.mockImplementation(async digest => record(digest))
  const { router, page, forum } = await routedPage()
  router.beforeResolve(to =>
    to.params.payloadDigest === 'b' ? false : undefined,
  )
  try {
    const result = await router.push('/forum/b')
    await flushPromises()
    const { isNavigationFailure, NavigationFailureType } = await import(
      'vue-router'
    )
    expect(isNavigationFailure(result, NavigationFailureType.aborted)).toBe(
      true,
    )
    expect(forum.getMessage('b')?.payloadDigest).toBe('b')
    expect(router.currentRoute.value.params.payloadDigest).toBe('a')
    expect(
      page.findComponent({ name: 'AMessage' }).props('message').payloadDigest,
    ).toBe('a')
  } finally {
    page.unmount()
  }
})

test('public read serialization prevents B overtaking pending A', async () => {
  const a = deferred(),
    b = deferred()
  mockFetchOne.mockImplementation(digest =>
    digest === 'a' ? a.promise : b.promise,
  )
  const { router, page } = await routedPage()
  try {
    const navigation = router.push('/forum/b')
    await flushPromises()
    b.resolve(record('b'))
    await flushPromises()
    expect(mockFetchOne.mock.calls).toEqual([['a']])
    expect(router.currentRoute.value.params.payloadDigest).toBe('a')
    a.resolve(record('a'))
    await navigation
    await flushPromises()
    expect(mockFetchOne.mock.calls).toEqual([['a'], ['b']])
    expect(router.currentRoute.value.params.payloadDigest).toBe('b')
    expect(
      page.findComponent({ name: 'AMessage' }).props('message').payloadDigest,
    ).toBe('b')
  } finally {
    page.unmount()
  }
})
