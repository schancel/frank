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
import {
  computed,
  getCurrentInstance,
  onMounted,
  onUnmounted,
  readonly,
  ref,
  watch,
} from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { accountStatus } from '../accounts/session'
import { messagingState } from '../utils/messaging-state'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { isWalletNotReady } from 'src/composables/wallet-not-ready'
import { formatDisplayAmount, formatRawAmount } from 'src/utils/chain-amount'

/** Window event the capacitor-only boot file dispatches on native app pause/resume, so this
 * composable needs no Capacitor import (the SPA/Electron builds deliberately never load it). */
export const APP_STATE_EVENT = 'frank:app-state'

export const BALANCE_POLL_MS = 15000
/** The profile address is read at most this often by the polling loop. The loop ticks every 3 s
 * while the spendable balance is zero, which is exactly when an account holds only cordoned
 * funds; without this bound that account asked the RPC for the same balance every tick, forever.
 * `refreshCordoned()` (the Wallet page opening) reads at once regardless. */
export const CORDONED_POLL_MS = 30000
export const BALANCE_BACKOFF_MAX_MS = 5 * 60 * 1000

// What the wallet itself reports as its balance (`getBalance`): the figure its own checks compare
// a native send or a payment to a contact against. null until the first successful fetch for the
// active wallet (so consumers can tell "not loaded" from a real zero); cleared when the wallet
// changes or the last consumer unmounts.
const balance = ref<bigint | null>(null)
const hasError = ref(false)
// The active wallet's chain cannot be reached: the wallet's own reads say so (`chainHealth`),
// or the balance read just failed on the network. Shown as a warning for that chain; paid
// messages queue meanwhile.
const chainUnreachable = ref(false)
const loaded = computed(() => balance.value !== null)
// Money at the profile address of an account whose deposit address is a different one (what a
// faucet or anyone who only knows the profile pays to). The wallet's `getBalance` leaves it out,
// although the wallet does pay message stamps from it when the main account is empty. Zero when
// the two addresses are the same.
const cordoned = ref<bigint>(0n)
// THE wallet balance every screen shows (Wallet page, wallet list, chat sidebar, Receive): what
// the wallet reports plus the profile address. One figure, computed here only, until the wallet
// exposes a single total of its own. null while not loaded.
const total = computed(() =>
  balance.value === null ? null : balance.value + cordoned.value,
)
// True only for a real, loaded zero (never for "not loaded yet" or a failed fetch).
const isEmpty = computed(() => total.value === 0n)
// The shown balance, shortened for reading (`formatDisplayAmount`); the `exact…` twin carries
// every digit for a title. Neither is an input to arithmetic.
const formattedBalance = computed(() =>
  formatDisplayAmount(activeChain, total.value ?? 0n),
)
const exactBalance = computed(() =>
  formatRawAmount(activeChain, total.value ?? 0n),
)
// The narrower figure, for the screens whose payment the wallet checks against `balance` alone
// (a payment to a contact): shown there under its own label, so the screen never offers a total
// the wallet will then refuse.
const formattedSpendable = computed(() =>
  formatDisplayAmount(activeChain, balance.value ?? 0n),
)
const exactSpendable = computed(() =>
  formatRawAmount(activeChain, balance.value ?? 0n),
)

/** The profile address's current balance for an account whose receive address differs from it
 * (a typed account); zero when they are the same address, which the wallet balance already
 * covers. A read only. */
export async function readCordonedBalance(_wallet: unknown): Promise<bigint> {
  // The wallet's own balance now counts money at the profile (identity) address: it is spendable
  // like any other coin. Nothing is held apart from it, so there is nothing to add on top.
  return 0n
}

let consumers = 0
// When the profile address was last asked for (success or failure); undefined: ask on next fetch.
let cordonedReadAtMs: number | undefined
let requestId = 0
let pending = false
let failures = 0
let backgrounded = false
let timer: ReturnType<typeof setTimeout> | undefined
// Acquisition revalidates custody every time; promises are not identity authorities.
let walletKey: number | undefined
let stopSessionWatch: (() => void) | undefined

function currentWalletKey(): number | undefined {
  return accountStatus.status === 'ready' ? accountStatus.revision : undefined
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
  if (
    consumers === 0 ||
    typeof document === 'undefined' ||
    !document ||
    document.hidden ||
    backgrounded
  )
    return
  const delay =
    failures <= 0 && (balance.value === null || balance.value === 0n)
      ? 3000
      : nextBalanceDelay(failures)
  timer = setTimeout(() => {
    timer = undefined
    if (pending)
      schedule() // still waiting on a fetch: skip this tick, keep ticking
    else void fetchBalance(true)
  }, delay)
}

