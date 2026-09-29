/**
 * Chain-bisection recovery of the "next unused change index" pointer (ticket #36 acceptance
 * criterion 4) -- a *fallback*, explicitly NOT the live day-to-day bookkeeping mechanism
 * (`MonadChangePool`'s persisted `ChangePoolStore` pointer, `./monad-change-pool.ts`, is that).
 * This module exists for restoring a wallet from its seed (mnemonic) alone, with no local
 * `ChangePoolStore` state to trust -- e.g. a fresh install, corrupted/lost local storage, or any
 * situation where the persisted pointer is missing or suspect.
 *
 * Why bisection works here, and why it's *only* safe as a recovery tool
 * -----------------------------------------------------------------------
 * Change indices are allocated strictly sequentially (`MonadChangePool.sweepToChange`, index 0,
 * then 1, then 2, ... in order, never reused, never skipped) -- so "has index i been used" is
 * monotonic across indices: every index below the true boundary is used, every index at or above
 * it is unused. That monotonicity is exactly what makes a binary search over the boundary valid.
 * It also means it's ONLY valid for the *confirmed* on-chain state -- a change index whose funding
 * sweep was just submitted but hasn't confirmed yet would still read as "unused" here (no nonce,
 * no balance visible on-chain yet), which would make the monotonic assumption false for that one
 * moment: index i "unused" while index i-1 (also just-submitted, or already confirmed) is "used"
 * is fine, but if a caller ran this *concurrently* with an in-flight sweep and then blindly trusted
 * the result as an up-to-the-instant live pointer, it could momentarily under-count and later
 * double-allocate that same index once the pending sweep confirms. Concretely: never call this
 * while any sweep might still be in flight, and never call it in the hot path of `sweepToChange`
 * itself. `MonadChangePool.setNextUnusedIndex` guards against clobbering real local records for
 * exactly this class of risk, but can't guard against feeding it a value taken from a
 * still-unconfirmed chain view -- that's on the caller.
 *
 * "Used" check: `nonce > 0 OR balance > 0` (per ticket's design, not balance alone)
 * -----------------------------------------------------------------------------------
 * An EVM account's nonce only increments when it *originates* a transaction (spends out), never
 * when it merely *receives* one. So the two failure modes balance-alone would miss are both
 * covered by adding the nonce check:
 *   - received-and-fully-spent-out: balance may be back to (near) zero, but nonce > 0 proves it
 *     was used.
 *   - received-and-still-held: balance > 0 directly, regardless of nonce.
 * `nonce > 0 || balance > 0` is complete across a change account's whole lifecycle (received and
 * held vs. received and later spent out) -- balance alone would misclassify the second case as
 * "unused" once fully drained.
 */
import { Provider } from 'ethers'

import { MonadChangeKeyring } from './monad-change-keyring'

/** Default safety cap on how many indices `recoverNextChangeIndex`'s exponential search will
 * probe before giving up -- guards against an unbounded RPC loop (e.g. against a misconfigured
 * keyring/provider pointed at the wrong network, where every index would otherwise look "used"
 * forever). `2**20` (~1,048,576) is comfortably beyond any realistic wallet's lifetime
 * change-account count at this hackathon's scale, while still cheap to search in O(log n) RPC
 * round-trips if genuinely needed. */
export const DEFAULT_MAX_CHANGE_INDEX_SEARCH = 2 ** 20

/** The `nonce > 0 OR balance > 0` used/unused check this file's header describes, for a single
 * change-account address. Exported for reuse/testing (e.g. a caller wanting to sanity-check one
 * specific index without running a full recovery search). */
export async function isChangeIndexUsed(
  provider: Provider,
  address: string
): Promise<boolean> {
  const [nonce, balance] = await Promise.all([
    provider.getTransactionCount(address),
    provider.getBalance(address),
  ])
  return nonce > 0 || balance > BigInt(0)
}

export interface RecoverNextChangeIndexParams {
  /** The change keyring (same root secret as the live wallet's) used to derive each candidate
   * index's address for the on-chain probe. */
  keyring: MonadChangeKeyring
  /** ethers `Provider` used for the `nonce`/`balance` reads driving `isChangeIndexUsed`. */
  provider: Provider
  /** Safety cap on the exponential search -- see `DEFAULT_MAX_CHANGE_INDEX_SEARCH`. */
  maxIndex?: number
  /** First allocatable index. Restored roots reserve index 0, so they search from 1. */
  minimumIndex?: number
}

/**
 * Reconstructs the "next unused change index" pointer from chain data alone (ticket #36 acceptance
 * criterion 4), by bisecting for the used/unused boundary -- see this file's header for why that's
 * valid (strict sequential allocation) and why this is a recovery-only tool, never the live
 * bookkeeping path.
 *
 * Algorithm: exponential search for an upper bound known to be unused (doubling from index 1),
 * then binary search within that range for the exact boundary. Every change index below the
 * returned value is used; the returned value itself, and everything at or above it, is unused.
 * O(log n) `isChangeIndexUsed` calls (2 RPC reads each) in the number of indices actually used.
 *
 * Returns `0` immediately (no search needed) if index 0 itself is unused -- the common case for a
 * wallet that has never swept any change yet. Throws if no unused index is found within
 * `maxIndex` (default `DEFAULT_MAX_CHANGE_INDEX_SEARCH`) -- almost certainly a misconfigured
 * `provider`/`keyring` pair (wrong network, wrong root secret) rather than a legitimately
 * enormous change-account history.
 */
export async function recoverNextChangeIndex(
  params: RecoverNextChangeIndexParams
): Promise<number> {
  const { keyring, provider } = params
  const maxIndex = params.maxIndex ?? DEFAULT_MAX_CHANGE_INDEX_SEARCH
  const minimumIndex = params.minimumIndex ?? 0
  if (!Number.isInteger(maxIndex) || maxIndex < 1) {
    throw new Error(`maxIndex must be a positive integer, got ${maxIndex}`)
  }
  if (
    !Number.isSafeInteger(minimumIndex) ||
    minimumIndex < 0 ||
    minimumIndex >= maxIndex
  ) {
    throw new Error('minimumIndex must be within the bounded search range')
  }

  const usedAt = (index: number): Promise<boolean> =>
    isChangeIndexUsed(provider, keyring.deriveChangeAccount(index).address)

  if (!(await usedAt(minimumIndex))) return minimumIndex

  // Exponential probe: find some hi that's unused, doubling from 1. `lo` always stays a known-used
  // index (starts at 0, which we've just confirmed is used).
  let lo = minimumIndex
  let hi = minimumIndex + 1
  while (await usedAt(hi)) {
    lo = hi
    hi = minimumIndex + (hi - minimumIndex) * 2
    if (hi > maxIndex) {
      throw new Error(
        `recoverNextChangeIndex: every index up to maxIndex=${maxIndex} appears used -- this is ` +
          'almost certainly a misconfigured provider/keyring (wrong network or wrong root secret) ' +
          'rather than a genuinely enormous change-account history. Pass a larger maxIndex only if ' +
          'you are certain that many change indices are legitimately used.'
      )
    }
  }

  // Binary search the boundary within (lo, hi]: lo is used, hi is unused, invariant maintained on
  // every iteration below.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (await usedAt(mid)) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return hi
}
