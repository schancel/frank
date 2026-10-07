import { getChainRegistryEntry } from '@frank/wallet/chain'
import type { MultiChainWalletResolver } from '@frank/wallet/sync-router'
import { accountSession } from './session'
import { useMonadWallet, useWallet } from '../utils/clients'

export class AppMultiChainWalletResolver implements MultiChainWalletResolver {
  private solanaWallet?: unknown

  constructor(options?: { solanaWallet?: unknown }) {
    this.solanaWallet = options?.solanaWallet
  }

  setSolanaWallet(wallet: unknown) {
    this.solanaWallet = wallet
  }

  async getWalletForChain(
    chainIdentifier: string,
  ): Promise<unknown | undefined> {
    const entry = getChainRegistryEntry(chainIdentifier)
    const family =
      entry?.family ??
      (chainIdentifier.startsWith('monad') || chainIdentifier.startsWith('evm')
        ? 'evm'
        : chainIdentifier.startsWith('xec') ||
          chainIdentifier.startsWith('ecash') ||
          chainIdentifier === 'lotus'
        ? 'bitcoin'
        : chainIdentifier.startsWith('solana')
        ? 'solana'
        : undefined)

    switch (family) {
      case 'evm': {
        try {
          return useMonadWallet()
        } catch {
          return (await accountSession
            .getWallet()
            .catch(() => undefined)) as unknown
        }
      }
      case 'bitcoin': {
        // eCash / Lotus legacy UTXO wallet
        try {
          return useWallet()
        } catch {
          return undefined
        }
      }
      case 'solana': {
        // Solana wallet / inventory
        return this.solanaWallet ?? undefined
      }
      default:
        return undefined
    }
  }
}

export const appMultiChainResolver = new AppMultiChainWalletResolver()
