import { createEvmChain } from "./monad-chain";
import { defaultNativeEvmTransactionBuilder } from "./evm-transaction-builder";
import type { ActiveChain } from "./active-chain";
import type { EvmChainConfig } from "./evm-chain-config";
import { getChainRegistryEntry } from "./chains-registry";
import { createStampDefaultResolver } from "../oracle/stamp-rate";
import { createRelayStampRateReader } from "../oracle/relay-stamp-pricing";
import {
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
