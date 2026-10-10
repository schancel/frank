/** Shared and concrete EVM handle contracts; leaf implementation owners remain unchanged. */
import type { Provider, Wallet } from "ethers";
import type { MonadSubAccountPool } from "./monad-account-pool";
import type { SubAccountLeaseManager } from "./monad-account-lease";
import type { MonadTxSubmitter } from "./monad-account-tx";
import type { MonadChangePool } from "./monad-change-pool";
import type { StampPaymentJournal } from "./storage/stamp-payment-journal";
import type { StampAttemptJournal } from "./storage/stamp-attempt-journal";
import type { TopicOperationJournal } from "./storage/topic-operation-journal";
import type {
  MonadWalletPersistenceBundle,
  MonadWalletOperationAdmission,
} from "./storage/monad-wallet-bundle";
import type { MonadCanonicalRoleOwner } from "./monad-wallet-material";
import type { StealthItem } from "@frank/cashweb/types/messages";
import type { MonadIdentity } from "./monad-identity";
import type { AccountHygieneEngine } from "./account-hygiene";
import type { ChainUtxoPool } from "./chain-utxo-pool";
import type { WalletHandle, NativeWalletHandle } from "./chain/active-chain";

export interface EvmWalletHandle {
  /** Master / author identity for signing messages and topic posts. */
  identity?: MonadIdentity;
  /** Explicit typed-root capability; absent until canonical composition is activated. */
  canonicalRoles?: MonadCanonicalRoleOwner;
  /** Private active delegation from the existing owner; structural values are rejected. */
  walletOperationAdmission?: MonadWalletOperationAdmission;
  /** Autonomous account hygiene and lazy dirty sweeper (Ticket #925). Encapsulated beneath the wallet API. */
  hygieneEngine?: AccountHygieneEngine<string>;
  /** Unified in-memory UTXO and spendable account pool (Issue #1184). */
  accountUtxoPool?: ChainUtxoPool;
  chainUtxoPool?: ChainUtxoPool;
  /** Invalidate in-memory cached balances across primary and stealth accounts. */
  invalidateBalanceCache?(networkTag?: string): void;
  /** @deprecated Use `accountUtxoPool` instead. */
  pool: MonadSubAccountPool;
  leaseManager: SubAccountLeaseManager;
  provider: Provider;
  httpClient: MonadTxSubmitter;
  /** HD change branch used to recover the unused balance from confirmed, single-use payment
   * accounts. Optional for narrow tests and external callers that have not wired persistence yet;
   * `MonadChain.createWallet` always supplies it from the same seed as `pool`.
   * @deprecated Use `accountUtxoPool` instead. */
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
  readonly chainUtxoPool?: ChainUtxoPool;
  invalidateBalanceCache?(networkTag?: string): void;
  close(): Promise<void>;
}
