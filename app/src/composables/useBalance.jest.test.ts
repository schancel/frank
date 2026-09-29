/** @jest-environment jsdom */

import { defineComponent, h, nextTick } from 'vue'
import { mount as vtuMount } from '@vue/test-utils'

import {
  BALANCE_BACKOFF_MAX_MS,
  BALANCE_POLL_MS,
  configureBalancePolling,
  nextBalanceDelay,
  refresh,
  useBalance,
} from './useBalance'

const mockGetBalance = jest.fn()
const capacitor = {
  isNative: false,
  broken: false,
  listener: undefined as ((s: { isActive: boolean }) => void) | undefined,
  remove: jest.fn(),
}

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
jest.mock('@capacitor/core', () => ({
  get Capacitor() {
    if (capacitor.broken) throw new Error('plugin unavailable')
    return { isNative: capacitor.isNative }
  },
  Plugins: {
    App: {
      addListener: (_: string, fn: (s: { isActive: boolean }) => void) => {
        capacitor.listener = fn
        return { remove: capacitor.remove }
      },
    },
  },
}))

const Consumer = defineComponent({
  setup() {
    const { formattedBalance } = useBalance()
    return () => h('span', formattedBalance.value)
  },
})

// Tracked so a failing assertion cannot leak a consumer (and its timer) into the next test.
const mounted: Array<ReturnType<typeof vtuMount>> = []
function mount(component: typeof Consumer) {
  const wrapper = vtuMount(component)
  mounted.push(wrapper)
  return wrapper
}

// Drives `refresh` from a consumer so tests can use the exposed function.
let manualRefresh: () => Promise<void> = refresh

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

