/** @jest-environment jsdom */

import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleFeed } from './useOracleFeed'
import { useOracleStore } from '../stores/oracle'
import type { HistoryRange } from '@frank/wallet/oracle'

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

function mountConsumer(
  range = ref<HistoryRange | null>(null),
  shown = ref(true),
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const oracle = useOracleStore()
  const held: string[] = []
  jest.spyOn(oracle, 'acquire').mockImplementation(feed => {
    held.push(feed)
    return () => {
      held.splice(held.indexOf(feed), 1)
    }
  })
  const wrapper = mount(
    defineComponent({
      setup() {
        useOracleFeed(
          () => (range.value ? { asset: 'solana', range: range.value } : null),
          () => shown.value,
        )
        return () => h('div')
      },
    }),
    { global: { plugins: [pinia] } },
  )
  return { wrapper, held, range }
}

afterEach(() => {
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  FakeIntersectionObserver.instances = []
})

describe('useOracleFeed', () => {
  beforeEach(() => {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver
  })

  it('holds nothing while its component is mounted but not on screen', async () => {
    const { wrapper, held } = mountConsumer()
    await nextTick()
    expect(held).toEqual([])
    FakeIntersectionObserver.instances[0].show(false)
    expect(held).toEqual([])
    wrapper.unmount()
  })

  it('holds nothing while its owner says it is not shown, whatever the browser reports', async () => {
    const shown = ref(false)
    const { wrapper, held } = mountConsumer(undefined, shown)
    FakeIntersectionObserver.instances[0].show(true)
    expect(held).toEqual([])
    shown.value = true
    expect(held).toEqual(['live'])
    shown.value = false
    expect(held).toEqual([])
    wrapper.unmount()
  })

  it('holds the live prices while on screen and lets go the moment it is hidden', () => {
    const { wrapper, held } = mountConsumer()
    const screen = FakeIntersectionObserver.instances[0]
    screen.show(true)
    expect(held).toEqual(['live'])
    // Hidden with v-show, a closed drawer, another tab panel: the browser reports it gone.
    screen.show(false)
    expect(held).toEqual([])
    screen.show(true)
    expect(held).toEqual(['live'])
    wrapper.unmount()
    expect(held).toEqual([])
    expect(screen.disconnected).toBe(true)
  })

  it('holds the candles of the open coin and range, and swaps them when the range changes', () => {
    const { wrapper, held, range } = mountConsumer(
      ref<HistoryRange | null>('24h'),
    )
    FakeIntersectionObserver.instances[0].show(true)
    expect(held).toEqual(['live', 'history:solana:24h'])
    range.value = '7d'
    expect(held).toEqual(['live', 'history:solana:7d'])
    // A long range is drawn from bundled files: no candles are held for it.
    range.value = null
    expect(held).toEqual(['live'])
    wrapper.unmount()
    expect(held).toEqual([])
  })
})

it('where the browser cannot report visibility, mounted counts as on screen', () => {
  const { wrapper, held } = mountConsumer()
  expect(held).toEqual(['live'])
  wrapper.unmount()
  expect(held).toEqual([])
})
