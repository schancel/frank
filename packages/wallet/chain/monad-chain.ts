import type { MonadWalletOperationAdmission } from "../storage/monad-wallet-bundle";
import type {
  PublicRevisionZeroInput,
  PublicRevisionZeroExport,
  PublicNextRevisionInput,
  PublicNextRevisionExport,
} from "../monad-wallet-handle";
import { MonadStealthKeyring, buildEvmStealthPayment } from "../monad-stealth";
import {
  EvmLegacyConsolidator,
  FundingAccount,
} from "./evm-legacy-consolidator";
/**
 * `MonadChain`: the real `ActiveChain` implementation (ticket #41 -- see `PLAN.md`'s M9 section)
 * over the already-merged Monad wallet clients (`../wallet/monad-stamp-client.ts`,
 * `monad-topic-post-client.ts`, `monad-topic-vote-client.ts`, `monad-topic-tally-client.ts`,
 * `monad-message-feed.ts`, `monad-message-envelope.ts`, `monad-identity.ts`). See
 * `./active-chain.ts`'s header for the interface-level design notes and deviations from issue
 * #41's own sketch; this file's header covers implementation-level judgment calls only.
 *
 * ## Configuration: why this file reads `process.env`, unlike the wallet client modules it wires
 *
 * Every wallet-client module this file composes (`../wallet/monad-http.ts`,
 * `../wallet/monad-stamp-client.ts`, ...) deliberately never reads `process.env` itself -- config
 * is always a caller-supplied constructor param, so those modules stay composable/testable
 * regardless of how a caller sources config (see `monad-stamp-client.ts`'s header: "Passed
 * explicitly rather than read from `process.env` here, matching `monad-http.ts`'s established
 * convention"). This file *is* that caller: it's the composition root the whole app imports
 * through (`./index.ts`'s `activeChain`), the same role `qwen-bot-common.ts`/the
 * `*.livecheck.ts` scripts already play for their own one-off demos, just wired once for the whole
 * app instead of per script. `loadMonadChainConfigFromEnv` reads the public relay and chain ID,
 * never a secret-bearing upstream RPC URL, plus `MONAD_STAMP_BURN_ADDRESS`,
 * `CASHWEB_STAMP_MIN_BURN_VALUE_WEI`), falling back to permissive localhost/testnet-adjacent
 * defaults (matching `qwen-bot.livecheck.ts`'s own `E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'`
 * precedent) rather than hard-failing on a missing var, so importing this module (e.g. from a jest
 * test, or from `chain/index.ts` in a dev environment with no `.env` configured yet) never throws
 * at import time. `createMonadChain` itself is a pure factory taking an explicit
 * `MonadChainConfig` -- this ticket's own tests build chains against a fixed test config, never
 * against env, and mock every wallet client `MonadChain` composes rather than hitting real HTTP.
 *
 * ## `directMessages`: wiring `monad-message-envelope.ts` for real
 *
 * `send()` resolves the recipient's registered pubkey via `../wallet/monad-identity.ts`'s
 * `fetchMonadProfile` (itself `GET /metadata/:addr` -- see that file's header for the live
 * Lotus-address-only backend gap this inherits), builds a real encrypted envelope
 * (`buildEnvelope`) keyed on both parties' addresses, and submits it via a fresh `MonadStampClient`
 * built from the sending wallet's own `MonadWalletHandle` bundle. `items: MessageItem[]` is
 * JSON-serialized into the envelope's plaintext (`serializeMessageItems` below) -- deliberately
 * only for the item kinds that have a real Monad-side meaning (`text`/`reply`/`image`);
 * `stealth`/`p2pkh` (Lotus on-chain-payment-embedded-in-message kinds) have no Monad equivalent to
 * build here (`PLAN.md`'s own M9 notes: the old `Wallet` class's ~400 lines of UTXO coin-selection
 * this would need "have no Monad equivalent to port -- not a gap, a simplification"), so `send()`
 * throws a clear error if asked to send one rather than silently dropping it.
 *
 * `fetchSince()` reads the wallet's own authenticated mailbox (`monad-message-feed.ts`'s
 * `fetchMonadMessagesSince`, which signs a relay challenge with the identity key; the relay serves
 * only rows addressed to this identity and a relay without the mailbox is a thrown
 * `MonadMailboxUnavailableError`, never an empty inbox), then imports/acks confirmed-prefix
 * recovery obligations (`syncMailboxRecoveries` below), parses every stored
 * message's `encrypted_payload` as a `MonadMessageEnvelope` (`parseEnvelope` -- silently skipping
 * anything that doesn't parse as one, e.g. pre-#9 demo messages with no envelope at all, exactly
 * the behavior that function's own doc comment describes), keeps only envelopes addressed to the
 * wallet's own identity address (`envelope.to`, compared case-insensitively -- EIP-55 checksums
 * differ only in letter case), resolves each sender's pubkey the same way `send()` resolves the
 * recipient's, and decrypts. The `stampValueWei` field on the returned
 * `DirectMessageReceived` is summed from the message's own signed stamp transactions
 * (`ethers.Transaction.from(...).value`), not merely echoed from config -- it is the actual
 * recipient-payment value, even if it ever diverges from `defaultStampValueWei`.
 *
 * ## Canonical Forum topics
 *
 * Topic reads use complete retained CBOR snapshots and the wallet-specific exact model.
 * Paid actions reconcile retained canonical operations under wallet admission before funding.
 */
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  formatEther,
  getAddress,
  getBytes,
  hexlify,
  parseEther,
} from "ethers";

import {
  ActiveChain,
  ChainAddress,
  ChainTransaction,
  DirectMessageClient,
  DirectMessagePreparationProgress,
  DirectMessageReceived,
  DirectMessageSendResult,
  ProfileInfo,
  StampPaymentInfo,
  TopicBroadcastClient,
  TopicPostOutcomeUnknownError,
  NativeWalletHandle,
  WalletHandle,
} from "./active-chain";
import { MessageItem, WalletSyncItem } from "@frank/cashweb/types/messages";
import { ForumMessage, ForumReadPolicy } from "../forum-model";
import { encodeForumPost } from "@frank/codec";
import { resolveChainIdentifier, PROTOCOL_CHAINS } from "./chains-registry";
import { applyWalletSyncItem } from "../sync-dispatcher";

import {
  createMonadWalletMaterial,
  canonicalWalletPublicBinding,
} from "../monad-wallet-material";
import type {
  MonadRootBundle,
  MonadWalletMaterial,
} from "../monad-wallet-material";
import type { HDSeed } from "./active-chain";
import { MonadChangePool } from "../monad-change-pool";
import { MonadSubAccountPool } from "../monad-account-pool";
import { ChainUtxoPool } from "../chain-utxo-pool";
import {
  BurnNotSentError,
  SubAccountLeaseManager,
} from "../monad-account-lease";
import { MonadHttpClient } from "../monad-http";
import { discoverFakeDemoRpc, FakeDemoRpcConfig } from "../monad-demo-rpc";
import {
  createMonadJsonRpcProvider,
  DEFAULT_MONAD_CHAIN_ID,
  monadProtocolIdentity,
} from "../monad-provider";
import {
  MonadAccountTxSigner,
  type MonadTxOverrides,
} from "../monad-account-tx";
import { MonadWalletHandle } from "../monad-wallet-handle";
import {
  openExistingPoolMonadTopicOwner,
  type CanonicalWalletBindingMismatchError,
  type MonadWalletPersistenceBundle,
} from "../storage/monad-wallet-bundle";
import {
  MonadIdentity,
  fetchMonadProfile,
  mailboxAuthFor,
} from "../monad-identity";
import {
  MonadStampClient,
  MonadCanonicalStampClient,
  quoteMonadStampPaymentGasReserve,
  recoverMonadStampPayments,
} from "../monad-stamp-client";
import { fetchMonadMessagesSince } from "@frank/cashweb/relay/monad-message-feed";
import { MailboxAuthParams } from "@frank/cashweb/relay/monad-mailbox-client";
import {
  decryptEnvelope,
  parseEnvelope,
} from "@frank/cashweb/relay/monad-message-envelope";
import {
  MonadTopicPostClient,
  MonadTopicPostAbandonedError,
  quoteMonadTopicBurnGasReserve,
} from "../monad-topic-post-client";
import { MonadTopicVoteClient } from "../monad-topic-vote-client";
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from "../monad-topic-tally-client";
import { readViteEnv } from "./vite-env";
import {
  CanonicalMessagingPendingError,
  LevelCanonicalLinkStore,
  MemoryCanonicalLinkStore,
  canonicalDirectMessages,
  type CanonicalDirectory,
  type CanonicalLinkStore,
} from "./monad-canonical-dm";
export {
  CanonicalMessagingHoldError,
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  CanonicalRecipientUndeliverableError,
  CanonicalRelayCannotForwardError,
  type CanonicalDirectory,
} from "./monad-canonical-dm";
import {
  ChainFamily,
  defaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  runNativeTransactionExclusive,
  sameChainTransaction,
} from "./chain-wallet";
import { LevelSubAccountPoolStore } from "../storage/level-sub-account-pool-store";
import { LevelChangePoolStore } from "../storage/level-change-pool-store";
import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
} from "../storage/stamp-payment-journal";
import {
  InMemoryStampAttemptJournal,
  LevelStampAttemptJournal,
} from "../storage/stamp-attempt-journal";
import {
  EvmTransactionBuilder,
  defaultNativeEvmTransactionBuilder,
} from "./evm-transaction-builder";

export interface EvmChainConfig extends MonadChainConfig {
  /** Unique chain identifier, e.g. "monad-testnet", "monad-mainnet", "hyperliquid-mainnet", "tempo-mainnet". */
  readonly chainIdentifier?: string;
  /** Human-readable chain display name, e.g. "Base", "HyperEVM". */
  readonly name?: string;
  /** Primary display unit symbol, e.g. "ETH", "HYPE". */
  readonly unit?: string;
  /** Custom transaction builder strategy for native gas vs token-as-gas (TIP-20/ERC-20). */
  readonly transactionBuilder?: EvmTransactionBuilder;
}

