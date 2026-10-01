/** @jest-environment jsdom */
// CreatePost: the preparation stages are shown in a live region while posting, and a post whose
// burn landed but could not be read back says so instead of inviting a retry (#273 review).

import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

import CreatePost from './CreatePost.vue'
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { errorNotify, infoNotify } from 'src/utils/notifications'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useWalletStore } from 'src/stores/wallet'

const mockPutMessage = jest.fn()
const mockDisplayToSafeRawAmount = jest.fn(() => 1_000_000)
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
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: (() => {
    const reservations = jest
      .requireActual('vue')
      .reactive(new Map<string, { id: number }>())
    let nextReservationId = 0
    const reservationKey = (
      wallet: { identity: { address: { raw: string } } },
      destination: string,
    ) => `${wallet.identity.address.raw.toLowerCase()}\u0000${destination}`
    const store = jest.requireActual('vue').reactive({
      topics: ['help'],
      selectedTopic: 'stamp',
      index: {} as Record<string, { topic: string }>,
      getMessage: (digest?: string) =>
        digest && Object.prototype.hasOwnProperty.call(store.index, digest)
          ? store.index[digest]
          : undefined,
      pushNewTopic: jest.fn(),
      putMessage: (...args: unknown[]) => mockPutMessage(...args),
      fetchMessage: jest.fn(
        async ({ payloadDigest }: { payloadDigest: string }) =>
          store.getMessage(payloadDigest),
      ),
      getPostReservationId: ({
        wallet,
        destination,
      }: {
        wallet: { identity: { address: { raw: string } } }
        destination: string
      }) => {
        return reservations.get(reservationKey(wallet, destination))?.id
      },
      reservePostSubmission: ({
        wallet,
        destination,
      }: {
        wallet: { identity: { address: { raw: string } } }
        destination: string
      }) => {
        const key = reservationKey(wallet, destination)
        if (reservations.has(key)) return undefined
        const id = ++nextReservationId
        reservations.set(key, { id })
        return id
      },
      releasePostSubmission: ({
        wallet,
        destination,
        reservationId,
      }: {
        wallet: { identity: { address: { raw: string } } }
        destination: string
        reservationId: number
      }) => {
        const key = reservationKey(wallet, destination)
        if (reservations.get(key)?.id !== reservationId) return false
        return reservations.delete(key)
      },
      clearPostReservations: () => reservations.clear(),
    })
    return () => store
  })(),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ getTopics: ['stamp', 'news', 'help'] }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { address: { raw: '0xaaa' }, displayAddress: '0xaaa' },
  })),
}))
jest.mock('src/stores/wallet', () => ({
  useWalletStore: (() => {
    const store = jest.requireActual('vue').reactive({ seedPhrase: 'seed-a' })
    return () => store
  })(),
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    defaultTopicVoteValue: 1_000_000_000_000n,
    toDisplayAmount: (n: bigint) => `${n}wei`,
    fromDisplayAmount: (s: string) => BigInt(s),
  },
}))
jest.mock('src/utils/chain-amount', () => ({
  displayToSafeRawAmount: (...args: unknown[]) =>
    mockDisplayToSafeRawAmount(...args),
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

// Jest aliases `quasar` to its SSR build, whose form controls do not render. Load the real UMD
// components for the regression that exercises disabled-field registration in QForm.
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

const messages: Record<string, string> = {
  'stampPreparation.posting': 'POSTING',
  'stampPreparation.postCreated': 'Post created in {topic}.',
  'stampPreparation.replyParentLoading': 'LOADING_PARENT',
  'stampPreparation.replyParentUnavailable': 'PARENT_UNAVAILABLE',
  'stampPreparation.retryReplyParent': 'RETRY_PARENT',
  'chat.stampPreparationChecking': 'CHECKING',
  'chat.stampPreparationFunding': 'FUNDING {completed}/{total} {feeReserve}',
  'chat.stampPreparationReady': 'READY',
  'stampPreparation.postedRefreshFailed': 'POSTED_REFRESH_FAILED',
}
const $t = (key: string, params: Record<string, unknown> = {}) =>
  (messages[key] ?? key).replace(/\{(\w+)\}/g, (_m, n) => String(params[n]))

const makeWallet = (address = '0xaaa') => ({
  identity: { address: { raw: address }, displayAddress: address },
})

function mountPage(parentDigest?: string) {
  const router = { go: jest.fn(), push: jest.fn() }
  const wrapper = shallowMount(CreatePost, {
    global: {
      mocks: {
        $t,
        $route: { params: { parentDigest } },
        $router: router,
        $q: { dark: { isActive: false } },
      },
      stubs: {
        QSelect: {
          name: 'QSelect',
          props: ['modelValue'],
          emits: ['update:modelValue', 'input-value'],
          template: '<div data-test="topic-select" />',
        },
      },
    },
  })
  return { wrapper, router }
}

async function mountRoutedPage(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/new-post', component: CreatePost },
      { path: '/new-post/:parentDigest', component: CreatePost },
      {
        path: '/outside',
        component: defineComponent({
          render: () => h('div', { 'data-test': 'outside' }),
        }),
      },
    ],
  })
  await router.push(path)
  await router.isReady()

  const host = mount(
    defineComponent({
      render: () => h(RouterView),
    }),
    {
      global: {
        plugins: [router],
        mocks: {
          $t,
          $q: { dark: { isActive: false } },
        },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QForm: { template: '<form><slot /></form>' },
          QInput: true,
          QBtn: true,
          QSelect: {
            name: 'QSelect',
            props: ['modelValue', 'disable'],
            emits: ['update:modelValue', 'input-value'],
            template: '<div data-test="topic-select" />',
          },
        },
      },
    },
  )
  await flushPromises()

  return {
    host,
    router,
    page: () => host.findComponent(CreatePost),
  }
}

