/** @jest-environment jsdom */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import TopicPage, { TOPIC_POLL_INTERVAL_MS } from './Topic.vue'

const mockRefreshMessages = jest.fn().mockResolvedValue(undefined)
const mockInvalidateRefresh = jest.fn()
const mockEnsureTopic = jest.fn()
const mockTopics = ref({
  general: {
    topic: 'general',
    threshold: '0',
    messages: [],
    lastUpdate: 0,
  },
  other: {
    topic: 'other',
    threshold: '0',
    messages: [],
    lastUpdate: 0,
  },
})

jest.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { params: { topic: 'general' } } },
  }),
}))

jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    refreshMessages: mockRefreshMessages,
    invalidateRefresh: mockInvalidateRefresh,
    ensureTopic: mockEnsureTopic,
    topics: mockTopics.value,
  }),
}))

jest.mock('pinia', () => {
  const actual = jest.requireActual('pinia')
  return {
    ...actual,
    storeToRefs: () => ({
      topics: mockTopics,
    }),
  }
})

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest
    .fn()
    .mockResolvedValue({ identity: { address: { raw: '0x123' } } }),
}))

jest.setTimeout(30_000)

describe('Topic.vue polling and visibility lifecycle', () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    })
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    jest.clearAllMocks()
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
    jest.useRealTimers()
  })

  function mountComponent() {
    return shallowMount(TopicPage, {
      global: {
        mocks: {
          $t: (k: string) => k,
        },
        stubs: {
          TopicMessage: true,
          TopicInput: true,
          QScrollArea: {
            template: '<div><slot /></div>',
            methods: {
              getScrollTarget: () => ({ scrollTop: 0, scrollHeight: 100 }),
              setScrollPosition: jest.fn(),
            },
          },
        },
      },
    })
  }

  it('refreshes immediately on mount and polls at TOPIC_POLL_INTERVAL_MS (10s)', async () => {
    expect(TOPIC_POLL_INTERVAL_MS).toBe(10_000)
    const wrapper = mountComponent()
    await flushPromises()

    // 1 immediate call on mount
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)
    expect(mockRefreshMessages).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'general' }),
    )

    // Advance 9.9s: should not fire yet
    await jest.advanceTimersByTimeAsync(9900)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    // Advance another 100ms (10s total): second poll
    await jest.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(2)

    // Advance another 10s: third poll
    await jest.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(3)

    wrapper.unmount()
  })

  it('pauses polling when document becomes hidden', async () => {
    const wrapper = mountComponent()
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    // Hide document and fire visibilitychange
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    // Advance 30s: should NOT poll while hidden
    await jest.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('wakes up immediately and restarts 10s polling when document becomes visible again', async () => {
    const wrapper = mountComponent()
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    // Hide document
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    // Advance 15s in background
    await jest.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    // Make visible again
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    // Should immediately refresh on wake-up
    expect(mockRefreshMessages).toHaveBeenCalledTimes(2)

    // And next poll should be scheduled 10s from wake-up
    await jest.advanceTimersByTimeAsync(9900)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(2)

    await jest.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(3)

    wrapper.unmount()
  })

  it('handles beforeRouteUpdate by invalidating refresh and polling the new topic', async () => {
    const wrapper = mountComponent()
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(1)

    // Simulate route navigation to new topic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper.vm as any).$options.beforeRouteUpdate.call(wrapper.vm, {
      params: { topic: 'other' },
    })
    await flushPromises()

    expect(mockInvalidateRefresh).toHaveBeenCalled()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(2)
    expect(mockRefreshMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic: 'other' }),
    )

    // Advance 10s: should poll the new topic
    await jest.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(3)
    expect(mockRefreshMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic: 'other' }),
    )

    wrapper.unmount()
  })

  it('unmounted clears timeout and removes visibilitychange listener', async () => {
    const removeEventListenerSpy = jest.spyOn(document, 'removeEventListener')
    const wrapper = mountComponent()
    await flushPromises()

    wrapper.unmount()
    await flushPromises()

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )

    // Subsequent timer advancement should not trigger refresh
    const countBefore = mockRefreshMessages.mock.calls.length
    await jest.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(mockRefreshMessages).toHaveBeenCalledTimes(countBefore)

    removeEventListenerSpy.mockRestore()
  })
})