describe('useBalance', () => {
  let errorSpy: jest.SpyInstance
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    })
    mockGetBalance.mockReset()
    mockGetBalance.mockResolvedValue(1n)
    capacitor.isNative = false
    capacitor.broken = false
    capacitor.listener = undefined
    capacitor.remove.mockReset()
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    manualRefresh = refresh
  })
  afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    setHidden(false)
    configureBalancePolling()
    errorSpy.mockRestore()
    jest.useRealTimers()
  })

  it('runs a single shared loop for two consumers', async () => {
    const a = mount(Consumer)
    const b = mount(Consumer)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(1) // second mount hits the guard
    expect(jest.getTimerCount()).toBe(1)
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    mockGetBalance.mockResolvedValue(7n)
    await advance(BALANCE_POLL_MS)
    expect(a.text()).toBe('7 MON')
    expect(b.text()).toBe('7 MON')
    a.unmount()
    b.unmount()
  })

  it('stops when the last consumer unmounts and restarts on the next mount', async () => {
    const a = mount(Consumer)
    const b = mount(Consumer)
    await advance(0)
    a.unmount()
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(2) // still polling for b
    b.unmount()
    expect(jest.getTimerCount()).toBe(0)
    await advance(BALANCE_POLL_MS * 4)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)

    const c = mount(Consumer)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(4)
    c.unmount()
  })

  it('computes bounded, jittered exponential delays', () => {
    expect(nextBalanceDelay(0, () => 0.9)).toBe(BALANCE_POLL_MS)
    expect(nextBalanceDelay(1, () => 0)).toBe(15000)
    expect(nextBalanceDelay(1, () => 1)).toBe(30000)
    expect(nextBalanceDelay(2, () => 0)).toBe(30000)
    expect(nextBalanceDelay(2, () => 1)).toBe(60000)
    expect(nextBalanceDelay(3, () => 1)).toBe(120000)
    expect(nextBalanceDelay(50, () => 1)).toBe(BALANCE_BACKOFF_MAX_MS)
    expect(nextBalanceDelay(50, () => 0)).toBe(BALANCE_BACKOFF_MAX_MS / 2)
  })

  it('backs off with jitter after failures and resets on success', async () => {
    configureBalancePolling({ random: () => 1 }) // always the top of the jitter window
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    const wrapper = mount(Consumer)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    // 1st failure: next attempt after 30s, not 15s.
    await advance(29999)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    // 2nd failure: 60s.
    await advance(59999)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
    // Success resets to the base interval.
    mockGetBalance.mockResolvedValue(5n)
    await advance(120000)
    expect(mockGetBalance).toHaveBeenCalledTimes(4)
    expect(wrapper.text()).toBe('5 MON')
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(5)
    // Jitter window low end.
    configureBalancePolling({ random: () => 0 })
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(6)
    await advance(14999)
    expect(mockGetBalance).toHaveBeenCalledTimes(6)
    await advance(1)
    expect(mockGetBalance).toHaveBeenCalledTimes(7)
    expect(errorSpy).toHaveBeenCalledWith(
      'balance refresh failed',
      expect.any(Error),
    )
    wrapper.unmount()
  })

  it('never exceeds the backoff cap', async () => {
    configureBalancePolling({ random: () => 1 })
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    const wrapper = mount(Consumer)
    await advance(0)
    let calls = 1
    for (let i = 0; i < 12; i++) {
      await advance(BALANCE_BACKOFF_MAX_MS)
      calls++
      expect(mockGetBalance).toHaveBeenCalledTimes(calls)
    }
    wrapper.unmount()
  })

  it('pauses while hidden and refreshes immediately when visible', async () => {
    const wrapper = mount(Consumer)
    await advance(0)
    setHidden(true)
    expect(jest.getTimerCount()).toBe(0)
    await advance(BALANCE_POLL_MS * 4)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    setHidden(false)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('does not reschedule when a pending fetch settles while hidden', async () => {
    let resolve: (v: bigint) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(new Promise<bigint>(r => (resolve = r)))
    const wrapper = mount(Consumer)
    await advance(0)
    setHidden(true)
    resolve(2n)
    await advance(0)
    expect(jest.getTimerCount()).toBe(0)
    await advance(BALANCE_POLL_MS * 3)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('skips ticks while a fetch is pending; refresh() bypasses the guard', async () => {
    mockGetBalance.mockReturnValueOnce(new Promise(() => undefined))
    const wrapper = mount(Consumer)
    await advance(0)
    await advance(BALANCE_POLL_MS * 3)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    await manualRefresh()
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('ignores a stale response that resolves after a newer one', async () => {
    let resolveOld: (v: bigint) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>(resolve => (resolveOld = resolve)),
    )
    mockGetBalance.mockResolvedValueOnce(9n)
    const wrapper = mount(Consumer)
    await advance(0)
    await manualRefresh()
    await nextTick()
    expect(wrapper.text()).toBe('9 MON')
    resolveOld(1n)
    await advance(0)
    await nextTick()
    expect(wrapper.text()).toBe('9 MON')
    wrapper.unmount()
  })

  it('does not count a stale failure toward backoff', async () => {
    configureBalancePolling({ random: () => 1 })
    let rejectOld: (e: Error) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>((_, reject) => (rejectOld = reject)),
    )
    const wrapper = mount(Consumer)
    await advance(0)
    await manualRefresh() // newer request succeeds
    rejectOld(new Error('late'))
    await advance(0)
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(3) // base interval, not backed off
    wrapper.unmount()
  })

  describe('Capacitor app pause/resume', () => {
    it('pauses on background and refreshes on resume when native', async () => {
      capacitor.isNative = true
      const wrapper = mount(Consumer)
      await advance(0)
      expect(capacitor.listener).toBeDefined()
      capacitor.listener?.({ isActive: false })
      await advance(BALANCE_POLL_MS * 3)
      expect(mockGetBalance).toHaveBeenCalledTimes(1)
      capacitor.listener?.({ isActive: true })
      await advance(0)
      expect(mockGetBalance).toHaveBeenCalledTimes(2)
      await advance(BALANCE_POLL_MS)
      expect(mockGetBalance).toHaveBeenCalledTimes(3)
      wrapper.unmount()
      expect(capacitor.remove).toHaveBeenCalledTimes(1)
    })

    it('does not register the plugin listener on the web', async () => {
      const wrapper = mount(Consumer)
      await advance(0)
      expect(capacitor.listener).toBeUndefined()
      wrapper.unmount()
    })

    it('falls back to visibilitychange when the plugin is unavailable', async () => {
      const warn = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined)
      capacitor.broken = true
      const wrapper = mount(Consumer)
      await advance(0)
      expect(warn).toHaveBeenCalled()
      setHidden(true)
      await advance(BALANCE_POLL_MS * 2)
      expect(mockGetBalance).toHaveBeenCalledTimes(1)
      setHidden(false)
      await advance(0)
      expect(mockGetBalance).toHaveBeenCalledTimes(2)
      wrapper.unmount()
      warn.mockRestore()
    })
  })
})