async function mountRealReplyForm(parentDigest: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(CreatePost, {
    attachTo: host,
    global: {
      plugins: [loadQuasar()],
      mocks: {
        $t,
        $route: { params: { parentDigest } },
        $router: { back: jest.fn(), push: jest.fn() },
      },
    },
  })
  await flushPromises()
  return wrapper
}

async function mountRealRoutedReplyForm(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/new-post', component: CreatePost },
      { path: '/new-post/:parentDigest', component: CreatePost },
    ],
  })
  await router.push(path)
  await router.isReady()
  const hostElement = document.createElement('div')
  document.body.appendChild(hostElement)
  const host = mount(
    defineComponent({
      render: () => h(RouterView),
    }),
    {
      attachTo: hostElement,
      global: {
        plugins: [router, loadQuasar()],
        mocks: { $t },
      },
    },
  )
  await flushPromises()
  return { host, router, page: () => host.findComponent(CreatePost) }
}

const status = (w: ReturnType<typeof mountPage>['wrapper']) =>
  w.find('[data-test="post-status"]')

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(useActiveWallet)
    .mockReturnValue(Promise.resolve(makeWallet()) as never)
  ;(useWalletStore() as unknown as { seedPhrase: string }).seedPhrase = 'seed-a'
  const forum = useForumStore() as unknown as {
    selectedTopic: string
    index: Record<string, { topic: string }>
    fetchMessage: jest.Mock
    clearPostReservations(): void
  }
  forum.selectedTopic = 'stamp'
  forum.index = {}
  forum.fetchMessage.mockReset().mockResolvedValue(undefined)
  forum.clearPostReservations()
  mockDisplayToSafeRawAmount.mockReset().mockReturnValue(1_000_000)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CreatePost selected-topic default (ticket #414)', () => {
  it('follows channel switches until the author edits the topic', async () => {
    const { wrapper } = mountPage()
    const forum = useForumStore() as unknown as { selectedTopic: string }
    const vm = wrapper.vm as unknown as { topic: string }

    expect(vm.topic).toBe('stamp')

    forum.selectedTopic = 'news'
    await nextTick()
    expect(vm.topic).toBe('news')

    wrapper
      .findComponent({ name: 'QSelect' })
      .vm.$emit('update:modelValue', 'custom')
    await nextTick()
    forum.selectedTopic = 'help'
    await nextTick()
    expect(vm.topic).toBe('custom')
  })

  it('does not overwrite the default while the author is typing a topic', async () => {
    const { wrapper } = mountPage()
    const forum = useForumStore() as unknown as { selectedTopic: string }
    const vm = wrapper.vm as unknown as { topic: string }

    wrapper.findComponent({ name: 'QSelect' }).vm.$emit('input-value', 'sta')
    await nextTick()
    forum.selectedTopic = 'news'
    await nextTick()

    expect(vm.topic).toBe('stamp')
  })

  it('pins replies to the parent topic instead of later channel switches', async () => {
    const forum = useForumStore() as unknown as {
      selectedTopic: string
      index: Record<string, { topic: string }>
    }
    forum.index = { parent: { topic: 'news' } }
    const { wrapper } = mountPage('parent')
    const vm = wrapper.vm as unknown as { topic: string }

    expect(vm.topic).toBe('news')
    forum.selectedTopic = 'help'
    await nextTick()
    expect(vm.topic).toBe('news')
  })

  it('synchronizes a reused pristine compose page from top-level to reply and back', async () => {
    const forum = useForumStore() as unknown as {
      selectedTopic: string
      index: Record<string, { topic: string }>
    }
    forum.index = { parent: { topic: 'news' } }
    const { page, router } = await mountRoutedPage('/new-post')
    const originalElement = page().element

    await router.push('/new-post/parent')
    await flushPromises()
    expect(page().element).toBe(originalElement)
    expect(page().vm).toMatchObject({ parentDigest: 'parent', topic: 'news' })

    forum.selectedTopic = 'help'
    await nextTick()
    await router.push('/new-post')
    await flushPromises()
    expect(page().element).toBe(originalElement)
    expect(page().vm).toMatchObject({ parentDigest: undefined, topic: 'help' })
  })

  it('restores an authored top-level topic after visiting a reply', async () => {
    const forum = useForumStore() as unknown as {
      selectedTopic: string
      index: Record<string, { topic: string }>
    }
    forum.index = { parent: { topic: 'news' } }
    const { page, router } = await mountRoutedPage('/new-post')

    page()
      .findComponent({ name: 'QSelect' })
      .vm.$emit('update:modelValue', 'custom')
    await nextTick()
    await router.push('/new-post/parent')
    await flushPromises()
    expect(page().vm).toMatchObject({ parentDigest: 'parent', topic: 'news' })

    forum.selectedTopic = 'help'
    await nextTick()
    await router.push('/new-post')
    await flushPromises()
    expect(page().vm).toMatchObject({
      parentDigest: undefined,
      topic: 'custom',
    })
  })

  it('repins the reused reply page when navigating from parent A to parent B', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = {
      parentA: { topic: 'news' },
      parentB: { topic: 'help' },
    }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    const originalUid = (page().vm as unknown as { $: { uid: number } }).$.uid

    await router.push('/new-post/parentB')
    await flushPromises()

    expect((page().vm as unknown as { $: { uid: number } }).$.uid).toBe(
      originalUid,
    )
    expect(page().vm).toMatchObject({ parentDigest: 'parentB', topic: 'help' })
  })

  it('locks a reply and pins its topic when the parent arrives later', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    const { page } = await mountRoutedPage('/new-post/late-parent')

    expect(page().vm).toMatchObject({
      parentDigest: 'late-parent',
      topic: '',
    })
    expect(page().findComponent({ name: 'QSelect' }).props('disable')).toBe(
      true,
    )

    forum.index = { 'late-parent': { topic: 'news' } }
    await nextTick()

    expect(page().vm).toMatchObject({
      parentDigest: 'late-parent',
      topic: 'news',
    })
  })

  it('announces parent loading and pins the fetched parent topic', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
      fetchMessage: jest.Mock
    }
    let finishFetch!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFetch = () => {
            forum.index = { parent: { topic: 'news' } }
            resolve()
          }
        }),
    )

    const { page } = await mountRoutedPage('/new-post/parent')
    const parentStatus = page().get('[data-test="parent-resolution-status"]')
    expect(parentStatus.attributes('role')).toBe('status')
    expect(parentStatus.attributes('aria-live')).toBe('polite')
    expect(parentStatus.text()).toContain('LOADING_PARENT')

    finishFetch()
    await flushPromises()

    expect(page().find('[data-test="parent-resolution-status"]').exists()).toBe(
      false,
    )
    expect(page().vm).toMatchObject({ topic: 'news' })
  })

  it('explains an unavailable parent and retries the same parent', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
      fetchMessage: jest.Mock
    }
    const { page } = await mountRoutedPage('/new-post/parent')

    expect(
      page().get('[data-test="parent-resolution-status"]').text(),
    ).toContain('PARENT_UNAVAILABLE')

    forum.fetchMessage.mockImplementationOnce(async () => {
      forum.index = { parent: { topic: 'help' } }
    })
    await page().get('[data-test="retry-parent"]').trigger('click')
    await flushPromises()

    expect(forum.fetchMessage).toHaveBeenCalledTimes(2)
    expect(page().find('[data-test="parent-resolution-status"]').exists()).toBe(
      false,
    )
    expect(page().vm).toMatchObject({ topic: 'help' })
  })

  it('keeps only the latest A request authoritative across A to B to A', async () => {
    const forum = useForumStore() as unknown as {
      fetchMessage: jest.Mock
    }
    const pending: Array<{
      digest: string
      resolve(): void
      reject(error: Error): void
    }> = []
    forum.fetchMessage.mockImplementation(
      ({ payloadDigest }: { payloadDigest: string }) =>
        new Promise<void>((resolve, reject) => {
          pending.push({ digest: payloadDigest, resolve, reject })
        }),
    )
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    await router.push('/new-post/parentB')
    await flushPromises()
    await router.push('/new-post/parentA')
    await flushPromises()

    expect(pending.map(request => request.digest)).toEqual([
      'parentA',
      'parentB',
      'parentA',
    ])
    pending[0]?.reject(new Error('stale A failed'))
    await flushPromises()
    expect(page().vm).toMatchObject({
      parentDigest: 'parentA',
      parentLoading: true,
    })
    expect(
      page().get('[data-test="parent-resolution-status"]').text(),
    ).toContain('LOADING_PARENT')

    pending[2]?.resolve()
    await flushPromises()
    expect(page().vm).toMatchObject({
      parentDigest: 'parentA',
      parentLoading: false,
    })
    expect(
      page().get('[data-test="parent-resolution-status"]').text(),
    ).toContain('PARENT_UNAVAILABLE')
    pending[1]?.resolve()
    await flushPromises()
  })

  it('keeps keyboard focus on the real retry button after an unsuccessful retry', async () => {
    const forum = useForumStore() as unknown as { fetchMessage: jest.Mock }
    const wrapper = await mountRealReplyForm('missing-parent')
    let finishRetry!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishRetry = resolve
        }),
    )
    const retry = wrapper.get<HTMLButtonElement>('[data-test="retry-parent"]')
    const retryElement = retry.element
    retryElement.focus()
    expect(document.activeElement).toBe(retryElement)

    await retry.trigger('keydown', { key: 'Enter' })
    await retry.trigger('keyup', { key: 'Enter' })
    retryElement.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 0 }),
    )
    await nextTick()

    expect(forum.fetchMessage).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-test="retry-parent"]').element).toBe(retryElement)
    expect(retryElement.isConnected).toBe(true)
    expect(document.activeElement).toBe(retryElement)
    finishRetry()
    await flushPromises()
    expect(wrapper.get('[data-test="retry-parent"]').element).toBe(retryElement)
    expect(document.activeElement).toBe(retryElement)
  })

  it('does not steal focus from a connected control after an unsuccessful retry', async () => {
    const forum = useForumStore() as unknown as { fetchMessage: jest.Mock }
    const wrapper = await mountRealReplyForm('missing-parent')
    let finishRetry!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishRetry = resolve)),
    )
    const retry = wrapper.get<HTMLButtonElement>('[data-test="retry-parent"]')
    retry.element.focus()
    await retry.trigger('click')
    await nextTick()

    const back = wrapper.get<HTMLButtonElement>(
      '[data-test="compose-focus-target"]',
    ).element
    back.focus()
    expect(document.activeElement).toBe(back)
    finishRetry()
    await flushPromises()

    expect(back.isConnected).toBe(true)
    expect(document.activeElement).toBe(back)
  })

  it('does not steal focus from a connected non-HTML control after an unsuccessful retry', async () => {
    const forum = useForumStore() as unknown as { fetchMessage: jest.Mock }
    const wrapper = await mountRealReplyForm('missing-parent')
    let finishRetry!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishRetry = resolve)),
    )
    const retry = wrapper.get<HTMLButtonElement>('[data-test="retry-parent"]')
    retry.element.focus()
    await retry.trigger('click')
    await nextTick()

    const svgControl = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg',
    )
    svgControl.setAttribute('tabindex', '0')
    document.body.appendChild(svgControl)
    svgControl.focus()
    expect(document.activeElement).toBe(svgControl)

    finishRetry()
    await flushPromises()
    expect(document.activeElement).toBe(svgControl)
    svgControl.remove()
  })

  it('returns genuinely lost focus to Retry after an unsuccessful retry', async () => {
    const forum = useForumStore() as unknown as { fetchMessage: jest.Mock }
    const wrapper = await mountRealReplyForm('missing-parent')
    let finishRetry!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishRetry = resolve)),
    )
    const retry = wrapper.get<HTMLButtonElement>('[data-test="retry-parent"]')
    retry.element.focus()
    await retry.trigger('click')
    await nextTick()

    const transient = document.createElement('button')
    document.body.appendChild(transient)
    transient.focus()
    transient.remove()
    expect(document.activeElement).toBe(document.body)
    finishRetry()
    await flushPromises()

    expect(document.activeElement).toBe(
      wrapper.get('[data-test="retry-parent"]').element,
    )
  })

  it('hands lost focus to a stable compose control when Retry resolves successfully', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
      fetchMessage: jest.Mock
    }
    const wrapper = await mountRealReplyForm('missing-parent')
    let finishRetry!: () => void
    forum.fetchMessage.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishRetry = () => {
            forum.index = { 'missing-parent': { topic: 'news' } }
            resolve()
          }
        }),
    )
    const retry = wrapper.get<HTMLButtonElement>('[data-test="retry-parent"]')
    retry.element.focus()
    await retry.trigger('click')
    await nextTick()

    finishRetry()
    await flushPromises()
    const composeTarget = wrapper.get(
      '[data-test="compose-focus-target"]',
    ).element
    expect(wrapper.find('[data-test="retry-parent"]').exists()).toBe(false)
    expect(composeTarget.isConnected).toBe(true)
    expect(document.activeElement).toBe(composeTarget)
  })

  it('never changes focus for a stale real-router parent completion', async () => {
    const forum = useForumStore() as unknown as { fetchMessage: jest.Mock }
    const { page, router } = await mountRealRoutedReplyForm('/new-post/parentA')
    const pending: Array<() => void> = []
    forum.fetchMessage.mockImplementation(
      () => new Promise<void>(resolve => pending.push(resolve)),
    )
    const retryA = page().get<HTMLButtonElement>('[data-test="retry-parent"]')
    retryA.element.focus()
    await retryA.trigger('click')
    await nextTick()

    await router.push('/new-post/parentB')
    await flushPromises()
    const retryB = page().get<HTMLButtonElement>(
      '[data-test="retry-parent"]',
    ).element
    const transient = document.createElement('button')
    document.body.appendChild(transient)
    transient.focus()
    transient.remove()
    expect(document.activeElement).toBe(document.body)

    pending[0]?.()
    await flushPromises()
    expect(retryB.isConnected).toBe(true)
    expect(document.activeElement).toBe(document.body)
    pending[1]?.()
    await flushPromises()
  })

  it.each(['success', 'failure'] as const)(
    'keeps meaningful focus when stale A succeeds during the current A retry, then that retry ends in %s',
    async currentRetryOutcome => {
      const forum = useForumStore() as unknown as {
        index: Record<string, { topic: string }>
        fetchMessage: jest.Mock
      }
      const { page, router } = await mountRealRoutedReplyForm(
        '/new-post/parentA',
      )
      const pending: Array<{
        digest: string
        resolve(): void
        reject(error: Error): void
      }> = []
      forum.fetchMessage.mockImplementation(
        ({ payloadDigest }: { payloadDigest: string }) =>
          new Promise<void>((resolve, reject) => {
            pending.push({ digest: payloadDigest, resolve, reject })
          }),
      )

      const retry = page().get<HTMLButtonElement>(
        '[data-test="retry-parent"]',
      ).element
      retry.focus()
      await page().get('[data-test="retry-parent"]').trigger('click')
      await nextTick()
      await router.push('/new-post/parentB')
      await flushPromises()
      await router.push('/new-post/parentA')
      await flushPromises()

      expect(pending.map(request => request.digest)).toEqual([
        'parentA',
        'parentB',
        'parentA',
      ])
      expect(retry.isConnected).toBe(true)
      expect(document.activeElement).toBe(retry)

      // A1 is no longer route-authoritative, but its content-addressed result is still a valid
      // shared-cache population. It must intentionally hand focus off before removing Retry,
      // while A2 remains pending.
      forum.index = { parentA: { topic: 'news' } }
      pending[0]?.resolve()
      await flushPromises()

      const composeTarget = page().get(
        '[data-test="compose-focus-target"]',
      ).element
      expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
      expect(page().find('[data-test="retry-parent"]').exists()).toBe(false)
      expect(page().vm).toMatchObject({
        activeParentRequestId: null,
        parentDigest: 'parentA',
        parentLoading: false,
        topic: 'news',
      })
      expect(composeTarget.isConnected).toBe(true)
      expect(document.activeElement).toBe(composeTarget)

      if (currentRetryOutcome === 'success') {
        pending[2]?.resolve()
      } else {
        pending[2]?.reject(new Error('current A retry failed after resolution'))
      }
      await flushPromises()
      expect(document.activeElement).toBe(composeTarget)
      expect(page().vm).toMatchObject({
        activeParentRequestId: null,
        parentDigest: 'parentA',
        parentLoading: false,
        topic: 'news',
      })

      // B's route completion is stale too and cannot disturb the resolved A route or focus.
      pending[1]?.resolve()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
      expect(document.activeElement).toBe(composeTarget)
    },
  )

  it.each(['empty', 'failure'] as const)(
    'hands idle Retry focus to compose when stale A arrives after A2 settles %s',
    async currentRetryOutcome => {
      const forum = useForumStore() as unknown as {
        index: Record<string, { topic: string }>
        fetchMessage: jest.Mock
      }
      const { page, router } = await mountRealRoutedReplyForm(
        '/new-post/parentA',
      )
      const pending: Array<{
        digest: string
        resolve(): void
        reject(error: Error): void
      }> = []
      forum.fetchMessage.mockImplementation(
        ({ payloadDigest }: { payloadDigest: string }) =>
          new Promise<void>((resolve, reject) => {
            pending.push({ digest: payloadDigest, resolve, reject })
          }),
      )

      await page().get('[data-test="retry-parent"]').trigger('click')
      await nextTick()
      await router.push('/new-post/parentB')
      await flushPromises()
      await router.push('/new-post/parentA')
      await flushPromises()
      expect(pending.map(request => request.digest)).toEqual([
        'parentA',
        'parentB',
        'parentA',
      ])

      if (currentRetryOutcome === 'empty') {
        pending[2]?.resolve()
      } else {
        pending[2]?.reject(new Error('current A retry failed'))
      }
      await flushPromises()
      expect(page().vm).toMatchObject({
        activeParentRequestId: null,
        parentDigest: 'parentA',
        parentLoading: false,
      })

      const idleRetry = page().get<HTMLButtonElement>(
        '[data-test="retry-parent"]',
      ).element
      idleRetry.focus()
      expect(document.activeElement).toBe(idleRetry)

      // A1 no longer owns a request finalizer, but its content-addressed cache result is valid.
      // Removing the idle Retry must still make a current-route meaningful focus handoff.
      forum.index = { parentA: { topic: 'news' } }
      pending[0]?.resolve()
      await flushPromises()

      const composeTarget = page().get(
        '[data-test="compose-focus-target"]',
      ).element
      expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
      expect(page().find('[data-test="retry-parent"]').exists()).toBe(false)
      expect(page().vm).toMatchObject({
        activeParentRequestId: null,
        parentDigest: 'parentA',
        parentLoading: false,
        topic: 'news',
      })
      expect(document.activeElement).toBe(composeTarget)

      // B's stale finalizer has no authority to take focus from the resolved A route.
      pending[1]?.resolve()
      await flushPromises()
      expect(document.activeElement).toBe(composeTarget)
    },
  )

  it('blocks a real QForm reply until its late parent supplies the topic', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    const wrapper = await mountRealReplyForm('late-parent')

    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBe('')
    // Quasar unregisters the disabled topic selector from QForm validation. A direct form submit
    // therefore reaches post(), whose guard must still prevent an empty-topic burn.
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(useActiveWallet).not.toHaveBeenCalled()
    expect(mockPutMessage).not.toHaveBeenCalled()

    forum.index = { 'late-parent': { topic: 'news' } }
    await nextTick()
    await flushPromises()
    expect(
      wrapper.get('button[type="submit"]').attributes('disabled'),
    ).toBeUndefined()

    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'news', parentDigest: 'late-parent' }),
    )
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'never prepares or burns for inherited parent key %s',
    async parentDigest => {
      const wrapper = await mountRealReplyForm(parentDigest)

      expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBe(
        '',
      )
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(useActiveWallet).not.toHaveBeenCalled()
      expect(mockPutMessage).not.toHaveBeenCalled()
    },
  )

  it('submits and names the exact topic shown in the form', async () => {
    const { wrapper } = mountPage()

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'stamp' }),
    )
    expect(infoNotify).toHaveBeenCalledWith('Post created in stamp.')
  })

  it('preserves an inherited topic as notification text for the safe notifier', async () => {
    const inheritedTopic = '<img src=x onerror="globalThis.topicXss=true">'
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = { parent: { topic: inheritedTopic } }
    const { wrapper } = mountPage('parent')

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(infoNotify).toHaveBeenCalledWith(
      `Post created in ${inheritedTopic}.`,
    )
  })

  it('keeps the complete submitted entry and topic across a deferred wallet lookup', async () => {
    const { wrapper } = mountPage()
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const vm = wrapper.vm as unknown as {
      title: string
      url: string | null
      message: string
      post(): Promise<void>
    }
    vm.title = 'Original title'
    vm.url = 'https://example.com/original'
    vm.message = 'Original message'
    const posting = vm.post()
    await flushPromises()
    wrapper
      .findComponent({ name: 'QSelect' })
      .vm.$emit('update:modelValue', 'news')
    vm.title = 'Changed title'
    vm.url = 'https://example.com/changed'
    vm.message = 'Changed message'
    await nextTick()
    resolveWallet(makeWallet())
    await posting
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'stamp',
        entry: {
          kind: 'post',
          title: 'Original title',
          url: 'https://example.com/original',
          message: 'Original message',
        },
      }),
    )
    expect(infoNotify).toHaveBeenCalledWith('Post created in stamp.')
  })

  it('keeps the authorized offering across a deferred wallet lookup', async () => {
    const { wrapper } = mountPage()
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )
    mockDisplayToSafeRawAmount.mockImplementationOnce(
      (_chain: unknown, amount: string) => Number(amount),
    )
    const vm = wrapper.vm as unknown as {
      offering: string
      post(): Promise<void>
    }
    vm.offering = '2'

    const posting = vm.post()
    vm.offering = '9'
    resolveWallet(makeWallet())
    await posting
    await flushPromises()

    expect(mockDisplayToSafeRawAmount).toHaveBeenCalledWith(
      expect.anything(),
      '2',
    )
    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ satoshis: 2 }),
    )
  })

  it('detaches an old deferred submission from a newer reused compose route', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = {
      parentA: { topic: 'news' },
      parentB: { topic: 'help' },
    }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const oldSubmission = (
      page().vm as unknown as { post(): Promise<void> }
    ).post()
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: false, parentDigest: 'parentA' })

    await router.push('/new-post/parentB')
    await flushPromises()
    expect(page().vm).toMatchObject({
      posting: false,
      preparationStatus: null,
      parentDigest: 'parentB',
      topic: 'help',
    })

    resolveWallet(makeWallet())
    await oldSubmission
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'news', parentDigest: 'parentA' }),
    )
    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentB')
    expect(page().vm).toMatchObject({
      posting: false,
      preparationStatus: null,
      parentDigest: 'parentB',
      topic: 'help',
    })
  })

  it('keeps the original destination busy across A to B to A route reuse', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = {
      parentA: { topic: 'news' },
      parentB: { topic: 'help' },
    }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const first = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    await router.push('/new-post/parentB')
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: false, parentDigest: 'parentB' })

    await router.push('/new-post/parentA')
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: false, parentDigest: 'parentA' })
    const second = (page().vm as unknown as { post(): Promise<void> }).post()

    resolveWallet(makeWallet())
    await second
    await first
    await flushPromises()
    expect(mockPutMessage).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
  })

  it('keeps a remounted destination busy until the original submission settles', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = { parentA: { topic: 'news' } }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    let resolveOriginalWallet!: (wallet: { identity: object }) => void
    let resolveRemountedWallet!: (wallet: { identity: object }) => void
    let finishPost!: () => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveOriginalWallet = resolve
      }),
    )
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishPost = resolve)),
    )

    const original = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    await router.push('/outside')
    await flushPromises()
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveRemountedWallet = resolve
      }),
    )
    await router.push('/new-post/parentA')
    await flushPromises()

    expect(page().vm).toMatchObject({ posting: false, parentDigest: 'parentA' })
    const duplicate = (page().vm as unknown as { post(): Promise<void> }).post()
    expect(mockPutMessage).not.toHaveBeenCalled()

    resolveOriginalWallet(makeWallet())
    await flushPromises()
    expect(mockPutMessage).toHaveBeenCalledTimes(1)
    resolveRemountedWallet(makeWallet())
    await duplicate
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: true, parentDigest: 'parentA' })
    expect(mockPutMessage).toHaveBeenCalledTimes(1)
    finishPost()
    await original
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentA')
    expect(page().vm).toMatchObject({ posting: false, parentDigest: 'parentA' })
  })

  it('cannot navigate a newer compose instance after the origin unmounts', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
    }
    forum.index = {
      parentA: { topic: 'news' },
      parentB: { topic: 'help' },
    }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    const originalUid = (page().vm as unknown as { $: { uid: number } }).$.uid
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValue(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const oldSubmission = (
      page().vm as unknown as { post(): Promise<void> }
    ).post()
    await flushPromises()
    await router.push('/outside')
    await flushPromises()
    expect(page().exists()).toBe(false)
    await router.push('/new-post/parentB')
    await flushPromises()
    expect((page().vm as unknown as { $: { uid: number } }).$.uid).not.toBe(
      originalUid,
    )

    resolveWallet(makeWallet())
    await oldSubmission
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentB')
    expect(page().vm).toMatchObject({
      posting: false,
      parentDigest: 'parentB',
      topic: 'help',
    })
  })
})

