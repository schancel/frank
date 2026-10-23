/** Shared and concrete EVM handle contracts; leaf implementation owners remain unchanged. */
import type { Provider, Wallet } from "ethers";
import type { EvmSubAccountPool as MonadSubAccountPool } from "./evm-account-pool";
import type { SubAccountLeaseManager } from "./evm-account-lease";
import type { MonadTxSubmitter } from "./evm-account-tx";
import type { EvmChangePool as MonadChangePool } from "./evm-change-pool";
import type { StampPaymentJournal } from "./storage/stamp-payment-journal";
import type { StampAttemptJournal } from "./storage/stamp-attempt-journal";
import type { TopicOperationJournal } from "./storage/topic-operation-journal";
import type {
  MonadWalletPersistenceBundle,
  MonadWalletOperationAdmission,
} from "./storage/evm-wallet-bundle";
import type { MonadCanonicalRoleOwner } from "./evm-wallet-material";
import type { StealthItem } from "@frank/cashweb/types/messages";
import type { MonadIdentity } from "./evm-identity";
import type { AccountHygieneEngine } from "./account-hygiene";
import type { ChainUtxoPool } from "./chain-utxo-pool";
import type { EvmSpendPool } from "./evm-spend-pool";
import type { WalletHandle, NativeWalletHandle } from "./chain/active-chain";
import type { Timestamp, RelayBinding } from "@frank/codec";
import type { RolePoint } from "../role-keys/src";

