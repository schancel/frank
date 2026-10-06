/**
 * The single compile-time seam every store/component should import through (ticket #41 -- see
 * `PLAN.md`'s M9 section, and `./active-chain.ts`'s header for the full design rationale).
 *
 * Selecting a different chain is a one-line change here (swap `MonadChain` for a future
 * `LotusChain`, once one is actually built for real -- see issue #41's "Non-goals"), never a
 * runtime branch anywhere else in the app.
 */
import { MonadChain } from "./monad-chain";
import { ActiveChain } from "./active-chain";
export { createChain } from "./chain-factory";
export type { ChainFactoryConfig } from "./chain-factory";
export type { EcashChainConfig } from "./ecash-chain";
export type { MonadChainConfig } from "./monad-chain";
export type { SolanaChainConfig } from "./solana-chain";

export const activeChain: ActiveChain = MonadChain;

export {
  PROTOCOL_CHAINS,
  getChainRegistryEntry,
  getChainRegistryByKind,
  getChainRegistryByNetworkTag,
  getChainRegistryByCaip2,
  getChainsByCurve,
  resolveChainIdentifier,
} from "./chains-registry";
export type {
  ChainRegistryEntry,
  SupportedChainFamily,
  SupportedChainKind,
  SupportedCurve,
  SupportedNetwork,
} from "./chains-registry";

export {
  NativeTransactionSubmissionError,
  TopicPostOutcomeUnknownError,
} from "./active-chain";
export {
  DefaultNativeTransactionAttemptStore,
  InMemoryNativeTransactionAttemptStore,
  defaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
} from "./chain-wallet";

export type {
  ActiveChain,
  ActiveNativeTransferClient,
  ChainAddress,
  ChainCapabilities,
  ChainKind,
  ChainTransaction,
  DirectMessageAttemptStatus,
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
} from "./active-chain";

export type { NativeTransactionAttemptStore } from "./chain-wallet";
