/** @jest-environment jsdom */

import { defineComponent, h, nextTick } from 'vue'
import { mount as vtuMount } from '@vue/test-utils'

import { walletNotReadyError } from './wallet-not-ready'
import {
  APP_STATE_EVENT,
  BALANCE_BACKOFF_MAX_MS,
  BALANCE_POLL_MS,
  CORDONED_POLL_MS,
  nextBalanceDelay,
  readCordonedBalance,
  useBalance,
} from './useBalance'

const mockGetBalance = jest.fn()
let mockSeed = 'a'
const mockWallets: Record<string, Promise<unknown>> = {}
jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
}))
const mockAccount = jest.requireMock('../accounts/session').accountStatus

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (amount: bigint) => amount.toString(),
    nativeTransfers: {
      getBalance: (...args: unknown[]) => mockGetBalance(...args),
    },
    directMessages: {
      chainHealth: () => mockChainHealth,
    },
  },
}))
let mockChainHealth: { reachable: boolean } = { reachable: true }
// Like the real one: memoized per seed, so a seed change yields a different promise.
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(
    () => (mockWallets[mockSeed] ??= Promise.resolve({ seed: mockSeed })),
  ),
}))

let refresh: () => Promise<void> = async () => undefined
let loadedNow: () => boolean = () => false
let errorNow: () => boolean = () => false

