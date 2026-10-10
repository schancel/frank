import { getCurrentInstance, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  historyFeed,
  useSafeOracleStore,
  type OracleFeed,
} from '../stores/oracle'
import type { HistoryRange, SupportedAsset } from '@frank/wallet/oracle'

/**
 * Keeps the oracle's prices current for as long as the calling component is actually on
 * screen, and not a moment longer.
 *
 * The component holds the 'live' feed (prices and chain statistics) while its root element
 * is mounted and visible: an element hidden with v-show, inside a closed drawer or
 * scrolled out of view holds nothing, so nothing is fetched for it. A caller that knows
 * for itself whether it is shown passes `shown`, and holds nothing while that is false,
 * whatever the browser reports about the element. With `history`, it
 * also holds that coin's candles for that chart range, and swaps them as the selection
 * changes. Everything is released on unmount.
 *
 * Holding a feed never fetches by itself more than the oracle's interval allows; it only
 * says someone is looking (see the oracle store's `acquire`).
 */
export function useOracleFeed(
  history?: () => { asset: SupportedAsset; range: HistoryRange } | null,
  /** The owner's own word on whether it is shown, e.g. a drawer panel's selected tab. */
  shown: () => boolean = () => true,
): void {
  const oracle = useSafeOracleStore()
  const instance = getCurrentInstance()
  const onScreen = ref(false)
  let observer: IntersectionObserver | null = null

  const held = new Map<OracleFeed, () => void>()
  function hold(feeds: OracleFeed[]) {
    held.forEach((release, feed) => {
      if (feeds.includes(feed)) return
      release()
      held.delete(feed)
    })
    for (const feed of feeds) {
      if (held.has(feed)) continue
      const release = oracle.acquire?.(feed)
      if (release) held.set(feed, release)
    }
  }

  watch(
    () => {
      if (!onScreen.value || !shown()) return []
      const selected = history?.()
      return [
        'live',
        ...(selected ? [historyFeed(selected.asset, selected.range)] : []),
      ] as OracleFeed[]
    },
    hold,
    // Released in the same tick the element leaves the screen.
    { flush: 'sync' },
  )

  onMounted(() => {
    const element = instance?.proxy?.$el as Element | undefined
    if (
      typeof IntersectionObserver === 'undefined' ||
      !(element instanceof Element)
    ) {
      // Nothing to measure visibility with: mounted counts as on screen.
      onScreen.value = true
      return
    }
    observer = new IntersectionObserver(entries => {
      onScreen.value = entries[entries.length - 1].isIntersecting
    })
    observer.observe(element)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    onScreen.value = false
    hold([])
  })
}
