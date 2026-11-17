import type { NativeAssetChain } from "@frank/wallet/chain/active-chain";
import {
  type DisplayRounding,
  shortenDisplayAmount,
} from "@frank/wallet/chain/base-unit";

/** How a text names an amount. Without `round` the amount is exact: what a message pays,
 * returns or was paid is said to the last digit. With `round` it is shortened for reading
 * (`shortenDisplayAmount`) in that direction: `"down"` for a limit a person may pay up to, so
 * the shown amount is allowed; `"up"` for a minimum or a price, so the shown amount is enough. */
export interface AmountFormat {
  round?: DisplayRounding;
}

/** How a bot writes and reads amounts of the chain it runs on. */
export interface BotAmounts {
  formatAmount(raw: bigint, format?: AmountFormat): string;
  parseAmount(display: string): bigint;
}

/**
 * The amount formatter of one chain: the chain's own conversion and its configured display
 * unit (the chain registry's `unit` for its canonical identifier). The host builds it once from
 * the chain it was started on and gives it to every bot in its context. It prints the exact
 * amount, as the app's `formatRawAmount` does, so a stake or a payout a bot names is the amount
 * that moves; a limit or a minimum is shortened in the direction its `format` names.
 */
export function chainAmounts(
  chain: Pick<NativeAssetChain, "unit" | "toDisplayAmount" | "fromDisplayAmount">
): BotAmounts {
  return {
    formatAmount: (raw, format) => {
      const exact = chain.toDisplayAmount(raw);
      const shown = format?.round ? shortenDisplayAmount(exact, format.round) : exact;
      return `${shown} ${chain.unit}`;
    },
    parseAmount: (display) => chain.fromDisplayAmount(display),
  };
}
