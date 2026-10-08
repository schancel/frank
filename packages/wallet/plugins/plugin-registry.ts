/**
 * DAppPlugin Registry Host (Ticket #1154).
 *
 * Central registry managing lifecycle, registration, lookup, and chain-type filtering
 * for all dApp reference and third-party plugins.
 */

import type { DAppChainType, DAppPlugin } from './types'

export class DAppPluginRegistry {
  private readonly plugins = new Map<string, DAppPlugin>()

  /**
   * Registers a new dApp plugin.
   * Throws if a plugin with the same ID is already registered.
   */
  register(plugin: DAppPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(
        `DAppPlugin with id "${plugin.id}" is already registered.`,
      )
    }
    this.plugins.set(plugin.id, plugin)
  }

  /**
   * Unregisters a dApp plugin by ID.
   * Returns true if the plugin was found and removed, false otherwise.
   */
  unregister(id: string): boolean {
    return this.plugins.delete(id)
  }

  /**
   * Retrieves a plugin by ID, or undefined if not found.
   */
  get(id: string): DAppPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Retrieves a plugin by ID, or throws if not found.
   */
  require(id: string): DAppPlugin {
    const plugin = this.get(id)
    if (!plugin) {
      throw new Error(`DAppPlugin with id "${id}" not found in registry.`)
    }
    return plugin
  }

  /**
   * Returns true if a plugin with the given ID is registered.
   */
  has(id: string): boolean {
    return this.plugins.has(id)
  }

  /**
   * Lists all registered plugins.
   */
  list(): DAppPlugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Filters registered plugins by chain type.
   * Multi-chain plugins are included when filtering by specific single chain types ('evm' or 'solana').
   */
  getByChainType(chainType: DAppChainType): DAppPlugin[] {
    if (chainType === 'multi') {
      return this.list().filter(plugin => plugin.chainType === 'multi')
    }
    return this.list().filter(
      plugin => plugin.chainType === chainType || plugin.chainType === 'multi',
    )
  }

  /**
   * Removes all registered plugins (primarily for tests).
   */
  clear(): void {
    this.plugins.clear()
  }
}

/**
 * Shared global singleton registry instance.
 */
export const defaultPluginRegistry = new DAppPluginRegistry()
