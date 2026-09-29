/**
 * Shared, ref-counted source of the active wallet's native balance (ticket #213).
 *
 * The drawer and the Receive page used to keep independent copies (the drawer polled, Receive
 * fetched once on mount and went stale). Every consumer of `useBalance()` now reads the same
 * `balance` ref, and ONE polling loop runs for all of them: it starts when the first consumer
 * mounts and stops when the last one unmounts.
 *
 * Loop rules (moved here unchanged from the drawer's own polling, plus backoff/resume):
 * - A tick is skipped while a fetch is pending; a monotonic request id makes a superseded (older)
 *   response unable to overwrite a newer balance. `refresh()` bypasses the guard and supersedes
 *   whatever is in flight.
 * - Polling pauses while `document.hidden` and refreshes immediately when visible again. On a
 *   Capacitor native app the plugin's `appStateChange` (pause/resume) does the same. The plugin
 *   ships inside `@capacitor/core` 2.x (no extra dependency), is imported lazily and gated on
 *   `Capacitor.isNative`, and any failure to load it falls back to `visibilitychange` alone.
 * - After failures the next tick is delayed with exponential backoff (bounded, "equal jitter":
 *   half deterministic, half random) so clients do not hammer an unhealthy RPC in lockstep. A
 *   success resets it. Failures are logged with `console.error`; there is no UI error state.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'

export const BALANCE_POLL_MS = 15000
export const BALANCE_BACKOFF_MAX_MS = 5 * 60 * 1000

const balance = ref(0n)
const formattedBalance = computed(
  () => `${activeChain.toDisplayAmount(balance.value)} ${activeChain.unit}`,
)

let consumers = 0
let requestId = 0
let pending = false
let failures = 0
let timer: ReturnType<typeof setTimeout> | undefined
let random: () => number = Math.random
let removeAppListener: (() => void) | undefined
let appListenerGeneration = 0

/** Test seam: inject the random source used for jitter. Call with no argument to restore. */
export function configureBalancePolling(opts: { random?: () => number } = {}) {
  random = opts.random ?? Math.random
}

/** Delay before the next tick: the base interval while healthy, else bounded jittered backoff. */
export function nextBalanceDelay(failureCount: number, rand = random): number {
  if (failureCount <= 0) return BALANCE_POLL_MS
  const cap = Math.min(
    BALANCE_BACKOFF_MAX_MS,
    BALANCE_POLL_MS * 2 ** Math.min(failureCount, 30),
  )
  return Math.round(cap / 2 + (rand() * cap) / 2)
}

function clearTimer() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function schedule() {
  clearTimer()
  if (consumers === 0 || document.hidden) return
  timer = setTimeout(() => {
    timer = undefined
    if (pending)
      schedule() // still waiting on a fetch: skip this tick, keep ticking
    else void refresh()
  }, nextBalanceDelay(failures))
}

/** Fetches now. `force` (also what `refresh()` does) bypasses the in-flight guard. */
async function fetchBalance(force: boolean) {
  if (pending && !force) return
  const id = ++requestId
  pending = true
  schedule()
  try {
    const wallet = await useActiveWallet()
    const next = await activeChain.nativeTransfers.getBalance({ wallet })
    if (id !== requestId) return
    balance.value = next
    failures = 0
  } catch (err) {
    // The setup route may render the drawer before a seed exists; log and keep polling.
    console.error('balance refresh failed', err)
    if (id === requestId) failures++
  } finally {
    if (id === requestId) {
      pending = false
      schedule()
    }
  }
}

/** Manual refresh that supersedes any in-flight request. */
export function refresh(): Promise<void> {
  return fetchBalance(true)
}

function resume() {
  void refresh()
}

function onVisibilityChange() {
  if (document.hidden) clearTimer()
  else resume()
}

async function listenForAppState() {
  const generation = ++appListenerGeneration
  try {
    const { Capacitor, Plugins } = await import('@capacitor/core')
    if (!Capacitor.isNative || generation !== appListenerGeneration) return
    const handle = Plugins?.App?.addListener('appStateChange', state => {
      if (state.isActive) resume()
      else clearTimer()
    })
    if (!handle) return
    removeAppListener = () => void handle.remove()
    // Stopped while the import was in flight: undo immediately.
    if (generation !== appListenerGeneration) stopAppListener()
  } catch (err) {
    // Web build / plugin unavailable: visibilitychange alone still covers the browser.
    console.warn('app pause/resume listener unavailable', err)
  }
}

function stopAppListener() {
  appListenerGeneration++
  removeAppListener?.()
  removeAppListener = undefined
}

function acquire() {
  consumers++
  if (consumers === 1) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    void listenForAppState()
  }
  void fetchBalance(false)
}

function release() {
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0) return
  clearTimer()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  stopAppListener()
  // Invalidate anything in flight so a fresh first consumer never inherits a stale guard.
  requestId++
  pending = false
  failures = 0
}

export function useBalance() {
  onMounted(acquire)
  onUnmounted(release)
  return { balance, formattedBalance, refresh }
}
