import type { Provider, Wallet } from "ethers";
import type { EvmChainWalletHandle, EvmWalletHandle } from "./evm-wallet-handle";
import type { EvmSpendPool, EvmSpendPoolFundingCandidate } from "./evm-spend-pool";
import type { EvmSubAccountPool as MonadSubAccountPool } from "./evm-account-pool";
import type { SubAccountLeaseManager } from "./monad-account-lease";
import type { MonadTxSubmitter } from "./monad-account-tx";
import type { EvmChangePool as MonadChangePool } from "./evm-change-pool";
import type { StampPaymentJournal } from "./storage/stamp-payment-journal";
import type { StampAttemptJournal } from "./storage/stamp-attempt-journal";
import type {
  CanonicalWalletBindingMismatchError,
  EvmWalletOperationAdmission,
} from "./storage/evm-wallet-bundle";
import type { MonadWalletMaterial } from "./monad-wallet-material";
import type { MonadIdentity } from "./monad-identity";
import type { MonadCanonicalStampClient } from "./monad-stamp-client";
import type {
  CanonicalDirectory,
  canonicalDirectMessages,
} from "./chain/monad-canonical-dm";
import type {
  DirectMessageFundAheadResult,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageStampQuote,
} from "./chain/active-chain";
import type { NativeTransactionAttemptStore } from "./chain/chain-wallet";
import type { StealthItem } from "@frank/cashweb/types/messages";
import type { ContactPayment } from "./storage/evm-coin-store";
import type { EvmLegacyConsolidator } from "./chain/evm-legacy-consolidator";
import type { EvmBlockWatcher } from "./evm-block-watcher";
import type { StealthPaymentReceiptCapability } from "./stealth-payment";

export type CanonicalInventoryFunder = (input: {
  stampValueWei: bigint;
  /** Unused: the fee an account keeps back does not depend on the recipient. */
  recipientStampKey?: Uint8Array;
  onProgress?: (progress: DirectMessagePreparationProgress) => void;
}) => Promise<string[]>;

export interface FundAheadBackoff {
  result: DirectMessageFundAheadResult;
  delayMs: number;
  startedAtMs: number;
  /** The main-account balance the pass saw, when it read one. */
  mainBalanceWei?: bigint;
}

export interface MainAccountAdmission {
  key: string;
  store: NativeTransactionAttemptStore;
}

/** What the wallet's coin list and its payments to contacts offer the chain's clients. */
export interface ReceivedCoinOwner {
  /** Records the one-time account of a received stealth item. Re-reading one is a no-op. */
  recordStealthItem(
    item: StealthItem,
    origin: { payloadDigest?: string; timestampMs: number }
  ): Promise<void>;
  /** Records the one-time accounts of the stamp payments a received message carried. */
  recordStampPayments(message: DirectMessageReceived): Promise<void>;
  /** Records one stamp account whose key the caller derived (the legacy transport). */
  recordStampCoin(coin: {
    address: string;
    privateKey: string;
    childIndex: number;
    /** The message's public shared point (hex), when the key was derived from it. */
    stampSharedPoint?: string;
    payloadDigest: string;
    valueWei: bigint;
    transaction: string;
    timestampMs: number;
  }): Promise<void>;
  /** Sends the note to self of every coin that has none yet. Never rejects. */
  noteCoins(): Promise<void>;
  /** The bounded background pass over pending coins. No request when none is pending. */
  checkPendingCoins(): Promise<void>;
  /** Finishes every payment to a contact that is not delivered yet. Never rejects. */
  resumeContactPayments(): Promise<void>;
  retryContactPayment(messageId: string): Promise<void>;
  /** A message carrying these stealth items has a durable attempt (`payloadDigest`), not yet
   * handed to the relay: remembered on the prepared payments the host delivers. */
  contactMessageAttempted(
    ephemeralPubKeys: readonly string[],
    payloadDigest: string
  ): Promise<void>;
  /** Start of a send whose message carries these stealth items. Rejects, before the send does
   * anything, if one of them is a released payment. Otherwise the items are in flight (never
   * released) until the returned function is called. */
  beginContactSend(ephemeralPubKeys: readonly string[]): Promise<() => void>;
  /** Releases the payments among these of which no byte ever left the device. True if any. */
  releaseUnsentContactPayments(
    ephemeralPubKeys: readonly string[]
  ): Promise<boolean>;
  /** The relay has stored that message: the payments it carries are broadcast. Never rejects. */
  contactMessageDelivered(payloadDigest: string): Promise<void>;
  /** Where the coin list's own first read of the whole mailbox stands. */
  mailboxScan(): { complete: boolean; sinceMs: number };
  recordMailboxScan(progress: {
    complete: boolean;
    sinceMs: number;
  }): Promise<void>;
}