export interface MonadChainConfig {
  /** Stable chain/deployment identifier used for wallet affinity checks. */
  networkId: string;
  /** Shared protocol chain identifier used by the relay family route. */
  rpcChain: string;
  /** Expected EVM chain ID, e.g. 10143 for Monad testnet. */
  chainId: number | bigint;
  /** Base URL of the `cashweb-registry` relay. */
  relayBaseUrl: string;
  /** Frank network tag included in every DM envelope before hashing. */
  networkTag: string;
  /** `0x`-prefixed Monad burn address Stamp/topic-vote burns are sent to (see
   * `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`). */
  stampBurnAddress: string;
  /** Default aggregate value, in wei, `directMessages.send` pays per Stamp message. */
  defaultStampValueWei: bigint;
  /** Default value, in wei, burned for a topic post or vote. */
  defaultTopicVoteValueWei: bigint;
  /** How many single-use funding sub-accounts `createWallet` pre-derives into the pool. */
  subAccountPoolSize: number;
  /** Parent LevelDB location for durable sender-account and change state. `false` is reserved for
   * isolated tests; production must persist these records so recreating a wallet cannot reuse a
   * sender account or rewind the change derivation path. */
  walletStorageLocation: string | false;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  /** Explicit disposable fake-service opt-in; never selected by a relay failure. */
  fakeDemo?: FakeDemoRpcConfig;
}

// Ticket #54 (found live doing real end-to-end GUI testing against a real relay + real Alchemy
// RPC -- the app silently fell back to `http://127.0.0.1:8545`, breaking every real chain call):
// `process.env.KEY` is silently always `undefined` in the browser bundle in this
// `@quasar/app-vite`/Vite 8/Rolldown toolchain -- confirmed a genuine, generic gap (even Vite's
// own built-in `process.env.NODE_ENV` has it), not something fixable with a `define` tweak (see
// `app/quasar.config.js`'s own investigation). `import.meta.env.QCLI_KEY` is the mechanism that
// actually works under this toolchain (Quasar's own `QCLI_` env-var-prefix convention, confirmed
// live) -- see `./vite-env.ts` for why that logic isn't written directly in this file, and
// `jest.config.js`'s `moduleNameMapper` for how this package's own tests avoid it entirely.
function readEnv(key: string): string | undefined {
  return readViteEnv(`QCLI_${key}`) ?? process.env[key];
}

export const CUSTOM_RELAY_STORAGE_KEY = "frank.relay.serverUrl";

let memoryCustomRelayUrl: string | undefined = undefined;

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore access restriction
  }
  return null;
}

/**
 * Returns the custom relay server URL persisted in localStorage, if one was configured by the user.
 */
export function getCustomRelayBaseUrl(): string | undefined {
  const storage = getLocalStorage();
  if (storage) {
    try {
      const stored = storage.getItem(CUSTOM_RELAY_STORAGE_KEY)?.trim();
      if (stored) {
        const parsed = new URL(stored);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return stored.replace(/\/+$/, "");
        }
      }
    } catch {
      // ignore invalid URL or storage error
    }
    return memoryCustomRelayUrl;
  }
  return memoryCustomRelayUrl;
}

/**
 * Persists or clears a custom relay server URL in localStorage.
 */
export function setCustomRelayBaseUrl(url: string | undefined): void {
  const cleaned =
    url && url.trim().length > 0 ? url.trim().replace(/\/+$/, "") : undefined;
  const storage = getLocalStorage();
  if (storage) {
    try {
      if (cleaned) {
        storage.setItem(CUSTOM_RELAY_STORAGE_KEY, cleaned);
      } else {
        storage.removeItem(CUSTOM_RELAY_STORAGE_KEY);
      }
    } catch {
      // ignore storage error
    }
  }
  memoryCustomRelayUrl = cleaned;
}

/**
 * Resolves the default build-injected relay base URL.
 */
export function getDefaultRelayBaseUrl(): string {
  const configured =
    readEnv("MONAD_RELAY_BASE_URL") ?? readEnv("E2E_DEMO_RELAY_URL");
  if (
    typeof window !== "undefined" &&
    window.location &&
    window.location.origin
  ) {
    const isLoopback =
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "localhost";
    if (isLoopback) {
      if (configured) {
        try {
          const parsed = new URL(configured);
          if (
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost"
          ) {
            return configured;
          }
        } catch {
          // ignore
        }
      }
      const port = readEnv("FRANK_DEMO_RELAY_PORT") ?? "8098";
      return `http://127.0.0.1:${port}`;
    }
    if (!configured) return window.location.origin;
    try {
      const parsed = new URL(configured);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return window.location.origin;
      }
    } catch {
      // keep configured
    }
  }
  return configured ?? "http://127.0.0.1:8098";
}

/** Reads `MonadChainConfig` from the environment (see `readEnv` just above for exactly where
 * from, and why two places), with permissive fallbacks -- see this file's header,
 * "Configuration", for why this (unlike the wallet client modules it configures) reads env
 * directly, and why it never throws on a missing var. */
export function loadMonadChainConfigFromEnv(overrides?: {
  isTestnet?: boolean;
}): MonadChainConfig {
  const rpcChain =
    overrides?.isTestnet !== undefined
      ? overrides.isTestnet
        ? "monad-testnet"
        : "monad-mainnet"
      : readEnv("MONAD_RPC_CHAIN") ?? "monad-testnet";
  const protocolIdentity = monadProtocolIdentity(rpcChain);
  const rawChainId = readEnv("MONAD_CHAIN_ID");
  // Quasar emits this explicit flag as a boolean; Node env values are strings.
  const fakeDemoFlag: unknown = readEnv("FRANK_FAKE_DEMO");
  const fakeDemoEnabled = fakeDemoFlag === true || fakeDemoFlag === "true";
  let chainId: bigint | undefined;
  if (rawChainId) {
    try {
      chainId = BigInt(rawChainId);
    } catch {
      // ignore invalid env var and fallback
    }
  }

  return {
    networkId:
      overrides?.isTestnet !== undefined
        ? rpcChain
        : readEnv("MONAD_NETWORK_ID") ?? rpcChain,
    rpcChain,
    // Known protocol rows are atomic: public overrides must not create a
    // mainnet route with a testnet chain ID (or the inverse).
    chainId:
      fakeDemoEnabled && rawChainId !== undefined
        ? chainId ?? -1n
        : protocolIdentity?.chainId ?? chainId ?? DEFAULT_MONAD_CHAIN_ID,
    get relayBaseUrl() {
      return getCustomRelayBaseUrl() ?? getDefaultRelayBaseUrl();
    },
    networkTag:
      (fakeDemoEnabled ? readEnv("FRANK_NETWORK_TAG") : undefined) ??
      protocolIdentity?.networkTag ??
      readEnv("FRANK_NETWORK_TAG") ??
      "MONT",
    stampBurnAddress:
      readEnv("MONAD_STAMP_BURN_ADDRESS") ??
      "0x000000000000000000000000000000000000dEaD",
    defaultStampValueWei: BigInt(
      readEnv("FRANK_DM_DEFAULT_STAMP_VALUE_WEI") ?? "10000000000000000"
    ),
    defaultTopicVoteValueWei: BigInt(
      readEnv("FRANK_TOPIC_DEFAULT_VOTE_VALUE_WEI") ??
        readEnv("CASHWEB_STAMP_MIN_BURN_VALUE_WEI") ??
        "1000000000000"
    ),
    subAccountPoolSize: Number(readEnv("MONAD_SUB_ACCOUNT_POOL_SIZE") ?? "8"),
    walletStorageLocation:
      readEnv("MONAD_WALLET_STORAGE_LOCATION") ?? "frank-monad-wallet-state",
    ...(fakeDemoEnabled
      ? {
          fakeDemo: {
            enabled: true,
            controlUrl: readEnv("FRANK_DEMO_CONTROL_URL") ?? "",
          },
        }
      : {}),
  };
}

/** Concrete Monad `WalletHandle`: the formalized wallet-client bundle (`MonadWalletHandle`,
 * `../wallet/monad-wallet-handle.ts`) plus the `identity` the generic `ActiveChain` interface
 * requires. See `./active-chain.ts`'s header, deviation 1, for why `WalletHandle` itself stays
 * `{ identity }`-only while this concrete type carries more. */
export interface MonadChainWalletHandle
  extends MonadWalletHandle,
    WalletHandle,
    NativeWalletHandle {
  readonly family: "evm";
  readonly chainIdentifier: string;
  readonly networkId: string;
  readonly identity: MonadIdentity;
  readonly stealthKeyring: MonadStealthKeyring;
  readonly mainAccount?: Wallet;
  readonly mainPrivateKey?: string;
  close(): Promise<void>;
}

export type EvmChainWalletHandle = MonadChainWalletHandle;

const closedWallets = new WeakSet<MonadChainWalletHandle>();
const typedWallets = new WeakSet<MonadChainWalletHandle>();
const walletMaterial = new WeakMap<
  MonadChainWalletHandle,
  MonadWalletMaterial
>();
// Facades may receive a handle created by another factory on the same configured network.
// Its key ownership and send queue travel with that handle, not with the receiving facade.
const walletSendQueues = new WeakMap<MonadChainWalletHandle, Promise<void>>();
// The private topic owner and enclosing admission travel with the creator's wallet too.
const privateTopicWallets = new WeakMap<
  MonadChainWalletHandle,
  MonadWalletHandle
>();
const installedCanonicalWalletDescriptors = new WeakMap<
  object,
  { networkTag: "MONT" | "MON1"; network: string; chainId: bigint }
