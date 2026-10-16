import { getAddress, hexlify } from "ethers";
import type {
  ChainAddress,
  DirectMessageFundAheadResult,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageStampQuote,
  NativeWalletHandle,
  WalletHandle,
} from "./active-chain";
import type { StealthItem } from "@frank/cashweb/types/messages";
import type { EvmChainWalletHandle, EvmWalletHandle } from "../evm-wallet-handle";
import type {
  PublicRevisionZeroInput,
  PublicRevisionZeroExport,
  PublicNextRevisionInput,
  PublicNextRevisionExport,
} from "../evm-wallet-handle";
import type { MonadWalletMaterial } from "../evm-wallet-material";
import type { MonadCanonicalStampClient } from "../evm-stamp-client";
import type { CanonicalWalletBindingMismatchError } from "../storage/evm-wallet-bundle";
import {
  CanonicalMessagingPendingError,
  type canonicalDirectMessages,
  type CanonicalDirectory,
} from "./evm-canonical-dm";
import type { EvmLegacyConsolidator } from "./evm-legacy-consolidator";
import {
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
} from "./chain-wallet";
import type { FundAheadBackoff } from "./evm-chain-config-env";

export const closedWallets = new WeakSet<EvmChainWalletHandle>();
export const typedWallets = new WeakSet<EvmChainWalletHandle>();
export const walletMaterial = new WeakMap<
  EvmChainWalletHandle,
  MonadWalletMaterial
>();
export const walletFundingCandidates = new WeakMap<
  EvmChainWalletHandle,
  () => readonly {
    source: "main" | "identity" | "coin";
    address: string;
    privateKey: () => string;
    balanceWei?: bigint;
  }[]
>();
// Facades may receive a handle created by another factory on the same configured network.
// Its key ownership and send queue travel with that handle, not with the receiving facade.
export const walletSendQueues = new WeakMap<
  EvmChainWalletHandle,
  Promise<void>
>();
// The private topic owner and enclosing admission travel with the creator's wallet too.
export const privateTopicWallets = new WeakMap<
  EvmChainWalletHandle,
  EvmWalletHandle
>();
export const installedCanonicalWalletDescriptors = new WeakMap<
  object,
  { networkTag: "MONT" | "MON1" | "MONR"; network: string; chainId: bigint }
>();

/** Public local evidence only. No Current, enrollment, provider or financial effects. */
export function prepareMonadRevisionZeroExport(
  wallet: NativeWalletHandle,
  input: PublicRevisionZeroInput
): PublicRevisionZeroExport {
  const live = wallet as EvmChainWalletHandle;
  const material = walletMaterial.get(live);
  if (
    !material?.canonicalRoles ||
    !typedWallets.has(live) ||
    closedWallets.has(live)
  )
    throw new Error("Revision-zero export requires live typed wallet custody");
  const unavailable = canonicalUnavailableWallets.get(wallet);
  if (unavailable) throw unavailable;
  const installed = installedCanonicalWalletDescriptors.get(wallet);
  if (
    !installed ||
    installed.networkTag !== input.networkTag ||
    installed.network !== input.network ||
    installed.chainId !== input.chainId
  )
    throw new Error(
      "Revision-zero export differs from actual installed wallet descriptor"
    );
  return material.canonicalRoles.prepareRevisionZero(input);
}

/** The next revision of this account's own entry: a renewal or a move to another relay. Public
 * local evidence only, signed by the same live typed wallet; no Current, provider or financial effects. */
export function prepareMonadNextRevisionExport(
  wallet: NativeWalletHandle,
  input: PublicNextRevisionInput
): PublicNextRevisionExport {
  const live = wallet as EvmChainWalletHandle;
  const material = walletMaterial.get(live);
  if (
    !material?.canonicalRoles ||
    !typedWallets.has(live) ||
    closedWallets.has(live)
  )
    throw new Error(
      "Directory entry renewal requires live typed wallet custody"
    );
  const unavailable = canonicalUnavailableWallets.get(wallet);
  if (unavailable) throw unavailable;
  const installed = installedCanonicalWalletDescriptors.get(wallet);
  if (
    !installed ||
    installed.networkTag !== input.networkTag ||
    installed.network !== input.network ||
    installed.chainId !== input.chainId
  )
    throw new Error(
      "Directory entry renewal differs from actual installed wallet descriptor"
    );
  return material.canonicalRoles.prepareNextRevision(input);
}

export const canonicalClientFactories = new WeakMap<
  object,
  () => MonadCanonicalStampClient
>();
// Live handles whose storage holds a canonical journal bound to a different identity tuple.
export const canonicalUnavailableWallets = new WeakMap<
  object,
  CanonicalWalletBindingMismatchError
>();

/** Opt-in bridge verifies the actual registered live typed wallet; no caller-supplied owner. */
export function canonicalMonadStampClient(
  wallet: NativeWalletHandle
): MonadCanonicalStampClient {
  const unavailable = canonicalUnavailableWallets.get(wallet);
  if (unavailable) throw unavailable;
  const create = canonicalClientFactories.get(wallet);
  if (!create)
    throw new Error("Canonical wallet requires live typed persistent custody");
  return create();
}