const EVM_WALLET_INTERNALS = Symbol("Frank.EvmWalletInternals");

/**
 * Private per-wallet runtime state for an `EvmWallet` instance.
 *
 * Replaces the 26 module-level `WeakMap` and `WeakSet` side-tables that previously tracked
 * per-wallet state across `monad-chain.ts`.
 */
export class EvmWalletInternals {
  closed = false;
  typed = false;
  enclosingTopicAdmission = false;
  material?: MonadWalletMaterial;
  fundingCandidates?: () => readonly EvmSpendPoolFundingCandidate[];
  sendQueue: Promise<void> = Promise.resolve();
  privateTopicWallet?: EvmWalletHandle;
  installedCanonicalDescriptor?: {
    networkTag: "MONT" | "MON1" | "MONR";
    network: string;
    chainId: bigint;
  };
  canonicalClientFactory?: () => MonadCanonicalStampClient;
  canonicalUnavailable?: CanonicalWalletBindingMismatchError;
  canonicalDirectory?: CanonicalDirectory;
  canonicalMessaging?: ReturnType<typeof canonicalDirectMessages>;
  canonicalInventoryFunder?: CanonicalInventoryFunder;
  canonicalStampQuoter?: (input: {
    stampValueWei: bigint;
    excludedAddresses?: readonly string[];
  }) => Promise<DirectMessageStampQuote>;
  stampFunderAhead?: () => Promise<DirectMessageFundAheadResult>;
  fundAheadBackoff?: FundAheadBackoff;
  mainAccountAdmission?: MainAccountAdmission;
  receivedCoinOwner?: ReceivedCoinOwner;
  heldTransferSources?: () => Set<string>;
  nativeOperationOwner?: EvmLegacyConsolidator;
  runningMainTasks = 0;
  blockWatcher?: EvmBlockWatcher;
  lastOwnLookMs?: number;
  readonly unjournalledTransfers = new Map<
    string,
    { txHash: string; nonce: number }[]
  >();
  readonly settledSelfNotes = new Set<string>();
  readonly waitingSelfNotes = new Map<string, number>();

  clearOnClose(): void {
    this.canonicalClientFactory = undefined;
    this.canonicalUnavailable = undefined;
    this.canonicalMessaging = undefined;
    this.canonicalInventoryFunder = undefined;
    this.canonicalStampQuoter = undefined;
    this.canonicalDirectory = undefined;
    this.installedCanonicalDescriptor = undefined;
    this.privateTopicWallet = undefined;
    this.material = undefined;
    this.nativeOperationOwner = undefined;
  }
}

interface HasEvmWalletInternals {
  [EVM_WALLET_INTERNALS]?: EvmWalletInternals;
}

/**
 * Returns the `EvmWalletInternals` for an `EvmWallet` (or attaches one non-enumerably if a unit
 * test passes a structural mock `WalletHandle`).
 */