describe('CreatePost preparation status', () => {
  it('shows each stage in a live region and clears it when the post is done', async () => {
    const { wrapper } = mountPage()
    let finish!: () => void
    let report!: (p: unknown) => void
    mockPutMessage.mockImplementationOnce(
      (args: { onPreparationProgress: (p: unknown) => void }) => {
        report = args.onPreparationProgress
        return new Promise<void>(resolve => (finish = resolve))
      },
    )

    const posting = (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    expect(status(wrapper).text()).toBe('POSTING')
    expect(status(wrapper).attributes('role')).toBe('status')

    report({ stage: 'checking' })
    await flushPromises()
    expect(status(wrapper).text()).toBe('CHECKING')

    report({ stage: 'funding', completed: 0, total: 1, feeReserveWei: 7n })
    await flushPromises()
    expect(status(wrapper).text()).toBe('FUNDING 0/1 7wei')

    report({ stage: 'ready', fundingTxHashes: [] })
    await flushPromises()
    expect(status(wrapper).text()).toBe('READY')

    finish()
    await posting
    await flushPromises()
    expect(status(wrapper).exists()).toBe(false)
  })

  it('ignores a second submit while the first is still in flight', async () => {
    const { wrapper } = mountPage()
    let finish!: () => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve)),
    )
    const vm = wrapper.vm as unknown as { post(): Promise<void> }

    const first = vm.post()
    await flushPromises()
    await vm.post()
    finish()
    await first

    expect(mockPutMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps pending B progress and ownership isolated from stale A', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
      getPostReservationId(args: {
        wallet: ReturnType<typeof makeWallet>
        destination: string
      }): number | undefined
    }
    forum.index = {
      parentA: { topic: 'news' },
      parentB: { topic: 'help' },
    }
    const { page, router } = await mountRoutedPage('/new-post/parentA')
    let finishA!: () => void
    let finishB!: () => void
    let reportA!: (progress: unknown) => void
    let reportB!: (progress: unknown) => void
    mockPutMessage
      .mockImplementationOnce(
        (args: { onPreparationProgress: (progress: unknown) => void }) => {
          reportA = args.onPreparationProgress
          return new Promise<void>(resolve => (finishA = resolve))
        },
      )
      .mockImplementationOnce(
        (args: { onPreparationProgress: (progress: unknown) => void }) => {
          reportB = args.onPreparationProgress
          return new Promise<void>(resolve => (finishB = resolve))
        },
      )

    const postingA = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    await router.push('/new-post/parentB')
    await flushPromises()
    const postingB = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    reportB({ stage: 'checking' })
    await flushPromises()
    expect(page().vm).toMatchObject({
      posting: true,
      preparationStatus: 'CHECKING',
      parentDigest: 'parentB',
    })

    reportA({ stage: 'funding', completed: 0, total: 1, feeReserveWei: 7n })
    finishA()
    await postingA
    await flushPromises()
    expect(page().vm).toMatchObject({
      posting: true,
      preparationStatus: 'CHECKING',
      parentDigest: 'parentB',
    })
    expect(router.currentRoute.value.fullPath).toBe('/new-post/parentB')

    reportA({ stage: 'ready', fundingTxHashes: [] })
    await flushPromises()
    expect(page().vm).toMatchObject({
      posting: true,
      preparationStatus: 'CHECKING',
      parentDigest: 'parentB',
    })

    finishB()
    await postingB
    await flushPromises()
    expect(
      forum.getPostReservationId({
        wallet: makeWallet(),
        destination: 'reply:parentB',
      }),
    ).toBeUndefined()
  })

  it('does not let wallet B completion clear wallet A busy UI at the same destination', async () => {
    const forum = useForumStore() as unknown as {
      index: Record<string, { topic: string }>
      getPostReservationId(args: {
        wallet: ReturnType<typeof makeWallet>
        destination: string
      }): number | undefined
    }
    const walletStore = useWalletStore() as unknown as { seedPhrase: string }
    const walletA = makeWallet('0xaaa')
    const walletB = makeWallet('0xbbb')
    const walletAPromise = Promise.resolve(walletA)
    const walletBPromise = Promise.resolve(walletB)
    jest.mocked(useActiveWallet).mockReturnValue(walletAPromise as never)
    forum.index = { parent: { topic: 'news' } }
    const { page, router } = await mountRoutedPage('/new-post/parent')
    let finishA!: () => void
    let finishB!: () => void
    mockPutMessage
      .mockImplementationOnce(
        () => new Promise<void>(resolve => (finishA = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<void>(resolve => (finishB = resolve)),
      )

    const postingA = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: true })

    jest.mocked(useActiveWallet).mockReturnValue(walletBPromise as never)
    walletStore.seedPhrase = 'seed-b'
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: false })
    const postingB = (page().vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: true })

    jest.mocked(useActiveWallet).mockReturnValue(walletAPromise as never)
    walletStore.seedPhrase = 'seed-a'
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: true })

    finishB()
    await postingB
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/new-post/parent')
    expect(page().vm).toMatchObject({ posting: true })
    expect(
      forum.getPostReservationId({
        wallet: walletA,
        destination: 'reply:parent',
      }),
    ).toEqual(expect.any(Number))
    expect(
      forum.getPostReservationId({
        wallet: walletB,
        destination: 'reply:parent',
      }),
    ).toBeUndefined()

    finishA()
    await postingA
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: false })
  })
})