// Canonical direct messages (#778). The caller installs the open directory once this account's own
// entry is published; it is never inferred from a wallet.
export const canonicalDirectories = new WeakMap<object, CanonicalDirectory>();
export const canonicalMessaging = new WeakMap<
  object,
  ReturnType<typeof canonicalDirectMessages>
>();

/** Install the caller's verified public directory for one live typed wallet. Returns its removal. */
export function installCanonicalDirectory(
  wallet: NativeWalletHandle,
  directory: CanonicalDirectory
): () => void {
  const installed = installedCanonicalWalletDescriptors.get(wallet);
  if (
    !installed ||
    !canonicalMessaging.has(wallet) ||
    closedWallets.has(wallet as EvmChainWalletHandle)
  )
    throw new Error(
      "Canonical directory requires live typed persistent custody"
    );
  if (installed.network !== directory.network)
    throw new Error(
      "Canonical directory differs from actual installed wallet network"
    );
  canonicalDirectories.set(wallet, directory);
  return () => {
    if (canonicalDirectories.get(wallet) === directory)
      canonicalDirectories.delete(wallet);
  };
}

export type CanonicalInventoryFunder = (input: {
  stampValueWei: bigint;
  /** Unused: the fee an account keeps back does not depend on the recipient. */
  recipientStampKey?: Uint8Array;
  onProgress?: (progress: DirectMessagePreparationProgress) => void;
}) => Promise<string[]>;

export const canonicalInventoryFunders = new WeakMap<
  object,
  CanonicalInventoryFunder
>();
/** The existing live payer owns read-only stamp planning too; no second spend inventory. */
export const canonicalStampQuoters = new WeakMap<
  object,
  (input: {
    stampValueWei: bigint;
    excludedAddresses?: readonly string[];
  }) => Promise<DirectMessageStampQuote>
>();
/** Per live typed wallet: its fund-ahead pass (`DirectMessageClient.fundAhead`). */
export const stampFundersAhead = new WeakMap<
  object,
  () => Promise<DirectMessageFundAheadResult>
>();
export const fundAheadBackoffs = new WeakMap<object, FundAheadBackoff>();

/** The main account was just read: more money than the last pass saw ends its wait. */
export function noteMainBalanceForFundAhead(
  wallet: object,
  balanceWei: bigint
): void {
  const waiting = fundAheadBackoffs.get(wallet);
  if (
    waiting?.mainBalanceWei !== undefined &&
    balanceWei > waiting.mainBalanceWei
  )
    fundAheadBackoffs.delete(wallet);
}

/**
 * Funds receipt-confirmed single-use sender accounts for one canonical stamp of `stampValueWei`,
 * from the wallet's own EVM main account, through the same pool machinery and owner admission as
 * every other inventory preparation. The accounts are left free for whichever message claims
 * them. Returns the funding transaction hashes (empty when inventory already sufficed).
 */
export function prepareCanonicalStampInventory(
  wallet: NativeWalletHandle,
  input: Parameters<CanonicalInventoryFunder>[0]
): Promise<string[]> {
  const fund = canonicalInventoryFunders.get(wallet);
  if (!fund || closedWallets.has(wallet as EvmChainWalletHandle))
    throw new Error(
      "Canonical inventory requires live typed persistent custody"
    );
  return fund(input);
}

/**
 * Scoped canonical message roles of the live typed wallet for one admitted Current of its own
 * subject. The caller disposes the result. No second copy of the wallet roots is needed.
 */
export function createCanonicalMessageRoles(
  wallet: NativeWalletHandle,
  current: import("../../directory-admission/src").Current
) {
  const live = wallet as EvmChainWalletHandle;
  const material = walletMaterial.get(live),
    installed = installedCanonicalWalletDescriptors.get(wallet);
  if (
    !material?.canonicalRoles ||
    !installed ||
    !typedWallets.has(live) ||
    closedWallets.has(live)
  )
    throw new Error("Canonical roles require live typed wallet custody");
  return material.canonicalRoles.create(installed.network, current);
}

/**
 * The live typed wallet's private conversation-ID salt, or `undefined` for a wallet that has no
 * typed messaging root (it then cannot allocate a deterministic conversation ID and its host
 * allocates a random one). See `@frank/cashweb/relay/conversation-id`.
 */
export function conversationIdSaltOf(
  wallet: NativeWalletHandle | WalletHandle
): Uint8Array | undefined {
  const live = wallet as EvmChainWalletHandle;
  const material = walletMaterial.get(live);
  if (
    !material?.canonicalRoles ||
    !typedWallets.has(live) ||
    closedWallets.has(live)
  )
    return undefined;
  return material.canonicalRoles.conversationIdSalt();
}