export function evmWalletInternals(wallet: object): EvmWalletInternals {
  const target = wallet as HasEvmWalletInternals;
  let internals = target[EVM_WALLET_INTERNALS];
  if (internals === undefined) {
    internals = new EvmWalletInternals();
    Object.defineProperty(target, EVM_WALLET_INTERNALS, {
      value: internals,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return internals;
}

export type EvmWalletDeps = Omit<
  EvmChainWalletHandle,
  "family" | "mainPrivateKey" | "evmReader"
> & {
  readonly spendPool: EvmSpendPool;
  readonly mainAccount: Wallet;
  readonly mainPrivateKey?: string;
  readonly evmReader?: Provider;
};

/**
 * Concrete EVM chain wallet instance instantiated per chain with injected dependencies and its
 * own unified `EvmSpendPool`.
 */
export class EvmWallet implements EvmChainWalletHandle {
  readonly family = "evm" as const;
  readonly chainIdentifier!: string;
  readonly networkId!: string;
  readonly identity!: MonadIdentity;
  readonly spendPool!: EvmSpendPool;
  readonly mainAccount!: Wallet;
  readonly mainPrivateKey!: string;
  readonly pool!: MonadSubAccountPool;
  readonly leaseManager!: SubAccountLeaseManager;
  readonly provider!: Provider;
  readonly evmReader!: Provider;
  readonly httpClient!: MonadTxSubmitter;
  readonly changePool!: MonadChangePool;
  readonly stampPaymentJournal!: StampPaymentJournal;
  readonly stampAttemptJournal!: StampAttemptJournal;
  readonly relayBaseUrl!: string;
  readonly forumBurnAddress!: string;
  readonly forumChainId!: bigint;
  readonly cborNetwork!: string;

  invalidateBalanceCache!: EvmChainWalletHandle["invalidateBalanceCache"];
  getReceiveAddress!: EvmChainWalletHandle["getReceiveAddress"];
  getBalance!: EvmChainWalletHandle["getBalance"];
  getBalanceObservation?: EvmChainWalletHandle["getBalanceObservation"];
  getBalanceParts!: EvmChainWalletHandle["getBalanceParts"];
  getReceivedPayments!: EvmChainWalletHandle["getReceivedPayments"];
  refreshReceivedPayments!: EvmChainWalletHandle["refreshReceivedPayments"];
  getMessagePayment!: EvmChainWalletHandle["getMessagePayment"];
  checkMessagePayment!: EvmChainWalletHandle["checkMessagePayment"];
  sweepReceivedCoins!: EvmChainWalletHandle["sweepReceivedCoins"];
  recordReceivedCoin!: EvmChainWalletHandle["recordReceivedCoin"];
  noteReceivedCoins!: EvmChainWalletHandle["noteReceivedCoins"];
  getContactPayments!: EvmChainWalletHandle["getContactPayments"];
  sendToContact!: EvmChainWalletHandle["sendToContact"];
  prepareContactPayment!: EvmChainWalletHandle["prepareContactPayment"];
  resumeContactPayments!: EvmChainWalletHandle["resumeContactPayments"];
  settleContactPayment!: EvmChainWalletHandle["settleContactPayment"];
  retryContactPayment!: EvmChainWalletHandle["retryContactPayment"];
  recordStealthPayment!: EvmChainWalletHandle["recordStealthPayment"];
  getNativeOperations!: EvmChainWalletHandle["getNativeOperations"];
  nativeOperationSyncFailed!: EvmChainWalletHandle["nativeOperationSyncFailed"];
  flushNativeSync!: EvmChainWalletHandle["flushNativeSync"];
  resumeNativeOperation!: EvmChainWalletHandle["resumeNativeOperation"];
  cancelUnsignedNativeOperation!: EvmChainWalletHandle["cancelUnsignedNativeOperation"];
  reobserveNativeOperations!: EvmChainWalletHandle["reobserveNativeOperations"];
  watchNativeOperation!: EvmChainWalletHandle["watchNativeOperation"];
  getUnresolvedNativeTransaction!: EvmChainWalletHandle["getUnresolvedNativeTransaction"];
  retryUnresolvedNativeTransaction!: EvmChainWalletHandle["retryUnresolvedNativeTransaction"];
  sendNative!: EvmChainWalletHandle["sendNative"];
  sendLegacy!: EvmChainWalletHandle["sendLegacy"];
  sendContractCall!: EvmChainWalletHandle["sendContractCall"];
  runOwnTransfer!: EvmChainWalletHandle["runOwnTransfer"];
  getContractCallFunds!: EvmChainWalletHandle["getContractCallFunds"];
  getUnresolvedContractCalls!: EvmChainWalletHandle["getUnresolvedContractCalls"];
  fundMainAccount!: EvmChainWalletHandle["fundMainAccount"];
  estimateLegacyFee!: EvmChainWalletHandle["estimateLegacyFee"];
  getUnresolvedLegacySend!: EvmChainWalletHandle["getUnresolvedLegacySend"];
  resumeLegacySend!: EvmChainWalletHandle["resumeLegacySend"];
  stealthPayments?: EvmChainWalletHandle["stealthPayments"];
  stealthReceipts?: StealthPaymentReceiptCapability;
  close!: EvmChainWalletHandle["close"];

  constructor(deps: EvmWalletDeps) {
    Object.defineProperty(this, EVM_WALLET_INTERNALS, {
      value: new EvmWalletInternals(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.assign(this, deps, {
      family: "evm" as const,
      mainPrivateKey: deps.mainPrivateKey ?? deps.mainAccount.privateKey,
      evmReader: deps.evmReader ?? deps.provider,
    });
  }

  get internals(): EvmWalletInternals {
    return evmWalletInternals(this);
  }
}

export type { EvmWalletOperationAdmission };
