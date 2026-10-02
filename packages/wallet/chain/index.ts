/**
 * The single compile-time seam every store/component should import through (ticket #41 -- see
 * `PLAN.md`'s M9 section, and `./active-chain.ts`'s header for the full design rationale).
 *
 * The application remains deliberately pinned to Monad. `createChain` is available to consumers
 * that explicitly configure another native-asset backend; it does not make UI chain selection
 * implicit or pretend every backend supports Frank messaging.
 */
import { MonadChain } from './monad-chain'
import { ActiveChain } from './active-chain'

export const activeChain: ActiveChain = MonadChain

export { createChain } from './chain-factory'
export {
  DefaultNativeTransactionAttemptStore,
  InMemoryNativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
} from './chain-wallet'
export type { NativeTransactionAttemptStore } from './chain-wallet'
export type { ChainFactoryConfig } from './chain-factory'
export type { EcashChainConfig } from './ecash-chain'
export type { SolanaChainConfig } from './solana-chain'

export type {
  ActiveChain,
  ChainCapabilities,
  ChainAddress,
  ChainKind,
  ChainTransaction,
  DirectMessageClient,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageSendResult,
  FrankIdentityHandle,
  HDSeed,
  NativeTransferClient,
  NativeAssetChain,
  NativeWalletHandle,
  ProfileInfo,
  TopicBroadcastClient,
  WalletHandle,
} from './active-chain'