/** Fetches now. `force` (also what `refresh()` does) bypasses the in-flight guard. */
async function fetchBalance(force: boolean) {
  const key = currentWalletKey()
  if (key !== walletKey) {
    // Wallet changed: drop the old value and invalidate anything still in flight for it.
    walletKey = key
    balance.value = null
    cordoned.value = 0n
    cordonedReadAtMs = undefined
    hasError.value = false
    chainUnreachable.value = false
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
    const wallet = await useActiveWallet()
    if (!isCurrent()) return
    if (typeof activeChain?.nativeTransfers?.getBalance !== 'function') return
    const next = await activeChain.nativeTransfers.getBalance({ wallet })
    if (!isCurrent()) return
    balance.value = next
    // Best effort: a failed read keeps the last cordoned amount and never fails the balance.
    // Throttled (`CORDONED_POLL_MS`); a failed read also waits out the interval.
    const now = Date.now()
    if (
      cordonedReadAtMs === undefined ||
      now - cordonedReadAtMs >= CORDONED_POLL_MS
    ) {
      cordonedReadAtMs = now
      const held = await readCordonedBalance(wallet).catch(() => undefined)
      if (!isCurrent()) return
      if (held !== undefined) cordoned.value = held
    }
    hasError.value = false
    failures = 0
    let health: { reachable: boolean } | undefined
    try {
      health = activeChain.directMessages?.chainHealth?.({ wallet })
    } catch {
      health = undefined
    }
    chainUnreachable.value = health?.reachable === false
  } catch (err) {
    // The setup route may render the drawer before a seed exists: not an error, keep polling.
    // Anything else is a real failure worth an error-level log.
    if (isWalletNotReady(err)) {
      console.debug('balance refresh waiting for a wallet (no seed phrase yet)')
    } else if (
      messagingState.status !== 'ready' &&
      (String(err).includes('rpc_auth_failed') || String(err).includes('401'))
    ) {
      console.debug('balance refresh waiting for directory admission')
    } else {
      const errStr =
        String(err) +
        (err instanceof Error ? ' ' + err.message : '') +
        (typeof err === 'object' && err !== null && 'info' in err
          ? ' ' + JSON.stringify((err as any).info)
          : '')
      const isTransientRpc =
        errStr.includes('502') ||
        errStr.includes('503') ||
        errStr.includes('504') ||
        errStr.includes('429') ||
        errStr.includes('SERVER_ERROR') ||
        errStr.includes('TIMEOUT') ||
        errStr.includes('invalid_rpc_upstream_response') ||
        errStr.includes('rpc_upstream_unavailable') ||
        errStr.includes('network') ||
        errStr.includes('failed to fetch') ||
        errStr.includes('Failed to fetch')

      if (isTransientRpc) {
        if (isCurrent()) chainUnreachable.value = true
        console.warn('balance refresh transient rpc issue (will retry)', err)
      } else {
        console.error('balance refresh failed', err)
      }
    }
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
    stopSessionWatch = watch(
      () =>
        [
          accountStatus.revision,
          accountStatus.status,
          messagingState.status,
        ] as const,
      ([newRev, newAccStatus, newMsgStatus], oldValue) => {
        const [oldRev, oldAccStatus, oldMsgStatus] = oldValue ?? []
        if (newRev !== oldRev || newAccStatus !== oldAccStatus) {
          balance.value = null
          cordoned.value = 0n
          cordonedReadAtMs = undefined
          hasError.value = false
          requestId++
          pending = false
          void fetchBalance(true)
        } else if (newMsgStatus === 'ready' && oldMsgStatus !== 'ready') {
          void fetchBalance(true)
        }
      },
      { flush: 'sync' },
    )
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(APP_STATE_EVENT, onAppState)
  }
  void fetchBalance(false)
}

function release() {
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0) return
  clearTimer()
  stopSessionWatch?.()
  stopSessionWatch = undefined
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener(APP_STATE_EVENT, onAppState)
  backgrounded = false
  balance.value = null
  cordoned.value = 0n
  cordonedReadAtMs = undefined
  hasError.value = false
  walletKey = undefined
  // Invalidate anything in flight so a fresh first consumer never inherits a stale guard.
  requestId++
  pending = false
  failures = 0
}

export function useBalance() {
  if (getCurrentInstance()) {
    onMounted(acquire)
    onUnmounted(release)
  }
  return {
    balance: readonly(balance),
    formattedBalance,
    exactBalance,
    total,
    formattedSpendable,
    exactSpendable,
    cordoned: readonly(cordoned),
    loaded,
    isEmpty,
    hasError,
    chainUnreachable: readonly(chainUnreachable),
    refresh: () => fetchBalance(true),
    /** Refreshes now and reads the profile address too, whenever it was last read. */
    refreshCordoned: () => {
      cordonedReadAtMs = undefined
      return fetchBalance(true)
    },
  }
}
