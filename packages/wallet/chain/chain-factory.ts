import { ActiveChain, NativeAssetChain } from "./active-chain";
import type { EcashChain, EcashChainConfig } from "./ecash-chain";
import { getChainRegistryEntry } from "./chains-registry";
import { createEvmChain } from "./evm-chain";
import type { EvmChainConfig } from "./evm-chain-config";

import type { SolanaChainConfig } from "./solana-chain";

export type ChainFactoryConfig =
  | { family: "evm"; chainIdentifier?: string; config: EvmChainConfig }
  | { family: "solana"; chainIdentifier?: string; config: SolanaChainConfig }
  | { family: "bitcoin"; chainIdentifier?: string; config: EcashChainConfig };

export function createChain(params: {
  family: "evm";
  chainIdentifier?: string;
  config: EvmChainConfig;
}): Promise<ActiveChain>;
export function createChain(params: {
  family: "solana";
  chainIdentifier?: string;
  config: SolanaChainConfig;
}): Promise<NativeAssetChain>;
export function createChain(params: {
  family: "bitcoin";
  chainIdentifier?: string;
  config: EcashChainConfig;
}): Promise<EcashChain>;
export function createChain(
  params: ChainFactoryConfig
): Promise<NativeAssetChain | EcashChain>;
export async function createChain(
  params: ChainFactoryConfig
): Promise<NativeAssetChain | EcashChain> {
  switch (params.family) {
    case "evm": {
      const chainIdentifier = params.chainIdentifier ?? params.config.rpcChain;
      if (
        params.config.rpcChain !== chainIdentifier ||
        (params.config.chainIdentifier !== undefined &&
          params.config.chainIdentifier !== chainIdentifier)
      ) {
        throw new Error("EVM chain identifier and RPC chain must match");
      }
      const chain = getChainRegistryEntry(chainIdentifier);
      if (!chain || chain.family !== "evm") {
        throw new Error(
          `Unsupported EVM chain identifier "${chainIdentifier}"`
        );
      }
      if (chain.kind === "tempo") {
        throw new Error(
          `Tempo wallet on ${chainIdentifier} is unavailable until its signed 0x76 transaction and fee-token recovery path is installed`
        );
      }
      return createEvmChain({
        ...params.config,
        ...(params.chainIdentifier !== undefined
          ? { chainIdentifier: params.chainIdentifier }
          : {}),
      });
    }
    case "solana": {
      const { createSolanaChain } = await import("./solana-chain");
      return createSolanaChain({
        ...params.config,
        ...(params.chainIdentifier !== undefined
          ? { chainIdentifier: params.chainIdentifier }
          : {}),
      });
    }
    case "bitcoin": {
      const { createEcashChain } = await import("./ecash-chain");
      return createEcashChain({
        ...params.config,
        ...(params.chainIdentifier !== undefined
          ? { chainIdentifier: params.chainIdentifier }
          : {}),
      });
    }
  }
}