export interface EvmWalletHandle {
  /** Narrow Forum journal mutation admission; transport never holds this gate. */
  forumOperationMutation?<T>(task: () => Promise<T>): Promise<T>;
  /** One native financial constructor shared by stamps, stealth and Forum. */
  transactionSetPreparer?: import("./evm-transaction-set").EvmTransactionSetPreparer;
  transactionSetLifecycle?: import("./evm-transaction-set-lifecycle").EvmTransactionSetLifecycle;
  refreshTransactionSetInventory?(): Promise<void>;
  observeRetainedForumSpend?(rawTx: string): Promise<void>;
  /** Master / author identity for signing messages and topic posts. */
  identity?: MonadIdentity;
  /** Explicit typed-root capability; absent until canonical composition is activated. */
  canonicalRoles?: MonadCanonicalRoleOwner;
  /** Private active delegation from the existing owner; structural values are rejected. */
  walletOperationAdmission?: MonadWalletOperationAdmission;
  /** Autonomous account hygiene and lazy dirty sweeper (Ticket #925). Encapsulated beneath the wallet API. */
  hygieneEngine?: AccountHygieneEngine<string>;
  /** Per-wallet unified spend pool over all owned account origins on this chain. */
  spendPool?: EvmSpendPool;
  /** Invalidate in-memory cached balances across primary and stealth accounts. */
  invalidateBalanceCache?(networkTag?: string): void;
  pool: MonadSubAccountPool;
  leaseManager: SubAccountLeaseManager;
  provider: Provider;
  httpClient: MonadTxSubmitter;
  /** HD change branch used to recover the unused balance from confirmed, single-use payment
   * accounts. Optional for narrow tests and external callers that have not wired persistence yet;
   * `MonadChain.createWallet` always supplies it from the same seed as `pool`. */
  changePool?: MonadChangePool;
  /** Durable public journal of recipient-owned one-time stamp outputs and their sweep state. */
  stampPaymentJournal?: StampPaymentJournal;
  /** Durable exact raw payment sets awaiting a definitive relay success. */
  stampAttemptJournal?: StampAttemptJournal;
  /** Exact byte authority for crash-replayable topic posts and votes. */
  topicOperationJournal?: TopicOperationJournal;
  /** Complete wallet-owned persistence authority. Production stamp composition supplies this so
   * pools and journals cannot be assembled from unrelated roots. */
  walletState?: MonadWalletPersistenceBundle;
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` -- each client
   * trims its own trailing slash, so this may or may not have one. */
  relayBaseUrl: string;
  /** Explicit Frank-CBOR network identifier. Canonical Forum operations require it. */
  cborNetwork?: string;
  /** Exact canonical Forum economic policy; required by paid Forum operations and replay. */
  forumBurnAddress?: string;
  forumChainId?: bigint;
}

/** Concrete EVM capability returned by the existing runtime factory. */
export interface EvmChainWalletHandle
  extends EvmWalletHandle,
    WalletHandle,
    NativeWalletHandle {
  readonly family: "evm";
  readonly chainIdentifier: string;
  readonly networkId: string;
  readonly identity: MonadIdentity;
  /** Records the one-time account of a stealth payment made to this wallet as a coin in its
   * durable coin list. Recording a known one changes nothing. A mailbox read does this itself for
   * every stealth item it returns; this is for a payment learned of some other way. */
  recordStealthPayment(
    item: StealthItem,
    origin?: { payloadDigest?: string; timestampMs?: number }
  ): Promise<void>;
  readonly mainAccount?: Wallet;
  readonly mainPrivateKey?: string;
  /**
   * For a host that signs a transfer from this wallet's identity or main account with the key
   * itself (a bot's own payout): runs `sign` while this wallet holds both accounts in its one
   * account claim, having waited its turn and the chain's spacing, so the transfer cannot be
   * signed at a nonce a message payment or a native send is using. `sign` reads the nonce
   * itself, broadcasts, and says what it sent; the account it spent stays claimed until the
   * chain shows that transaction mined or its nonce consumed (for this session: the transfer
   * has no durable record here). Rejects with what `sign` rejects with; then nothing is held.
   */
  runOwnTransfer?<
    T extends { txHash: string; from: string; nonce: number }
  >(
    sign: () => Promise<T>,
    options?: { mainAccountWaitMs?: number }
  ): Promise<T>;
  readonly chainUtxoPool?: ChainUtxoPool;
  invalidateBalanceCache?(networkTag?: string): void;
  close(): Promise<void>;
}

/** Present only on the private wallet-owner facade, never inferred from a normal legacy handle. */
export interface MonadCanonicalWalletHandle extends EvmWalletHandle {
  walletState: MonadWalletPersistenceBundle;
  canonicalRoles: MonadCanonicalRoleOwner;
  installedNetworkTag: "MONT" | "MON1" | "MONR";
  runCanonicalExclusive<T>(
    operation: (
      lifetime: MonadWalletOperationAdmission
    ) => Promise<T>
  ): Promise<T>;
}

export type EvmCanonicalWalletHandle = MonadCanonicalWalletHandle;

/**
 * What an account signs into its own directory entry: the one relay it lives on and how long the
 * entry is valid. The relay tuple is the one that relay publishes at `/relay/v1/info`.
 */
export interface PublicRevisionZeroInput {
  readonly networkTag: "MONT" | "MON1" | "MONR";
  readonly network: string;
  readonly chainId: bigint;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly now: Timestamp;
  readonly relay: RelayBinding;
}

/** A later revision of the same entry: a renewal, or a move to another relay. No key changes. */
export interface PublicNextRevisionInput extends PublicRevisionZeroInput {
  /** Revision being signed; the current head's revision plus one. */
  readonly revision: bigint;
  /** T1 of the current head statement. */
  readonly predecessor: Uint8Array;
}

export interface PublicRevisionZeroExport {
  readonly kind: "public-revision-zero-preparation";
  readonly registry: RolePoint["registry"];
  readonly networkTag: "MONT" | "MON1" | "MONR";
  readonly network: string;
  readonly chainId: bigint;
  readonly authAddress: string;
  readonly auth: RolePoint<"auth">;
  readonly message: RolePoint<"message">;
  readonly stamp: RolePoint<"stamp">;
  readonly statement: Uint8Array;
  readonly attestation: Uint8Array;
  readonly t1: Uint8Array;
  readonly configuration: PublicRevisionZeroInput;
}

export interface PublicNextRevisionExport
  extends Omit<PublicRevisionZeroExport, "kind" | "configuration"> {
  readonly kind: "public-next-revision-preparation";
  readonly revision: bigint;
  readonly configuration: PublicNextRevisionInput;
}

