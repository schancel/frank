import { ActiveChain, NativeAssetChain } from "./active-chain";
import type { EcashChain, EcashChainConfig } from "./ecash-chain";
import { createEvmChain, EvmChainConfig } from "./monad-chain";
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
    case "evm":
      return createEvmChain({
        ...params.config,
        ...(params.chainIdentifier !== undefined
          ? { chainIdentifier: params.chainIdentifier }
          : {}),
      });
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
