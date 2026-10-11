import type { NativeAssetChain } from "@frank/wallet/chain/active-chain";

/** How a bot writes and reads amounts of the chain it runs on. */
export interface BotAmounts {
  formatAmount(raw: bigint): string;
  parseAmount(display: string): bigint;
}

/**
 * The amount formatter of one chain: the chain's own conversion and its configured display
 * unit (the chain registry's `unit` for its canonical identifier). The host builds it once from
 * the chain it was started on and gives it to every bot in its context. It prints the exact
 * amount, as the app's `formatRawAmount` does, so a stake, a price or a payout a bot names is the
 * amount that moves.
 */
export function chainAmounts(
  chain: Pick<NativeAssetChain, "unit" | "toDisplayAmount" | "fromDisplayAmount">
): BotAmounts {
  return {
    formatAmount: (raw) => `${chain.toDisplayAmount(raw)} ${chain.unit}`,
    parseAmount: (display) => chain.fromDisplayAmount(display),
  };
}
