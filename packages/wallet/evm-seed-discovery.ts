/**
 * Finds the accounts of one deterministic key branch that the chain shows in use.
 *
 * The keyring derives every key from the seed; what it cannot know by itself is how far along
 * the branch this wallet (or another device of the same account) has gone. Ordinary HD wallets
 * answer that by walking the branch from index 0 and stopping after a run of `gap` unused
 * indices (BIP-44 account discovery). An index is in use when the chain shows its account with
 * a nonce above zero or a balance; both are read at `latest`, so no transaction history or
 * indexer is needed.
 *
 * A restored device therefore finds the same accounts as the device that created them, from the
 * seed and the chain alone, with no sync message and no coordination (AGENTS.md §5). Indices the
 * caller already owns are not read again; they count as in use so the walk continues past them.
 * Every index below `highWater` (the caller's own allocation mark) is read regardless of runs.
 */
import type { Provider } from 'ethers'
import { READS_AT_ONCE } from './evm-rpc-read-budget'

/** Unused indices after the last used one before the walk stops. The wallet allocates up to
 * `maxChangeOutputs` (20) change accounts per spent input, and a build that fails after
 * allocating keeps its indices, so the window is wider than BIP-44's 20. */
export const SEED_DISCOVERY_GAP = 50

/** Indices past the high-water mark one walk reads at most before giving up. */
const MAX_WALK = 10_000

export interface DiscoveredSeedAccount {
  readonly index: number
  /** Lower-case 0x address. */
  readonly account: string
  readonly nonce: number
  readonly balanceWei: bigint
}

export async function discoverSeedBranch(params: {
  readonly provider: Pick<Provider, 'getBalance' | 'getTransactionCount'>
  readonly addressOf: (index: number) => string
  /** Indices the wallet already holds as its own: not read, and never ending a run. */
  readonly isKnown: (index: number) => boolean
  /** Every index below this is read even inside an unused run. */
  readonly highWater: number
  readonly gap?: number
  readonly readsAtOnce?: number
  readonly stopped?: () => boolean
}): Promise<DiscoveredSeedAccount[]> {
  const gap = params.gap ?? SEED_DISCOVERY_GAP
  const width = Math.max(1, params.readsAtOnce ?? READS_AT_ONCE)
  if (!Number.isSafeInteger(gap) || gap < 1)
    throw new Error('Seed discovery gap must be a positive integer')
  const found: DiscoveredSeedAccount[] = []
  let index = 0
  let unused = 0
  const more = () =>
    !params.stopped?.() && (index < params.highWater || unused < gap)
  // A branch whose every index reads as used has no end to find (a node that answers wrongly):
  // stop with an error rather than walk forever.
  const limit = params.highWater + MAX_WALK
  while (more()) {
    if (index > limit)
      throw new Error('Seed discovery found no unused run on this branch')
    // Read a window of the next unknown indices in parallel, then judge them in index order.
    const window: { index: number; account: string }[] = []
    while (more() && window.length < width) {
      if (params.isKnown(index)) {
        unused = 0
      } else {
        window.push({
          index,
          account: params.addressOf(index).toLowerCase(),
        })
        // Assume unused while the window is planned; an in-use answer resets the run below.
        // The run that ends the walk starts at the high-water mark.
        unused = index < params.highWater ? 0 : unused + 1
      }
      index++
    }
    const reads = await Promise.all(
      window.map(async probe => {
        const [nonce, balanceWei] = await Promise.all([
          params.provider.getTransactionCount(probe.account, 'latest'),
          params.provider.getBalance(probe.account, 'latest'),
        ])
        return { ...probe, nonce, balanceWei }
      }),
    )
    if (params.stopped?.()) break
    let lastUsed = -1
    for (const read of reads)
      if (read.nonce > 0 || read.balanceWei > 0n) {
        found.push(read)
        lastUsed = read.index
      }
    // The run of unused indices restarts after the last used index of this window.
    if (lastUsed >= 0) {
      unused = 0
      for (let next = lastUsed + 1; next < index; next++)
        if (params.isKnown(next) || next < params.highWater) unused = 0
        else unused++
    }
  }
  return found
}
