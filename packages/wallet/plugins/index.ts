/**
 * DAppPlugin Host Abstraction & Reference Plugins (Ticket #1154).
 *
 * Exports plugin host registry, interfaces, and chain-specific exchange adaptors:
 * 1. Uniswap Universal Router (EVM DEX swapping with 8.75 bps partner fee sharing & HD change address settlement)
 * 2. Jupiter Aggregator (Solana SPL token swaps with 8.75 bps platform fee sharing & fresh HD change ATA setup)
 * 3. eCash Atomic Swap Router (Non-custodial UTXO atomic swap & HTLC cross-chain exchange adaptor)
 * 4. Prediction Escrow (EIP-712 structured typed data signing for binary predictions & conditional escrow)
 * 5. Tempo Settlement Engine (TIP-20 high-throughput stable settlement engine)
 * 6. Hyperliquid L1 Orderbook Router (Native CLOB orderbook execution & spot router)
 */

export * from './types'
export * from './plugin-registry'
export * from './uniswap-plugin'
export * from './jupiter-plugin'
export * from './ecash-swap-plugin'
export * from './prediction-escrow-plugin'
export * from './tempo-plugin'
export * from './hyperliquid-plugin'

import { DAppPluginRegistry, defaultPluginRegistry } from './plugin-registry'
import { UniswapDAppPlugin } from './uniswap-plugin'
import { JupiterDAppPlugin } from './jupiter-plugin'
import { EcashSwapPlugin } from './ecash-swap-plugin'
import { PredictionEscrowDAppPlugin } from './prediction-escrow-plugin'
import { TempoDAppPlugin } from './tempo-plugin'
import { HyperliquidDAppPlugin } from './hyperliquid-plugin'

export function createStandardPluginRegistry(): DAppPluginRegistry {
  const registry = new DAppPluginRegistry()
  registry.register(new UniswapDAppPlugin())
  registry.register(new JupiterDAppPlugin())
  registry.register(new EcashSwapPlugin())
  registry.register(new PredictionEscrowDAppPlugin())
  registry.register(new TempoDAppPlugin())
  registry.register(new HyperliquidDAppPlugin())
  return registry
}

export function initializeDefaultPluginRegistry(): void {
  const plugins = [
    new UniswapDAppPlugin(),
    new JupiterDAppPlugin(),
    new EcashSwapPlugin(),
    new PredictionEscrowDAppPlugin(),
    new TempoDAppPlugin(),
    new HyperliquidDAppPlugin(),
  ]
  for (const p of plugins) {
    if (!defaultPluginRegistry.has(p.id)) {
      defaultPluginRegistry.register(p)
    }
  }
}

// Initialize default registry singleton with standard reference plugins
initializeDefaultPluginRegistry()