>();
/** Public local evidence only. No Current, enrollment, provider or financial effects. */
export function prepareMonadRevisionZeroExport(
  wallet: NativeWalletHandle,
  input: PublicRevisionZeroInput
): PublicRevisionZeroExport {
  const live = wallet as MonadChainWalletHandle;
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
  const live = wallet as MonadChainWalletHandle;
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
const canonicalClientFactories = new WeakMap<
  object,
  () => MonadCanonicalStampClient
>();
// Live handles whose storage holds a canonical journal bound to a different identity tuple.
const canonicalUnavailableWallets = new WeakMap<
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
const canonicalDirectories = new WeakMap<object, CanonicalDirectory>();
const canonicalMessaging = new WeakMap<
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
    closedWallets.has(wallet as MonadChainWalletHandle)
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
type CanonicalInventoryFunder = (input: {
  stampValueWei: bigint;
  recipientStampKey: Uint8Array;
  onProgress?: (progress: DirectMessagePreparationProgress) => void;
}) => Promise<string[]>;
const canonicalInventoryFunders = new WeakMap<
  object,
  CanonicalInventoryFunder
>();
/**
 * Funds receipt-confirmed single-use sender accounts for one canonical stamp of `stampValueWei`,
 * from the wallet's own EVM main account, through the same pool machinery and owner admission as
 * every other inventory preparation. Call it before `prepareIntent`, which selects only funded
 * accounts. Returns the funding transaction hashes (empty when inventory already sufficed).
 */
export function prepareCanonicalStampInventory(
  wallet: NativeWalletHandle,
  input: Parameters<CanonicalInventoryFunder>[0]
): Promise<string[]> {
  const fund = canonicalInventoryFunders.get(wallet);
  if (!fund || closedWallets.has(wallet as MonadChainWalletHandle))
    throw new Error(
      "Canonical inventory requires live typed persistent custody"
    );
  return fund({
    ...input,
    recipientStampKey: new Uint8Array(input.recipientStampKey),
  });
}
/**
 * Scoped canonical message roles of the live typed wallet for one admitted Current of its own
 * subject. The caller disposes the result. No second copy of the wallet roots is needed.
 */
export function createCanonicalMessageRoles(
  wallet: NativeWalletHandle,
  current: import("../../directory-admission/src").Current
) {
  const live = wallet as MonadChainWalletHandle;
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
/** Typed wallets use only the canonical path: pending is an error, never a legacy fallback. */
function canonicalMessagingFor(wallet: MonadChainWalletHandle) {
  requireOpenWallet(wallet);
  if (!typedWallets.has(wallet)) return undefined;
  const canonical = canonicalMessaging.get(wallet);
  if (!canonical)
    throw new CanonicalMessagingPendingError(
      "Canonical direct messages require persistent typed wallet storage on a Monad network."
    );
  return canonical;
}
const enclosingTopicAdmissions = new WeakSet<MonadChainWalletHandle>();
type SignedNativeTransfer = Awaited<
  ReturnType<MonadAccountTxSigner["buildAndSignTransfer"]>
>;
interface MainAccountAdmission {
  key: string;
  store: NativeTransactionAttemptStore;
  unresolved?: {
    signed?: SignedNativeTransfer;
    error: NativeTransactionSubmissionError;
  };
  lastSubmitted?: ChainTransaction;
}
// The native attempt owner travels with the handle, including across chain facades.
const mainAccountAdmissions = new WeakMap<
  MonadChainWalletHandle,
  MainAccountAdmission
>();

async function reconcileNativeAdmission(
  admission: MainAccountAdmission,
  provider: MonadChainWalletHandle["provider"]
): Promise<void> {
  const persisted = admission.store.get(admission.key);
  if (persisted === undefined) {
    admission.unresolved = undefined;
    return;
  }
  if (
    admission.lastSubmitted !== undefined &&
    sameChainTransaction(persisted, admission.lastSubmitted)
  ) {
    // Preserve the existing policy: this owner already received submission acknowledgment.
    // A later submission of identical bytes can still have lost its acknowledgment.
    if (admission.unresolved !== undefined) throw admission.unresolved.error;
    return;
  }
  if (
    admission.unresolved?.signed !== undefined &&
    sameChainTransaction(persisted, admission.unresolved.error.transaction)
  ) {
    // An in-memory unknown attempt keeps its exact retry/explicit-resolution authority.
    throw admission.unresolved.error;
  }
  admission.unresolved = {
    error: new NativeTransactionSubmissionError({
      transaction: persisted,
      reason: new Error("Recovered unresolved native transaction"),
    }),
  };
  const receipt = await provider.getTransactionReceipt(persisted.txHash);
  if (receipt === null || receipt === undefined) {
    throw admission.unresolved.error;
  }
  admission.store.delete(admission.key);
  admission.unresolved = undefined;
}
// One typed economic owner per EVM account/network in this runtime, across chain factories.
// Repeated callers on the same factory share its handle; another auth/factory must first close it.
const openTypedEvmAccounts = new Set<string>();

function requireOpenWallet(wallet: MonadChainWalletHandle): void {
  if (closedWallets.has(wallet)) throw new Error("Monad wallet is closed");
}

function requireLegacyMessaging(wallet: MonadChainWalletHandle): void {
  requireOpenWallet(wallet);
  if (typedWallets.has(wallet)) {
    throw new Error(
      "Typed Monad wallets do not use the legacy stamp-payment journal"
    );
  }
}

/** Narrows a generic `WalletHandle` to `MonadChainWalletHandle`. Safe under this ticket's
 * compile-time single-chain seam (see `./active-chain.ts`'s header) -- `MonadChain.createWallet`
 * is the only producer of `WalletHandle` values in a Monad-only build, so every handle reaching
 * `MonadChain`'s other methods already is one; this throws instead of silently misbehaving if that
 * invariant is ever broken. */
function asMonadWallet(
  wallet: WalletHandle,
  expectedNetworkId?: string
): MonadChainWalletHandle {
  const candidate = wallet as Partial<MonadChainWalletHandle>;
  requireOpenWallet(wallet as MonadChainWalletHandle);
  if (
    (candidate.family !== undefined && candidate.family !== "evm") ||
    candidate.pool === undefined ||
    candidate.leaseManager === undefined ||
    candidate.provider === undefined ||
    candidate.httpClient === undefined ||
    candidate.relayBaseUrl === undefined
  ) {
    throw new Error(
      "Expected a MonadChainWalletHandle (produced by MonadChain.createWallet), got a " +
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
  return candidate as MonadChainWalletHandle;
}

function toChainAddress(raw: string): ChainAddress {
  return { raw: getAddress(raw) };
}

function bareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2);
}

/**
 * Imports the recipient-owned payments of relay recovery obligations into the wallet's stamp
 * payment journal (status `discovered`, so the ordinary sweep path can spend them) and then, only
 * when it is safe, acknowledges terminal obligations so the relay can retire them.
 *
 * Ack safety (the relay forgets the obligation, so the journal becomes the only record of the
 * one-time-address payments):
 * - only a `durable` journal may trigger an ack; an in-memory journal (e.g. `walletStorageLocation:
 *   false`) is still filled for the current session but never acks, so a restart re-reads the
 *   obligation from the relay;
 * - for a terminal obligation EVERY child of the canonical message is journalled, not just the
 *   confirmed prefix: expired/attempts-exhausted claims can still have unconfirmed children land
 *   on chain after the ack, and the sweep checks the on-chain balance;
 * - the ack is sent only after every `confirmedChildren` index is verifiably present in the
 *   journal. A record whose confirmed child cannot be recovered is left un-acked.
 * Non-terminal obligations (`pending`, `fully_confirmed`, `delivered`) import the confirmed
 * children and are never acked (the relay answers 409).
 *
 * Best-effort relative to the inbox read (which already succeeded when this runs): a relay/network
 * failure here is retried on the next poll rather than failing message delivery.
 */
/** Longest `fetchSince` waits for the recovery sync before returning the messages. */
export const MAILBOX_RECOVERY_SYNC_WAIT_MS = 5_000;

async function boundedSync(sync: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sync,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MAILBOX_RECOVERY_SYNC_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** @deprecated Recovery endpoint is retired; stamp discovery is unified through mailbox. */
export const MAILBOX_RECOVERY_SYNC_INTERVAL_MS = 60_000;

/** JSON-serializes `items` for use as a direct message's plaintext.
 * Throws only on `'p2pkh'` items, which are legacy Lotus-only script items.
 * Stealth items are supported across chains (Monad, Solana, eCash). */
export function serializeMessageItems(items: MessageItem[]): string {
  for (const item of items) {
    if (item.type === "p2pkh") {
      throw new Error(
        `MonadChain direct messages don't support '${item.type}' items: on-chain-payment-` +
          "embedded-in-message has no Monad equivalent (see PLAN.md's M9 notes)"
      );
    }
  }
  return JSON.stringify(items);
}

/** Inverse of {@link serializeMessageItems}. Throws if `plaintext` doesn't decode to a JSON
 * array. */
export function deserializeMessageItems(plaintext: string): MessageItem[] {
  const parsed: unknown = JSON.parse(plaintext);
  if (!Array.isArray(parsed)) {
    throw new Error("Decrypted direct-message plaintext was not a JSON array");
  }
  return parsed as MessageItem[];
}

/** Preparing the account that will burn a topic post/vote failed before anything was posted. The
 * pool's funding is record-before-broadcast, so retrying resumes an already-sent funding
 * transaction instead of sending another; the message says so because the caller shows it as is. */
export class TopicBurnPreparationError extends Error {
  constructor(
    reason: string,
    options?: { cause?: unknown; stage?: "preparing" | "signing" }
  ) {
    super(
      options?.stage === "signing"
        ? `Could not build the burn (${reason}). Nothing was sent, and the funded account is kept. ` +
            "It is safe to try again."
        : `Could not prepare an account to burn from (${reason}). Nothing was sent. ` +
            "It is safe to try again: a funding transaction that was already sent is reused, not repeated."
    );
    this.name = "TopicBurnPreparationError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** A burn that failed while being built/signed (RPC hiccup after the account was funded) sent
 * nothing and left the funded account available: report it with the same "nothing sent, safe to
 * retry" message as a failed preparation. Every other error passes through untouched. */
function asNothingSent(err: unknown): never {
  if (err instanceof BurnNotSentError) {
    throw new TopicBurnPreparationError(err.message, {
      cause: err,
      stage: "signing",
    });
  }
  throw err;
}

/** Pure factory: builds an `ActiveChain` from an explicit `MonadChainConfig`. See this file's
 * header, "Configuration", for why config is a param here (unlike the `MonadChain` singleton
 * below, which reads it from env). */
export function createEvmChain(config: EvmChainConfig): ActiveChain {
  const isTestnet =
    config.rpcChain === "monad-testnet" ||
    (config.rpcChain?.includes("testnet") ?? false) ||
    (config.rpcChain?.includes("devnet") ?? false) ||
    config.chainId === 10143 ||
    config.chainId === 10143n ||
    config.networkTag === "MONT";
  const chainIdentifier =
    config.chainIdentifier ??
    config.rpcChain ??
    (isTestnet ? "monad-testnet" : "monad-mainnet");
  const transactionBuilder =
    config.transactionBuilder ?? defaultNativeEvmTransactionBuilder;
  const walletsByIdentity = new Map<
    string,
    { fingerprint: string; pending: Promise<MonadChainWalletHandle> }
  >();
  const mainPrivateKey = (wallet: MonadChainWalletHandle) =>
    walletMaterial.get(wallet)?.mainAccount.privateKey ??
    wallet.identity.toPrivateKeyHex();
  // One queue per wallet for everything that prepares and spends sub-accounts (direct messages,
  // topic posts, votes): a burn account prepared for a topic post must not be picked up by a
  // concurrent stamp selection between preparation and lease.
  const runWalletExclusive = <T>(
    wallet: MonadChainWalletHandle,
    task: (admission?: MonadWalletOperationAdmission) => Promise<T>,
    canonical = false
  ): Promise<T> => {
    requireOpenWallet(wallet);
    const run = (walletSendQueues.get(wallet) ?? Promise.resolve()).then(
      async () => {
        const owner = privateTopicWallets.get(wallet)?.walletState;
        if (
          !canonical &&
          owner?.canonicalRetained
            ?.getIntents()
            .some((intent) =>
              intent.members.some(
                (m) =>
                  wallet.pool.getRecord(m.reservation.index)?.status ===
                  "available"
              )
            )
        )
          throw new Error(
            "Canonical pre-sign intent requires explicit correlation before ordinary pool operations"
          );
        if (!owner) return task();
        enclosingTopicAdmissions.add(wallet);
        try {
          return await (canonical
            ? owner.runCanonicalOperation(task)
            : owner.runOperation(task));
        } finally {
          enclosingTopicAdmissions.delete(wallet);
        }
      }
    );
    walletSendQueues.set(
      wallet,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  };
  const runMainAccountExclusive = <T>(
    wallet: MonadChainWalletHandle,
    task: () => Promise<T>
  ): Promise<T> => {
    let admission = mainAccountAdmissions.get(wallet);
    if (admission === undefined) {
      // Legacy callers may supply the wallet-client bundle directly rather than createWallet.
      admission = {
        key: nativeTransactionAttemptKey({
          family: "evm",
          chainIdentifier,
          address: wallet.identity.address.raw.toLowerCase(),
        }),
        store:
          config.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      };
      mainAccountAdmissions.set(wallet, admission);
    }
    const owner = admission;
    // Always acquire in this order: wallet queue -> native coordination -> pool funding queue.
    // Keep the durable read and all funding/signing inside the same account coordination scope.
    return runNativeTransactionExclusive(
      owner.key,
      owner.store.coordinationScope,
      async () => {
        await reconcileNativeAdmission(owner, wallet.provider);
        return task();
      }
    );
  };
  /** Funds (or reuses) one sub-account able to burn `voteWeightWei` in a single transaction and
   * returns its pool index for the caller to lease. Admission conservatively holds reuse too:
   * even its fee quote signs with the main account. See `MonadSubAccountPool.prepareBurnAccount`. */
  const prepareTopicBurnAccount = async (
    wallet: MonadChainWalletHandle,
    voteWeightWei: bigint,
    onProgress:
      | ((progress: DirectMessagePreparationProgress) => void)
      | undefined
  ): Promise<number> => {
    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: mainPrivateKey(wallet),
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    });
    try {
      onProgress?.({ stage: "checking" });
      const preparation = await runMainAccountExclusive(wallet, async () => {
        // The fee quote itself signs a probe, so it belongs behind admission too.
        const gasReserveWei = await quoteMonadTopicBurnGasReserve({
          signer: mainAccountSigner,
          burnAddress: creatorForumPolicy(
            privateTopicWallets.get(wallet) ?? wallet
          ).burnAddress,
        });
        return wallet.pool.prepareBurnAccount({
          mainAccountSigner,
          provider: wallet.provider,
          burnValueWei: voteWeightWei,
          gasReserveWei,
          onProgress,
        });
      });
      return preparation.index;
    } catch (err) {
      const reason =
        typeof (err as { shortMessage?: unknown })?.shortMessage === "string"
          ? (err as { shortMessage: string }).shortMessage
          : err instanceof Error
          ? err.message
          : String(err);
      throw new TopicBurnPreparationError(reason, { cause: err });
    }
  };
  const directMessages: DirectMessageClient = {
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.send(params);
    },

    async unattributedAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.unattributedAttempts(params);
    },

    async resolveUnattributedAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      await canonical.resolveUnattributedAttempts(params);
    },

    async reconcileAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.reconcileAttempts(params);
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      const received: DirectMessageReceived[] = [];
      const seenDigests = new Set<string>();
      if (canonical) {
        const canonicalReceived = await canonical.fetchSince(params);
        for (const msg of canonicalReceived) {
          const digest = (msg.payloadDigest ?? "").toLowerCase();
          if (digest) {
            seenDigests.add(digest);
          }
          received.push(msg);
        }
      }

      try {
        const mailbox = mailboxAuthFor(wallet.identity, wallet.relayBaseUrl);
        const stored = await fetchMonadMessagesSince({
          ...mailbox,
          sinceMs: params.sinceMs,
          onTruncated: params.onTruncated,
        });
        const myAddress = wallet.identity.address.raw.toLowerCase();

      for (const record of stored) {
        if (record.message === undefined) continue;
        const payloadHashHex = bareHex(record.message.payloadHash);
        if (seenDigests.has(payloadHashHex.toLowerCase())) continue;
        seenDigests.add(payloadHashHex.toLowerCase());

        const envelope = parseEnvelope(record.message.encryptedPayload);
        if (envelope === undefined) continue;
        if (envelope.to.toLowerCase() !== myAddress) continue;

        if (wallet.stampPaymentJournal !== undefined) {
          const recovered = recoverMonadStampPayments({
            message: record.message,
            recipientPrivateKey: getBytes(wallet.identity.toPrivateKeyHex()),
          });
          for (const payment of recovered) {
            const existing = wallet.stampPaymentJournal.get(
              payloadHashHex,
              payment.childIndex
            );
            if (existing !== undefined) continue;
            await wallet.stampPaymentJournal.put({
              payloadHashHex,
              childIndex: payment.childIndex,
              txHash: payment.txHash,
              address: payment.address,
              valueWei: payment.valueWei.toString(),
              status: "discovered",
            });
          }
        }

        const senderProfile = await fetchMonadProfile({
          relayBaseUrl: wallet.relayBaseUrl,
          address: toChainAddress(envelope.from),
        });
        if (senderProfile === undefined) {
          params.onQuarantinedTimestamp?.(record.timestamp, payloadHashHex);
          continue;
        }

        let items: MessageItem[];
        try {
          items = deserializeMessageItems(
            decryptEnvelope({
              envelope,
              myPrivateKey: wallet.identity.toNakamotoPrivateKey(),
              senderPubKey: Buffer.from(senderProfile.pubKey),
            })
          );
        } catch {
          continue;
        }

        for (const item of items) {
          if (item.type === "wallet-sync" || item.type === "payment-transfer") {
            try {
              applyWalletSyncItem(wallet, item as WalletSyncItem);
            } catch (err) {
              console.warn("Failed to process received wallet-sync item:", err);
            }
          }
        }

        let stampValueWei = 0n;
        const stampPayments: StampPaymentInfo[] = [];
        for (const payment of record.message.stampPayments) {
          const tx = Transaction.from(hexlify(payment.rawTx));
          stampValueWei += tx.value;
          if (tx.hash !== null && tx.to !== null) {
            stampPayments.push({
              txHash: tx.hash,
              destinationAddress: tx.to,
              valueWei: tx.value,
            });
          }
        }

          received.push({
            senderAddress: toChainAddress(envelope.from),
            recipientAddress: toChainAddress(envelope.to),
            items,
            payloadDigest: payloadHashHex,
            stampValueWei,
            stampPayments,
            receivedTime: record.timestamp,
          });
        }
      } catch (err) {
        if (!canonical) {
          throw err;
        }
        // Standard mailbox read is best-effort fallback alongside canonical messaging
      }
      received.sort((a, b) => (a.receivedTime ?? 0) - (b.receivedTime ?? 0));
      return received;
    },

    async listRecoveredStampPayments({ wallet }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      return [];
    },

    async sweepRecoveredStampPayment({ wallet }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      throw new Error("No legacy recovered stamp payment found");
    },

    subscribeMailboxStream(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (canonical?.subscribeMailboxStream) {
        return canonical.subscribeMailboxStream(params);
      }
      return () => {};
    },
  };

  async function collectWalletFundingAccounts(
    wallet: MonadChainWalletHandle
  ): Promise<FundingAccount[]> {
    const monadWallet = asMonadWallet(wallet, config.networkId);
    if (monadWallet.accountUtxoPool) {
      const coins = monadWallet.accountUtxoPool
        .getAllCoins("monad")
        .filter(
          (c) =>
            c.balanceWei > 0n &&
            c.status !== "pending" &&
            Boolean(c.privateKey)
        );
      const accountsByAddress = new Map<string, FundingAccount>();
      for (const coin of coins) {
        const key = coin.address.toLowerCase();
        const existing = accountsByAddress.get(key);
        if (!existing || coin.balanceWei > existing.balanceWei) {
          accountsByAddress.set(key, {
            address: coin.address,
            balanceWei: coin.balanceWei,
            privateKey: coin.privateKey,
          });
        }
      }
      if (accountsByAddress.size > 0) {
        return Array.from(accountsByAddress.values());
      }
    }

    const accounts: FundingAccount[] = [];
    const material = walletMaterial.get(monadWallet);

    const mainKey =
      material?.mainAccount.privateKey ?? mainPrivateKey(monadWallet);
    const mainAddress =
      material?.mainAccount.address ?? monadWallet.identity.address.raw;
    try {
      const mainBal = await monadWallet.provider.getBalance(mainAddress);
      if (mainBal > 0n) {
        accounts.push({
          address: mainAddress,
          balanceWei: mainBal,
          privateKey: mainKey,
        });
      }
    } catch {}

    if (monadWallet.identity?.address?.raw) {
      const identAddr = monadWallet.identity.address.raw;
      if (identAddr.toLowerCase() !== mainAddress.toLowerCase()) {
        try {
          const identBal = await monadWallet.provider.getBalance(identAddr);
          if (identBal > 0n) {
            accounts.push({
              address: identAddr,
              balanceWei: identBal,
              privateKey: monadWallet.identity.toPrivateKeyHex(),
            });
          }
        } catch {}
      }
    }

    try {
      const candidateStealth = (
        monadWallet.stealthKeyring?.getAccounts() ?? []
      ).filter((st) => !st.isSpent);
      const stealthBalances = await Promise.all(
        candidateStealth.map(async (st) => {
          try {
            const bal = await monadWallet.provider.getBalance(st.address);
            if (bal > 0n) {
              await monadWallet.stealthKeyring?.updateBalance(st.address, bal);
              return {
                address: st.address,
                balanceWei: bal,
                privateKey: st.privateKey,
              };
            }
          } catch {}
          return undefined;
        })
      );
      for (const acc of stealthBalances) {
        if (acc) {
          accounts.push(acc);
        }
      }
    } catch {}

    if (material) {
      try {
        for (const record of monadWallet.pool.records()) {
          if (record.status === "available" || record.status === "unfunded") {
            const bal = await monadWallet.provider.getBalance(record.address);
            if (bal > 0n) {
              const derived = material.keyring.deriveSubAccount(record.index);
              accounts.push({
                address: record.address,
                balanceWei: bal,
                privateKey: derived.privateKey,
              });
            }
          }
        }
      } catch {}
    }

    return accounts;
  }

  const nativeTransfers: ActiveChain["nativeTransfers"] = {
    async getBalance({ wallet }): Promise<bigint> {
      asMonadWallet(wallet, config.networkId);
      return wallet.getBalance();
    },

    async send({
      wallet,
      recipient,
      value,
      onSigned,
    }): Promise<{ txHash: string }> {
      asMonadWallet(wallet, config.networkId);
      return wallet.sendNative({ recipient, value, onSigned });
    },

    async getTransactionStatus({ wallet, transaction }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      const receipt = await monadWallet.provider.getTransactionReceipt(
        transaction.txHash
      );
      if (receipt) return receipt.status === 0 ? "failed" : "confirmed";
      const known = await monadWallet.provider.getTransaction(
        transaction.txHash
      );
      return known ? "pending" : "unknown";
    },

    async sendLegacy({ wallet, recipient, value, onProgress, onSigned }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      const consolidator = new EvmLegacyConsolidator({
        provider: monadWallet.provider,
        getFundingAccounts: () => collectWalletFundingAccounts(monadWallet),
        chainIdentifier,
        transactionBuilder,
        onSyncTransaction: async (syncItem) => {
          applyWalletSyncItem(wallet, syncItem);
          if (monadWallet.accountUtxoPool && syncItem.spentInputs) {
            for (const input of syncItem.spentInputs) {
              const coins = monadWallet.accountUtxoPool.getCoinsByAddress(
                input.address,
                "monad"
              );
              for (const c of coins) {
                try {
                  monadWallet.accountUtxoPool.markSpent(c.id);
                } catch {}
              }
            }
          }
          try {
            await directMessages.send({
              wallet,
              recipient: toChainAddress(wallet.identity.address.raw),
              items: [syncItem],
              stampValue: 0n,
            });
          } catch (err) {
            console.warn("could not broadcast self-send sync item:", err);
          }
        },
      });
      return consolidator.sendLegacy({
        recipient,
        value,
        onProgress,
        onSigned,
      });
    },

    async estimateLegacyFee({ wallet, recipient, value }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      const consolidator = new EvmLegacyConsolidator({
        provider: monadWallet.provider,
        getFundingAccounts: () => collectWalletFundingAccounts(monadWallet),
        chainId: config.chainId,
        transactionBuilder,
      });
      return consolidator.estimateLegacyFee(recipient, value);
    },

    async sendToContact({ wallet, recipient, value, memo, onProgress }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      onProgress?.({ stage: "resolving-keys" });

      let spendKey: Uint8Array | undefined;
      let viewKey: Uint8Array | undefined;

      if ("pubKey" in recipient && recipient.pubKey) {
        spendKey = recipient.pubKey;
        viewKey = recipient.pubKey;
      } else {
        const profile = await fetchMonadProfile({
          relayBaseUrl: config.relayBaseUrl,
          address: recipient as ChainAddress,
        });
        if (profile?.pubKey) {
          spendKey = profile.pubKey;
          viewKey = profile.pubKey;
        }
      }

      if (!spendKey) {
        throw new Error("Unable to resolve stealth spend key for recipient");
      }

      onProgress?.({ stage: "deriving-stealth" });
      onProgress?.({ stage: "signing" });
      const stealthPayment = await buildEvmStealthPayment({
        wallet: monadWallet,
        recipientSpendPubKey: spendKey,
        amountWei: value,
        memo,
      });

      onProgress?.({ stage: "confirmed", txHash: stealthPayment.txHash });
      return {
        txHash: stealthPayment.txHash,
        stealthAddress: stealthPayment.stealthDestination.stealthAddress,
        value,
      };
    },
  };

  // The normal handle stays unchanged for DM callers. Only topic code receives this owner.
  const runTopicExclusive = <T>(
    wallet: MonadChainWalletHandle,
    task: (topicWallet: MonadWalletHandle) => Promise<T>
  ): Promise<T> =>
    runWalletExclusive(wallet, async (admission) => {
      enclosingTopicAdmissions.add(wallet);
      try {
        const topicWallet = privateTopicWallets.get(wallet) ?? wallet;
        if (!topicWallet.walletState)
          throw new Error(
            "Canonical topics require coherent wallet persistence"
          );
        return await task(
          admission === undefined
            ? topicWallet
            : {
                ...topicWallet,
                walletState:
                  topicWallet.walletState.delegateAdmission(admission),
                walletOperationAdmission: admission,
              }
        );
      } finally {
        enclosingTopicAdmissions.delete(wallet);
      }
    });
  const forumPolicy: ForumReadPolicy = {
    network:
      config.networkTag === "MON1"
        ? "monad-mainnet"
        : config.networkTag === "MONT"
        ? "monad-testnet"
        : config.networkTag,
    chainId: BigInt(config.chainId),
    burnAddress: config.stampBurnAddress,
  };
  const creatorForumPolicy = (wallet: MonadWalletHandle): ForumReadPolicy => ({
    network: wallet.cborNetwork ?? forumPolicy.network,
    chainId: wallet.forumChainId ?? forumPolicy.chainId,
    burnAddress: wallet.forumBurnAddress ?? forumPolicy.burnAddress,
  });
  const reconcileTopicOperations = async (
    wallet: MonadWalletHandle,
    admission?: import("../storage/monad-wallet-bundle").MonadWalletOperationAdmission
  ) => {
    await new MonadTopicPostClient(wallet).resumePendingOperations(admission);
    await new MonadTopicVoteClient(wallet).resumePendingOperations(admission);
  };
  const topics: TopicBroadcastClient = {
    async reconcileOperations(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      await runTopicExclusive(wallet, async (topicWallet) => {
        await topicWallet.walletState!.runOperation((admission) =>
          reconcileTopicOperations(topicWallet, admission)
        );
      });
    },
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return runTopicExclusive(wallet, async (topicWallet) => {
        const client = new MonadTopicPostClient(topicWallet);
        const policy = creatorForumPolicy(topicWallet);
        return topicWallet.walletState!.runOperation(async (admission) => {
          await reconcileTopicOperations(topicWallet, admission);
          if (
            params.direction !== "up" ||
            params.voteWeightWei < 1n ||
            params.voteWeightWei > 9223372036854775807n
          )
            throw new Error(
              "Canonical post burn must be up and within 1..i64::MAX"
            );
          const timestampMs = Date.now();
          if (params.entries.length > 0) {
            encodeForumPost({
              network: policy.network,
              topic: params.topic,
              entries: params.entries,
              parentHash: params.parentDigest
                ? getBytes(`0x${params.parentDigest}`)
                : undefined,
              authored: {
                seconds: BigInt(Math.floor(timestampMs / 1000)),
                nanoseconds: (timestampMs % 1000) * 1000000,
              },
            });
          }
          const leaseIndex = await prepareTopicBurnAccount(
            wallet,
            params.voteWeightWei,
            params.onPreparationProgress
          );
          const result = await client
            .submitTopicPost(
              {
                topic: params.topic,
                entries: params.entries,
                timestampMs,
                parentPostHash: params.parentDigest
                  ? getBytes(`0x${params.parentDigest}`)
                  : undefined,
                direction: params.direction,
                burnAddress: policy.burnAddress,
                voteWeightWei: params.voteWeightWei,
                leaseIndex,
              },
              admission
            )
            .catch((err: unknown) => {
              if (err instanceof MonadTopicPostAbandonedError) {
                throw new TopicPostOutcomeUnknownError(err.message, err);
              }
              return asNothingSent(err);
            });
          return { payloadDigest: result.payloadHashHex };
        });
      });
    },

    async vote(params): Promise<void> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      await runTopicExclusive(wallet, async (topicWallet) => {
        const client = new MonadTopicVoteClient(topicWallet);
        const policy = creatorForumPolicy(topicWallet);
        await topicWallet.walletState!.runOperation(async (admission) => {
          await reconcileTopicOperations(topicWallet, admission);
          if (
            (params.direction !== "up" && params.direction !== "down") ||
            params.voteWeightWei < 1n ||
            params.voteWeightWei > 9223372036854775807n
          )
            throw new Error("Canonical vote burn must be within 1..i64::MAX");
          const targetPayloadHash = getBytes(`0x${params.payloadDigest}`);
          if (targetPayloadHash.length !== 32)
            throw new Error("Canonical vote requires a T1 digest");
          const leaseIndex = await prepareTopicBurnAccount(
            wallet,
            params.voteWeightWei,
            params.onPreparationProgress
          );
          await client
            .castVote(
              {
                targetPayloadHash,
                direction: params.direction,
                burnAddress: policy.burnAddress,
                voteWeightWei: params.voteWeightWei,
                leaseIndex,
              },
              admission
            )
            .catch(asNothingSent);
        });
      });
    },

    async fetchByTopic(params): Promise<ForumMessage[]> {
      const wallet = params.wallet
        ? asMonadWallet(params.wallet, config.networkId)
        : undefined;
      return fetchMonadTopicPostsSince({
        relayBaseUrl: wallet?.relayBaseUrl ?? config.relayBaseUrl,
        topic: params.topic,
        sinceMs: params.sinceMs,
        policy: wallet
          ? creatorForumPolicy(privateTopicWallets.get(wallet) ?? wallet)
          : forumPolicy,
      });
    },

    async fetchOne(payloadDigest): Promise<ForumMessage | undefined> {
      return fetchMonadTopicPostView({
        relayBaseUrl: config.relayBaseUrl,
        payloadHashHex: payloadDigest,
        policy: forumPolicy,
      });
    },
    async discoverTopics() {
      return fetchDiscoveredTopics({
        relayBaseUrl: config.relayBaseUrl,
        policy: forumPolicy,
      });
    },
  };
  const name = config.name ?? (isTestnet ? "Monad Testnet" : "Monad");
  const unit = config.unit ?? (isTestnet ? "MONT" : "MON");
  const network = isTestnet ? "testnet" : "mainnet";

  return {
    family: "evm",
    chainIdentifier,
    name,
    unit,
    networkId: config.networkId,
    network,
    isTestnet,
    capabilities: {
      profiles: true,
      directMessages: true,
      topics: true,
      stealthPayments: true,
      legacyConsolidation: "evm-staging",
    },
    defaultStampValue: config.defaultStampValueWei,
    defaultTopicVoteValue: config.defaultTopicVoteValueWei,

    toDisplayAmount(raw: bigint): string {
      return formatEther(raw);
    },

    fromDisplayAmount(display: string): bigint {
      return parseEther(display);
    },

    addressToString(addr: ChainAddress): string {
      return addr.raw;
    },

    transactionToString(transaction: ChainTransaction): string {
      return transaction.txHash;
    },

    formatAddress(addr: ChainAddress): string {
      return addr.raw;
    },

    parseAddress(input: string): ChainAddress | undefined {
      try {
        return { raw: getAddress(input) };
      } catch {
        return undefined;
      }
    },

    async createWallet(
      seed: HDSeed | MonadRootBundle
    ): Promise<MonadChainWalletHandle> {
      const material = createMonadWalletMaterial(seed);
      const { identity, mainAccount, keyring, changeKeyring } = material;
      const identityKey = identity.address.raw.toLowerCase();
      const mainAccountKey = mainAccount.address.toLowerCase();
      const economicOwnerKey =
        material.messagingRoot === undefined
          ? undefined
          : `${config.chainId}:${mainAccountKey}`;
      const existing = walletsByIdentity.get(identityKey);
      if (existing !== undefined) {
        material.dispose();
        if (existing.fingerprint !== material.fingerprint)
          throw new Error(
            "Monad wallet root bundle does not match the cached identity"
          );
        const wallet = await existing.pending;
        requireOpenWallet(wallet);
        return wallet;
      }
      if (
        economicOwnerKey !== undefined &&
        openTypedEvmAccounts.has(economicOwnerKey)
      ) {
        material.dispose();
        throw new Error(
          "Monad EVM account is already open in another wallet handle"
        );
      }
      if (economicOwnerKey !== undefined)
        openTypedEvmAccounts.add(economicOwnerKey);

      const pending = (async (): Promise<MonadChainWalletHandle> => {
        const storageKey =
          material.messagingRoot === undefined
            ? identityKey
            : `evm-${mainAccount.address.toLowerCase()}`;
        const storageLocation =
          config.walletStorageLocation === false
            ? undefined
            : `${config.walletStorageLocation}-${storageKey}`;
        const subAccountStore =
          storageLocation === undefined
            ? undefined
            : new LevelSubAccountPoolStore(storageLocation);
        const changeStore =
          storageLocation === undefined
            ? undefined
            : new LevelChangePoolStore(storageLocation);
        const stampPaymentJournal =
          storageLocation === undefined
            ? new InMemoryStampPaymentJournal()
            : new LevelStampPaymentJournal(storageLocation);
        const stampAttemptJournal =
          storageLocation === undefined
            ? new InMemoryStampAttemptJournal()
            : new LevelStampAttemptJournal(storageLocation);
        const closeStores = () =>
          Promise.allSettled([
            subAccountStore?.Close(),
            changeStore?.Close(),
            stampPaymentJournal instanceof LevelStampPaymentJournal
              ? stampPaymentJournal.Close()
              : undefined,
            stampAttemptJournal instanceof LevelStampAttemptJournal
              ? stampAttemptJournal.Close()
              : undefined,
          ]);
        const pool = new MonadSubAccountPool({
          keyring,
          store: subAccountStore,
        });
        const changePool = new MonadChangePool({
          keyring: changeKeyring,
          store: changeStore,
        });
        const accountUtxoPool = new ChainUtxoPool();
        pool.setAccountUtxoPool(accountUtxoPool);
        changePool.setAccountUtxoPool(accountUtxoPool);

        // Populate initial HD sub-accounts with attached private keys
        const initialSubSize = Math.max(config.subAccountPoolSize, 5);
        for (let i = 0; i < initialSubSize; i++) {
          const derived = keyring.deriveSubAccount(i);
          accountUtxoPool.registerSubAccount({
            chain: "monad",
            address: derived.address,
            privateKey: derived.privateKey,
            balanceWei: 0n,
            derivationPath: keyring.subAccountPath(i),
            index: i,
          });
        }
        for (const record of pool.records()) {
          const derived = keyring.deriveSubAccount(record.index);
          const cached = pool.capacityCache.get(record.index);
          const bal = cached !== undefined ? cached.capacityWei : 0n;
          const utxo = accountUtxoPool.registerSubAccount({
            chain: "monad",
            address: derived.address,
            privateKey: derived.privateKey,
            balanceWei: bal,
            derivationPath: keyring.subAccountPath(record.index),
            index: record.index,
          });
          if (record.status === "spent" || record.status === "retired") {
            accountUtxoPool.markSpent(utxo.id);
          } else if (record.status === "in-use") {
            accountUtxoPool.markPending(utxo.id);
          }
        }
        // Populate initial HD change accounts with attached private keys
        for (let k = 0; k < 5; k++) {
          const derived = changeKeyring.deriveChangeAccount(k);
          accountUtxoPool.registerChangeAccount({
            chain: "monad",
            address: derived.address,
            privateKey: derived.privateKey,
            balanceWei: 0n,
            derivationPath: changeKeyring.subAccountPath(k),
            index: k,
          });
        }
        const leaseManager = new SubAccountLeaseManager(pool);
        let topicOwner: MonadWalletPersistenceBundle | undefined;
        let canonicalLinks: CanonicalLinkStore | undefined;
        let topicOwnerWallet: MonadChainWalletHandle | undefined;
        let destroyProvider: (() => void) | undefined;
        let destroyHttpClient: (() => void) | undefined;
        try {
          topicOwner = await openExistingPoolMonadTopicOwner({
            location: storageLocation,
            encloseFinancialOperation: (operation) => {
              if (topicOwnerWallet === undefined)
                throw new Error("Financial wallet admission is not yet open");
              return runWalletExclusive(topicOwnerWallet, (admission) => {
                if (admission === undefined)
                  throw new Error("Financial admission token is unavailable");
                return operation(admission);
              });
            },
            canonicalBinding:
              material.canonicalRoles === undefined
                ? undefined
                : canonicalWalletPublicBinding(
                    material,
                    forumPolicy.network,
                    BigInt(config.chainId)
                  ),
            pool,
            changePool,
            leaseManager,
            subKeyring: keyring,
            changeKeyring,
            stampReferencesLeaseIndex: (index) =>
              stampAttemptJournal
                .getAll()
                .some((attempt) => attempt.leaseIndices.includes(index)),
            assertEnclosingAdmission: () => {
              if (
                topicOwnerWallet === undefined ||
                !enclosingTopicAdmissions.has(topicOwnerWallet)
              ) {
                throw new Error(
                  "Topic operations require enclosing wallet admission"
                );
              }
            },
          });
          const demoRpcUrl = await discoverFakeDemoRpc(config);
          const opened = await Promise.allSettled([
            subAccountStore?.Open(),
            changeStore?.Open(),
            stampPaymentJournal instanceof LevelStampPaymentJournal
              ? stampPaymentJournal.Open()
              : undefined,
            stampAttemptJournal instanceof LevelStampAttemptJournal
              ? stampAttemptJournal.Open()
              : undefined,
          ]);
          const openFailure = opened.find(
            (result) => result.status === "rejected"
          );
          if (openFailure?.status === "rejected") throw openFailure.reason;

          const nativeAttemptStore =
            config.nativeAttemptStore ?? defaultNativeTransactionAttemptStore;
          const nativeAttemptKey = nativeTransactionAttemptKey({
            family: "evm",
            chainIdentifier,
            address: mainAccount.address.toLowerCase(),
          });
          const admission: MainAccountAdmission = {
            key: nativeAttemptKey,
            store: nativeAttemptStore,
          };
          const persistedNative = nativeAttemptStore.get(nativeAttemptKey);
          if (persistedNative !== undefined) {
            admission.unresolved = {
              error: new NativeTransactionSubmissionError({
                transaction: persistedNative,
                reason: new Error("Recovered unresolved native transaction"),
              }),
            };
          }

          pool.ensureUnfundedSize(config.subAccountPoolSize);
          // Classification is deliberately irrelevant here: every old obligation pins its lease.
          const pendingLeaseIndices = new Set([
            ...(topicOwner.canonicalRetained
              ?.getIntents()
              .flatMap((intent) =>
                intent.members.map((m) => m.reservation.index)
              ) ?? []),
            ...(topicOwner.canonicalRetained
              ?.getAll()
              .filter((attempt) => !attempt.cleanupComplete)
              .flatMap((attempt) => attempt.reservations.map((r) => r.index)) ??
              []),
            ...stampAttemptJournal
              .getAll()
              .flatMap((attempt) => attempt.leaseIndices),
            ...topicOwner.topicOperationJournal
              .getAll()
              .map((operation) => operation.leaseIndex),
          ]);
          for (const record of pool.records()) {
            if (
              record.status === "in-use" &&
              !pendingLeaseIndices.has(record.index)
            ) {
              // A crash during signing can persist the lease before the exact raw set exists. No
              // relay broadcast is possible in that window, but the account is conservatively
              // retired rather than silently reused with an uncertain locally-signed nonce.
              pool.setStatus(record.index, "retired");
            }
          }
          await pool.flush();
          const rpcUrl =
            demoRpcUrl ??
            `${config.relayBaseUrl.replace(
              /\/$/,
              ""
            )}/chain-rpc/${encodeURIComponent(config.rpcChain)}/rpc`;
          const relayAuth =
            demoRpcUrl === undefined
              ? {
                  chain: config.rpcChain,
                  customer: identity.address.raw,
                  subject: hexlify(identity.compressedPubKey).slice(2),
                  networkTag: config.networkTag,
                  signDigest: (digest: Uint8Array) =>
                    identity.signHash(Buffer.from(digest)),
                }
              : undefined;
          const provider = createMonadJsonRpcProvider({
            rpcUrl,
            chainId: config.chainId,
            relayAuth,
            ...(demoRpcUrl === undefined
              ? {}
              : { demoOnlyAbortOnDestroy: true }),
          });
          destroyProvider = () => provider.destroy();
          const httpClient = new MonadHttpClient({
            rpcUrl,
            chainId: config.chainId,
            relayAuth,
            ...(demoRpcUrl === undefined
              ? {}
              : { demoOnlyAbortOnDestroy: true }),
          });
          destroyHttpClient = () => httpClient.destroy();
          const submitNative = async (
            signed: SignedNativeTransfer,
            onSigned?: (transaction: ChainTransaction) => Promise<void>
          ): Promise<ChainTransaction> => {
            const transaction = { txHash: signed.txHash };
            if (onSigned !== undefined) await onSigned(transaction);
            nativeAttemptStore.put(nativeAttemptKey, transaction);
            admission.unresolved = {
              signed,
              error: new NativeTransactionSubmissionError({
                transaction,
                reason: new Error(
                  "Native transaction submission is in progress"
                ),
              }),
            };
            const signer = new MonadAccountTxSigner({
              privateKey: mainAccount.privateKey,
              provider,
              httpClient,
            });
            try {
              const submitted = { txHash: await signer.submit(signed) };
              admission.lastSubmitted = submitted;
              admission.unresolved = undefined;
              return submitted;
            } catch (reason) {
              const error = new NativeTransactionSubmissionError({
                transaction,
                reason,
              });
              admission.unresolved = { signed, error };
              throw error;
            }
          };
          const stealthKeyring = new MonadStealthKeyring();
          for (const s of stealthKeyring.getAccounts()) {
            accountUtxoPool.registerStealthAccount({
              chain: "monad",
              address: s.address,
              privateKey: s.privateKey,
              balanceWei: s.balanceWei ?? 0n,
              ephemeralPubKey: s.ephemeralPubKey,
              txHash: s.txHash,
            });
          }
          const wallet: MonadChainWalletHandle = {
            family: "evm",
            chainIdentifier,
            networkId: config.networkId,
            identity,
            stealthKeyring,
            accountUtxoPool,
            mainAccount,
            mainPrivateKey: mainAccount.privateKey,
            async getReceiveAddress() {
              requireOpenWallet(wallet);
              return { raw: mainAccount.address };
            },
            async getBalance() {
              requireOpenWallet(wallet);
              const mainBalance = await transactionBuilder.getBalance({
                address: mainAccount.address,
                provider,
              });
              const identityBalance =
                identity.address.raw.toLowerCase() ===
                mainAccount.address.toLowerCase()
                  ? 0n
                  : await transactionBuilder.getBalance({
                      address: identity.address.raw,
                      provider,
                    });
              const stealthBalance = await stealthKeyring.getTotalBalance(
                provider,
                config.networkTag
              );
              return mainBalance + identityBalance + stealthBalance;
            },
            getUnresolvedNativeTransaction() {
              requireOpenWallet(wallet);
              return admission.unresolved?.error.transaction;
            },
            async retryUnresolvedNativeTransaction() {
              return runWalletExclusive(wallet, () =>
                runNativeTransactionExclusive(
                  nativeAttemptKey,
                  nativeAttemptStore.coordinationScope,
                  async () => {
                    const unresolved = admission.unresolved;
                    if (unresolved === undefined) {
                      throw new Error(
                        "No unresolved native transaction to retry"
                      );
                    }
                    if (unresolved.signed === undefined) {
                      throw new Error(
                        "Recovered unresolved transaction must be reconciled by id before sending again"
                      );
                    }
                    const persisted = nativeAttemptStore.get(nativeAttemptKey);
                    if (
                      persisted === undefined ||
                      !sameChainTransaction(
                        persisted,
                        unresolved.error.transaction
                      )
                    ) {
                      admission.unresolved =
                        persisted === undefined
                          ? undefined
                          : {
                              error: new NativeTransactionSubmissionError({
                                transaction: persisted,
                                reason: new Error(
                                  "Recovered unresolved native transaction"
                                ),
                              }),
                            };
                      throw new Error(
                        "Unresolved native transaction changed before retry"
                      );
                    }
                    return submitNative(unresolved.signed);
                  }
                )
              );
            },
            async resolveUnresolvedNativeTransaction({ transaction }) {
              await runWalletExclusive(wallet, () =>
                runNativeTransactionExclusive(
                  nativeAttemptKey,
                  nativeAttemptStore.coordinationScope,
                  async () => {
                    const expected =
                      admission.unresolved?.error.transaction ??
                      admission.lastSubmitted;
                    const persisted = nativeAttemptStore.get(nativeAttemptKey);
                    if (
                      expected === undefined ||
                      !sameChainTransaction(expected, transaction) ||
                      persisted === undefined ||
                      !sameChainTransaction(persisted, transaction)
                    ) {
                      throw new Error(
                        "Transaction does not match the unresolved native attempt"
                      );
                    }
                    nativeAttemptStore.delete(nativeAttemptKey);
                    admission.unresolved = undefined;
                    admission.lastSubmitted = undefined;
                  }
                )
              );
            },
            async sendNative({ recipient, value, onSigned }) {
              return runWalletExclusive(wallet, () =>
                runMainAccountExclusive(wallet, async () => {
                  if (value <= 0n) {
                    throw new Error("Transfer value must be greater than zero");
                  }
                  if (
                    pool.records().some((record) => record.status === "funding")
                  ) {
                    throw new Error(
                      "Resolve pending Monad account funding before sending a native transfer"
                    );
                  }
                  let spendingPrivateKey = mainAccount.privateKey;
                  let selectedStealthAddress: string | undefined;
                  try {
                    const mainBalance = await provider.getBalance(
                      mainAccount.address
                    );
                    if (mainBalance < value) {
                      const identAddr = identity.address.raw;
                      const identBal =
                        identAddr.toLowerCase() !==
                        mainAccount.address.toLowerCase()
                          ? await provider.getBalance(identAddr)
                          : 0n;
                      if (identBal >= value) {
                        spendingPrivateKey = identity.toPrivateKeyHex();
                      } else {
                        const selected =
                          await stealthKeyring.selectAccountForSpend(
                            value,
                            provider,
                            config.networkTag
                          );
                        if (selected) {
                          spendingPrivateKey = selected.privateKey;
                          selectedStealthAddress = selected.address;
                        }
                      }
                    }
                  } catch {
                    // Fall back to main account if provider balance check cannot complete
                  }
                  const signer = new MonadAccountTxSigner({
                    privateKey: spendingPrivateKey,
                    provider,
                    httpClient,
                  });
                  const txRequest = await transactionBuilder.buildTransfer({
                    from: signer.address,
                    recipient: recipient.raw,
                    amount: value,
                  });
                  const overrides: MonadTxOverrides = {
                    ...(txRequest.gasLimit != null && {
                      gasLimit: BigInt(txRequest.gasLimit.toString()),
                    }),
                    ...(txRequest.maxFeePerGas != null && {
                      maxFeePerGas: BigInt(txRequest.maxFeePerGas.toString()),
                    }),
                    ...(txRequest.maxPriorityFeePerGas != null && {
                      maxPriorityFeePerGas: BigInt(
                        txRequest.maxPriorityFeePerGas.toString()
                      ),
                    }),
                    ...(txRequest.gasPrice != null && {
                      gasPrice: BigInt(txRequest.gasPrice.toString()),
                    }),
                    ...(txRequest.nonce != null && {
                      nonce: Number(txRequest.nonce),
                    }),
                  };
                  const data = txRequest.data ? String(txRequest.data) : "0x";
                  const to = txRequest.to
                    ? String(txRequest.to)
                    : recipient.raw;
                  const txValue =
                    txRequest.value != null
                      ? BigInt(txRequest.value.toString())
                      : value;
                  const signed =
                    data !== "0x" && data !== ""
                      ? await signer.buildAndSignCall(
                          to,
                          txValue,
                          data,
                          overrides
                        )
                      : await signer.buildAndSignTransfer(
                          to,
                          txValue,
                          overrides
                        );
                  const submitted = await submitNative(signed, onSigned);
                  if (selectedStealthAddress) {
                    await stealthKeyring.recordSpend(selectedStealthAddress, {
                      valueWei: value,
                      txHash: submitted.txHash,
                    });
                  }
                  return submitted;
                })
              );
            },
            sendLegacy: (params) =>
              nativeTransfers.sendLegacy!({ wallet, ...params }),
            estimateLegacyFee: (params) =>
              nativeTransfers.estimateLegacyFee!({ wallet, ...params }),
            getUnresolvedLegacySend: () => {
              const consolidator = new EvmLegacyConsolidator({
                provider,
                getFundingAccounts: () => collectWalletFundingAccounts(wallet),
                chainIdentifier,
                transactionBuilder,
              });
              return consolidator.getUnresolvedLegacySend();
            },
            resumeLegacySend: () => {
              const consolidator = new EvmLegacyConsolidator({
                provider,
                getFundingAccounts: () => collectWalletFundingAccounts(wallet),
                chainIdentifier,
                transactionBuilder,
                onSyncTransaction: async (syncItem: WalletSyncItem) => {
                  applyWalletSyncItem(wallet, syncItem);
                  try {
                    await directMessages.send({
                      wallet,
                      recipient: toChainAddress(wallet.identity.address.raw),
                      items: [syncItem],
                      stampValue: 0n,
                    });
                  } catch (err) {
                    console.warn(
                      "resumeLegacySend: could not broadcast self-send sync item:",
                      err
                    );
                  }
                },
              });
              return consolidator.resumeLegacySend();
            },
            pool,
            leaseManager,
            provider,
            httpClient,
            changePool,
            stampPaymentJournal,
            stampAttemptJournal,
            relayBaseUrl: config.relayBaseUrl,
            forumBurnAddress: config.stampBurnAddress,
            forumChainId: BigInt(config.chainId),
            cborNetwork: forumPolicy.network,
            close() {
              if (closing !== undefined) return closing;
              closedWallets.add(wallet);
              closing = (async () => {
                await walletSendQueues.get(wallet);
                try {
                  await topicOwner!.close();
                  await canonicalLinks?.close();
                  const results = await closeStores();
                  const failure = results.find(
                    (result) => result.status === "rejected"
                  );
                  if (failure?.status === "rejected") throw failure.reason;
                } finally {
                  walletsByIdentity.delete(identityKey);
                  if (economicOwnerKey !== undefined)
                    openTypedEvmAccounts.delete(economicOwnerKey);
                  provider.destroy();
                  httpClient.destroy();
                  material.dispose();
                  canonicalClientFactories.delete(wallet);
                  canonicalUnavailableWallets.delete(wallet);
                  canonicalMessaging.delete(wallet);
                  canonicalInventoryFunders.delete(wallet);
                  canonicalDirectories.delete(wallet);
                  installedCanonicalWalletDescriptors.delete(wallet);
                  privateTopicWallets.delete(wallet);
                  walletMaterial.delete(wallet);
                }
              })();
              return closing;
            },
          };
          let closing: Promise<void> | undefined;
          topicOwnerWallet = wallet;
          privateTopicWallets.set(wallet, {
            ...wallet,
            walletState: topicOwner,
            topicOperationJournal: topicOwner.topicOperationJournal,
          });
          if (topicOwner.canonicalUnavailable !== undefined)
            canonicalUnavailableWallets.set(
              wallet,
              topicOwner.canonicalUnavailable
            );
          else if (
            material.canonicalRoles !== undefined &&
            (config.networkTag === "MONT" || config.networkTag === "MON1")
          )
            installedCanonicalWalletDescriptors.set(wallet, {
              networkTag: config.networkTag,
              network: forumPolicy.network,
              chainId: BigInt(config.chainId),
            });
          if (
            material.canonicalRoles !== undefined &&
            topicOwner.canonicalJournal !== undefined &&
            (config.networkTag === "MONT" || config.networkTag === "MON1")
          ) {
            const canonicalRoles = material.canonicalRoles;
            const installedNetworkTag = config.networkTag;
            canonicalClientFactories.set(wallet, () => {
              requireOpenWallet(wallet);
              return new MonadCanonicalStampClient({
                ...wallet,
                walletState: topicOwner!,
                canonicalRoles,
                installedNetworkTag,
                runCanonicalExclusive: (task) =>
                  runWalletExclusive(wallet, () => task(), true),
              });
            });
            // Fast in-memory coin selection using ChainUtxoPool (< 1ms, zero network calls)
            const defaultGasReserveWei =
              BigInt(21_000) * BigInt(2_000_000_000);

            const prepareInventory: CanonicalInventoryFunder = ({
              stampValueWei,
              recipientStampKey,
              onProgress,
            }) =>
              runWalletExclusive(wallet, async () => {
                const triggerReplenishment = async (): Promise<string[]> => {
                  let fundingPrivateKey = mainAccount.privateKey;
                  try {
                    const mainBal = await provider.getBalance(mainAccount.address);
                    if (
                      mainBal === 0n &&
                      identity.address.raw.toLowerCase() !==
                        mainAccount.address.toLowerCase()
                    ) {
                      const identBal = await provider.getBalance(
                        identity.address.raw
                      );
                      if (identBal > 0n) {
                        fundingPrivateKey = identity.toPrivateKeyHex();
                      }
                    }
                  } catch {}
                  const mainAccountSigner = new MonadAccountTxSigner({
                    privateKey: fundingPrivateKey,
                    provider,
                    httpClient,
                  });
                  const preparation = await runMainAccountExclusive(
                    wallet,
                    async () =>
                      pool.prepareStampInventory({
                        mainAccountSigner,
                        provider,
                        stampValueWei,
                        gasReserveWei: await quoteMonadStampPaymentGasReserve({
                          signer: mainAccountSigner,
                          recipientPublicKey: recipientStampKey,
                        }).catch(() => defaultGasReserveWei),
                        onProgress,
                      })
                  );
                  return preparation.fundingTxHashes;
                };

                // Verify that the sub-account pool actually has at least 2 funded sub-accounts ready
                let hasSufficientCleanCoins = false;
                try {
                  const accounts = await pool.fundedCapacities(
                    provider,
                    defaultGasReserveWei
                  );
                  const selection = accounts.filter(
                    (a) => a.capacityWei >= (stampValueWei * BigInt(3)) / BigInt(8)
                  );
                  if (
                    selection.length >= 2 ||
                    (stampValueWei === BigInt(1) && selection.length === 1)
                  ) {
                    hasSufficientCleanCoins = true;
                  }
                } catch {
                  hasSufficientCleanCoins = false;
                }

                if (hasSufficientCleanCoins) {
                  return [];
                }

                // If insufficient clean capacity for immediate payment, replenish synchronously
                return await triggerReplenishment();
              });
            canonicalInventoryFunders.set(wallet, prepareInventory);
            if (config.subAccountPoolSize > 0) {
              pool.configureProactiveWarming({
                provider,
                mainAccountSigner: new MonadAccountTxSigner({
                  privateKey: mainAccount.privateKey,
                  provider,
                  httpClient,
                }),
                stampValueWei: config.defaultStampValueWei,
                gasReserveWei: BigInt(21_000) * BigInt(2_000_000_000),
                minCount: Math.min(2, config.subAccountPoolSize),
              });
              pool.triggerProactiveWarming();
            }
            const links =
              storageLocation !== undefined
                ? await LevelCanonicalLinkStore.open(storageLocation)
                : new MemoryCanonicalLinkStore();
            canonicalLinks = links;
            canonicalMessaging.set(
              wallet,
              canonicalDirectMessages(
                {
                  installedNetworkTag,
                  relayBaseUrl: config.relayBaseUrl,
                  identityAddress: identity.address.raw,
                  subject: bareHex(identity.compressedPubKey),
                  roles: canonicalRoles,
                  links,
                  client: () => canonicalMonadStampClient(wallet),
                  signDigest: (digest) =>
                    new Uint8Array(identity.signHash(Buffer.from(digest))),
                  directory: () => canonicalDirectories.get(wallet),
                  prepareInventory,
                },
                config.defaultStampValueWei
              )
            );
          }
          walletMaterial.set(wallet, material);
          mainAccountAdmissions.set(wallet, admission);
          if (material.messagingRoot !== undefined) typedWallets.add(wallet);
          if (material.messagingRoot === undefined) {
            await new MonadStampClient(wallet).resumePendingAttempts();
          }
          return wallet;
        } catch (error) {
          try {
            await topicOwner?.close();
            await canonicalLinks?.close();
          } catch {
            /* preserve the original opening error */
          }
          await closeStores();
          destroyProvider?.();
          destroyHttpClient?.();
          material.dispose();
          throw error;
        }
      })();
      walletsByIdentity.set(identityKey, {
        fingerprint: material.fingerprint,
        pending,
      });
      try {
        return await pending;
      } catch (err) {
        material.dispose();
        walletsByIdentity.delete(identityKey);
        if (economicOwnerKey !== undefined)
          openTypedEvmAccounts.delete(economicOwnerKey);
        throw err;
      }
    },

    nativeTransfers,

    async fetchProfile(
      addr: ChainAddress,
      opts?: { relayBaseUrl?: string }
    ): Promise<ProfileInfo | undefined> {
      return fetchMonadProfile({
        relayBaseUrl: opts?.relayBaseUrl ?? config.relayBaseUrl,
        address: addr,
      });
    },

    directMessages,
    topics,

    getStateChannelAddress(): string {
      const entry = config.networkTag
        ? resolveChainIdentifier(config.networkTag)
        : PROTOCOL_CHAINS[isTestnet ? "monad-testnet" : "monad-mainnet"];
      const addr =
        entry?.contracts?.stateChannel || entry?.contracts?.channelVault;
      if (!addr) {
        throw new Error(
          `StateChannel contract is not configured for network ${
            config.networkTag || "unknown"
          }`
        );
      }
      return addr;
    },

    getHtlcAddress(): string {
      const entry = config.networkTag
        ? resolveChainIdentifier(config.networkTag)
        : PROTOCOL_CHAINS[isTestnet ? "monad-testnet" : "monad-mainnet"];
      const addr = entry?.contracts?.htlc;
      if (!addr) {
        throw new Error(
          `GenericHTLC contract is not configured for network ${
            config.networkTag || "unknown"
          }`
        );
      }
      return addr;
    },

    getChannelVaultAddress(): string {
      return this.getStateChannelAddress();
    },

    getTablePotVaultAddress(): string {
      return this.getHtlcAddress();
    },
  };
}

export function createMonadChain(config: MonadChainConfig): ActiveChain {
  return createEvmChain(config);
}

/** The default, env-configured `MonadChain` singleton -- `./index.ts`'s `activeChain` is exactly
 * this. See this file's header, "Configuration", for why reading env here (rather than in every
 * wallet client) is the right composition point. */
export const MonadChain: ActiveChain = createMonadChain(
  loadMonadChainConfigFromEnv()
);
