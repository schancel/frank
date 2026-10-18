import { createEvmChain } from "./evm-chain";
import { defaultNativeEvmTransactionBuilder } from "./evm-transaction-builder";
import type { ActiveChain, NativeAssetChain } from "./active-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import { getChainRegistryEntry } from "./chains-registry";
import { createStampDefaultResolver } from "../oracle/stamp-rate";
import { createRelayStampRateReader } from "../oracle/relay-stamp-pricing";
import {
  DEFAULT_EVM_STAMP_FALLBACK_COIN,
  stampPolicyConfig,
  type StampPolicyConfig,
} from "../oracle/stamp-policy";

/** Explicit SDK/host composition; the wallet implementation never fetches an oracle itself. */
export function createRelayStampDefaultResolver(
  config: EvmChainConfig,
  adapter: Pick<ActiveChain, "capabilities" | "fromDisplayAmount">,
  pricing: StampPolicyConfig = stampPolicyConfig()
) {
  const chainIdentifier = config.chainIdentifier ?? config.rpcChain;
  const entry = getChainRegistryEntry(chainIdentifier);
  if (!entry || entry.family !== "evm")
    throw new Error(`Unsupported EVM chain: ${chainIdentifier}`);
  return createStampDefaultResolver({
    chainIdentifier,
    asset: entry.kind,
    supportsDirectMessages:
      adapter.capabilities.directMessages &&
      (config.transactionBuilder === undefined ||
        config.transactionBuilder === defaultNativeEvmTransactionBuilder),
    baseUnitsPerCoin: adapter.fromDisplayAmount("1"),
    fallbackStamp: adapter.fromDisplayAmount(DEFAULT_EVM_STAMP_FALLBACK_COIN),
    config: pricing,
    getRates: createRelayStampRateReader({ relayBaseUrl: config.relayBaseUrl }),
  });
}

export function createRelayPricedEvmChain(
  config: EvmChainConfig,
  pricing: StampPolicyConfig = stampPolicyConfig()
) {
  const hostConfig = { ...config };
  const chain = createEvmChain(hostConfig);
  hostConfig.resolveDefaultStamp ??= createRelayStampDefaultResolver(
    hostConfig,
    chain,
    pricing
  );
  return chain;
}

/**
 * A secondary EVM wallet uses the same validated custody and native transfer adapter as the
 * full application chain. Its host has not installed profile, messaging, forum, or contact
 * payment services on this network, so those capabilities must not be advertised.
 */
export type NativeOnlyEvmChain = Omit<NativeAssetChain, "createWallet"> &
  Pick<ActiveChain, "createWallet">;

export function createNativeOnlyEvmChain(config: EvmChainConfig): NativeOnlyEvmChain {
  const chain = createEvmChain(config);
  const nativeTransfers: NativeAssetChain["nativeTransfers"] = {
    getBalance: chain.nativeTransfers.getBalance,
    send: chain.nativeTransfers.send,
    getTransactionStatus: chain.nativeTransfers.getTransactionStatus,
    ...(chain.nativeTransfers.sendLegacy
      ? { sendLegacy: chain.nativeTransfers.sendLegacy }
      : {}),
    ...(chain.nativeTransfers.estimateLegacyFee
      ? { estimateLegacyFee: chain.nativeTransfers.estimateLegacyFee }
      : {}),
  };
  return {
    family: chain.family,
    chainIdentifier: chain.chainIdentifier,
    name: chain.name,
    unit: chain.unit,
    networkId: chain.networkId,
    network: chain.network,
    isTestnet: chain.isTestnet,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      stealthPayments: false,
      legacyConsolidation: chain.capabilities.legacyConsolidation,
    },
    toDisplayAmount: chain.toDisplayAmount,
    fromDisplayAmount: chain.fromDisplayAmount,
    addressToString: chain.addressToString,
    transactionToString: chain.transactionToString,
    formatAddress: chain.formatAddress,
    parseAddress: chain.parseAddress,
    createWallet: chain.createWallet,
    nativeTransfers,
  };
}
