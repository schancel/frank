import type { ActiveChain } from '@frank/wallet/chain'

type ChainAmountAdapter = Pick<
  ActiveChain,
  'unit' | 'fromDisplayAmount' | 'toDisplayAmount'
>

/** Forum paid inputs stay exact from the display parser to the wallet boundary. */
export function displayToRawAmount(
  chain: ChainAmountAdapter,
  display: string,
): bigint {
  return chain.fromDisplayAmount(display)
}

export function formatRawAmount(
  chain: ChainAmountAdapter,
  raw: string | bigint,
): string {
  return `${chain.toDisplayAmount(BigInt(raw))} ${chain.unit}`
}
