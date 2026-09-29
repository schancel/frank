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
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({})),
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
})
