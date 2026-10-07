/**
 * Multi-chain wallet sync router (@frank/cashweb, Issue #1126).
 *
 * Inspects a WalletSyncItem, determines the target chain via its canonical chainIdentifier,
 * delegates to the appropriate chain wallet from the resolver, and applies the state update.
 */
import type { WalletSyncItem } from "./types/messages";
import {
  applyWalletSyncItem,
  type WalletSyncDispatchResult,
} from "./sync-dispatcher";

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

  // Canonicalize common aliases
  let chainId = rawChainId;
  if (chainId === "ecash-mainnet") {
    chainId = "xec-mainnet";
  } else if (chainId === "ecash-testnet") {
    chainId = "xec-testnet";
  }

  // 1. Resolve target wallet from the multi-chain resolver
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

  // 2. Dispatch fine-grained updates to the resolved wallet
  return applyWalletSyncItem(targetWallet, item);
}
