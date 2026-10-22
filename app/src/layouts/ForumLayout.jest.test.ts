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
    width?: number
  }) {
    const mockRoute = options?.route ?? { path: '/forum', params: {} }
    const mockRouter = options?.router ?? { push: jest.fn() }
    return mount(ForumLayout, {
      global: {
        mocks: {
          $t: (key: string) => t(enUS, key),
          $route: mockRoute,
          $router: mockRouter,
          $q: { screen: { width: options?.width ?? 1280 } },
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
          QPullToRefresh: {
            props: ['disable', 'noMouse'],
            emits: ['refresh'],
            template:
              '<div data-test="forum-pull-to-refresh" :data-disable="String(disable)"><slot /></div>',
          },
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

  it('renders the selected topic as plain breadcrumb text and preserves Forum parent navigation', async () => {
    const store = useForumStore()
    store.setSelectedTopic('news')

    const wrapper = mountLayout({
      route: { path: '/forum', params: {} },
    })
    await flushPromises()

    const topic = wrapper.get('[data-test="forum-active-topic"]')
    expect(topic.element.tagName).toBe('SPAN')
    expect(topic.text()).toBe('#news')
    expect(topic.classes()).toEqual([])
    expect(wrapper.find('.q-chip').exists()).toBe(false)
    expect(wrapper.find('.chip-remove').exists()).toBe(false)
    await topic.trigger('click')
    expect(store.selectedTopic).toBe('news')

    const breadcrumb = wrapper.find('[data-test="forum-breadcrumb-root"]')
    expect(breadcrumb.exists()).toBe(true)

    await breadcrumb.trigger('click')
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

  it('on a phone keeps both the compact title and manual refresh alongside pull-to-refresh', async () => {
    const store = useForumStore()
    store.setSelectedTopic('memes')
    const wrapper = mountLayout({ width: 375 })
    await flushPromises()

    expect(wrapper.get('[data-test="forum-compact-title"]').text()).toBe(
      '#memes',
    )
    expect(wrapper.find('[data-test="forum-breadcrumb-root"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('button[data-icon="refresh"]').exists()).toBe(true)
    const pull = wrapper.getComponent('[data-test="forum-pull-to-refresh"]')
    expect(pull.props('disable')).toBeUndefined()
    expect(pull.props('noMouse')).toBe('')

    mockFetchByTopic.mockClear()
    const done = jest.fn()
    pull.vm.$emit('refresh', done)
    await flushPromises()
    expect(mockFetchByTopic).toHaveBeenCalled()
    expect(done).toHaveBeenCalledTimes(1)

    mockFetchByTopic.mockRejectedValue(create503Error())
    const failedDone = jest.fn()
    pull.vm.$emit('refresh', failedDone)
    await flushPromises()
    expect(failedDone).toHaveBeenCalledTimes(1)
    expect(store.isRefreshing).toBe(false)
  })

  it.each([320, 390, 590, 1280])(
    'keeps a working refresh action at %ipx',
    async width => {
      useForumStore().setSelectedTopic('memes')
      const wrapper = mountLayout({ width })
      await flushPromises()
      mockFetchByTopic.mockClear()
      await wrapper.get('[data-test="forum-refresh"]').trigger('click')
      await flushPromises()
      expect(mockFetchByTopic).toHaveBeenCalledTimes(1)
    },
  )

  it('suspends only the touched draggable target and restores it on cancel/unmount', async () => {
    const wrapper = mountLayout()
    await flushPromises()
    const pull = wrapper.get('[data-test="forum-pull-to-refresh"]')
    const image = document.createElement('img')
    pull.element.appendChild(image)
    expect(image.draggable).toBe(true)
    image.dispatchEvent(new Event('touchstart', { bubbles: true }))
    expect(image.draggable).toBe(false)
    image.dispatchEvent(new Event('touchcancel', { bubbles: true }))
    expect(image.hasAttribute('draggable')).toBe(false)
    expect(image.draggable).toBe(true)

    const link = document.createElement('a')
    link.href = 'https://example.invalid/read'
    link.setAttribute('draggable', 'true')
    pull.element.appendChild(link)
    link.dispatchEvent(new Event('touchstart', { bubbles: true }))
    expect(link.draggable).toBe(false)
    wrapper.unmount()
    expect(link.getAttribute('draggable')).toBe('true')
  })

  it('on desktop keeps the breadcrumb and refresh button with touch refresh available', async () => {
    const store = useForumStore()
    store.setSelectedTopic('memes')
    const wrapper = mountLayout({ width: 1280 })
    await flushPromises()

    expect(wrapper.find('[data-test="forum-compact-title"]').exists()).toBe(
      false,
    )
    expect(wrapper.get('[data-test="forum-active-topic"]').text()).toBe(
      '#memes',
    )
    expect(wrapper.find('button[data-icon="refresh"]').exists()).toBe(true)
    expect(
      wrapper
        .get('[data-test="forum-pull-to-refresh"]')
        .attributes('data-disable'),
    ).toBe('undefined')
  })
})
