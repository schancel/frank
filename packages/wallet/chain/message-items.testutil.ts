/**
 * Test composition: a chain whose every wallet has the default message-item registry installed
 * when it is created, as a host installs one for its own wallets. The canonical message path
 * neither sends nor reads without a registry.
 */
import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../message-item-plugins/registry'
import { installMessageItemRegistry } from './monad-canonical-dm'

export function withDefaultMessageItems<
  C extends { createWallet(...args: never[]): Promise<object> },
>(chain: C): C {
  const createWallet = chain.createWallet.bind(chain) as (
    ...args: unknown[]
  ) => Promise<object>
  return Object.assign(chain, {
    createWallet: async (...args: unknown[]) => {
      const wallet = await createWallet(...args)
      installMessageItemRegistry(
        wallet,
        createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
      )
      return wallet
    },
  })
}
