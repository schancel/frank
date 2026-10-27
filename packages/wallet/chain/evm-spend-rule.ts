/**
 * How many blocks after the block that brought money into an account the node first admits a
 * transfer out of that money, on a network with a spend-spacing rule
 * (`ChainRegistryEntry.spendSpacingBlocks`; Monad: 3). The node judges a transaction against
 * the sender's balance of `spendSpacingBlocks + 1` blocks back, whatever the amount: a transfer
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
