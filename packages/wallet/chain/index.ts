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
export {
  canonicalEcashNetworkId,
  ECASH_CHECKPOINTS,
  ECASH_MAINNET_CHECKPOINT_HEIGHT,
  ECASH_MAINNET_CHECKPOINT_HASH,
  ECASH_TESTNET_CHECKPOINT_HEIGHT,
  ECASH_TESTNET_CHECKPOINT_HASH,
} from "../ecash-wallet";
export type { EcashNetworkId, EcashAddressPrefix } from "../ecash-wallet";
export {
  createEvmChain,
  loadMonadChainConfigFromEnv,
  CUSTOM_RELAY_STORAGE_KEY,
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
  getDefaultRelayBaseUrl,
} from "./monad-chain";
export type { EvmChainConfig } from "./evm-chain-config";
export type { EvmWalletHandle, EvmChainWalletHandle } from "../evm-wallet-handle";
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
  EvmDrainParams,
} from "./evm-transaction-builder";
export type { SolanaChainConfig } from "./solana-chain";
export {
  fetchSolanaBalance,
  fetchSolanaTokenAccounts,
  DEFAULT_SOLANA_RPC_URLS,
  KNOWN_SOLANA_DEVNET_TOKENS,
} from "./solana-balance";
export type {
  FetchSolanaBalanceOptions,
  SolanaBalanceResult,
  SolanaTokenAccount,
} from "./solana-balance";
export {
  EvmLegacyConsolidator,
  EvmNativeOperationPendingError,
} from "./evm-legacy-consolidator";
export type { EvmLegacyConsolidatorConfig } from "./evm-legacy-consolidator";
export { EvmNativeOperationJournal } from "../storage/evm-native-operation-journal";
export type {
  EvmNativeOperation,
  EvmNativeSource,
} from "../storage/evm-native-operation-journal";

let currentActiveChain: ActiveChain = MonadChain;
const activeChainListeners = new Set<(chain: ActiveChain) => void>();

export const activeChain: ActiveChain = Object.assign({}, MonadChain);

export function setActiveChain(chain: ActiveChain): void {
  currentActiveChain = chain;
  for (const key of Object.keys(activeChain)) {
    delete (activeChain as any)[key];
  }
  Object.assign(activeChain, chain);
  for (const listener of activeChainListeners) {
    try {
      listener(chain);
    } catch (err) {
      console.error("Error in activeChain change listener", err);
    }
  }
}

export function getActiveChain(): ActiveChain {
  return currentActiveChain;
}

export function onActiveChainChange(
  listener: (chain: ActiveChain) => void
): () => void {
  activeChainListeners.add(listener);
  return () => {
    activeChainListeners.delete(listener);
  };
}

export {
  PROTOCOL_CHAINS,
  getAllChainsByKind,
  getChainsByFamily,
  getChainRegistryEntry,
  getChainRegistryByKind,
  getChainRegistryByNetworkTag,
  getChainRegistryByCaip2,
  getChainsByCurve,
  resolveChainIdentifier,
  getChainExchangeConfig,
  isChainEnabled,
  getChainsByNetwork,
  resolveNetworkId,
  validateChainAddress,
} from "./chains-registry";
export type {
  ChainRegistryEntry,
  ChainWalletSupport,
  ChainExchangeConfig,
  ExchangeAdapterType,
  SupportedChainFamily,
  SupportedChainKind,
  SupportedCurve,
  SupportedNetwork,
} from "./chains-registry";

export {
  DirectMessageAlreadyAttemptedError,
  DirectMessageArgumentError,
  DirectMessageAttemptUnlinkedError,
  NativeTransactionSubmissionError,
  TopicPostOutcomeUnknownError,
} from "./active-chain";
export {
  CanonicalMessagingHoldError,
  CanonicalRecipientNotPublishedError,
  CanonicalRelayCannotForwardError,
} from "./monad-canonical-dm";
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
  ContactSendParams,
  ContactPaymentInfo,
  PreparedContactPayment,
  ReceivedPayment,
  ReceivedPaymentStatus,
  ReceivedCoinSweep,
  MessagePayment,
} from "./active-chain";
export {
  ContactPaymentPendingError,
  ContactPaymentFailedError,
  ContactPaymentReleasedError,
  ContactPaymentTooLargeError,
  MAX_STEALTH_ITEM_AMOUNT,
} from "./active-chain";

export type { NativeTransactionAttemptStore } from "./chain-wallet";

export {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  evmStealthItem,
  stealthCoinFromItem,
  stealthItemTransfer,
} from "../monad-stealth";
export type {
  EvmStealthDestination,
  EvmStealthDerivedAccount,
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

export {
  ElectrumClient,
  ElectrumRpcError,
  toElectrumScriptHash,
} from "./electrum-client";
export type {
  ElectrumUtxo,
  ElectrumHistoryItem,
  ElectrumBalance,
  ElectrumClientOptions,
} from "./electrum-client";

export { electrumIndexer, relayElectrumUrl } from "./electrum-indexer";
export {
  NativeFeeExceededError,
  NativeTransactionRefusedError,
} from "./chain-wallet";
export { createUtxoChain } from "./utxo-chain";
export { openRelayUtxoChain } from "./utxo-family";
export type { RelayUtxoChain } from "./utxo-family";
export type { UtxoChain, UtxoChainConfig } from "./utxo-chain";

export {
  summarizeEvmNativeOperation,
  findEvmNativeOperationStatus,
} from "./evm-native-operation-status";
export type { EvmNativeOperationStatus } from "./evm-native-operation-status";
