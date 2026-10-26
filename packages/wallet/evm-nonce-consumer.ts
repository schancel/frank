/**
 * Which transaction used one account nonce, read from the chain alone.
 *
 * A signed transaction the node has no receipt for, whose account's nonce is already past it
 * (`nativeMemberSuperseded`), was either replaced by a different transaction at that nonce or
 * mined on a node that has since dropped it from its history. Only the first can never pay.
 * The block in which the account's nonce moved past this one holds exactly one transaction of
 * that account at that nonce: if this transaction's hash is not among the block's transactions,
 * a different transaction used the nonce.
 *
 * Reads, all allowed by the relay's chain proxy: the account's transaction count at past blocks
 * (state the node still keeps) and one block with transaction hashes only.
 */
import type { Provider } from 'ethers'

export interface EvmNonceConsumer {
  /** `this`: the block holds this very transaction. `another`: it holds a different one. */
  readonly by: 'this' | 'another'
  /** The block in which the account's nonce moved past the signed transaction's. */
  readonly blockNumber: number
}

/** How far back, in doublings, the search looks for a block before the nonce was used. */
const MAX_DOUBLINGS = 24

/**
 * `undefined` when the chain does not say: the nonce is not used at `consumedBy`, a read failed,
 * or the node no longer keeps the state of the blocks it would have to read. Never throws.
 */
export async function findNonceConsumer(
  provider: Pick<Provider, 'getTransactionCount' | 'getBlock'>,
  signed: { account: string; nonce: number; transactionHash: string },
  /** A block at which the chain already showed the account's nonce past `signed.nonce`. */
  consumedBy: number,
): Promise<EvmNonceConsumer | undefined> {
  const used = async (block: number) =>
    (await provider.getTransactionCount(signed.account, block)) > signed.nonce
  try {
    if (!(await used(consumedBy))) return undefined
    // `hi` always shows the nonce used; find a block `lo` that does not, doubling the step.
    let hi = consumedBy
    let lo: number | undefined
    for (let step = 1, n = 0; n < MAX_DOUBLINGS && hi > 0; step *= 2, n++) {
      const at = Math.max(0, hi - step)
      if (!(await used(at))) {
        lo = at
        break
      }
      hi = at
    }
    if (lo === undefined) return undefined
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (await used(mid)) hi = mid
      else lo = mid
    }
    const block = await provider.getBlock(hi)
    if (!block || block.number !== hi) return undefined
    const hash = signed.transactionHash.toLowerCase()
    return {
      by: block.transactions.some(candidate => candidate.toLowerCase() === hash)
        ? 'this'
        : 'another',
      blockNumber: hi,
    }
  } catch {
    return undefined
  }
}
