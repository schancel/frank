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

describe('LeftDrawer balance polling', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    mockGetBalance.mockReset()
    mockGetBalance.mockResolvedValue(1n)
  })
  afterEach(() => {
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
})
