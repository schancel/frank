/**
 * DAppPlugin Host Abstraction & Reference Plugins (Ticket #1154).
 *
 * Exports plugin host registry, interfaces, and three reference plugins:
 * 1. Uniswap Universal Router (EVM DEX swapping with 8.75 bps partner fee sharing & HD change address settlement)
 * 2. Jupiter Aggregator (Solana SPL token swaps with 8.75 bps platform fee sharing & fresh HD change ATA setup)
 * 3. Prediction Escrow (EIP-712 structured typed data signing for binary predictions & conditional escrow)
 */

export * from './types'
export * from './plugin-registry'
export * from './uniswap-plugin'
export * from './jupiter-plugin'
export * from './prediction-escrow-plugin'

import { DAppPluginRegistry } from './plugin-registry'
import { UniswapDAppPlugin } from './uniswap-plugin'
import { JupiterDAppPlugin } from './jupiter-plugin'
import { PredictionEscrowDAppPlugin } from './prediction-escrow-plugin'

export function createStandardPluginRegistry(): DAppPluginRegistry {
  const registry = new DAppPluginRegistry()
  registry.register(new UniswapDAppPlugin())
  registry.register(new JupiterDAppPlugin())
  registry.register(new PredictionEscrowDAppPlugin())
  return registry
}
