import { ActiveChain, NativeAssetChain } from './active-chain'
import type { EcashChainConfig } from './ecash-chain'
import { createMonadChain, MonadChainConfig } from './monad-chain'
import type { SolanaChainConfig } from './solana-chain'

export type ChainFactoryConfig =
  | { kind: 'monad'; config: MonadChainConfig }
  | { kind: 'solana'; config: SolanaChainConfig }
  | { kind: 'ecash'; config: EcashChainConfig }

export function createChain(params: {
  kind: 'monad'
  config: MonadChainConfig
}): Promise<ActiveChain>
export function createChain(params: {
  kind: 'solana'
  config: SolanaChainConfig
}): Promise<NativeAssetChain>
export function createChain(params: {
  kind: 'ecash'
  config: EcashChainConfig
}): Promise<NativeAssetChain>
export function createChain(
  params: ChainFactoryConfig,
): Promise<NativeAssetChain>
export async function createChain(
  params: ChainFactoryConfig,
): Promise<NativeAssetChain> {
  switch (params.kind) {
    case 'monad':
      return createMonadChain(params.config)
    case 'solana': {
      const { createSolanaChain } = await import('./solana-chain')
      return createSolanaChain(params.config)
    }
    case 'ecash': {
      const { createEcashChain } = await import('./ecash-chain')
      return createEcashChain(params.config)
    }
  }
}
