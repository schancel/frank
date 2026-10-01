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

const mockPutMessage = jest.fn()
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
    const store = jest.requireActual('vue').reactive({
      topics: ['help'],
      selectedTopic: 'stamp',
      index: {} as Record<string, { topic: string }>,
      getMessage: (digest?: string) =>
        digest ? store.index[digest] : undefined,
      pushNewTopic: jest.fn(),
      putMessage: (...args: unknown[]) => mockPutMessage(...args),
    })
    return () => store
  })(),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ getTopics: ['stamp', 'news', 'help'] }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({ identity: {} })),
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
  displayToSafeRawAmount: () => 1_000_000,
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
  'chat.stampPreparationChecking': 'CHECKING',
  'chat.stampPreparationFunding': 'FUNDING {completed}/{total} {feeReserve}',
  'chat.stampPreparationReady': 'READY',
  'stampPreparation.postedRefreshFailed': 'POSTED_REFRESH_FAILED',
}
const $t = (key: string, params: Record<string, unknown> = {}) =>
  (messages[key] ?? key).replace(/\{(\w+)\}/g, (_m, n) => String(params[n]))

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

const status = (w: ReturnType<typeof mountPage>['wrapper']) =>
  w.find('[data-test="post-status"]')

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useActiveWallet).mockResolvedValue({ identity: {} } as never)
  const forum = useForumStore() as unknown as {
    selectedTopic: string
    index: Record<string, { topic: string }>
  }
  forum.selectedTopic = 'stamp'
  forum.index = {}
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
    const originalElement = page().element

    await router.push('/new-post/parentB')
    await flushPromises()

    expect(page().element).toBe(originalElement)
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

  it('submits and names the exact topic shown in the form', async () => {
    const { wrapper } = mountPage()

    await (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'stamp' }),
    )
    expect(infoNotify).toHaveBeenCalledWith('Post created in stamp.')
  })

  it('keeps the submitted topic across a deferred wallet lookup', async () => {
    const { wrapper } = mountPage()
    let resolveWallet!: (wallet: { identity: object }) => void
    jest.mocked(useActiveWallet).mockReturnValueOnce(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const posting = (wrapper.vm as unknown as { post(): Promise<void> }).post()
    await flushPromises()
    wrapper
      .findComponent({ name: 'QSelect' })
      .vm.$emit('update:modelValue', 'news')
    await nextTick()
    resolveWallet({ identity: {} })
    await posting
    await flushPromises()

    expect(mockPutMessage).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'stamp' }),
    )
    expect(infoNotify).toHaveBeenCalledWith('Post created in stamp.')
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
    jest.mocked(useActiveWallet).mockReturnValueOnce(
      new Promise(resolve => {
        resolveWallet = resolve
      }),
    )

    const oldSubmission = (
      page().vm as unknown as { post(): Promise<void> }
    ).post()
    await flushPromises()
    expect(page().vm).toMatchObject({ posting: true, parentDigest: 'parentA' })

    await router.push('/new-post/parentB')
    await flushPromises()
    expect(page().vm).toMatchObject({
      posting: false,
      preparationStatus: null,
      parentDigest: 'parentB',
      topic: 'help',
    })

    resolveWallet({ identity: {} })
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
