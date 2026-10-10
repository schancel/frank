import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'

/**
 * The symbol to SHOW for an asset in a swap. A token is shown under its own symbol. The chain's
 * native coin is shown under the unit the chain registry gives that network ("MONT" on Monad
 * testnet), the same unit every balance and amount elsewhere in the app uses: an exchange's token
 * list calls it by the mainnet ticker ("MON"), and it is the same asset, not a second one.
 *
 * Display only: what is quoted, signed and recorded keeps the exchange's own token entry.
 */
export function swapAssetSymbol(
  chainIdentifier: string,
  asset: { readonly symbol: string; readonly address?: string | null },
): string {
  if (asset.address) return asset.symbol
  return getChainRegistryEntry(chainIdentifier)?.unit ?? asset.symbol
}
