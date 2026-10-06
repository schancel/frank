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
export { createEvmChain, createMonadChain } from "./monad-chain";
export type {
  EvmChainConfig,
  EvmChainWalletHandle,
  MonadChainConfig,
  MonadChainWalletHandle,
} from "./monad-chain";
export {
  NativeEvmTransactionBuilder,
  defaultNativeEvmTransactionBuilder,
  Tip20TransactionBuilder,
  defaultTempoTransactionBuilder,
  TEMPO_PATH_USD_ADDRESS,
} from "./evm-transaction-builder";
export type {
  EvmTransactionBuilder,
  EvmTransferParams,
  EvmBurnParams,
} from "./evm-transaction-builder";
export type { SolanaChainConfig } from "./solana-chain";
export {
  EvmLegacyConsolidator,
  InMemoryLegacySendJournalStore,
} from "./evm-legacy-consolidator";
export type {
  EvmLegacyConsolidatorConfig,
  FundingAccount,
  LegacySendIntent,
  LegacySendJournalStore,
} from "./evm-legacy-consolidator";

export const activeChain: ActiveChain = MonadChain;

export {
  PROTOCOL_CHAINS,
  registerProtocolChain,
  clearDynamicChains,
  getAllChainsByKind,
  getChainsByFamily,
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
  ChainFamily,
  ChainTransaction,
  DirectMessageAttemptStatus,
  DirectMessageClient,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageSendResult,
  FrankIdentityHandle,
  HDSeed,
  MessageItem,
  ChannelUpdateItem,
  NativeTransferClient,
  NativeAssetChain,
  NativeWalletHandle,
  ProfileInfo,
  TopicBroadcastClient,
  WalletHandle,
  LegacySendStage,
  LegacySendProgress,
  LegacyFeeEstimate,
  LegacySendResult,
  ContactSendProgress,
  ContactSendResult,
} from "./active-chain";

export type { NativeTransactionAttemptStore } from "./chain-wallet";

export {
  MonadStealthKeyring,
  MemoryMonadStealthKeyringStore,
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  buildEvmStealthPayment,
} from "../monad-stealth";
export type {
  EvmStealthDestination,
  EvmStealthDerivedAccount,
  StealthAccountRecord,
  MonadStealthKeyringStore,
  BuildEvmStealthPaymentParams,
  EvmStealthPaymentResult,
} from "../monad-stealth";

export {
  SOLANA_MIN_STEALTH_LAMPORTS,
  SolanaEd25519StealthStrategy,
  SolanaStealthKeyring,
  MemorySolanaStealthKeyringStore,
  deriveSolanaStealthAddress,
  deriveSolanaStealthKeypair,
  buildSolanaStealthPayment,
} from "../solana-stealth";
export type {
  SolanaStealthDestination,
  SolanaStealthDerivedAccount,
  SolanaStealthAccountRecord,
  SolanaStealthKeyringStore,
  SolanaStealthMetadata,
  BuildSolanaStealthPaymentParams,
  SolanaStealthPaymentResult,
} from "../solana-stealth";

