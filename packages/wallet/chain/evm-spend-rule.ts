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
): Promise<number> {
  if (spendRuleHead !== 'finalized') return provider.getBlockNumber()
  const block = await provider.getBlock('finalized')
  if (!block) throw new Error('The node names no finalized block')
  return block.number
}