/** Typed wallets use only the canonical path: pending is an error, never a legacy fallback. */
export function canonicalMessagingFor(wallet: EvmChainWalletHandle) {
  requireOpenWallet(wallet);
  if (!typedWallets.has(wallet)) return undefined;
  const canonical = canonicalMessaging.get(wallet);
  if (!canonical)
    throw new CanonicalMessagingPendingError(
      "Canonical direct messages require persistent typed wallet storage on a Monad network."
    );
  return canonical;
}

export const enclosingTopicAdmissions = new WeakSet<EvmChainWalletHandle>();

export interface MainAccountAdmission {
  key: string;
  store: NativeTransactionAttemptStore;
}

export const mainAccountAdmissions = new WeakMap<
  EvmChainWalletHandle,
  MainAccountAdmission
>();

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

export const receivedCoinOwners = new WeakMap<object, ReceivedCoinOwner>();
/** Per wallet: the accounts (lower case) a signed transfer is held on while its message is being
 * delivered. Nothing else may take such an account's next nonce: not a native send or a sweep
 * (the journal refuses those), and not a funding transfer (which reads the nonce from the node,
 * so it asks here first). */
export const heldTransferSources = new WeakMap<object, () => Set<string>>();
export const sourceIsHeld = (wallet: object, address: string): boolean =>
  heldTransferSources.get(wallet)?.().has(address.toLowerCase()) ?? false;

export const nativeOperationOwners = new WeakMap<
  EvmChainWalletHandle,
  EvmLegacyConsolidator
>();

export function nativeOperationOwner(
  wallet: EvmChainWalletHandle
): EvmLegacyConsolidator {
  requireOpenWallet(wallet);
  const owner = nativeOperationOwners.get(wallet);
  if (!owner) throw new Error("Wallet has no durable native-operation owner");
  return owner;
}

/** Sends again the notes of earlier operations whose transport failed or never ran: every send
 * and resume is also a retry for them. Not waited for, and nothing it meets is this call's error. */
export function retryEarlierNotes(
  owner: EvmLegacyConsolidator,
  operationId: string,
  started: { transported: Promise<void> }
): void {
  // Once this call's own note has been tried: if that just failed, the earlier ones would fail
  // the same way now, and the next send or resume tries them all again.
  void started.transported
    .then(() =>
      owner.syncTransportFailed(operationId) ? undefined : owner.flushSync()
    )
    .catch(() => undefined);
}

export async function reconcileNativeAdmission(
  admission: MainAccountAdmission
): Promise<void> {
  const persisted = admission.store.get(admission.key);
  if (persisted !== undefined)
    throw new NativeTransactionSubmissionError({
      transaction: persisted,
      reason: new Error(
        "Unsupported retained hash-only native evidence; preserve and reconcile before native admission"
      ),
    });
}

// One typed economic owner per EVM account/network in this runtime, across chain factories.
// Repeated callers on the same factory share its handle; another auth/factory must first close it.
export const openTypedEvmAccounts = new Set<string>();

export function requireOpenWallet(wallet: EvmChainWalletHandle): void {
  if (closedWallets.has(wallet)) throw new Error("Monad wallet is closed");
}

export function requireLegacyMessaging(wallet: EvmChainWalletHandle): void {
  requireOpenWallet(wallet);
  if (typedWallets.has(wallet)) {
    throw new Error(
      "Typed Monad wallets do not use the legacy stamp-payment journal"
    );
  }
}

/** Narrows a generic `WalletHandle` to `EvmChainWalletHandle`. */
export function asMonadWallet(
  wallet: WalletHandle,
  expectedNetworkId?: string
): EvmChainWalletHandle {
  const candidate = wallet as Partial<EvmChainWalletHandle>;
  requireOpenWallet(wallet as EvmChainWalletHandle);
  if (
    (candidate.family !== undefined && candidate.family !== "evm") ||
    candidate.pool === undefined ||
    candidate.leaseManager === undefined ||
    candidate.provider === undefined ||
    candidate.httpClient === undefined ||
    candidate.relayBaseUrl === undefined
  ) {
    throw new Error(
      "Expected an EvmChainWalletHandle (produced by MonadChain.createWallet), got a " +
        "WalletHandle missing the Monad wallet-client bundle"
    );
  }
  if (
    expectedNetworkId !== undefined &&
    candidate.networkId !== undefined &&
    candidate.networkId !== expectedNetworkId
  ) {
    throw new Error(
      `Expected Monad network ${expectedNetworkId}, got ${candidate.networkId}`
    );
  }
  return candidate as EvmChainWalletHandle;
}

export function toChainAddress(raw: string): ChainAddress {
  return { raw: getAddress(raw) };
}

export function bareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2);
}

export {
  prepareMonadRevisionZeroExport as prepareEvmRevisionZeroExport,
  prepareMonadNextRevisionExport as prepareEvmNextRevisionExport,
  canonicalMonadStampClient as canonicalEvmStampClient,
  asMonadWallet as asEvmWallet,
};
