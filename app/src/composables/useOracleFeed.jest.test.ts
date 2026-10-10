/** @jest-environment jsdom */

import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAppOracleFeed, useOracleHistory } from './useOracleFeed'
import { useOracleStore } from '../stores/oracle'

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