const Consumer = defineComponent({
  setup() {
    const api = useBalance()
    const { formattedBalance } = api
    refresh = api.refresh
    loadedNow = () => api.loaded.value
    errorNow = () => api.hasError.value
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
    mockSeed = 'a'
    mockAccount.status = 'ready'
    mockAccount.revision = 1
    for (const k of Object.keys(mockWallets)) delete mockWallets[k]
    jest.spyOn(Math, 'random').mockReturnValue(0.5)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    setHidden(false)
    errorSpy.mockRestore()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('waits quietly (no error log) while no seed exists yet, then loads once it does', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const useActiveWallet = jest.requireMock('src/composables/useActiveWallet')
      .useActiveWallet as jest.Mock
    const debugSpy = jest
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined)
    useActiveWallet.mockImplementation(() => {
      throw walletNotReadyError('no seed phrase set')
    })
    try {
      const wrapper = mount(Consumer)
      await advance(0)
      expect(errorSpy).not.toHaveBeenCalled()
      expect(debugSpy).toHaveBeenCalled()
      expect(mockGetBalance).not.toHaveBeenCalled()

      useActiveWallet.mockImplementation(
        () => (mockWallets[mockSeed] ??= Promise.resolve({ seed: mockSeed })),
      )
      await refresh()
      await advance(0)
      expect(wrapper.text()).toBe('1 MON')
    } finally {
      useActiveWallet.mockImplementation(
        () => (mockWallets[mockSeed] ??= Promise.resolve({ seed: mockSeed })),
      )
    }
  })

  it('still logs a real balance failure at error level', async () => {
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    mount(Consumer)
    await advance(0)
    expect(errorSpy).toHaveBeenCalledWith(
      'balance refresh failed',
      expect.any(Error),
    )
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
    jest.spyOn(Math, 'random').mockReturnValue(1) // always the top of the jitter window
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
    jest.spyOn(Math, 'random').mockReturnValue(0)
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
    jest.spyOn(Math, 'random').mockReturnValue(1)
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
    await refresh()
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
    await refresh()
    await nextTick()
    expect(wrapper.text()).toBe('9 MON')
    resolveOld(1n)
    await advance(0)
    await nextTick()
    expect(wrapper.text()).toBe('9 MON')
    wrapper.unmount()
  })

  it('does not count a stale failure toward backoff', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1)
    let rejectOld: (e: Error) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>((_, reject) => (rejectOld = reject)),
    )
    const wrapper = mount(Consumer)
    await advance(0)
    await refresh() // newer request succeeds
    rejectOld(new Error('late'))
    await advance(0)
    await advance(BALANCE_POLL_MS)
    expect(mockGetBalance).toHaveBeenCalledTimes(3) // base interval, not backed off
    wrapper.unmount()
  })

  describe('native app pause/resume (frank:app-state)', () => {
    const appState = (isActive: boolean) =>
      window.dispatchEvent(
        new CustomEvent(APP_STATE_EVENT, { detail: { isActive } }),
      )

    it('pauses on background and refreshes on resume', async () => {
      const wrapper = mount(Consumer)
      await advance(0)
      appState(false)
      await advance(BALANCE_POLL_MS * 3)
      expect(mockGetBalance).toHaveBeenCalledTimes(1)
      appState(true)
      await advance(0)
      expect(mockGetBalance).toHaveBeenCalledTimes(2)
      await advance(BALANCE_POLL_MS)
      expect(mockGetBalance).toHaveBeenCalledTimes(3)
      wrapper.unmount()
    })

    it('does not re-arm the timer when a fetch settles after backgrounding', async () => {
      let resolve: (v: bigint) => void = () => undefined
      mockGetBalance.mockReturnValueOnce(
        new Promise<bigint>(r => (resolve = r)),
      )
      const wrapper = mount(Consumer)
      await advance(0)
      appState(false)
      resolve(3n)
      await advance(0)
      expect(jest.getTimerCount()).toBe(0)
      await advance(BALANCE_POLL_MS * 3)
      expect(mockGetBalance).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('works with no event ever dispatched and removes its listener', async () => {
      const remove = jest.spyOn(window, 'removeEventListener')
      const wrapper = mount(Consumer)
      await advance(0)
      await advance(BALANCE_POLL_MS)
      expect(mockGetBalance).toHaveBeenCalledTimes(2)
      wrapper.unmount()
      expect(remove).toHaveBeenCalledWith(APP_STATE_EVENT, expect.any(Function))
      appState(true) // no listener left
      await advance(0)
      expect(mockGetBalance).toHaveBeenCalledTimes(2)
    })
  })

  describe('active wallet identity', () => {
    it('does not let an in-flight response for the old wallet write after a seed change', async () => {
      let resolveOld: (v: bigint) => void = () => undefined
      mockGetBalance.mockReturnValueOnce(
        new Promise<bigint>(r => (resolveOld = r)),
      )
      const wrapper = mount(Consumer)
      await advance(0)
      mockSeed = 'b'
      mockAccount.revision++
      mockGetBalance.mockResolvedValueOnce(2n)
      await refresh()
      await nextTick()
      expect(wrapper.text()).toBe('2 MON')
      resolveOld(99n)
      await advance(0)
      await nextTick()
      expect(wrapper.text()).toBe('2 MON')
      wrapper.unmount()
    })

    it('automatically refreshes the new revision and ignores a late old-wallet response', async () => {
      let resolveOld: (v: bigint) => void = () => undefined
      mockGetBalance.mockReturnValueOnce(
        new Promise<bigint>(r => (resolveOld = r)),
      )
      const wrapper = mount(Consumer)
      await advance(0)
      mockSeed = 'b'
      mockAccount.revision++
      resolveOld(99n)
      await advance(0)
      expect(loadedNow()).toBe(true)
      expect(wrapper.text()).toBe('1 MON')
      wrapper.unmount()
    })

    it('drops the old value at once on a seed change, even if the new fetch fails', async () => {
      mockGetBalance.mockResolvedValueOnce(5n)
      const wrapper = mount(Consumer)
      await advance(0)
      expect(loadedNow()).toBe(true)
      mockSeed = 'b'
      mockAccount.revision++
      mockGetBalance.mockRejectedValue(new Error('rpc down'))
      await refresh()
      expect(loadedNow()).toBe(false)
      expect(errorNow()).toBe(true)
      wrapper.unmount()
    })

    it('shows no old value when remounting after a seed change', async () => {
      mockGetBalance.mockResolvedValueOnce(5n)
      const first = mount(Consumer)
      await advance(0)
      first.unmount()
      mockSeed = 'b'
      mockAccount.revision++
      mockGetBalance.mockReturnValueOnce(new Promise(() => undefined))
      const second = mount(Consumer)
      await advance(0)
      expect(loadedNow()).toBe(false)
      second.unmount()
    })

    it('ignores a stale fetch that settles after the last unmount and a remount', async () => {
      let resolveOld: (v: bigint) => void = () => undefined
      mockGetBalance.mockReturnValueOnce(
        new Promise<bigint>(r => (resolveOld = r)),
      )
      const first = mount(Consumer)
      await advance(0)
      first.unmount()
      mockGetBalance.mockReturnValueOnce(new Promise(() => undefined))
      const second = mount(Consumer)
      await advance(0)
      resolveOld(42n)
      await advance(0)
      expect(loadedNow()).toBe(false)
      second.unmount()
    })
  })

  describe('loaded / error state', () => {
    it('is not loaded before the first success, errors on failure, recovers', async () => {
      mockGetBalance.mockRejectedValueOnce(new Error('rpc down'))
      const wrapper = mount(Consumer)
      expect(loadedNow()).toBe(false)
      await advance(0)
      expect(loadedNow()).toBe(false)
      expect(errorNow()).toBe(true)
      await advance(30000)
      expect(loadedNow()).toBe(true)
      expect(errorNow()).toBe(false)
      wrapper.unmount()
    })
  })

  it('a superseded failing request neither counts toward backoff nor clears the newer guard', async () => {
    let rejectOld: (e: Error) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>((_, reject) => (rejectOld = reject)),
    )
    mockGetBalance.mockReturnValueOnce(new Promise(() => undefined)) // newer, hangs
    const wrapper = mount(Consumer)
    await advance(0)
    void refresh() // supersedes; the newer request hangs
    await advance(0)
    rejectOld(new Error('late'))
    await advance(0)
    expect(errorNow()).toBe(false)
    // Newer request is still pending: ticks must still be skipped.
    await advance(BALANCE_POLL_MS * 3)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('a superseded failure does not lengthen the next backoff delay', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1)
    let rejectOld: (e: Error) => void = () => undefined
    mockGetBalance.mockReturnValueOnce(
      new Promise<bigint>((_, reject) => (rejectOld = reject)),
    )
    const wrapper = mount(Consumer)
    await advance(0)
    mockGetBalance.mockRejectedValue(new Error('rpc down'))
    await refresh() // newer request fails: 1 failure, next attempt in 30s
    rejectOld(new Error('late')) // stale: must not count
    await advance(0)
    await advance(30000)
    expect(mockGetBalance).toHaveBeenCalledTimes(3) // 2 failures now: next in 60s, not 120s
    await advance(60000)
    expect(mockGetBalance).toHaveBeenCalledTimes(4)
    wrapper.unmount()
  })

  it('regression #534: 60-second persistent outage asserts bounded request count, cancellation, and recovery', async () => {
    // Top of jitter window so delays are deterministic: failure 1 -> 30s, failure 2 -> 60s
    jest.spyOn(Math, 'random').mockReturnValue(1)
    mockGetBalance.mockRejectedValue(new Error('503 Service Unavailable'))
    const wrapper = mount(Consumer)

    // Initial mount at t=0s triggers fetch #1
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(1)
    expect(errorNow()).toBe(true)

    // Over 60 seconds of persistent outage:
    // With 1st backoff = 30s, fetch #2 happens at t=30s
    // With 2nd backoff = 60s, fetch #3 would not happen until t=90s
    // So within 60s, total fetches is exactly 2 (strictly bounded vs ~60 from 1s loop)
    await advance(30000)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)

    await advance(29999)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)

    // Unmounting the consumer at t=60s cancels polling
    wrapper.unmount()
    expect(jest.getTimerCount()).toBe(0)

    // Advancing further produces zero requests (cancellation confirmed)
    await advance(60000)
    expect(mockGetBalance).toHaveBeenCalledTimes(2)

    // When a consumer remounts after RPC recovers, balance refreshes promptly and resets backoff
    mockGetBalance.mockResolvedValue(100n)
    const newWrapper = mount(Consumer)
    await advance(0)
    expect(mockGetBalance).toHaveBeenCalledTimes(3)
    expect(errorNow()).toBe(false)
    expect(loadedNow()).toBe(true)
    expect(newWrapper.text()).toBe('100 MON')
    newWrapper.unmount()
  })

  // Funds at the profile (identity) address are part of the wallet's own balance now: the wallet
  // spends them like any other coin, so nothing is reported beside the balance any more.

  it('shows the complete wallet balance once, including profile and sending accounts', async () => {
    mockGetBalance.mockResolvedValue(1640n)
    const wrapper = mount(Consumer)
    await advance(0)
    const api = useBalance()
    expect(api.balance.value).toBe(1640n)
    expect(api.total.value).toBe(1640n)
    expect(api.cordoned.value).toBe(0n)
    expect(wrapper.text()).toBe('1640 MON')
    // Opening the Wallet page must not add a second profile-address observation.
    await api.refreshCordoned()
    expect(api.total.value).toBe(1640n)
    expect(wrapper.text()).toBe('1640 MON')
  })

  it('allows useBalance().refresh() to be invoked outside an active component instance', async () => {
    mockGetBalance.mockResolvedValue(500n)
    const api = useBalance()
    await api.refresh()
    expect(mockGetBalance).toHaveBeenCalled()
    expect(api.balance.value).toBe(500n)
    expect(api.formattedBalance.value).toBe('500 MON')
  })

  // The owner's rule: when the chain cannot be reached, a warning for that chain is shown.
  it("says the chain cannot be reached when the wallet's own reads say so or the balance read fails on the network, and clears it when the chain answers again", async () => {
    mockChainHealth = { reachable: true }
    const api = useBalance()
    await api.refresh()
    expect(api.chainUnreachable.value).toBe(false)
    // The wallet's reads (a send's fee or nonce read) found the node not answering.
    mockChainHealth = { reachable: false }
    await api.refresh()
    expect(api.chainUnreachable.value).toBe(true)
    mockChainHealth = { reachable: true }
    await api.refresh()
    expect(api.chainUnreachable.value).toBe(false)
    // The balance read itself fails on the network.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockGetBalance.mockRejectedValueOnce(new Error('Failed to fetch'))
    await api.refresh()
    expect(api.chainUnreachable.value).toBe(true)
    mockGetBalance.mockResolvedValue(1n)
    await api.refresh()
    expect(api.chainUnreachable.value).toBe(false)
  })
})
