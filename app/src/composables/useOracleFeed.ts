import { getCurrentInstance, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSafeOracleStore } from '../stores/oracle'

/**
 * Keeps the oracle's AVU rates current for as long as the app is running. Called once, by
 * the app shell: AVU figures stand beside balances and amounts on every screen, so the
 * feed is not tied to any one view. The store asks for the latest feed once per refresh
 * interval and never while the window is hidden (see its `acquire`).
 */
export function useAppOracleFeed(): void {
  const oracle = useSafeOracleStore()
  let release: (() => void) | undefined
  onMounted(() => {
    release = oracle.acquire?.()
  })
  onBeforeUnmount(() => {
    release?.()
    release = undefined
  })
}

/**
 * For the one view that draws history (the Parity chart): while the calling component's
 * root element is on screen, makes the oracle's local series hold the range the view
 * shows, asking the feed only for the stretches they lack. `range` gives the start of
 * the range (unix seconds) and its resolution, or null when the view needs no history.
 * An element hidden with v-show, inside a closed drawer or scrolled out of view asks for
 * nothing.
 */
export function useOracleHistory(
  range: () => { since: number; step: number } | null,
): void {
  const oracle = useSafeOracleStore()
  const instance = getCurrentInstance()
  const onScreen = ref(false)
  let observer: IntersectionObserver | null = null

  watch(
    () => {
      const wanted = onScreen.value ? range() : null
      return wanted ? `${wanted.since}:${wanted.step}` : ''
    },
    key => {
      if (!key) return
      const [since, step] = key.split(':').map(Number)
      void oracle.ensureHistory?.(since, step)
    },
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
  })
}
