/**
 * DAppPlugin host registry and the plugins it holds.
 *
 * A plugin is registered only if what it returns comes from somewhere real. The EVM swap is not a
 * plugin: it lives in `../swap` and quotes from the chain. The plugins that used to be here for
 * Uniswap, eCash swaps, Tempo and Hyperliquid computed their answers from constants in the source
 * and have been deleted. The prediction-escrow typed-data builder remains as a library for its
 * own tests but is not registered: nothing is deployed at the contract address it signs for.
 */

export * from './types'
export * from './plugin-registry'
export * from './jupiter-plugin'
export * from './prediction-escrow-plugin'

import { DAppPluginRegistry, defaultPluginRegistry } from './plugin-registry'
import { JupiterDAppPlugin } from './jupiter-plugin'

export function createStandardPluginRegistry(): DAppPluginRegistry {
  const registry = new DAppPluginRegistry()
  registry.register(new JupiterDAppPlugin())
  return registry
}

export function initializeDefaultPluginRegistry(): void {
  const plugins = [new JupiterDAppPlugin()]
  for (const p of plugins) {
    if (!defaultPluginRegistry.has(p.id)) {
      defaultPluginRegistry.register(p)
    }
  }
}

initializeDefaultPluginRegistry()