describe('CreatePost outcomes', () => {
  it('a burn that landed but could not be read back says so, does not show an error, and leaves the form', async () => {
    const { wrapper, router } = mountPage()
    mockPutMessage.mockRejectedValueOnce(
      new BurnRefreshError('post', new Error('read failed')),
    )

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(infoNotify).toHaveBeenCalledWith('POSTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    // Not kept for a retry: the page goes back like any successful post.
    expect(router.push.mock.calls.length + router.go.mock.calls.length).toBe(1)
  })

  it('a failed burn shows the error and keeps the draft page for a retry', async () => {
    const { wrapper, router } = mountPage()
    const failure = new Error('Nothing was sent')
    mockPutMessage.mockRejectedValueOnce(failure)

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(router.push).not.toHaveBeenCalled()
    expect(router.go).not.toHaveBeenCalled()
  })
})

describe('CreatePost topic options (ticket #368)', () => {
  const optionsFor = (typed: string) => {
    const { wrapper } = mountPage()
    const vm = wrapper.vm as unknown as {
      filterTopics(t: string, update: (fn: () => void) => void): void
      topics: string[]
    }
    vm.filterTopics(typed, fn => fn())
    return vm.topics
  }

  it('opens with the known topics (forum + default/discovered), not a single empty row', () => {
    expect(optionsFor('')).toEqual(['help', 'stamp', 'news'])
  })

  it('narrows to matches once text is typed, offering the typed text first', () => {
    expect(optionsFor('ne')).toEqual(['ne', 'news'])
  })
})
