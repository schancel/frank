/**
 * Which accounts a set of found accounts sent value to, read from the blocks themselves. Used by
 * `returnToFaucet` (`monad-wallets.ts`) and `monad-group-writes` to check that the keys a sweep
 * found cover every account the wallets paid into.
 */

/**
 * The group-write payee the regtest stack configures on its relays (`relayConfig` in
 * `regtest-stack.ts`). A relay's group-write payee is its own configured address, and nobody holds
 * this one's key, so payments to it are not funds the wallets lost.
 */
export const REGTEST_GROUP_WRITE_PAYEE = '0x000000000000000000000000000000000000dEaD'

/**
 * The accounts a regtest stack's wallets pay that are not the wallets': the faucet, the burn
 * address of stamps and forum burns, the relays' group-write payee, and any further payee a check
 * learned (a group's write policy can name its own).
 */
export function notTheWallets(faucet: string, burn: string, payees: Iterable<string> = []): Set<string> {
  return new Set([faucet, burn, REGTEST_GROUP_WRITE_PAYEE, ...payees].map(address => address.toLowerCase()))
}

export type ReachTx = { from: string; to: string | null; value: string }

/** A block as `eth_getBlockByNumber` with full transactions returns it; `null` when the node no longer has it. */
export type ReachBlock = { number: number; block: { transactions: ReachTx[] } | null }

/**
 * Follow every non-zero transfer from the `found` accounts, in block order, and from each account
 * those reached in turn. Returns the reached accounts that are neither found nor `excluded` (the
 * faucet, burn and payee addresses, which are not the wallets'), and the block ranges that could
 * not be read: a transfer in such a range may have reached an account that is not listed, so a
 * caller must treat a missing range as funds it cannot account for.
 */
export function followTransfers(
  blocks: ReachBlock[],
  found: Iterable<string>,
  excluded: Iterable<string>,
): { reached: Set<string>; missing: Array<[number, number]> } {
  const foundSet = new Set([...found].map(address => address.toLowerCase()))
  const excludedSet = new Set([...excluded].map(address => address.toLowerCase()))
  const senders = new Set(foundSet)
  const reached = new Set<string>()
  const missing: Array<[number, number]> = []
  for (const { number, block } of [...blocks].sort((a, b) => a.number - b.number)) {
    if (!block) {
      const last = missing[missing.length - 1]
      if (last && last[1] === number - 1) last[1] = number
      else missing.push([number, number])
      continue
    }
    for (const tx of block.transactions) {
      const from = tx.from.toLowerCase()
      const to = tx.to?.toLowerCase()
      if (!to || !senders.has(from) || BigInt(tx.value) === 0n || excludedSet.has(to)) continue
      senders.add(to)
      if (!foundSet.has(to)) reached.add(to)
    }
  }
  return { reached, missing }
}

/** `blocks 10..12, 15` for a list of missing ranges. */
export function describeRanges(ranges: Array<[number, number]>): string {
  return `block${ranges.length === 1 && ranges[0][0] === ranges[0][1] ? '' : 's'} ${ranges
    .map(([from, to]) => (from === to ? `${from}` : `${from}..${to}`))
    .join(', ')}`
}
