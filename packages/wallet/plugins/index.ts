/**
 * DAppPlugin host registry and the plugins it holds.
 *
 * A plugin is registered only if what it returns comes from somewhere real. The EVM swap is not a
 * plugin: it lives in `../swap` and quotes from the chain. The plugins that used to be here for
 * Uniswap, eCash swaps, Tempo and Hyperliquid computed their answers from constants in the source
 * and have been deleted. The prediction-escrow typed-data builder remains as a library for its
 * own tests but is not registered: nothing is deployed at the contract address it signs for.
 * The Jupiter plugin did the same (a price table, a made-up fee recipient) and is deleted too:
 * Solana swaps live in `../solana-swap`. Nothing is registered today.
 */

export * from './types'
export * from './plugin-registry'
export * from './prediction-escrow-plugin'

import { DAppPluginRegistry } from './plugin-registry'

export function createStandardPluginRegistry(): DAppPluginRegistry {
  return new DAppPluginRegistry()
}
