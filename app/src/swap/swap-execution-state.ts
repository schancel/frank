/**
 * Read model of this session's HTLC swap runner (docs/plans/htlc-swaps/README.md, "Ownership").
 * The runner, started by session composition (`htlc-swap-execution.ts`), publishes its snapshot
 * here; the swap card only reads it. There are no commands: A's XEC lock follows the accept
 * automatically, B's MON lock follows its own accept, and claims and refunds follow the chains.
 */
import { shallowReactive } from 'vue'
import type { HtlcSwapView } from '@frank/swap-protocol/src/htlc-swap-runner'

/** `off`: no session, or a network without HTLC swaps; `starting`: opening the swap records and
 * wallets; `ready`: the runner is running; `failed`: it cannot run on this device (see
 * `failure`), and the card says so on every accepted swap. */
export type SwapExecutionStatus = 'off' | 'starting' | 'ready' | 'failed'

export type SwapExecutionFailure =
  /** No IndexedDB, or the swap record database could not be opened. */
  | 'storage-unavailable'
  /** The session's account or wallet key could not be read. */
  | 'account-unavailable'
  /** The eCash or EVM wallet has no HTLC capability (it is retried while `starting`). */
  | 'wallet-unavailable'
  /**
   * The browser holds this account's database of the retired execution records
   * (`frank-swap-execution-v1-<namespace>`), named in `oldDatabase`. They are not read or
   * migrated (development baseline, AGENTS §6); the runner does not start until the database is
   * deleted (browser developer tools → Application → IndexedDB), then the page is reloaded.
   */
  | 'old-execution-records'

export const swapExecutionState = shallowReactive({
  status: 'off' as SwapExecutionStatus,
  failure: null as SwapExecutionFailure | null,
  /** The retired database to delete, for `old-execution-records`. */
  oldDatabase: '',
  /** Whether this is the account's active device: only it acts; the others show progress. */
  activeDevice: true,
  /** The runner's last view of each swap, by lowercase swapId hex. */
  views: {} as Readonly<Record<string, HtlcSwapView>>,
})

export function swapExecutionView(swapIdHex: string): HtlcSwapView | undefined {
  return swapExecutionState.views[swapIdHex.toLowerCase()]
}

export function resetSwapExecutionState(): void {
  swapExecutionState.status = 'off'
  swapExecutionState.failure = null
  swapExecutionState.oldDatabase = ''
  swapExecutionState.activeDevice = true
  swapExecutionState.views = {}
}

export function publishSwapExecutionViews(
  views: readonly HtlcSwapView[],
): void {
  const next: Record<string, HtlcSwapView> = {}
  for (const view of views) next[view.swapId.toLowerCase()] = view
  swapExecutionState.views = next
}
