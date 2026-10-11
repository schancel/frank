/** @jest-environment jsdom */

import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAppOracleFeed, useOracleHistory } from './useOracleFeed'
import { useOracleStore } from '../stores/oracle'
import { testFeed } from '../stores/oracle-test-feed'
import { developmentBuildActions } from '../../test/jest/utils/pinia-dev-build'

/** Stands in for the browser telling the page whether an element is on screen. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  disconnected = false
  constructor(private callback: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe() {
    // The element is reported on or off screen by show().
  }
  disconnect() {
    this.disconnected = true
  }
  show(isIntersecting: boolean) {
    this.callback([{ isIntersecting }])
  }
}

afterEach(() => {
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  FakeIntersectionObserver.instances = []
})

describe('useAppOracleFeed', () => {
  it('holds the feed for as long as the app shell is mounted, whatever is on screen', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const oracle = useOracleStore()
    let held = 0
    jest.spyOn(oracle, 'acquire').mockImplementation(() => {
      held++
      return () => {
        held--
      }
    })
    const wrapper = mount(
      defineComponent({
        setup() {
          useAppOracleFeed()
          return () => h('div')
        },
      }),
      { global: { plugins: [pinia] } },
    )
    await nextTick()
    expect(held).toBe(1)
    expect(oracle.acquire).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    expect(held).toBe(0)
  })
})

describe('the app shell, mounted in a development build', () => {
  const RELAY = 'http://127.0.0.1:28198'
  const realFetch = globalThis.fetch
  const realRelay = process.env.MONAD_RELAY_BASE_URL

  afterEach(() => {
    globalThis.fetch = realFetch
    if (realRelay === undefined) delete process.env.MONAD_RELAY_BASE_URL
    else process.env.MONAD_RELAY_BASE_URL = realRelay
  })

  // The bug of 2026-10-10: in `quasar dev` every AVU value was "Unavailable" and no price
  // request was ever made. Nothing here is replaced but the network call itself.
  it('asks its relay for the latest feed on mount, and the answer becomes the AVU rates', async () => {
    process.env.MONAD_RELAY_BASE_URL = RELAY
    const now = Math.floor(Date.now() / 1000)
    const requested: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return {
        status: 200,
        ok: true,
        json: async () =>
          testFeed([now], { prices: { 'monad-mainnet': 0.02 } }),
      }
    }) as unknown as typeof fetch

    const pinia = createPinia()
    pinia.use(developmentBuildActions)
    setActivePinia(pinia)
    const wrapper = mount(
      defineComponent({
        setup() {
          useAppOracleFeed()
          return () => h('div')
        },
      }),
      { global: { plugins: [pinia] } },
    )
    const oracle = useOracleStore()
    for (let turn = 0; turn < 20 && !oracle.avuHash; turn++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    expect(requested).toEqual([`${RELAY}/oracle/v1/feed?latest`])
    expect(oracle.avuHash?.kwhPerValue).toBeGreaterThan(0)
    expect(oracle.rates.monad).toBeGreaterThan(0)
    wrapper.unmount()
  })
})

describe('useOracleHistory', () => {
  function mountChart(
    range = ref<{ since: number; step: number } | null>(null),
  ) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const oracle = useOracleStore()
    const ensure = jest
      .spyOn(oracle, 'ensureHistory')
      .mockImplementation(async () => undefined)
    const acquire = jest.spyOn(oracle, 'acquire')
    const wrapper = mount(
      defineComponent({
        setup() {
          useOracleHistory(() => range.value)
          return () => h('div')
        },
      }),
      { global: { plugins: [pinia] } },
    )
    return { wrapper, ensure, acquire, range }
  }

  beforeEach(() => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver
  })

  it('asks for no history while its component is mounted but not on screen', async () => {
    const { ensure } = mountChart(ref({ since: 100, step: 60 }))
    await nextTick()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('asks for the range shown once the component is on screen, and again when the range changes', async () => {
    const { ensure, range } = mountChart(ref({ since: 100, step: 60 }))
    await nextTick()
    FakeIntersectionObserver.instances[0].show(true)
    await nextTick()
    expect(ensure.mock.calls).toEqual([[100, 60]])
    range.value = { since: 5, step: 3600 }
    await nextTick()
    expect(ensure.mock.calls).toEqual([
      [100, 60],
      [5, 3600],
    ])
    // Scrolled away and a new range chosen meanwhile: nothing is asked for.
    FakeIntersectionObserver.instances[0].show(false)
    range.value = { since: 1, step: 86_400 }
    await nextTick()
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('asks for nothing when the view needs no history, and never holds the live feed itself', async () => {
    const { ensure, acquire, wrapper } = mountChart(ref(null))
    await nextTick()
    FakeIntersectionObserver.instances[0].show(true)
    await nextTick()
    expect(ensure).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true)
  })

  it('counts mounted as on screen where visibility cannot be measured', async () => {
    delete (globalThis as { IntersectionObserver?: unknown })
      .IntersectionObserver
    const { ensure } = mountChart(ref({ since: 7, step: 600 }))
    await nextTick()
    expect(ensure.mock.calls).toEqual([[7, 600]])
  })
})
