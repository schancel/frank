/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ForumLayout from './ForumLayout.vue'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import enUS from '../i18n/en-us'

const mockFetchByTopic = jest.fn()
const mockDiscoverTopics = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    defaultTopicVoteValue: 100_000_000n,
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => String(amount),
    fromDisplayAmount: (amount: string) => BigInt(amount),
    topics: {
      post: jest.fn(),
      fetchOne: jest.fn(),
      fetchByTopic: (...args: unknown[]) => mockFetchByTopic(...args),
      discoverTopics: (...args: unknown[]) => mockDiscoverTopics(...args),
      vote: jest.fn(),
    },
  },
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

function t(messages: unknown, key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string' ? value : key
}

const testWallet = {
  identity: { address: { raw: '0xabc' }, displayAddress: '0xabc' },
}

function create503Error(): Error {
  const err = new Error('Request failed with status code 503')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(err as any).response = { status: 503, data: 'Service Unavailable' }
  return err
}

describe('ForumLayout.vue refresh and rejection handling (#533)', () => {
  let unhandledRejections: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandledRejections.push(reason)
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    unhandledRejections = []
    process.on('unhandledRejection', onUnhandled)
    mockDiscoverTopics.mockResolvedValue([])
    ;(useActiveWallet as jest.Mock).mockResolvedValue(testWallet)
  })

  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled)
  })

  function mountLayout(options?: {
    route?: { path: string; params?: Record<string, string> }
    router?: { push: jest.Mock }
  }) {
    const mockRoute = options?.route ?? { path: '/forum', params: {} }
    const mockRouter = options?.router ?? { push: jest.fn() }
    return mount(ForumLayout, {
      global: {
        mocks: {
          $t: (key: string) => t(enUS, key),
          $route: mockRoute,
          $router: mockRouter,
        },
        stubs: {
          ForumDrawer: { template: '<div class="forum-drawer-stub" />' },
          RouterView: { template: '<div class="router-view-stub" />' },
          QDrawer: { template: '<div><slot /></div>' },
          QHeader: { template: '<header><slot /></header>' },
          QToolbar: { template: '<div><slot /></div>' },
          QToolbarTitle: { template: '<div><slot /></div>' },
          QSpace: { template: '<div />' },
          QPageContainer: { template: '<div><slot /></div>' },
          QPage: { template: '<div><slot /></div>' },
          QScrollArea: { template: '<div><slot /></div>' },
          QIcon: { template: '<i />' },
          QChip: {
            name: 'QChip',
            props: ['removable'],
            emits: ['remove'],
            template:
              '<span class="q-chip"><slot /><button v-if="removable" class="chip-remove" @click="$emit(\'remove\')">x</button></span>',
          },
          QBtn: {
            name: 'QBtn',
            props: ['icon', 'ariaLabel', 'loading'],
            template:
              '<button :data-icon="icon" :disabled="loading" :data-loading="loading"><slot /></button>',
          },
        },
      },
    })
  }

  it('mounted refresh handles HTTP 503 rejection without an unhandled browser exception', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    const wrapper = mountLayout()
    await flushPromises()

    const store = useForumStore()
    expect(store.hasFetchedOnce).toBe(true)
    expect(store.outageStatus).toBe('outage')
    expect(store.isRefreshing).toBe(false)

    // Critical requirement: zero unhandled rejections from mounted path
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })

  it('manual refresh button in toolbar handles HTTP 503 without unhandled rejection and tracks isRefreshing', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()

    // Settle mounted refresh first
    mockFetchByTopic.mockRejectedValue(create503Error())
    const wrapper = mountLayout()
    await flushPromises()

    const store = useForumStore()
    expect(store.isRefreshing).toBe(false)

    // Find the toolbar refresh button
    const refreshBtn = wrapper.find('button[data-icon="refresh"]')
    expect(refreshBtn.exists()).toBe(true)

    // Delay the rejection on the manual click so we can assert the loading state
    const deferreds: Array<{ reject: (err: Error) => void }> = []
    mockFetchByTopic.mockRejectedValue(create503Error()).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          deferreds.push({ reject })
        }),
    )

    // Trigger manual refresh
    const clickPromise = refreshBtn.trigger('click')
    // Wait for useActiveWallet to resolve and fetchByTopic to be invoked
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.isRefreshing).toBe(true)
    expect(refreshBtn.attributes('data-loading')).toBe('true')

    // Reject all with 503
    deferreds.forEach(d => d.reject(create503Error()))
    await clickPromise
    await flushPromises()

    expect(store.isRefreshing).toBe(false)
    expect(refreshBtn.attributes('data-loading')).toBe('false')
    expect(store.outageStatus).toBe('outage')

    // Critical requirement: zero unhandled rejections from manual path
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })

  it('setTopic handles HTTP 503 without unhandled rejection', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFetchByTopic.mockRejectedValue(create503Error())

    const wrapper = mountLayout()
    await flushPromises()

    const vm = wrapper.vm as unknown as { setTopic(t: string): void }
    vm.setTopic('custom-topic')
    await flushPromises()

    const store = useForumStore()
    expect(store.selectedTopic).toBe('custom-topic')
    expect(store.outageStatus).toBe('outage')
    expect(unhandledRejections).toHaveLength(0)

    consoleError.mockRestore()
  })

  it('renders back button and breadcrumb on thread route and navigates back to /forum', async () => {
    const mockRouterPush = jest.fn()
    const wrapper = mountLayout({
      route: {
        path: '/forum/0x1234567890abcdef',
        params: { payloadDigest: '0x1234567890abcdef' },
      },
      router: { push: mockRouterPush },
    })

    const backBtn = wrapper.find('[data-test="forum-back"]')
    expect(backBtn.exists()).toBe(true)

    const breadcrumb = wrapper.find('[data-test="forum-breadcrumb"]')
    expect(breadcrumb.exists()).toBe(true)

    await backBtn.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/forum')

    mockRouterPush.mockClear()
    await breadcrumb.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/forum')
  })

  it('navigates to /forum when setTopic is invoked from thread route', async () => {
    const mockRouterPush = jest.fn()
    const wrapper = mountLayout({
      route: {
        path: '/forum/0x1234567890abcdef',
        params: { payloadDigest: '0x1234567890abcdef' },
      },
      router: { push: mockRouterPush },
    })

    const vm = wrapper.vm as any
    await vm.setTopic('memes')

    expect(mockRouterPush).toHaveBeenCalledWith('/forum')
    const store = useForumStore()
    expect(store.selectedTopic).toBe('memes')
  })

  it('renders active topic chip and breadcrumb on /forum when selectedTopic is active, and clearTopic resets it', async () => {
    const store = useForumStore()
    store.setSelectedTopic('news')

    const wrapper = mountLayout({
      route: { path: '/forum', params: {} },
    })
    await flushPromises()

    const chip = wrapper.find('[data-test="forum-active-topic-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('#news')

    const breadcrumb = wrapper.find('[data-test="forum-breadcrumb-root"]')
    expect(breadcrumb.exists()).toBe(true)

    const vm = wrapper.vm as any
    await vm.clearTopic()
    await flushPromises()

    expect(store.selectedTopic).toBe('')
  })

  it('renders back button on /new-post route', async () => {
    const mockRouterPush = jest.fn()
    const wrapper = mountLayout({
      route: { path: '/new-post', params: {} },
      router: { push: mockRouterPush },
    })

    const backBtn = wrapper.find('[data-test="forum-back"]')
    expect(backBtn.exists()).toBe(true)

    await backBtn.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/forum')
  })
})

