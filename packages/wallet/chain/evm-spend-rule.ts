import { recordWalletFailure } from '../wallet-failure'
/**
 * How many blocks after the block that brought money into an account the node first admits a
 * transfer out of that money, on a network with a spend-spacing rule
 * (`ChainRegistryEntry.spendSpacingBlocks`; Monad: 3), counted on the head the node judges from
 * (`readSpendRuleHead`). The node judges a transaction against the sender's balance of
 * `spendSpacingBlocks + 1` blocks back, whatever the amount: a transfer
 * offered sooner is refused ("Signer had insufficient balance") and those exact bytes stay
 * refused (`docs/protocol/chains/monad-reserve-balance.md`, "Money that has just arrived").
 *
 * The one source for that window: a change coin, a coin a set funds for its own later member,
 * a deposit the coin-list sync sees, and the Send to Address funds-settle wait all use it. It is
 * distinct from the reserve rule's quiet window after an account's own transfer
 * (`spendSpacingBlocks`, only below the reserve). 0 when the network has no such rule.
 */
export function fundsSettleBlocks(spendSpacingBlocks: number | undefined): number {
  return spendSpacingBlocks ? spendSpacingBlocks + 1 : 0
}

/**
 * The head the wallet counts the spend rule's blocks from (`ChainRegistryEntry.spendRuleHead`):
 * the newest block, or on Monad the newest finalized one. Monad's transaction pool judges a new
 * transaction against the sender's balance at its last committed block minus
 * `spendSpacingBlocks - 1`; `eth_blockNumber` names the newest proposed block, which a loaded
 * node lets run several blocks ahead of the committed one. Counted from the proposed head, money
 * the node cannot see yet looks four blocks old, and a transfer out of it is refused (those
 * exact bytes stay refused for 15 minutes: monad-rpc keeps each hash's answer that long).
 */
export async function readSpendRuleHead(
  provider: {
    getBlockNumber(): Promise<number>
    getBlock(tag: 'finalized'): Promise<{ readonly number: number } | null>
  },
  spendRuleHead: 'latest' | 'finalized' | undefined,
  /** `eth_blockNumber`, when the caller has just read it. */
  newest?: number,
): Promise<number> {
  if (spendRuleHead !== 'finalized') return newest ?? provider.getBlockNumber()
  const [block, tip] = await Promise.all([
    provider.getBlock('finalized'),
    newest ?? provider.getBlockNumber(),
  ])
  if (!block) throw new FinalizedHeadUnavailableError()
  return checkedFinalized(block.number, tip)
}

/** How far the finalized block may trail `eth_blockNumber` before the wallet stops trusting it.
 * Monad keeps it about 2 blocks behind, 7 or 8 on a heavily loaded node (2026-10-27). */
export const MAX_FINALIZED_LAG_BLOCKS = 64

/**
 * The node names no finalized block, or one more than `MAX_FINALIZED_LAG_BLOCKS` behind its newest
 * block. Seen on solonet (2026-10-27): after its execution process was restarted, monad-rpc kept
 * answering `finalized` (and `latest`) with block 349696 while `eth_blockNumber` passed 352000.
 * Every spend-rule wait counts on the finalized head, so without this a payment would wait for
 * it forever. Nothing is signed; the send fails with this reason, and works again once the node
 * reports finalized blocks.
 */
export class FinalizedHeadUnavailableError extends Error {
  constructor(readonly finalized?: number, readonly newest?: number) {
    super(
      finalized === undefined
        ? 'The network node does not say which blocks are final, so payments cannot be checked. Try again later or use another node.'
        : `The network node has stopped reporting final blocks (block ${finalized}, while its newest is ${newest}), so payments cannot be checked. Try again later or use another node.`,
    )
    this.name = 'FinalizedHeadUnavailableError'
    // The app tells the user the network is busy, and a later retry may go through.
    recordWalletFailure(this, { observationUnavailable: true, transientTransport: true })
  }
}

function checkedFinalized(finalized: number, newest: number): number {
  if (newest - finalized > MAX_FINALIZED_LAG_BLOCKS)
    throw new FinalizedHeadUnavailableError(finalized, newest)
  return finalized
}

/**
 * A `readSpendRuleHead` for a block watcher that looks every few hundred milliseconds. Naming
 * the finalized block takes `eth_getBlockByNumber` (5 units at the relay's RPC proxy, and not
 * anonymous) where `eth_blockNumber` takes 1, so on a network counted on the finalized head the
 * finalized block is read again only when the newest block has moved and `minIntervalMs` has
 * passed, or after `maxAgeMs` in any case; between, the last answer is returned. Elsewhere it is
 * `eth_blockNumber` on every look.
 */
export function spendRuleHeadReader(
  provider: Parameters<typeof readSpendRuleHead>[0],
  spendRuleHead: 'latest' | 'finalized' | undefined,
  options: { minIntervalMs?: number; maxAgeMs?: number; now?: () => number } = {},
): () => Promise<number> {
  if (spendRuleHead !== 'finalized') return () => provider.getBlockNumber()
  const { minIntervalMs = 500, maxAgeMs = 2_000, now = () => Date.now() } = options
  let last: { newest: number; head: number; at: number } | undefined
  return async () => {
    const newest = await provider.getBlockNumber()
    const age = last === undefined ? Infinity : now() - last.at
    if (last && age < maxAgeMs && (newest === last.newest || age < minIntervalMs))
      return checkedFinalized(last.head, newest)
    const head = await readSpendRuleHead(provider, 'finalized', newest)
    // Never backwards: a lagging replica's answer does not undo what an earlier look saw.
    last = { newest, head: Math.max(head, last?.head ?? 0), at: now() }
    return last.head
  }
}

/**
 * The waits of an account's next coin, read at `block` after the account's own transfer was
 * mined (at or before `block`). The quiet window, with the margin the rest of the rule keeps:
 * `fundsSettleBlocks` after `block`. When the account holds more than that transfer left it
 * (`freshMoney`), money arrived by `block` too; the node does not see it before the same
 * block, and nothing relaxes that (`fundsVisibleFromBlock`), not even a transfer that leaves
 * the account above the reserve. Otherwise its money is visible already (`block`) and only the
 * quiet window holds it. Spacing 0: no wait.
 */
export function nextCoinWaits(
  block: number,
  spacing: number,
  freshMoney: boolean,
): { spendableFromBlock?: number; fundsVisibleFromBlock?: number } {
  if (spacing <= 0) return {}
  const settles = block + fundsSettleBlocks(spacing)
  return { spendableFromBlock: settles, fundsVisibleFromBlock: freshMoney ? settles : block }
}
