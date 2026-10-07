/**
 * Multi-chain wallet sync router (Issue #1126).
 *
 * Inspects a WalletSyncItem, determines the target chain via its canonical chainIdentifier,
 * queries getChainRegistryEntry to identify the chain family ('evm', 'bitcoin', 'solana'),
 * delegates to the appropriate chain wallet from the resolver, and applies the state update.
 *
 * The router is an independent routing layer decoupled from WalletHandle or any specific wallet.
 */
import type { WalletSyncItem } from "@frank/cashweb/types/messages";
import {
  applyWalletSyncItem,
  type WalletSyncDispatchResult,
} from "./sync-dispatcher";
import {
  getChainRegistryEntry,
  type ChainRegistryEntry,
} from "./chain/chains-registry";

export interface MultiChainWalletResolver {
  /**
   * Resolves the active or instantiated wallet handle for the given canonical chain identifier.
   * Returns undefined if that chain's wallet is currently locked, uninitialized, or unavailable.
   */
  getWalletForChain(
    chainIdentifier: string
  ): Promise<unknown | undefined> | unknown | undefined;
}

export interface RouteWalletSyncOptions {
  resolver: MultiChainWalletResolver;
  /** Optional fallback wallet if resolver returns undefined. */
  fallbackWallet?: unknown;
}

/**
 * Inspects a WalletSyncItem, determines the target chain via its canonical chainIdentifier,
 * queries getChainRegistryEntry to identify the chain family ('evm', 'bitcoin', 'solana'),
 * delegates to the appropriate chain wallet from the resolver, and applies the state update.
 */
export async function routeWalletSyncItem(
  item: WalletSyncItem,
  options: RouteWalletSyncOptions
): Promise<WalletSyncDispatchResult> {
  if (!item) return {};

  const rawChainId = item.chainIdentifier || (item as any).chainId;
  if (!rawChainId) {
    console.warn("routeWalletSyncItem: item missing chainIdentifier");
    return {};
  }

  // 1. Inspect chainIdentifier and query getChainRegistryEntry to canonicalize and identify chain family
  const entry: ChainRegistryEntry | undefined = getChainRegistryEntry(rawChainId);
  const chainId = entry?.id ?? rawChainId;

  // 2. Resolve target wallet from the multi-chain resolver
  let targetWallet = await options.resolver.getWalletForChain(chainId);
  if (!targetWallet && chainId !== rawChainId) {
    targetWallet = await options.resolver.getWalletForChain(rawChainId);
  }
  if (!targetWallet && options.fallbackWallet) {
    targetWallet = options.fallbackWallet;
  }

  if (!targetWallet) {
    console.warn(`routeWalletSyncItem: no wallet resolved for chain "${chainId}"`);
    return {};
  }

  // 3. Dispatch fine-grained updates to the resolved wallet
  return applyWalletSyncItem(targetWallet, item);
}
