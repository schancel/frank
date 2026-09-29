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
 *   Capacitor native app, `boot/capacitor.ts` (capacitor mode only) forwards the plugin's
 *   `appStateChange` as a `frank:app-state` window event handled the same way (a backgrounded app
 *   never re-arms the timer). There is no Capacitor import here.
 * - After failures the next tick is delayed with exponential backoff (bounded, "equal jitter":
 *   half deterministic, half random) so clients do not hammer an unhealthy RPC in lockstep. A
 *   success resets it. Failures are logged with `console.error`; there is no UI error state.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { activeChain, WalletHandle } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'

/** Window event the capacitor-only boot file dispatches on native app pause/resume, so this
 * composable needs no Capacitor import (the SPA/Electron builds deliberately never load it). */
export const APP_STATE_EVENT = 'frank:app-state'

export const BALANCE_POLL_MS = 15000
export const BALANCE_BACKOFF_MAX_MS = 5 * 60 * 1000

// null until the first successful fetch for the active wallet (so consumers can tell "not
// loaded" from a real zero); cleared when the wallet changes or the last consumer unmounts.
const balance = ref<bigint | null>(null)
const hasError = ref(false)
const loaded = computed(() => balance.value !== null)
const formattedBalance = computed(
  () =>
    `${activeChain.toDisplayAmount(balance.value ?? 0n)} ${activeChain.unit}`,
)

let consumers = 0
let requestId = 0
let pending = false
let failures = 0
let backgrounded = false
let timer: ReturnType<typeof setTimeout> | undefined
// Identity of the wallet the current value/in-flight request belong to. `useActiveWallet`
// memoizes its promise per seed phrase, so a new seed yields a new promise.
let walletKey: Promise<WalletHandle> | undefined

function currentWalletKey(): Promise<WalletHandle> | undefined {
  try {
    return useActiveWallet()
  } catch {
    return undefined // no seed yet
  }
}

/** Delay before the next tick: the base interval while healthy, else bounded jittered backoff. */
export function nextBalanceDelay(
  failureCount: number,
  rand = Math.random,
): number {
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
  if (consumers === 0 || document.hidden || backgrounded) return
  timer = setTimeout(() => {
    timer = undefined
    if (pending)
      schedule() // still waiting on a fetch: skip this tick, keep ticking
    else void fetchBalance(true)
  }, nextBalanceDelay(failures))
}

/** Fetches now. `force` (also what `refresh()` does) bypasses the in-flight guard. */
async function fetchBalance(force: boolean) {
  const key = currentWalletKey()
  if (key !== walletKey) {
    // Wallet changed: drop the old value and invalidate anything still in flight for it.
    walletKey = key
    balance.value = null
    hasError.value = false
    failures = 0
    requestId++
    pending = false
  }
  if (pending && !force) return
  const id = ++requestId
  pending = true
  schedule()
  const isCurrent = () => id === requestId && currentWalletKey() === key
  try {
    const wallet = await (key ?? useActiveWallet())
    const next = await activeChain.nativeTransfers.getBalance({ wallet })
    if (!isCurrent()) return
    balance.value = next
    hasError.value = false
    failures = 0
  } catch (err) {
    // The setup route may render the drawer before a seed exists; log and keep polling.
    console.error('balance refresh failed', err)
    if (isCurrent()) {
      failures++
      hasError.value = true
    }
  } finally {
    if (id === requestId) {
      pending = false
      schedule()
    }
  }
}

function resume() {
  backgrounded = false
  void fetchBalance(true)
}

function onVisibilityChange() {
  if (document.hidden) clearTimer()
  else resume()
}

function onAppState(event: Event) {
  const isActive = (event as CustomEvent<{ isActive: boolean }>).detail
    ?.isActive
  if (isActive) {
    resume()
  } else {
    backgrounded = true
    clearTimer()
  }
}

function acquire() {
  consumers++
  if (consumers === 1) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(APP_STATE_EVENT, onAppState)
  }
  void fetchBalance(false)
}

function release() {
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0) return
  clearTimer()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener(APP_STATE_EVENT, onAppState)
  backgrounded = false
  balance.value = null
  hasError.value = false
  walletKey = undefined
  // Invalidate anything in flight so a fresh first consumer never inherits a stale guard.
  requestId++
  pending = false
  failures = 0
}

export function useBalance() {
  onMounted(acquire)
  onUnmounted(release)
  return {
    formattedBalance,
    loaded,
    hasError,
    refresh: () => fetchBalance(true),
  }
}
