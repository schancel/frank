/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'

import LeftDrawer from './LeftDrawer.vue'

const mockGetBalance = jest.fn()

jest.mock('vue-router', () => ({
  useRoute: () => ({ path: '/' }),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ totalUnread: 0, getSortedChatOrder: [] }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({ topics: {}, refreshDiscoveredTopics: jest.fn() }),
}))
jest.mock('src/stores/forum', () => ({
  useForumStore: () => ({ selectedTopic: '' }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => amount.toString(),
    nativeTransfers: {
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
    },
  },
}))
// One stable promise, like the real memoized-per-seed useActiveWallet (useBalance keys on it).
let mockWallet = Promise.resolve({})
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() => mockWallet),
}))
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => false,
}))
jest.mock('../chat/ChatList.vue', () => ({ template: '<div />' }))
jest.mock('../chat/ChatListLink.vue', () => ({ template: '<div />' }))
jest.mock('../panels/SettingsPanel.vue', () => ({ template: '<div />' }))
jest.mock('../dialogs/RelayConnectDialog.vue', () => ({ template: '<div />' }))

function mountDrawer() {
  return shallowMount(LeftDrawer, {
    global: {
      mocks: { $status: { setup: true }, $t: (key: string) => key },
    },
  })
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms)
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('LeftDrawer balance polling', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    mockGetBalance.mockReset()
    mockGetBalance.mockResolvedValue(1n)
  })
  afterEach(() => {
    setHidden(false)
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('re-fetches the balance every 15s and stops after unmount', async () => {
    const wrapper = mountDrawer()
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)

    await advance(15000)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    await advance(15000)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)

    wrapper.unmount()
    await advance(60000)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
  })

  it('keeps polling after a failed fetch', async () => {
    // Moved with the polling into useBalance: a failure now backs off (15-30s); pin jitter low.
    jest.spyOn(Math, 'random').mockReturnValue(0)
    mockGetBalance.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountDrawer()
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    await advance(15000)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not start a second fetch while one is pending', async () => {
    mockGetBalance.mockReturnValue(new Promise(() => undefined))
    const wrapper = mountDrawer()
    await advance(0)
    await advance(45000)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('never lets an older response overwrite a newer balance', async () => {
    let resolveOld: (v: bigint) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>(resolve => (resolveOld = resolve)),
    )
    mockGetBalance.mockResolvedValueOnce(9n)
    const wrapper = mountDrawer()
    await advance(0)
    setHidden(true)
    setHidden(false) // forced refresh supersedes the hung request
    await advance(0)
    expect(wrapper.text()).toContain('9 MON')
    resolveOld(1n)
    await advance(0)
    expect(wrapper.text()).toContain('9 MON')
    wrapper.unmount()
  })

  it('logs a failed fetch and keeps polling', async () => {
    // Moved with the polling into useBalance: a failure now backs off (15-30s); pin jitter low.
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockGetBalance.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountDrawer()
    await advance(0)
    expect(spy).toHaveBeenCalledWith(
      'balance refresh failed',
      expect.any(Error),
    )
    await advance(15000)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    spy.mockRestore()
  })

  it('exposes the balance caption as a polite live region', async () => {
    const wrapper = mountDrawer()
    await advance(0)
    const region = wrapper.find('[role="status"]')
    expect(region.exists()).toBe(true)
    expect(region.attributes('aria-live')).toBe('polite')
    expect(region.text()).toBe('1 MON')
    // Unchanged value across a tick: the region's text node is not replaced.
    const node = region.element.firstChild
    await advance(15000)
    expect(region.element.firstChild).toBe(node)
    expect(region.text()).toBe('1 MON')
    wrapper.unmount()
  })

  it('pauses polling while hidden and refreshes when visible again', async () => {
    const wrapper = mountDrawer()
    await advance(0)
    setHidden(true)
    await advance(60000)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    setHidden(false)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    await advance(15000)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('removes the visibility listener and timer on unmount', async () => {
    const add = jest.spyOn(document, 'addEventListener')
    const remove = jest.spyOn(document, 'removeEventListener')
    const wrapper = mountDrawer()
    await advance(0)
    const call = add.mock.calls.find(c => c[0] === 'visibilitychange')
    expect(call).toBeDefined()
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', call?.[1])
    expect(jest.getTimerCount()).toBe(0)
    add.mockRestore()
    remove.mockRestore()
  })

  describe('unknown balance (#272)', () => {
    const balanceRegion = (w: ReturnType<typeof mountDrawer>) =>
      w.get('[data-testid="drawer-balance"]')

    it('shows a dash with accessible text, not 0, before the first fetch', async () => {
      mockGetBalance.mockReturnValue(new Promise(() => undefined))
      const wrapper = mountDrawer()
      try {
        await advance(0)
        const region = balanceRegion(wrapper)
        expect(region.text()).toBe('\u2014')
        expect(region.text()).not.toContain('0')
        expect(region.attributes('aria-label')).toBe(
          'receiveBitcoinDialog.balanceUnavailable',
        )
        expect(region.attributes('aria-live')).toBe('polite')
      } finally {
        wrapper.unmount()
      }
    })

    it('shows a dash when the very first fetch fails', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      mockGetBalance.mockRejectedValue(new Error('rpc down'))
      const wrapper = mountDrawer()
      try {
        await advance(0)
        expect(balanceRegion(wrapper).text()).toBe('\u2014')
      } finally {
        wrapper.unmount()
      }
    })

    it('shows a genuine zero as 0', async () => {
      mockGetBalance.mockResolvedValue(0n)
      const wrapper = mountDrawer()
      try {
        await advance(0)
        const region = balanceRegion(wrapper)
        expect(region.text()).toBe('0 MON')
        expect(region.attributes('aria-label')).toBeUndefined()
      } finally {
        wrapper.unmount()
      }
    })

    it('keeps the last-known value marked stale after a later failure, then recovers', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
      jest.spyOn(Math, 'random').mockReturnValue(0)
      mockGetBalance.mockResolvedValueOnce(5n)
      mockGetBalance.mockRejectedValueOnce(new Error('rpc down'))
      const wrapper = mountDrawer()
      try {
        await advance(0)
        expect(balanceRegion(wrapper).text()).toBe('5 MON')
        await advance(15000)
        expect(balanceRegion(wrapper).text()).toBe(
          '5 MON chatList.balanceStale',
        )
        mockGetBalance.mockResolvedValue(7n)
        await advance(30000)
        expect(balanceRegion(wrapper).text()).toBe('7 MON')
      } finally {
        wrapper.unmount()
      }
    })

    it('never shows the old wallet balance for a newly active wallet', async () => {
      mockGetBalance.mockResolvedValueOnce(5n)
      const wrapper = mountDrawer()
      const original = mockWallet
      try {
        await advance(0)
        expect(balanceRegion(wrapper).text()).toBe('5 MON')
        mockWallet = Promise.resolve({}) // new identity
        mockGetBalance.mockReturnValue(new Promise(() => undefined))
        await advance(15000)
        expect(balanceRegion(wrapper).text()).toBe('\u2014')
      } finally {
        mockWallet = original
        wrapper.unmount()
      }
    })
  })
})
