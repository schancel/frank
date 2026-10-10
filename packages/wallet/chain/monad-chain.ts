import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
import { DERIVATION_REGISTRY_ID } from "../../domain-roots/src";
import type { EvmNativeSource } from "../storage/evm-native-operation-journal";
import type { MonadWalletOperationAdmission } from "../storage/monad-wallet-bundle";
import {
  EvmInputAdmissionError,
  nativeAdmissionJournal,
  poolSpendAdmission,
} from "../evm-input-admission";
import type {
  PublicRevisionZeroInput,
  PublicRevisionZeroExport,
  PublicNextRevisionInput,
  PublicNextRevisionExport,
} from "../monad-wallet-handle";
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  evmStealthItem,
  stealthCoinFromItem,
  stealthItemTransfer,
} from "../monad-stealth";
import {
  CONTACT_PAYMENT_NAMESPACE,
  EVM_COIN_NAMESPACE,
  LevelRecordStore,
  MemoryRecordStore,
  messagePaymentOf,
  observeEvmCoin,
  receivedPaymentOf,
  spendableCoinTotal,
  spendableCoins,
  type ContactPayment,
  type EvmCoin,
  type EvmCoinTransfer,
  type RecordStore,
} from "../storage/evm-coin-store";
import { EvmLegacyConsolidator } from "./evm-legacy-consolidator";
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
 * at import time. `createEvmChain` itself is a pure factory taking an explicit
 * `EvmChainConfig` -- this ticket's own tests build chains against a fixed test config, never
 * against env, and mock every wallet client `MonadChain` composes rather than hitting real HTTP.
 *
 * ## `directMessages`: wiring `monad-message-envelope.ts` for real
 *
 * `send()` resolves the recipient's registered pubkey via `../wallet/monad-identity.ts`'s
 * `fetchMonadProfile` (itself `GET /metadata/:addr` -- see that file's header for the live
 * Lotus-address-only backend gap this inherits), builds a real encrypted envelope
 * (`buildEnvelope`) keyed on both parties' addresses, and submits it via a fresh `MonadStampClient`
 * built from the sending wallet's own `EvmWalletHandle` bundle. `items: MessageItem[]` is
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
 * recipient's, and decrypts. The decrypted JSON is not delivered as it is: every item goes
 * through the wire module's receive rule (`receiveLegacyItems`), the same one a canonical message's
 * items go through, so a type that path does not carry, or an item its plugin refuses, arrives as
 * an `unsupported` item. The `stampValueWei` of a legacy message is always `0n`: the raw
 * transactions a legacy message carries are its SENDER'S CLAIM. The relay delivers a legacy
 * message to the inbox even while those payments are pending or after they were terminally
 * rejected (`backend/cashweb/cashweb-registry/src/http/monad_message.rs`), and this wallet does
 * not check them against the chain, so nothing here reports them as money received. Its
 * `stampPayments` still list where those transactions pay, because a stamp address is derived
 * from the message and cannot be found again from the seed alone: the list is what lets the
 * funds be swept to a seed-derived address before the message is deleted. The sweep reads the
 * chain for what is really there. Payments to this wallet's derived stamp addresses are also
 * recorded in the stamp-payment journal as `discovered`.
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
  computeAddress,
  formatEther,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  toUtf8Bytes,
} from "ethers";

import {
  ActiveChain,
  DirectMessageAlreadyAttemptedError,
  ChainAddress,
  ChainTransaction,
  DirectMessageClient,
  DirectMessageFundAheadResult,
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
import {
  MessageItem,
  StealthItem,
  WalletSyncItem,
} from "@frank/cashweb/types/messages";
import { WalletSyncItemRejectedError } from "@frank/cashweb/sync-dispatcher";
import { applyWalletSyncItem } from "../sync-dispatcher";
import { createMessageItemRegistry } from "../message-item-plugins/registry";
import {
  MessageItemBudgetExceededError,
  boundedLegacyPlaintext,
  receiveLegacyItems,
} from "../message-item-plugins/wire";
import { ForumMessage, ForumReadPolicy } from "../forum-model";
import { encodeForumPost } from "@frank/codec";
import { requireChainContract, resolveChainIdentifier } from "./chains-registry";

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
import {
  FundAheadRefusedError,
  MonadSubAccountPool,
  STAMP_PAIR_TRANSFERS,
  SubAccountSpendRefusedError,
} from "../monad-account-pool";
import { ChainUtxoPool } from "../chain-utxo-pool";
import {
  BurnNotSentError,
  SubAccountLeaseManager,
} from "../monad-account-lease";
import { MonadHttpClient } from "../monad-http";
import {
  createMonadJsonRpcProvider,
  DEFAULT_MONAD_CHAIN_ID,
  monadProtocolIdentity,
} from "../monad-provider";
import { MonadAccountTxSigner } from "../monad-account-tx";
import type { EvmWalletHandle } from "../evm-wallet-handle";

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
  CanonicalRecipientNotPublishedError,
  LevelCanonicalLinkStore,
  MemoryCanonicalLinkStore,
  canonicalDirectMessages,
  installedMessageItemRegistry,
  type CanonicalDirectory,
  type CanonicalLinkStore,
} from "./monad-canonical-dm";
export {
  CanonicalMessagingHoldError,
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  CanonicalRecipientUndeliverableError,
  CanonicalRelayCannotForwardError,
  CanonicalSenderUnpublishedError,
  type CanonicalDirectory,
} from "./monad-canonical-dm";
import {
  ChainFamily,
  type ReceivedCoinSweep,
  ContactPaymentFailedError,
  ContactPaymentPendingError,
  type ContactSendParams,
  type ContactSendResult,
  type PreparedContactPayment,
  defaultNativeTransactionAttemptStore,
  nativeTransactionAttemptKey,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  runNativeTransactionExclusive
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
import { defaultNativeEvmTransactionBuilder } from "./evm-transaction-builder";

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
      const port = readEnv("FRANK_DEMO_RELAY_PORT") ?? "8098";
      if (window.location.port && window.location.port !== port) {
        return window.location.origin;
      }
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

/** Reads `EvmChainConfig` from the environment (see `readEnv` just above for exactly where
 * from, and why two places), with permissive fallbacks -- see this file's header,
 * "Configuration", for why this (unlike the wallet client modules it configures) reads env
 * directly, and why it never throws on a missing var. */
export function loadMonadChainConfigFromEnv(overrides?: {
  isTestnet?: boolean;
}): EvmChainConfig {
  const rpcChain =
    overrides?.isTestnet !== undefined
      ? overrides.isTestnet
        ? "monad-testnet"
        : "monad-mainnet"
      : readEnv("MONAD_RPC_CHAIN") ?? "monad-testnet";
  const protocolIdentity = monadProtocolIdentity(rpcChain);
  const rawChainId = readEnv("MONAD_CHAIN_ID");
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
    chainId: protocolIdentity?.chainId ?? chainId ?? DEFAULT_MONAD_CHAIN_ID,
    get relayBaseUrl() {
      return getCustomRelayBaseUrl() ?? getDefaultRelayBaseUrl();
    },
    networkTag:
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
  };
}

const closedWallets = new WeakSet<EvmChainWalletHandle>();
const typedWallets = new WeakSet<EvmChainWalletHandle>();
const walletMaterial = new WeakMap<
  EvmChainWalletHandle,
  MonadWalletMaterial
>();
// Facades may receive a handle created by another factory on the same configured network.
// Its key ownership and send queue travel with that handle, not with the receiving facade.
const walletSendQueues = new WeakMap<EvmChainWalletHandle, Promise<void>>();
// The private topic owner and enclosing admission travel with the creator's wallet too.
const privateTopicWallets = new WeakMap<
  EvmChainWalletHandle,
  EvmWalletHandle
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
type CanonicalInventoryFunder = (input: {
  stampValueWei: bigint;
  recipientStampKey: Uint8Array;
  onProgress?: (progress: DirectMessagePreparationProgress) => void;
}) => Promise<string[]>;
const canonicalInventoryFunders = new WeakMap<
  object,
  CanonicalInventoryFunder
>();
/** Per live typed wallet: its fund-ahead pass (`DirectMessageClient.fundAhead`). */
const stampFundersAhead = new WeakMap<
  object,
  () => Promise<DirectMessageFundAheadResult>
>();
/**
 * A fund-ahead pass that could fund nothing (no money, a pair it cannot afford, an earlier
 * transfer still unresolved, a failed read) is not repeated on every host tick: the next pass
 * waits `FUND_AHEAD_BACKOFF_MIN_MS`, doubling while the reason stays the same, up to
 * `FUND_AHEAD_BACKOFF_MAX_MS`. Until then a call answers what the last pass answered and makes
 * no request; that is also the schedule on which a stuck transfer's bytes are offered again.
 * The wait ends early when a send prepares its inventory or when the wallet's own balance read
 * shows the main account grew. Process memory only: a restart starts with no wait.
 */
export const FUND_AHEAD_BACKOFF_MIN_MS = 4_000;
export const FUND_AHEAD_BACKOFF_MAX_MS = 240_000;
interface FundAheadBackoff {
  result: DirectMessageFundAheadResult;
  delayMs: number;
  startedAtMs: number;
  /** The main-account balance the pass saw, when it read one. */
  mainBalanceWei?: bigint;
}
const fundAheadBackoffs = new WeakMap<object, FundAheadBackoff>();
/** The main account was just read: more money than the last pass saw ends its wait. */
function noteMainBalanceForFundAhead(wallet: object, balanceWei: bigint): void {
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
 * every other inventory preparation. Call it before `prepareIntent`, which selects only funded
 * accounts. Returns the funding transaction hashes (empty when inventory already sufficed).
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
/** Typed wallets use only the canonical path: pending is an error, never a legacy fallback. */
function canonicalMessagingFor(wallet: EvmChainWalletHandle) {
  requireOpenWallet(wallet);
  if (!typedWallets.has(wallet)) return undefined;
  const canonical = canonicalMessaging.get(wallet);
  if (!canonical)
    throw new CanonicalMessagingPendingError(
      "Canonical direct messages require persistent typed wallet storage on a Monad network."
    );
  return canonical;
}
const enclosingTopicAdmissions = new WeakSet<EvmChainWalletHandle>();
interface MainAccountAdmission {
  key: string;
  store: NativeTransactionAttemptStore;
}
const mainAccountAdmissions = new WeakMap<
  EvmChainWalletHandle,
  MainAccountAdmission
>();
/** The most pending coins one background pass asks the chain about. */
export const PENDING_COIN_PROBES_PER_PASS = 8;
/** How long the wallet waits before asking the chain a second time whether a received payment's
 * transfer really can never land. */
export const TRANSFER_FAILURE_RECHECK_MS = 2_000;
/** How long `sweepReceivedCoins` waits for its sweep to be included before answering `pending`. */
export const SWEEP_INCLUSION_WAIT_MS = 10_000;

/** What the wallet's coin list and its payments to contacts offer the chain's clients. */
interface ReceivedCoinOwner {
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
    payloadDigest: string;
    valueWei: bigint;
    transaction: string;
    timestampMs: number;
  }): Promise<void>;
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
  /** The relay has stored that message: the payments it carries are broadcast. Never rejects. */
  contactMessageDelivered(payloadDigest: string): Promise<void>;
  /** Where the coin list's own first read of the whole mailbox stands. A coin list that did not
   * exist when earlier messages were read (a new device, a store added later) has never seen the
   * money those messages brought, whatever the host's cursor says: until `complete`, the mailbox
   * is read from `sinceMs` for coins alone. */
  mailboxScan(): { complete: boolean; sinceMs: number };
  recordMailboxScan(progress: { complete: boolean; sinceMs: number }): Promise<void>;
}
const receivedCoinOwners = new WeakMap<object, ReceivedCoinOwner>();
/** Per wallet: the accounts (lower case) a signed transfer is held on while its message is being
 * delivered. Nothing else may take such an account's next nonce: not a native send or a sweep
 * (the journal refuses those), and not a funding transfer (which reads the nonce from the node,
 * so it asks here first). */
const heldTransferSources = new WeakMap<object, () => Set<string>>();
const sourceIsHeld = (wallet: object, address: string): boolean =>
  heldTransferSources.get(wallet)?.().has(address.toLowerCase()) ?? false;
/** Why a funding transfer was refused: its source is held by a payment to a contact. */
export const SOURCE_HELD_FOR_CONTACT_PAYMENT =
  "These funds are held for a payment to a contact whose message is being delivered";
const nativeOperationOwners = new WeakMap<
  EvmChainWalletHandle,
  EvmLegacyConsolidator
>();
function nativeOperationOwner(
  wallet: EvmChainWalletHandle
): EvmLegacyConsolidator {
  requireOpenWallet(wallet);
  const owner = nativeOperationOwners.get(wallet);
  if (!owner) throw new Error("Wallet has no durable native-operation owner");
  return owner;
}
/** Sends again the notes of earlier operations whose transport failed or never ran: every send
 * and resume is also a retry for them. Not waited for, and nothing it meets is this call's error. */
function retryEarlierNotes(owner: EvmLegacyConsolidator): void {
  void owner.flushSync().catch(() => undefined);
}
async function reconcileNativeAdmission(
  admission: MainAccountAdmission
): Promise<void> {
  const persisted = admission.store.get(admission.key);
  if (persisted !== undefined)
    throw new NativeTransactionSubmissionError({
      transaction: persisted,
      reason: new Error(
        "Unsupported retained hash-only native evidence; preserve and reconcile before native admission"
      )
    });
}
// One typed economic owner per EVM account/network in this runtime, across chain factories.
// Repeated callers on the same factory share its handle; another auth/factory must first close it.
const openTypedEvmAccounts = new Set<string>();

function requireOpenWallet(wallet: EvmChainWalletHandle): void {
  if (closedWallets.has(wallet)) throw new Error("Monad wallet is closed");
}

function requireLegacyMessaging(wallet: EvmChainWalletHandle): void {
  requireOpenWallet(wallet);
  if (typedWallets.has(wallet)) {
    throw new Error(
      "Typed Monad wallets do not use the legacy stamp-payment journal"
    );
  }
}

/** Narrows a generic `WalletHandle` to `EvmChainWalletHandle`. Safe under this ticket's
 * compile-time single-chain seam (see `./active-chain.ts`'s header) -- `MonadChain.createWallet`
 * is the only producer of `WalletHandle` values in a Monad-only build, so every handle reaching
 * `MonadChain`'s other methods already is one; this throws instead of silently misbehaving if that
 * invariant is ever broken. */
function asMonadWallet(
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

/** How long a received note from this wallet's own key that could not be applied is tried again
 * (and so kept in the reader's replay window) before it is passed. In memory: it starts over when
 * the wallet is reopened. */
export const SELF_NOTE_RETRY_MS = 10 * 60_000;
const MAX_WAITING_SELF_NOTES = 256;

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
 * array. What it returns is whatever JSON the sender wrote, typed as items but checked by
 * nothing: a wallet's own read passes it through `receiveLegacyItems` before anything is
 * delivered, and any other reader must treat every field as the sender's claim. */
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

/** Pure factory: builds an `ActiveChain` from an explicit `EvmChainConfig`. See this file's
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
  // A configured network tag that names no registered network must not fall back to
  // another network's contracts.
  const contractChainIdentifier = (): string =>
    config.networkTag
      ? resolveChainIdentifier(config.networkTag)?.id ?? config.networkTag
      : chainIdentifier;
  const transactionBuilder =
    config.transactionBuilder ?? defaultNativeEvmTransactionBuilder;
  const walletsByIdentity = new Map<
    string,
    { fingerprint: string; pending: Promise<EvmChainWalletHandle> }
  >();
  const mainPrivateKey = (wallet: EvmChainWalletHandle) =>
    walletMaterial.get(wallet)?.mainAccount.privateKey ??
    wallet.identity.toPrivateKeyHex();
  // One queue per wallet for everything that prepares and spends sub-accounts (direct messages,
  // topic posts, votes): a burn account prepared for a topic post must not be picked up by a
  // concurrent stamp selection between preparation and lease.
  const runWalletExclusive = <T>(
    wallet: EvmChainWalletHandle,
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
    wallet: EvmChainWalletHandle,
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
        await reconcileNativeAdmission(owner);
        return task();
      }
    );
  };
  /** Funds (or reuses) one sub-account able to burn `voteWeightWei` in a single transaction and
   * returns its pool index for the caller to lease. Admission conservatively holds reuse too:
   * even its fee quote signs with the main account. See `MonadSubAccountPool.prepareBurnAccount`. */
  const prepareTopicBurnAccount = async (
    wallet: EvmChainWalletHandle,
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
      if (
        sourceIsHeld(
          wallet,
          walletMaterial.get(wallet)?.mainAccount.address ??
            wallet.identity.address.raw
        )
      )
        throw new Error(SOURCE_HELD_FOR_CONTACT_PAYMENT);
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
  // The wallet sync boundary for a note this account wrote to itself from another device: the
  // items the wire rule carries only in a self-addressed message. They are decoded as real items
  // only when the message's authenticated sender is this wallet, and they are consumed here,
  // through `applyWalletSyncItem` (chain affinity first, then the pool's own checks of the
  // signed transaction), never handed to a host as a chat message.
  //
  // Runs outside the wallet's operation queue, as `applyWalletSyncItem` requires. Applying a note
  // twice changes nothing; a digest settled in this session is not applied again.
  //
  // A note that cannot be applied never holds the reader's cursor for good. A refusal that would
  // be repeated word for word is final at once. Anything else is tried again on later reads, for
  // at most `SELF_NOTE_RETRY_MS` from the first failure in this session, and is then passed too.
  // Either way the note changed nothing, and one warning says so.
  const settledSelfNotes = new WeakMap<object, Set<string>>();
  const waitingSelfNotes = new WeakMap<object, Map<string, number>>();
  const selfNoteRefusalIsFinal = (error: unknown): boolean => {
    // Another chain's note.
    if (error instanceof WalletSyncItemRejectedError) return true;
    if (error instanceof SubAccountSpendRefusedError) {
      // No applier yet: the wallet is not fully composed. A held row is usually another
      // operation's and is released; two kinds of hold are not: the row is gone but for its
      // terminal checkpoint, or it already carries a different spend.
      if (error.code === "no-applier") return false;
      if (error.code !== "held") return true;
      return /compacted terminal checkpoint|another spend checkpoint/.test(
        error.message
      );
    }
    // The note's transaction cannot be this wallet's to record. (`conflicting-authorization` is
    // not final: this device's own journal holds the pair while its member is pending.)
    return (
      error instanceof EvmInputAdmissionError &&
      error.reason === "invalid-provenance"
    );
  };
  const consumeSelfNotes = async (
    wallet: EvmChainWalletHandle,
    message: DirectMessageReceived
  ): Promise<
    | { kind: "none" }
    | { kind: "consumed"; rest: DirectMessageReceived | undefined }
    | { kind: "retry" }
  > => {
    const own = wallet.identity.address.raw.toLowerCase();
    if (
      message.senderAddress.raw.toLowerCase() !== own ||
      message.recipientAddress.raw.toLowerCase() !== own
    )
      return { kind: "none" };
    // Of the items carried only in a note to self, the wallet consumes the transaction records.
    // A swap's record in the same note is the host's: it goes on with the rest of the message.
    const notes = message.items.filter((item) => item.type === "wallet-sync");
    if (notes.length === 0) return { kind: "none" };
    const others = message.items.filter((item) => item.type !== "wallet-sync");
    const rest = others.length > 0 ? { ...message, items: others } : undefined;
    const digest = message.payloadDigest;
    let settled = settledSelfNotes.get(wallet);
    if (settled === undefined)
      settledSelfNotes.set(wallet, (settled = new Set()));
    if (settled.has(digest)) return { kind: "consumed", rest };
    let waiting = waitingSelfNotes.get(wallet);
    if (waiting === undefined)
      waitingSelfNotes.set(wallet, (waiting = new Map()));
    try {
      for (const note of notes)
        await applyWalletSyncItem(wallet, note as WalletSyncItem);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const since = waiting.get(digest) ?? Date.now();
      const final = selfNoteRefusalIsFinal(error);
      if (!final && Date.now() - since < SELF_NOTE_RETRY_MS) {
        // Bounded: the oldest remembered failure is forgotten first (and starts over if seen).
        if (!waiting.has(digest) && waiting.size >= MAX_WAITING_SELF_NOTES)
          waiting.delete(waiting.keys().next().value as string);
        waiting.set(digest, since);
        return { kind: "retry" };
      }
      console.warn(
        `[wallet-sync] a note this wallet wrote to itself was not applied and is passed (${digest}; ${
          final ? "refused" : "still failing after the retry window"
        }): ${detail}`
      );
    }
    waiting.delete(digest);
    settled.add(digest);
    return { kind: "consumed", rest };
  };
  const recordReceivedCoins = async (
    wallet: EvmChainWalletHandle,
    messages: readonly DirectMessageReceived[]
  ): Promise<void> => {
    const owner = receivedCoinOwners.get(wallet);
    if (owner === undefined) return;
    const own = wallet.identity.address.raw.toLowerCase();
    for (const message of messages) {
      // This wallet's own payment to someone else is not money it received.
      if (
        message.outbound === true ||
        message.senderAddress.raw.toLowerCase() === own
      )
        continue;
      for (const item of message.items)
        if (item.type === "stealth")
          await owner.recordStealthItem(item, {
            payloadDigest: message.payloadDigest,
            timestampMs: message.receivedTime ?? Date.now(),
          });
    }
    // The stamps a message paid this wallet: one-time accounts too, found only through the
    // message. A note this wallet wrote to itself pays its own stamp key, so it is included.
    for (const message of messages)
      if (message.outbound !== true) await owner.recordStampPayments(message);
  };
  const directMessages: DirectMessageClient = {
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      // A message that carries a contact payment the host delivers: the payment learns the
      // message's attempt before the relay sees a byte, and is broadcast only once the relay
      // has stored the message.
      const coinOwner = receivedCoinOwners.get(wallet);
      const carried = params.items.flatMap((item) =>
        item.type === "stealth" && item.ephemeralPubKey
          ? [item.ephemeralPubKey.replace(/^0x/, "").toLowerCase()]
          : []
      );
      if (coinOwner === undefined || carried.length === 0)
        return canonical.send(params);
      const result = await canonical.send({
        ...params,
        onAttemptCreated: async (payloadDigest) => {
          await coinOwner.contactMessageAttempted(carried, payloadDigest);
          await params.onAttemptCreated?.(payloadDigest);
        },
      });
      void coinOwner.contactMessageDelivered(result.payloadDigest);
      return result;
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
      const statuses = await canonical.reconcileAttempts(params);
      // A message the relay turns out to have stored: the contact payments it carries go out.
      const coinOwner = receivedCoinOwners.get(wallet);
      for (const [digest, status] of Object.entries(statuses))
        if (status === "delivered") void coinOwner?.contactMessageDelivered(digest);
      return statuses;
    },

    async fundAhead(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const fund = stampFundersAhead.get(wallet);
      if (!fund) return { outcome: "unavailable", fundingTxHashes: [] };
      return fund();
    },

    async discardAttempt(params) {
      try {
        const wallet = asMonadWallet(params.wallet, config.networkId);
        const canonical = canonicalMessagingFor(wallet);
        if (canonical && typeof (canonical as any).discardAttempt === "function") {
          await (canonical as any).discardAttempt(params);
        }
      } catch {
        // Discard is best-effort when wallet or canonical messaging is unavailable
      }
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      const received: DirectMessageReceived[] = [];
      const seenDigests = new Set<string>();
      if (canonical) {
        // The coin list's own first read of the mailbox, from the start, whatever cursor the
        // host asks from: money that arrived before this coin list existed is found here. It
        // records coins only; no message of it is handed to the host. Done once: afterwards
        // every read records what it returns.
        const coinOwner = receivedCoinOwners.get(wallet);
        const scan = coinOwner?.mailboxScan();
        let canonicalReceived: DirectMessageReceived[];
        if (coinOwner === undefined || scan === undefined || scan.complete) {
          canonicalReceived = await canonical.fetchSince(params);
          // Before anything is consumed below: a note this wallet wrote to itself is never
          // handed to the host; whatever a message paid this wallet is recorded first.
          await recordReceivedCoins(wallet, canonicalReceived);
        } else {
          // The host's own read covers it when it starts no later than the scan stands (a new
          // device reads from the beginning anyway); otherwise the earlier part is read first.
          let truncated = false;
          let scannedUntil = scan.sinceMs;
          if (params.sinceMs > scan.sinceMs) {
            const earlier = await canonical.fetchSince({
              wallet: params.wallet,
              sinceMs: scan.sinceMs,
              onTruncated: () => {
                truncated = true;
              },
            });
            await recordReceivedCoins(wallet, earlier);
            scannedUntil = earlier.reduce(
              (latest, message) => Math.max(latest, message.receivedTime ?? 0),
              scannedUntil
            );
          }
          const earlierComplete = !truncated;
          canonicalReceived = await canonical.fetchSince({
            ...params,
            onTruncated: (reason) => {
              truncated = true;
              params.onTruncated?.(reason);
            },
          });
          await recordReceivedCoins(wallet, canonicalReceived);
          // A cut-off read continues from its last complete timestamp next time.
          await coinOwner.recordMailboxScan({
            complete: !truncated,
            sinceMs: earlierComplete
              ? canonicalReceived.reduce(
                  (latest, message) =>
                    Math.max(latest, message.receivedTime ?? 0),
                  Math.max(scannedUntil, params.sinceMs)
                )
              : scannedUntil,
          });
        }
        for (const msg of canonicalReceived) {
          const digest = (msg.payloadDigest ?? "").toLowerCase();
          if (digest) {
            seenDigests.add(digest);
          }
          const taken = await consumeSelfNotes(wallet, msg);
          if (taken.kind === "none") received.push(msg);
          else if (taken.kind === "retry")
            params.onIncompleteTimestamp?.(msg.receivedTime);
          else if (taken.rest !== undefined) received.push(taken.rest);
          // Nothing of the row is a message: the caller's cursor may pass it.
          else
            params.onQuarantinedTimestamp?.(
              msg.receivedTime,
              msg.payloadDigest
            );
        }
      }

      try {
        // The legacy JSON mailbox (`PUT /message/monad`): still written by the command-line
        // client and by scripts, and a relay that enables it accepts it from anyone. Its items
        // go through the same receive rule as a canonical message's. An untyped wallet whose
        // host installed no registry (the canonical read above refuses outright without one)
        // still gets its messages, with every item unsupported: nothing is ever delivered raw.
        const registry =
          installedMessageItemRegistry(wallet) ?? createMessageItemRegistry();
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
          // Nothing the sender wrote is an item until a plugin has read it: a type this path
          // does not carry, or one its plugin refuses, arrives as an unsupported item. A legacy
          // message is never self-addressed, so a wallet sync record is among them and reaches
          // no wallet state.
          items = receiveLegacyItems(
            registry,
            deserializeMessageItems(
              boundedLegacyPlaintext(
                decryptEnvelope({
                  envelope,
                  myPrivateKey: wallet.identity.toNakamotoPrivateKey(),
                  senderPubKey: Buffer.from(senderProfile.pubKey),
                })
              )
            )
          );
        } catch (error) {
          // Too large to parse, or its items together cost more than one message may: refused
          // as a whole and for good, as on the canonical path. Anything else is not a message.
          if (error instanceof MessageItemBudgetExceededError)
            params.onQuarantinedTimestamp?.(record.timestamp, payloadHashHex);
          continue;
        }

        if (wallet.stampPaymentJournal !== undefined) {
          const recovered = recoverMonadStampPayments({
            message: record.message,
            recipientPrivateKey: getBytes(wallet.identity.toPrivateKeyHex()),
          });
          for (const payment of recovered) {
            await receivedCoinOwners.get(wallet)?.recordStampCoin({
              address: payment.address,
              privateKey: hexlify(payment.privateKey),
              childIndex: payment.childIndex,
              payloadDigest: payloadHashHex,
              valueWei: payment.valueWei,
              transaction: hexlify(
                record.message.stampPayments.find(
                  (carried) => carried.childIndex === payment.childIndex
                )!.rawTx
              ),
              timestampMs: record.timestamp,
            });
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

        // Where the carried transactions pay, kept so the funds can be swept before the message
        // is deleted (see this file's header). Not an amount received.
        const stampPayments: StampPaymentInfo[] = [];
        for (const payment of record.message.stampPayments) {
          const tx = Transaction.from(hexlify(payment.rawTx));
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
          // Unverified on this transport, so not reported as received: the transactions a legacy
          // message carries are its sender's claim. Nothing was shown to have been paid.
          stampValueWei: 0n,
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
      // A wallet effect of reading the mailbox, on either transport: the one-time account of
      // every stealth payment addressed to this wallet is recorded as a coin, durably, before
      // the messages are returned (so before any host cursor can pass them). A failed write
      // fails the read, and the same messages are read again.
      await recordReceivedCoins(wallet, received);
      // Payments to contacts whose message is not delivered yet are finished from here: the
      // hosts' existing mailbox poll, never at wallet open.
      void receivedCoinOwners.get(wallet)?.resumeContactPayments();
      // The wallet's background pass over payments the chain has not shown yet: bounded, and
      // no request at all when nothing is pending. Not awaited: the messages do not wait for it.
      void receivedCoinOwners.get(wallet)?.checkPendingCoins();
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
        return canonical.subscribeMailboxStream({
          ...params,
          // The same boundary as a polled read. A note not applied yet is left to the poll.
          onRecord: (record) => {
            // A stealth payment is recorded as a coin before the record is handed on.
            void (record.items.some((item) => item.type === "stealth")
              ? recordReceivedCoins(wallet, [record]).then(() =>
                  consumeSelfNotes(wallet, record)
                )
              : consumeSelfNotes(wallet, record)
            ).then(
              (taken) => {
                if (taken.kind === "none") params.onRecord(record);
                else if (taken.kind === "consumed" && taken.rest !== undefined)
                  params.onRecord(taken.rest);
              },
              (error) =>
                params.onError?.(
                  error instanceof Error ? error : new Error(String(error))
                )
            );
          },
        });
      }
      return () => {};
    },
  };

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
      const owned = asMonadWallet(wallet, config.networkId);
      nativeOperationOwner(owned);
      return owned.sendLegacy!({ recipient, value, onProgress, onSigned });
    },
    async estimateLegacyFee({ wallet, recipient, value }) {
      return nativeOperationOwner(
        asMonadWallet(wallet, config.networkId)
      ).estimateLegacyFee(recipient, value);
    },

    async sendToContact({ wallet, ...params }) {
      return asMonadWallet(wallet, config.networkId).sendToContact!(params);
    },
  };

  // The normal handle stays unchanged for DM callers. Only topic code receives this owner.
  const runTopicExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: (topicWallet: EvmWalletHandle) => Promise<T>
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
  const creatorForumPolicy = (wallet: EvmWalletHandle): ForumReadPolicy => ({
    network: wallet.cborNetwork ?? forumPolicy.network,
    chainId: wallet.forumChainId ?? forumPolicy.chainId,
    burnAddress: wallet.forumBurnAddress ?? forumPolicy.burnAddress,
  });
  const reconcileTopicOperations = async (
    wallet: EvmWalletHandle,
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
    ): Promise<EvmChainWalletHandle> {
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

      const pending = (async (): Promise<EvmChainWalletHandle> => {
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
            coins?.close(),
            contactPayments?.close(),
            coinListState?.close(),
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
        let coins: RecordStore<EvmCoin> | undefined;
        let contactPayments: RecordStore<ContactPayment> | undefined;
        let coinListState:
          | RecordStore<{ complete: boolean; sinceMs: number }>
          | undefined;
        let topicOwnerWallet: EvmChainWalletHandle | undefined;
        let destroyProvider: (() => void) | undefined;
        let destroyHttpClient: (() => void) | undefined;
        try {
          const branchDescriptor = (
            ring:
              | MonadWalletMaterial["keyring"]
              | MonadWalletMaterial["changeKeyring"]
          ) => {
            const descriptor = ring.publicBranchDescriptor();
            return {
              path: descriptor.path,
              publicKey: hexlify(descriptor.publicKey),
              chainCode: hexlify(descriptor.chainCode)
            };
          };
          topicOwner = await openExistingPoolMonadTopicOwner({
            loadExistingState: async () => {
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
            },
            nativeBinding: {
              chainIdentifier,
              nativeChainId: String(config.chainId),
              publicTuple: JSON.stringify({
                version: 1,
                registry: DERIVATION_REGISTRY_ID,
                chainIdentifier,
                nativeChainId: String(config.chainId),
                mainAddress: mainAccount.address.toLowerCase(),
                spend: branchDescriptor(keyring),
                change: branchDescriptor(changeKeyring)
              })
            },
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

          pool.ensureUnfundedSize(config.subAccountPoolSize);
          // Classification is deliberately irrelevant here: every old obligation pins its lease.
          const pendingLeaseIndices = new Set([
            ...topicOwner
              .nativeJournal!.list()
              .filter((row) => !row.cancelled)
              .flatMap((row) =>
                row.members.flatMap((m) =>
                  m.source.kind === "spend" ? [m.source.index] : []
                )
              ),
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
          const rpcUrl = `${config.relayBaseUrl.replace(
            /\/$/,
            ""
          )}/chain-rpc/${encodeURIComponent(config.rpcChain)}/rpc`;
          const relayAuth = {
            chain: config.rpcChain,
            customer: identity.address.raw,
            subject: hexlify(identity.compressedPubKey).slice(2),
            networkTag: config.networkTag,
            signDigest: (digest: Uint8Array) =>
              identity.signHash(Buffer.from(digest)),
          };
          const provider = createMonadJsonRpcProvider({
            rpcUrl,
            chainId: config.chainId,
            relayAuth,
          });
          destroyProvider = () => provider.destroy();
          const httpClient = new MonadHttpClient({
            rpcUrl,
            chainId: config.chainId,
            relayAuth,
          });
          destroyHttpClient = () => httpClient.destroy();
          // The coin list: one-time accounts money arrived at, with their keys, in one durable
          // store. It is the only record of them: nothing is kept in memory alone.
          coins =
            storageLocation === undefined
              ? new MemoryRecordStore<EvmCoin>()
              : await LevelRecordStore.open<EvmCoin>(
                  storageLocation,
                  EVM_COIN_NAMESPACE
                );
          contactPayments =
            storageLocation === undefined
              ? new MemoryRecordStore<ContactPayment>()
              : await LevelRecordStore.open<ContactPayment>(
                  storageLocation,
                  CONTACT_PAYMENT_NAMESPACE
                );
          coinListState =
            storageLocation === undefined
              ? new MemoryRecordStore<{ complete: boolean; sinceMs: number }>()
              : await LevelRecordStore.open<{ complete: boolean; sinceMs: number }>(
                  storageLocation,
                  "received-coins-mailbox-scan"
                );
          const scanState = coinListState;
          const coinStore = coins;
          const paymentStore = contactPayments;
          const nativeChainId = BigInt(config.chainId);
          // What the chain says about the transfer a coin's message named. The wallet hands the
          // carried signed transaction to the node itself (the sender and the relay do too; a
          // second broadcast of a known or mined transaction changes nothing) and then reads the
          // chain. The node's wording is never interpreted: whatever it answered, the transaction,
          // its receipt and its sender's nonce say what happened.
          const transferOf = async (coin: EvmCoin): Promise<EvmCoinTransfer> => {
            if (coin.transactions.length === 0) return "none";
            const transfer = stealthItemTransfer(
              coin.transactions,
              coin.address,
              nativeChainId
            );
            // Named something that is not a transfer to this account on this chain.
            if (transfer === undefined) return "unseen";
            const included = async (): Promise<EvmCoinTransfer | undefined> => {
              const receipt = await provider.getTransactionReceipt(
                transfer.txHash
              );
              if (receipt === null) return undefined;
              // A carried signed transaction was already checked to pay this account. A bare
              // hash may be a contract call that pays it (an escrow payout): its success, with
              // money at the account, is what can be verified.
              return receipt.status === 1 ? "included" : "failed";
            };
            const mined = await included();
            if (mined !== undefined) return mined;
            // Already judged unable to land: only a receipt can change that.
            if (coin.state === "failed") return "failed";
            if (transfer.rawTransaction === undefined)
              return (await provider.getTransaction(transfer.txHash)) !== null
                ? "seen"
                : "unseen";
            try {
              await provider.broadcastTransaction(transfer.rawTransaction);
              return "seen";
            } catch {
              // Refused: already known, already mined, its nonce used, or not acceptable yet.
              if ((await provider.getTransaction(transfer.txHash)) !== null)
                return (await included()) ?? "seen";
              const signed = Transaction.from(transfer.rawTransaction);
              const used = await provider.getTransactionCount(signed.from!);
              if (used <= signed.nonce) return "unseen";
              // The nonce is spent. By this transaction, if the chain shows it; if not, by
              // another one, and this transfer can never land. That verdict is final for the
              // money, so it is not taken from one reading: someone else (the sender, the relay)
              // may have broadcast this very transaction a moment ago, and a node can report its
              // nonce before its receipt. The chain is asked again after a pause.
              const mined = await included();
              if (mined !== undefined) return mined;
              await new Promise((resolve) =>
                setTimeout(resolve, TRANSFER_FAILURE_RECHECK_MS)
              );
              if ((await provider.getTransaction(transfer.txHash)) !== null)
                return (await included()) ?? "seen";
              return (await included()) ?? "failed";
            }
          };
          // Reads the chain for coins and records what it shows.
          // - A coin already counted: its balance (one request), unless `pendingOnly`.
          // - A pending coin: its transfer and its balance, at most
          //   `PENDING_COIN_PROBES_PER_PASS` coins per pass, taken in turn.
          // - A failed coin: one receipt read on a full or named read (a late inclusion makes it
          //   received), nothing on the background pass. A spent coin: nothing, ever.
          // So a pass makes no request at all when nothing is pending (and nothing is counted, or
          // `pendingOnly`). A node that cannot be reached changes nothing: the coin keeps what was
          // last read, unless `strict`, which rejects.
          let coinsReadAtMs = 0;
          let pendingTurn = 0;
          let readingCoins: Promise<void> | undefined;
          // One pass at a time: two passes would hand the same transaction to the node twice
          // and read each other's half-finished effects.
          let coinPasses: Promise<unknown> = Promise.resolve();
          const readCoinsPass = (options: {
            pendingOnly?: boolean;
            only?: ReadonlySet<string>;
            strict?: boolean;
          }): Promise<void> => {
            const run = coinPasses.then(() => readCoinsPassNow(options));
            coinPasses = run.catch(() => undefined);
            return run;
          };
          const readCoinsPassNow = async (options: {
            pendingOnly?: boolean;
            only?: ReadonlySet<string>;
            strict?: boolean;
          }): Promise<void> => {
            let complete = true;
            const all = coinStore
              .all()
              .filter(
                (coin) => options.only === undefined || options.only.has(coin.address)
              );
            // A failed coin is looked at again only when asked for by name or on a full read
            // (never by the background pass): if the chain shows its transfer after all, it is
            // received.
            const pending = all.filter(
              (coin) =>
                coin.state === "pending" ||
                (coin.state === "failed" && !options.pendingOnly)
            );
            const probed =
              options.only !== undefined ||
              pending.length <= PENDING_COIN_PROBES_PER_PASS
                ? pending
                : Array.from(
                    { length: PENDING_COIN_PROBES_PER_PASS },
                    (_, i) => pending[(pendingTurn + i) % pending.length]!
                  );
            if (probed.length < pending.length) {
              pendingTurn = (pendingTurn + probed.length) % pending.length;
              complete = false;
            }
            const counted = options.pendingOnly
              ? []
              : all.filter((coin) => coin.state === "unspent");
            for (const coin of [...probed, ...counted]) {
              if (closedWallets.has(wallet)) return;
              try {
                const transfer =
                  coin.state === "unspent" ? undefined : await transferOf(coin);
                const balanceWei = await provider.getBalance(coin.address);
                const current = coinStore.get(coin.address);
                if (current === undefined || closedWallets.has(wallet)) continue;
                const next = observeEvmCoin(current, {
                  balanceWei,
                  transfer,
                  atMs: Date.now(),
                });
                if (
                  next.state !== current.state ||
                  next.amountWei !== current.amountWei ||
                  next.transferSeen !== current.transferSeen ||
                  current.checkedAtMs === undefined
                ) {
                  await coinStore.put(next.address, next);
                  primaryBalanceCache = undefined;
                }
              } catch (error) {
                if (options.strict) throw error;
                complete = false;
              }
            }
            if (complete && !options.pendingOnly && options.only === undefined)
              coinsReadAtMs = Date.now();
          };
          const readCoins = (maxAgeMs = 0): Promise<void> => {
            if (maxAgeMs > 0 && Date.now() - coinsReadAtMs < maxAgeMs)
              return Promise.resolve();
            readingCoins ??= readCoinsPass({}).finally(() => {
              readingCoins = undefined;
            });
            return readingCoins;
          };
          const recordCoin = async (coin: EvmCoin): Promise<void> => {
            // Known already (a message read again, on this device or after a restore): no-op.
            if (coinStore.get(coin.address) !== undefined) return;
            await coinStore.put(coin.address, coin);
            coinsReadAtMs = 0;
            primaryBalanceCache = undefined;
          };
          let primaryBalanceCache:
            | {
                mainBalance: bigint;
                identityBalance: bigint;
                cachedAtMs: number;
              }
            | undefined;
          const PRIMARY_BALANCE_CACHE_TTL_MS = 4_000;

          const wallet: EvmChainWalletHandle = {
            family: "evm",
            chainIdentifier,
            networkId: config.networkId,
            identity,
            accountUtxoPool,
            chainUtxoPool: accountUtxoPool,
            mainAccount,
            mainPrivateKey: mainAccount.privateKey,
            invalidateBalanceCache(networkTag?: string) {
              void networkTag;
              primaryBalanceCache = undefined;
              coinsReadAtMs = 0;
            },
            async getReceiveAddress() {
              requireOpenWallet(wallet);
              return { raw: mainAccount.address };
            },
            async getBalance() {
              requireOpenWallet(wallet);
              const now = Date.now();
              let mainBalance: bigint;
              let identityBalance: bigint;

              if (
                primaryBalanceCache !== undefined &&
                now - primaryBalanceCache.cachedAtMs < PRIMARY_BALANCE_CACHE_TTL_MS
              ) {
                mainBalance = primaryBalanceCache.mainBalance;
                identityBalance = primaryBalanceCache.identityBalance;
              } else {
                const mainCoins = accountUtxoPool.getCoinsByAddress(
                  mainAccount.address,
                  "monad"
                );
                if (
                  mainCoins.length > 0 &&
                  mainCoins[0].balanceWei > 0n &&
                  mainCoins[0].status === "clean"
                ) {
                  mainBalance = mainCoins[0].balanceWei;
                } else {
                  mainBalance = await transactionBuilder.getBalance({
                    address: mainAccount.address,
                    provider,
                  });
                }
                noteMainBalanceForFundAhead(wallet, mainBalance);

                if (
                  material.canonicalRoles !== undefined ||
                  identity.address.raw.toLowerCase() ===
                  mainAccount.address.toLowerCase()
                ) {
                  identityBalance = 0n;
                } else {
                  const identCoins = accountUtxoPool.getCoinsByAddress(
                    identity.address.raw,
                    "monad"
                  );
                  if (
                    identCoins.length > 0 &&
                    identCoins[0].balanceWei > 0n &&
                    identCoins[0].status === "clean"
                  ) {
                    identityBalance = identCoins[0].balanceWei;
                  } else {
                    identityBalance = await transactionBuilder.getBalance({
                      address: identity.address.raw,
                      provider,
                    });
                  }
                }

                primaryBalanceCache = {
                  mainBalance,
                  identityBalance,
                  cachedAtMs: now,
                };
              }

              // Plus every received coin the chain shows funded. A pending coin (nothing seen on
              // the chain yet) is never counted, whatever its message said.
              await readCoins(PRIMARY_BALANCE_CACHE_TTL_MS);
              return (
                mainBalance +
                identityBalance +
                spendableCoinTotal(coinStore.all())
              );
            },
            getReceivedPayments() {
              return coinStore.all().map((coin) => receivedPaymentOf(coin));
            },
            async refreshReceivedPayments() {
              requireOpenWallet(wallet);
              await readCoins();
              return coinStore.all().map((coin) => receivedPaymentOf(coin));
            },
            getMessagePayment(payloadDigest) {
              return messagePaymentOf(coinStore.all(), payloadDigest);
            },
            async checkMessagePayment(payloadDigest) {
              requireOpenWallet(wallet);
              const digest = payloadDigest.replace(/^0x/, "").toLowerCase();
              const pending = coinStore
                .all()
                .filter(
                  (coin) =>
                    coin.payloadDigest === digest && coin.state === "pending"
                );
              // Nothing pending: the answer is already known, and nothing is asked.
              if (pending.length > 0)
                await readCoinsPass({
                  only: new Set(pending.map((coin) => coin.address)),
                });
              return messagePaymentOf(coinStore.all(), digest);
            },
            sweepReceivedCoins: (params) => sweepReceivedCoins(params),
            getContactPayments() {
              return paymentStore.all().map((payment) => ({
                messageId: payment.messageId,
                recipientAddress: payment.recipientAddress,
                valueWei: BigInt(payment.valueWei),
                state: payment.state,
                ...(payment.txHash ? { txHash: payment.txHash } : {}),
                ...(payment.failure ? { failure: payment.failure } : {}),
              }));
            },
            sendToContact: (params) => sendToContact(params),
            prepareContactPayment: (params) => prepareContactPayment(params),
            resumeContactPayments: () => resumeContactPayments(),
            retryContactPayment: (messageId) => retryContactPayment(messageId),
            recordStealthPayment: (item, origin) =>
              receivedCoinOwners.get(wallet)!.recordStealthItem(item, {
                payloadDigest: origin?.payloadDigest,
                timestampMs: origin?.timestampMs ?? Date.now(),
              }),
            getNativeOperations() {
              return nativeOperationOwner(wallet).listOperations();
            },
            nativeOperationSyncFailed(operationId) {
              return nativeOperationOwner(wallet).syncTransportFailed(
                operationId
              );
            },
            async resumeNativeOperation(operationId) {
              // A payment to a contact is broadcast only once the relay has its message.
              if (heldForItsMessage(operationId))
                throw new Error(
                  "This transfer pays a contact and is broadcast once its message is delivered"
                );
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.resumeOperation(operationId, admission)
                )
              );
              // The note to this account's other devices is started, not waited for: a native
              // send or resume never waits on the relay or on a message being sent.
              if (!closedWallets.has(wallet)) {
                await owner.startSync(operationId);
                retryEarlierNotes(owner);
              }
              return result;
            },
            async cancelUnsignedNativeOperation(operationId) {
              await runWalletExclusive(wallet, (admission) => {
                if (admission === undefined)
                  throw new Error("Native operation lifetime is unavailable");
                return nativeAdmissionJournal(
                  topicOwner!.inputAdmission,
                  admission
                ).cancelUnsigned(operationId);
              });
            },
            // Bounded re-observation of broadcast members nothing has seen confirm. Called from
            // the hosts' existing polls, never at open. The network reads run under the wallet
            // lifetime only (inside the consolidator), outside this wallet's queue; only the
            // local pass that follows a newly recorded inclusion enters the queue, where the
            // queue's own guard may refuse it. A refusal leaves the observation recorded.
            reobserveNativeOperations() {
              const owner = nativeOperationOwners.get(wallet);
              if (!owner || closedWallets.has(wallet)) return Promise.resolve();
              // A contract call the node was seen not to know is handed to it again (the same
              // signed bytes), so a lost broadcast cannot hold the main account for good.
              return owner
                .reobservePending(() =>
                  runWalletExclusive(wallet, (admission) =>
                    owner.applyRecordedEvidence(admission)
                  )
                )
                .then(() => owner.resendMissingContractCalls());
            },
            getUnresolvedNativeTransaction() {
              requireOpenWallet(wallet);
              const unsupported = nativeAttemptStore.get(nativeAttemptKey);
              if (unsupported) return unsupported;
              const row = nativeOperationOwner(wallet)
                .listOperations()
                .find(
                  (r) =>
                    r.kind === "native" &&
                    !r.cancelled &&
                    !heldForItsMessage(r.operationId) &&
                    r.members.some(
                      (m) =>
                        m.signed && m.observation.state !== "included-success"
                    )
                );
              return row?.members[0]?.signed
                ? { txHash: row.members[0].signed.transactionHash }
                : undefined;
            },
            async retryUnresolvedNativeTransaction() {
              const rows = nativeOperationOwner(wallet)
                .listOperations()
                .filter(
                  (r) =>
                    r.kind === "native" &&
                    !r.cancelled &&
                    !heldForItsMessage(r.operationId) &&
                    r.members.some(
                      (m) =>
                        m.signed && m.observation.state !== "included-success"
                    )
                );
              if (rows.length !== 1)
                throw new Error(
                  "Select the original native operation by operationId"
                );
              const row = await wallet.resumeNativeOperation!(
                rows[0]!.operationId
              );
              return { txHash: row.members[0]!.signed!.transactionHash };
            },
            async sendNative(params) {
              params = { ...params, recipient: { ...params.recipient } };
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.sendNative(params, admission)
                )
              );
              primaryBalanceCache = undefined;
              if (!closedWallets.has(wallet)) {
                await owner.startSync(
                  owner
                    .listOperations()
                    .find(
                      (row) =>
                        row.members[row.members.length - 1]?.signed
                          ?.transactionHash === result.txHash
                    )!.operationId
                );
                retryEarlierNotes(owner);
              }
              return result;
            },
            async sendLegacy(params) {
              params = { ...params, recipient: { ...params.recipient } };
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.sendLegacy(params, admission)
                )
              );
              primaryBalanceCache = undefined;
              if (!closedWallets.has(wallet)) {
                await owner.startSync(
                  owner
                    .listOperations()
                    .find(
                      (row) =>
                        row.members[row.members.length - 1]?.signed
                          ?.transactionHash === result.txHash
                    )!.operationId
                );
                retryEarlierNotes(owner);
              }
              return result;
            },
            // Contract calls (a swap and its approvals). Same queues, journal and recovery as a
            // native send; see `EvmLegacyConsolidator.sendContractCall`.
            async sendContractCall(params) {
              params = { ...params, to: { ...params.to } };
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.sendContractCall(params, admission)
                )
              );
              primaryBalanceCache = undefined;
              return result;
            },
            getContractCallFunds: () =>
              nativeOperationOwner(wallet).contractCallFunds(),
            getUnresolvedContractCalls: () =>
              nativeOperationOwner(wallet).unresolvedContractCalls(),
            evmReader: provider,
            async fundMainAccount(params) {
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.fundMainAccount({ ...params }, admission)
                )
              );
              primaryBalanceCache = undefined;
              // The move is an ordinary legacy send to one of this wallet's own accounts: it
              // notes itself to the account's other devices exactly as `sendLegacy` does.
              if (!closedWallets.has(wallet)) {
                const operation = owner
                  .listOperations()
                  .find(
                    (row) =>
                      row.members[row.members.length - 1]?.signed
                        ?.transactionHash === result.txHash
                  );
                if (operation) await owner.startSync(operation.operationId);
                retryEarlierNotes(owner);
              }
              return result;
            },
            estimateLegacyFee: (params) =>
              nativeOperationOwner(wallet).estimateLegacyFee(
                params.recipient,
                params.value
              ),
            getUnresolvedLegacySend: () =>
              nativeOperationOwner(wallet).getUnresolvedLegacySend(),
            async resumeLegacySend(operationId) {
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(wallet, () =>
                  owner.resumeLegacySend(operationId, admission)
                )
              );
              primaryBalanceCache = undefined;
              if (!closedWallets.has(wallet)) {
                await owner.startSync(operationId);
                retryEarlierNotes(owner);
              }
              return result;
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
                // A re-observation pass in flight holds the wallet lifetime: end it first, or a
                // node that never answers would hold the close.
                await nativeOperationOwners.get(wallet)?.stopReobservation();
                await walletSendQueues.get(wallet);
                await nativeOperationOwners.get(wallet)?.drain();
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
                  nativeOperationOwners.delete(wallet);
                }
              })();
              return closing;
            },
          };
          let closing: Promise<void> | undefined;
          const identityPublicKey = hexlify(
            identity.compressedPubKey
          ).toLowerCase();
          const resolveSource = (source: EvmNativeSource): Wallet => {
            let signer: Wallet;
            if (source.kind === "main") signer = material.mainAccount;
            else if (source.kind === "spend")
              signer = new Wallet(
                material.keyring.deriveSubAccount(source.index).privateKey
              );
            else if (source.kind === "change")
              signer = new Wallet(
                material.changeKeyring.deriveChangeAccount(
                  source.index
                ).privateKey
              );
            else if (source.kind === "coin") {
              // A received coin: the coin list holds its key (it cannot be derived from the
              // seed alone). The address check below is what ties the key to the source.
              const coin = coinStore.get(source.address);
              if (coin === undefined)
                throw new Error("Native source is not a coin of this wallet");
              signer = new Wallet(coin.privateKey);
            } else {
              if (source.identityPublicKey !== identityPublicKey)
                throw new Error("Native source belongs to another identity");
              signer = new Wallet(
                source.kind === "identity"
                  ? identity.toPrivateKeyHex()
                  : deriveEvmStealthPrivateKey({
                      recipientSpendSecret: identity.toPrivateKeyHex(),
                      ephemeralPubKey: getBytes(source.ephemeralPublicKey)
                    }).stealthPrivateKey
              );
            }
            if (signer.address.toLowerCase() !== source.address)
              throw new Error("Native custody source address mismatch");
            return signer;
          };
          const coinSource = (coin: EvmCoin): EvmNativeSource =>
            coin.origin === "stealth" && coin.ephemeralPubKey !== undefined
              ? {
                  kind: "identity-stealth-v1",
                  address: coin.address,
                  identityPublicKey,
                  ephemeralPublicKey: `0x${coin.ephemeralPubKey}`,
                }
              : { kind: "coin", address: coin.address };
          const getSources = async (): Promise<EvmNativeSource[]> => {
            // Preserve the existing funding-source hold until P2 derives shared
            // source claims. Filtering funding children alone cannot protect
            // their main/identity sender or a retained journal source reference.
            if (pool.records().some((record) => record.status === "funding"))
              throw new Error(
                "Native send is unavailable while pool funding remains pending"
              );
            // This construction pool belongs to this bound wallet; indexes are derivation hints.
            const refs: EvmNativeSource[] = [
              { kind: "main", address: mainAccount.address.toLowerCase() },
              {
                kind: "identity",
                address: identity.address.raw.toLowerCase(),
                identityPublicKey
              },
              ...pool
                .records()
                .filter((r) => r.status !== "in-use" && r.status !== "funding")
                .map((r) => ({
                  kind: "spend" as const,
                  address: r.address.toLowerCase(),
                  index: r.index
                })),
              ...changePool
                .records()
                .map((r) => ({
                  kind: "change" as const,
                  address: r.address.toLowerCase(),
                  index: r.index
                })),
              ...changePool
                .recoveredAccounts()
                .map((r) => ({
                  kind: "change" as const,
                  address: r.address.toLowerCase(),
                  index: r.index
                })),
              ...accountUtxoPool
                .getAllCoins()
                .flatMap((coin) =>
                  coin.index !== undefined &&
                  (coin.origin === "change" || coin.origin === "subaccount") &&
                  coin.status !== "pending"
                    ? [
                        {
                          kind:
                            coin.origin === "change"
                              ? ("change" as const)
                              : ("spend" as const),
                          address: coin.address.toLowerCase(),
                          index: coin.index
                        }
                      ]
                    : []
                ),
              // Received stealth coins the chain shows funded: sources like any other.
              // Received coins (stealth payments, stamps) the chain has verified: sources like
              // any other. `spendableCoins` is the one rule; an unverified coin is never offered.
              ...spendableCoins(coinStore.all()).map((coin) => coinSource(coin)),
              ...topicOwner!.nativeJournal!.sourceReferences()
            ];
            // Resolve public provenance before selection; attached coin secrets are not authority.
            for (const ref of refs) resolveSource(ref);
            const known = new Set(refs.map((r) => r.address));
            for (const coin of accountUtxoPool.getAllCoins()) {
              if (
                coin.balanceWei > 0n &&
                coin.status !== "pending" &&
                !known.has(coin.address.toLowerCase())
              )
                throw new Error(
                  "Funded native source has no recoverable custody reference"
                );
            }
            return refs;
          };
          // A pool account a non-cancelled native member spends from is reserved: read from the
          // journal on every selection, so it holds from the journal write and across restart.
          pool.attachSpendReservation((index) =>
            topicOwner!.nativeJournal!.referencesSpendIndex(index)
          );
          // Caller B, the sync boundary: a wallet sync item's signed transaction reaches the one
          // writer only here, inside the wallet queue (whose guard refuses while a canonical
          // pre-sign intent holds an available row) and under the input admission. Not
          // re-entrant: `applyWalletSyncItem` must never be called from inside this queue.
          // This handle has no address inventory and no UTXO store, so the pool branch is all the
          // dispatcher does for it; its other branches log and swallow their failures, and
          // nothing here relies on them.
          pool.attachSpendApplier((rawTx, itemChainIdentifier) =>
            runWalletExclusive(wallet, (admission) => {
              if (admission === undefined)
                throw new Error("Wallet sync lifetime is unavailable");
              return poolSpendAdmission(
                topicOwner!.inputAdmission,
                admission
              ).applySpend(rawTx, itemChainIdentifier);
            })
          );
          nativeOperationOwners.set(
            wallet,
            new EvmLegacyConsolidator({
              provider,
              journal: topicOwner.nativeJournal!,
              inputAdmission: topicOwner.inputAdmission,
              runLifetime: (operation) => topicOwner!.runLifetime(operation),
              transactionBuilder,
              getSources,
              sign: async (source, unsignedTransaction) => {
                return resolveSource(source).signTransaction(
                  Transaction.from(unsignedTransaction)
                );
              },
              // Caller A, this device's own send. The consolidator calls these at the end of a
              // native send or resume, INSIDE the wallet queue that call holds: they go to the
              // admission directly. Routing them through `applyWalletSyncItem` would enter
              // `runWalletExclusive` again, which is not re-entrant, and wait for itself.
              applyLocalMember: (operationId, memberIndex, lifetime) => {
                if (lifetime === undefined)
                  throw new Error("Native operation lifetime is unavailable");
                return poolSpendAdmission(
                  topicOwner!.inputAdmission,
                  lifetime
                ).applyMember(operationId, memberIndex);
              },
              classifyLocalMember: (row, memberIndex, lifetime) => {
                if (lifetime === undefined)
                  throw new Error("Native operation lifetime is unavailable");
                return poolSpendAdmission(
                  topicOwner!.inputAdmission,
                  lifetime
                ).classifyMember(row, memberIndex);
              },
              // After a native send, the account's other devices are told through a note this
              // wallet writes to itself: a FREE message (no stamp), carrying only the sync item.
              // It creates no payment attempt, funds and reserves nothing, and is not held by a
              // pending paid message. Its message identity is fixed by the transaction it
              // reports, so a repeat is the same message; applying it twice changes nothing.
              // Best effort: a failure leaves the member not sync-applied and a later flush
              // sends it again. The other devices apply it in `consumeSelfNotes`.
              onSyncTransaction: async (item, swapRecord) => {
                await directMessages.send({
                  wallet,
                  recipient: toChainAddress(identity.address.raw),
                  // A swap's record rides in the same note as its transaction: one free
                  // message, the same identity, sent and retried the same way.
                  items: swapRecord ? [item, swapRecord] : [item],
                  stampValue: 0n,
                  messageId: getBytes(
                    keccak256(
                      toUtf8Bytes(
                        `frank-wallet-sync:${item.chainIdentifier}:${item.txHash}`
                      )
                    )
                  ).slice(0, 16),
                });
              },
            })
          );
          // Payments to contacts. One payment is: a transfer to a one-time address only the
          // contact can spend from, and a message that carries the signed transfer and the
          // ephemeral key the contact's wallet needs to find it.
          //
          // Order:
          //   1. the message's stamp accounts are made ready, so the message itself will need
          //      no transfer from the account the payment is then signed on;
          //   2. the payment is saved (`planned`);
          //   3. the transfer is planned and signed by the native operation owner, exactly as a
          //      native send is (same sources, same journal, same reservation), and NOT broadcast;
          //   4. the payment is saved with the signed transfer (`prepared`). From here its source
          //      account is HELD: the journal refuses it to every other native send and sweep,
          //      and the funding paths refuse it too (`heldTransferSources`), so nothing can take
          //      the nonce the signed transfer needs;
          //   5. the message carrying the item (with the signed transfer in it) goes through the
          //      paid message path, which keeps its own exact bytes and retries them;
          //   6. ONLY when the relay has confirmed it stored the message (`delivered`) does this
          //      wallet broadcast the transfer. The contact's wallet broadcasts the carried
          //      transfer too when it reads the message, so the money arrives even if this device
          //      stops right after the relay's answer;
          //   7. once the chain shows the transfer included the payment is `paid`.
          // So money never moves before its message is with the relay. A relay that cannot be
          // reached leaves nothing broadcast: every later mailbox read repeats 5 with the same
          // message ID and then 6, from the saved record. Nothing is ever signed again.
          const nativeOwner = nativeOperationOwners.get(wallet)!;
          const signedTransferTo = (address: string) =>
            topicOwner!
              .nativeJournal!.list()
              .find(
                (row) =>
                  !row.cancelled &&
                  row.recipient === address &&
                  row.members.length === 1 &&
                  row.members[0]!.signed
              );
          const newMessageId = (): string => {
            const bytes = randomBytes(16);
            bytes[6] = (bytes[6]! & 0x0f) | 0x40;
            bytes[8] = (bytes[8]! & 0x3f) | 0x80;
            const hex = hexlify(bytes).slice(2);
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
              12,
              16
            )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
          };
          // The accounts a signed, not yet deliverable transfer sits on.
          heldTransferSources.set(wallet, () => {
            const held = new Set<string>();
            for (const payment of paymentStore.all()) {
              if (payment.state !== "prepared" && payment.state !== "failed")
                continue;
              const row = topicOwner!
                .nativeJournal!.list()
                .find((r) => r.operationId === payment.operationId);
              const source = row?.members[0]?.source.address;
              if (source !== undefined) held.add(source);
            }
            return held;
          });
          /** A transfer that must not be broadcast yet: its message is not with the relay. */
          const heldForItsMessage = (operationId: string): boolean =>
            paymentStore
              .all()
              .some(
                (payment) =>
                  payment.operationId === operationId &&
                  (payment.state === "prepared" || payment.state === "failed")
              );
          const broadcastContactTransfer = async (
            payment: ContactPayment
          ): Promise<ContactPayment> => {
            const operationId = payment.operationId!;
            await runWalletExclusive(wallet, (admission) =>
              runMainAccountExclusive(wallet, () =>
                nativeOwner.resumeOperation(operationId, admission)
              )
            ).catch(() => undefined);
            primaryBalanceCache = undefined;
            // Seen included (by this wallet's broadcast or the contact's): nothing more to do.
            const member = topicOwner!
              .nativeJournal!.list()
              .find((row) => row.operationId === operationId)?.members[0];
            if (member?.observation.state !== "included-success") return payment;
            const paid: ContactPayment = { ...payment, state: "paid" };
            await paymentStore.put(payment.stealthAddress, paid);
            return paid;
          };
          let contactQueue: Promise<unknown> = Promise.resolve();
          const contactExclusive = <T>(task: () => Promise<T>): Promise<T> => {
            const run = contactQueue.then(task);
            contactQueue = run.catch(() => undefined);
            return run;
          };
          const finishContactPayment = async (
            stealthAddress: string,
            onProgress?: ContactSendParams["onProgress"]
          ): Promise<ContactPayment> => {
            let payment = paymentStore.get(stealthAddress);
            if (payment === undefined)
              throw new Error("No such payment to a contact");
            if (payment.state === "planned") {
              // Stopped around signing. A transfer the journal holds signed is this payment's;
              // with none, nothing was signed and the plan is dropped.
              const row = signedTransferTo(stealthAddress);
              if (row === undefined) {
                await paymentStore.delete(stealthAddress);
                throw new Error(
                  "The payment was never signed. Nothing was sent."
                );
              }
              payment = {
                ...payment,
                state: "prepared",
                operationId: row.operationId,
                rawTransaction: row.members[0]!.signed!.rawTransaction,
                txHash: row.members[0]!.signed!.transactionHash,
              };
              await paymentStore.put(stealthAddress, payment);
            }
            if (payment.state === "failed")
              throw new ContactPaymentFailedError(
                payment.messageId,
                payment.failure ?? "ended"
              );
            if (payment.state === "delivered")
              return broadcastContactTransfer(payment);
            if (payment.state !== "prepared") return payment;
            if (payment.deliveredBy === "host") {
              // The host's own send path carries the message. Once it has an attempt, its
              // outcome is asked for; `contactMessageDelivered` is told when the relay has it.
              if (payment.payloadDigest !== undefined)
                await directMessages
                  .reconcileAttempts({
                    wallet,
                    payloadDigests: [payment.payloadDigest],
                  })
                  .catch(() => undefined);
              return payment;
            }
            onProgress?.({ stage: "delivering", txHash: payment.txHash });
            let payloadDigest: string;
            try {
              payloadDigest = (
                await directMessages.send({
                  wallet,
                  recipient: { raw: getAddress(payment.recipientAddress) },
                  items: [itemOf(payment)],
                  messageId: payment.messageId,
                  ...(payment.conversationId === undefined
                    ? {}
                    : { conversationId: payment.conversationId }),
                  ...(payment.stampValueWei === undefined
                    ? {}
                    : { stampValue: BigInt(payment.stampValueWei) }),
                })
              ).payloadDigest;
            } catch (error) {
              // Sent before (this session or an earlier one): the answer is the original's.
              if (!(error instanceof DirectMessageAlreadyAttemptedError))
                throw error;
              const status = (
                await directMessages.reconcileAttempts({
                  wallet,
                  payloadDigests: [error.payloadDigest],
                })
              )[error.payloadDigest];
              if (status === "dead") {
                // The relay will never deliver that message. This wallet has not broadcast the
                // transfer, and its source stays held: the bytes went to a relay. The item is
                // kept: `retryContactPayment` sends it in a new message.
                const failure = "the relay ended the message";
                await paymentStore.put(stealthAddress, {
                  ...payment,
                  state: "failed",
                  payloadDigest: error.payloadDigest,
                  failure,
                });
                throw new ContactPaymentFailedError(payment.messageId, failure);
              }
              if (status !== "delivered") throw error;
              payloadDigest = error.payloadDigest;
            }
            payment = { ...payment, state: "delivered", payloadDigest };
            await paymentStore.put(stealthAddress, payment);
            // The relay has the message. Now, and only now, the transfer is broadcast: the
            // journalled bytes, the same the message carries. A failure here is not the
            // payment's: the contact's wallet broadcasts them too, and later passes try again.
            onProgress?.({ stage: "broadcasting", txHash: payment.txHash });
            return broadcastContactTransfer(payment);
          };
          const itemOf = (payment: ContactPayment): StealthItem =>
            evmStealthItem({
              networkTag: config.networkTag,
              ephemeralPubKey: getBytes(`0x${payment.ephemeralPubKey}`),
              rawTransaction: payment.rawTransaction!,
              amountWei: BigInt(payment.valueWei),
              memo: payment.memo,
            });
          const sendToContact = (params: ContactSendParams) =>
            payContact(params, false) as Promise<ContactSendResult>;
          const prepareContactPayment = (params: ContactSendParams) =>
            payContact(params, true) as Promise<PreparedContactPayment>;
          // `hostDelivers`: the host sends the message that carries the item (a chat's own send
          // path); the wallet learns of its delivery where that message passes through
          // `directMessages` and broadcasts then.
          const payContact = async (
            params: ContactSendParams,
            hostDelivers: boolean
          ): Promise<ContactSendResult | PreparedContactPayment> => {
            requireOpenWallet(wallet);
            if (params.value <= 0n)
              throw new RangeError("Transfer value must be positive");
            const recipientAddress = getAddress(
              params.recipient.raw
            ).toLowerCase();
            if (recipientAddress === identityKey)
              throw new Error("A payment to a contact needs another account");
            params.onProgress?.({ stage: "resolving-keys" });
            // The contact's published signing key: the key the one-time address is derived
            // from, and the key the message is sealed to. Unpublished: refused before anything.
            let spendKey: Uint8Array | undefined;
            let recipientStampKey: Uint8Array | undefined;
            const directory = canonicalDirectories.get(wallet);
            if (directory !== undefined) {
              const peer = await directory.peerCurrent({
                address: params.recipient.raw,
              });
              if (!peer)
                throw new CanonicalRecipientNotPublishedError(
                  params.recipient.raw
                );
              spendKey = getBytes(`0x${peer.subject}`);
              recipientStampKey = peer.current.stampKey.keyBytes;
            } else {
              spendKey = (
                await fetchMonadProfile({
                  relayBaseUrl: config.relayBaseUrl,
                  address: { raw: params.recipient.raw },
                })
              )?.pubKey;
            }
            if (
              spendKey === undefined ||
              computeAddress(hexlify(spendKey)).toLowerCase() !==
                recipientAddress
            )
              throw new Error(
                "The contact has no published key for this address"
              );
            // The message is owed once the transfer is out, and it costs a stamp: refused here,
            // before anything, when the wallet cannot pay for both.
            const stampWei = params.stampValue ?? config.defaultStampValueWei;
            if ((await wallet.getBalance()) < params.value + stampWei)
              throw new RangeError(
                "Insufficient funds for the payment and its message stamp"
              );
            params.onProgress?.({ stage: "deriving-stealth" });
            const destination = deriveEvmStealthAddress({
              recipientSpendPubKey: spendKey,
            });
            const stealthAddress = destination.stealthAddress.toLowerCase();
            return contactExclusive(async () => {
              requireOpenWallet(wallet);
              // The message's stamp accounts first: any funding transfer the message needs is
              // made now, before the payment's transfer is signed, so the two are ordered and
              // the message will not need the held account again.
              const prepare = canonicalInventoryFunders.get(wallet);
              if (prepare !== undefined && recipientStampKey !== undefined)
                await prepare({
                  stampValueWei: stampWei,
                  recipientStampKey,
                  onProgress: undefined,
                });
              const messageId = newMessageId();
              await paymentStore.put(stealthAddress, {
                messageId,
                stealthAddress,
                ephemeralPubKey: hexlify(destination.ephemeralPubKey).slice(2),
                recipientAddress,
                valueWei: params.value.toString(),
                ...(params.memo ? { memo: params.memo } : {}),
                ...(params.conversationId === undefined
                  ? {}
                  : { conversationId: params.conversationId }),
                ...(params.stampValue === undefined
                  ? {}
                  : { stampValueWei: params.stampValue.toString() }),
                state: "planned",
                deliveredBy: hostDelivers ? "host" : "wallet",
                createdAtMs: Date.now(),
              });
              params.onProgress?.({ stage: "signing" });
              try {
                await runWalletExclusive(wallet, (admission) =>
                  runMainAccountExclusive(wallet, () =>
                    nativeOwner.signNative(
                      { recipient: { raw: stealthAddress }, value: params.value },
                      admission
                    )
                  )
                );
              } catch (error) {
                if (signedTransferTo(stealthAddress) === undefined) {
                  await paymentStore.delete(stealthAddress);
                  throw error;
                }
              }
              let payment: ContactPayment;
              try {
                payment = await finishContactPayment(
                  stealthAddress,
                  params.onProgress
                );
              } catch (error) {
                const saved = paymentStore.get(stealthAddress);
                if (
                  error instanceof ContactPaymentFailedError ||
                  saved === undefined
                )
                  throw error;
                throw new ContactPaymentPendingError(
                  saved.messageId,
                  saved.txHash,
                  error
                );
              }
              if (hostDelivers)
                return {
                  item: itemOf(payment),
                  txHash: payment.txHash!,
                  stealthAddress: destination.stealthAddress,
                  value: params.value,
                };
              params.onProgress?.({ stage: "confirmed", txHash: payment.txHash });
              return {
                txHash: payment.txHash!,
                stealthAddress: destination.stealthAddress,
                value: params.value,
                messageId: payment.messageId,
                payloadDigest: payment.payloadDigest!,
              };
            });
          };
          let resumingContactPayments: Promise<void> | undefined;
          const resumeContactPayments = (): Promise<void> => {
            resumingContactPayments ??= contactExclusive(async () => {
              // Nothing to finish (every payment paid or ended): no request is made.
              for (const payment of paymentStore.all()) {
                if (closedWallets.has(wallet)) return;
                if (
                  payment.state === "planned" ||
                  payment.state === "prepared" ||
                  payment.state === "delivered"
                )
                  await finishContactPayment(payment.stealthAddress).catch(
                    () => undefined
                  );
              }
            })
              .catch(() => undefined)
              .finally(() => {
                resumingContactPayments = undefined;
              });
            return resumingContactPayments;
          };
          // The relay ended a payment's message for good. The same item is sent again in a new
          // message; the transfer is never signed or made again.
          const retryContactPayment = (messageId: string): Promise<void> =>
            contactExclusive(async () => {
              requireOpenWallet(wallet);
              const payment = paymentStore
                .all()
                .find((row) => row.messageId === messageId);
              if (payment === undefined)
                throw new Error("No such payment to a contact");
              if (payment.state === "failed") {
                const { failure: _failure, payloadDigest: _digest, ...rest } =
                  payment;
                await paymentStore.put(payment.stealthAddress, {
                  ...rest,
                  messageId: newMessageId(),
                  state: "prepared",
                });
              }
              await finishContactPayment(payment.stealthAddress);
            });
          const recordStampCoin: ReceivedCoinOwner["recordStampCoin"] = (
            stamp
          ) =>
            recordCoin({
              address: stamp.address.toLowerCase(),
              privateKey: stamp.privateKey,
              origin: "stamp",
              state: "pending",
              amountWei: "0",
              claimedAmountWei: stamp.valueWei.toString(),
              transactions: [stamp.transaction.replace(/^0x/, "").toLowerCase()],
              payloadDigest: stamp.payloadDigest.replace(/^0x/, "").toLowerCase(),
              childIndex: stamp.childIndex,
              discoveredAtMs: stamp.timestampMs,
            });
          // Moves the unspent coins of these messages to the main account: a seed-derived
          // address, so the money survives the message and a restore from the seed. One journalled
          // native operation per coin, each a single transfer; a coin an earlier sweep already
          // carries is resumed there and never signed for twice.
          const sweepReceivedCoins = async (params: {
            payloadDigests: readonly string[];
          }): Promise<Record<string, ReceivedCoinSweep>> => {
            requireOpenWallet(wallet);
            const asked = params.payloadDigests.map((digest) => ({
              digest,
              bare: digest.replace(/^0x/, "").toLowerCase(),
            }));
            const wanted = new Set(asked.map((entry) => entry.bare));
            const coinsOf = () =>
              coinStore
                .all()
                .filter(
                  (coin) =>
                    coin.payloadDigest !== undefined &&
                    wanted.has(coin.payloadDigest)
                );
            const mainAddress = mainAccount.address.toLowerCase();
            const live = () =>
              coinsOf().filter(
                (coin) => coin.state === "pending" || coin.state === "unspent"
              );
            let failure: string | undefined;
            /** Coins the sweep left where they are: worth less than their own move. */
            const left = new Set<string>();
            /** Coins another operation of this wallet holds right now. */
            const heldByOthers = new Set<string>();
            const sweptAlready = (address: string): boolean =>
              topicOwner!
                .nativeJournal!.list()
                .some(
                  (row) =>
                    !row.cancelled &&
                    row.recipient === mainAddress &&
                    row.members.some(
                      (member) =>
                        member.source.address === address &&
                        member.observation.state === "included-success"
                    )
                );
            const sweepOf = (address: string) =>
              topicOwner!
                .nativeJournal!.list()
                .find(
                  (row) =>
                    !row.cancelled &&
                    row.recipient === mainAddress &&
                    row.members.some(
                      (member) =>
                        member.source.address === address &&
                        member.observation.state !== "included-success" &&
                        member.observation.state !== "included-revert"
                    )
                );
            if (live().length > 0) {
              try {
                // What is really there, read now: a coin is never swept on an old reading.
                await readCoinsPass({
                  only: new Set(live().map((coin) => coin.address)),
                  strict: true,
                });
                const owner = nativeOperationOwner(wallet);
                const until = Date.now() + SWEEP_INCLUSION_WAIT_MS;
                for (;;) {
                  // A coin whose sweep is in a block is done: what is left of it is the
                  // difference between the fee it allowed for and the fee it paid.
                  const unspent = spendableCoins(live()).filter(
                    (coin) =>
                      !left.has(coin.address) &&
                      !heldByOthers.has(coin.address) &&
                      !sweptAlready(coin.address)
                  );
                  if (unspent.length === 0) break;
                  const carried = new Set(
                    unspent.flatMap((coin) => {
                      const row = sweepOf(coin.address);
                      return row === undefined ? [] : [row.operationId];
                    })
                  );
                  const fresh = unspent.filter(
                    (coin) => sweepOf(coin.address) === undefined
                  );
                  let waiting = false;
                  for (const operationId of carried)
                    await runWalletExclusive(wallet, (admission) =>
                      runMainAccountExclusive(wallet, () =>
                        owner.resumeOperation(operationId, admission)
                      )
                    ).catch((error) => {
                      if (!(error instanceof NativeTransactionSubmissionError))
                        throw error;
                      waiting = true;
                    });
                  if (fresh.length > 0)
                    await runWalletExclusive(wallet, (admission) =>
                      runMainAccountExclusive(wallet, () =>
                        owner.sweepSources(
                          {
                            sources: fresh.map(coinSource),
                            recipient: { raw: mainAddress },
                          },
                          admission
                        )
                      )
                    ).then(
                      (swept) => {
                        for (const address of swept.left) left.add(address);
                        for (const address of swept.held)
                          heldByOthers.add(address);
                        if (swept.pending) waiting = true;
                      },
                      (error) => {
                        if (!(error instanceof NativeTransactionSubmissionError))
                          throw error;
                        waiting = true;
                      }
                    );
                  primaryBalanceCache = undefined;
                  await readCoinsPass({
                    only: new Set(unspent.map((coin) => coin.address)),
                    strict: true,
                  });
                  // Broadcast and not in a block yet: looked at again, for a bounded time.
                  if (!waiting || Date.now() >= until) break;
                  await new Promise((resolve) => setTimeout(resolve, 1_000));
                  if (closedWallets.has(wallet)) break;
                }
              } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
              }
            }
            const answers: Record<string, ReceivedCoinSweep> = {};
            for (const { digest, bare } of asked) {
              const coins = coinStore
                .all()
                .filter((coin) => coin.payloadDigest === bare);
              const moved = coins.some((coin) => sweptAlready(coin.address));
              // Still holding money worth moving, or with a payment on its way (the node knows
              // the transfer and it is not in a block yet): the message must stay. A payment the
              // chain does not know at all holds nothing and keeps no message.
              const held = coins.filter(
                (coin) =>
                  (coin.state === "unspent" &&
                    !left.has(coin.address) &&
                    !sweptAlready(coin.address)) ||
                  (coin.state === "pending" &&
                    (coin.transferSeen === true || failure !== undefined))
              );
              if (held.length === 0)
                answers[digest] = { outcome: moved ? "swept" : "none" };
              else if (
                failure === undefined &&
                held.every(
                  (coin) =>
                    coin.state === "unspent" && sweepOf(coin.address) !== undefined
                )
              )
                answers[digest] = {
                  outcome: "pending",
                  reason: "The sweep is broadcast and not in a block yet",
                };
              else
                answers[digest] = {
                  outcome: "failed",
                  reason:
                    failure ??
                    (held.some((coin) => coin.state === "pending")
                      ? "A payment of this message is not on the chain yet"
                      : held.some((coin) => heldByOthers.has(coin.address))
                      ? "Another operation of this wallet is spending from these coins"
                      : "The coins could not be moved"),
                };
            }
            return answers;
          };
          receivedCoinOwners.set(wallet, {
            recordStampCoin,
            async recordStampPayments(message) {
              const roles = material.canonicalRoles;
              if (
                roles === undefined ||
                message.stampSharedPoint === undefined ||
                message.recipientAddress.raw.toLowerCase() !== identityKey
              )
                return;
              for (const payment of message.stampPayments) {
                if (payment.childIndex === undefined) continue;
                const address = payment.destinationAddress.toLowerCase();
                if (coinStore.get(address) !== undefined) continue;
                // Only an account this wallet's stamp key opens is a coin of this wallet.
                const privateKey = roles.stampChildPrivateKey({
                  network: forumPolicy.network,
                  sharedPoint: getBytes(`0x${message.stampSharedPoint}`),
                  childIndex: payment.childIndex,
                  address,
                });
                if (privateKey === undefined) continue;
                await recordStampCoin({
                  address,
                  privateKey,
                  childIndex: payment.childIndex,
                  payloadDigest: message.payloadDigest,
                  valueWei: payment.valueWei,
                  transaction: payment.rawTx ?? payment.txHash,
                  timestampMs: message.receivedTime ?? Date.now(),
                });
              }
            },
            checkPendingCoins: () =>
              readCoinsPass({ pendingOnly: true }).catch(() => undefined),
            async recordStealthItem(item, origin) {
              if ((item.networkTag ?? item.chainId) !== config.networkTag) return;
              const coin = stealthCoinFromItem({
                item,
                recipientSpendSecret: identity.toPrivateKeyHex(),
                payloadDigest: origin.payloadDigest,
                discoveredAtMs: origin.timestampMs,
              });
              if (coin !== undefined) await recordCoin(coin);
            },
            resumeContactPayments,
            retryContactPayment,
            mailboxScan: () =>
              scanState.get("scan") ?? { complete: false, sinceMs: 0 },
            recordMailboxScan: (progress) => scanState.put("scan", progress),
            async contactMessageAttempted(ephemeralPubKeys, payloadDigest) {
              for (const payment of paymentStore.all())
                if (
                  payment.deliveredBy === "host" &&
                  payment.state === "prepared" &&
                  ephemeralPubKeys.includes(payment.ephemeralPubKey) &&
                  payment.payloadDigest !== payloadDigest
                )
                  await paymentStore.put(payment.stealthAddress, {
                    ...payment,
                    payloadDigest,
                  });
            },
            contactMessageDelivered: (payloadDigest) =>
              contactExclusive(async () => {
                for (const payment of paymentStore.all()) {
                  if (
                    closedWallets.has(wallet) ||
                    payment.deliveredBy !== "host" ||
                    payment.state !== "prepared" ||
                    payment.payloadDigest !== payloadDigest
                  )
                    continue;
                  // The relay has the message: now the transfer is broadcast.
                  const delivered: ContactPayment = {
                    ...payment,
                    state: "delivered",
                  };
                  await paymentStore.put(payment.stealthAddress, delivered);
                  await broadcastContactTransfer(delivered);
                }
              }).catch(() => undefined),
          });
          // Wallet open, native operations. Local only: nothing in this block may make a network
          // request, ask for a signature or fail the open, and each step stands alone.
          // A plan that never signed (a crash or failure between the journal write and the first
          // signature) is cancelled here. That ends its reservation of its pool accounts and its
          // freeze of its source address; the journal row is retained, cancelled.
          await topicOwner
            .runLifetime((lifetime) =>
              nativeOperationOwners
                .get(wallet)!
                .cancelUnsignedOperations(lifetime)
            )
            .catch(() => undefined);
          // A pool account whose native spend the journal already records as included, and whose
          // row was never marked (a crash or a close between the observation and the local pass),
          // is marked spent here, through the same admission writer a send's own pass uses. Only
          // observations already in the journal count: a pending member is not looked up. It runs
          // after the cancel above (an unsigned plan can hold an address against an included
          // member) and before the wallet is published, so nothing else can be in the queue.
          // Skipped entirely under the wallet queue's own guard (`runWalletExclusive`): a retained
          // canonical pre-sign intent on an available row. A failure leaves the member unmarked
          // for the next native send or the next open; a failed pool write leaves this session
          // unable to sign, as it would in a send.
          await topicOwner
            .runLifetime(async (lifetime) => {
              if (
                topicOwner!.canonicalRetained
                  ?.getIntents()
                  .some((intent) =>
                    intent.members.some(
                      (m) =>
                        pool.getRecord(m.reservation.index)?.status ===
                        "available"
                    )
                  )
              )
                return;
              await nativeOperationOwners
                .get(wallet)!
                .applyRecordedEvidence(lifetime);
            })
            .catch(() => undefined);
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
                  runWalletExclusive(wallet, (admission) => {
                    if (admission === undefined)
                      throw new Error("Canonical operation lifetime is unavailable");
                    return task(admission);
                  }, true),
              });
            });
            const defaultGasReserveWei =
              BigInt(21_000) * BigInt(2_000_000_000);
            // What a stamp payment keeps back in each account for its own fee: the figure the
            // payment intent subtracts (21,000 gas at the current fee cap). An inventory check
            // made with any other figure can pass accounts the intent then finds too small.
            const stampPaymentFeeReserve = async (): Promise<bigint> => {
              try {
                const feeData = await provider.getFeeData();
                const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
                if (feePerGas !== null && feePerGas !== undefined)
                  return BigInt(21_000) * feePerGas;
              } catch {
                /* The fixed reserve below is the answer without a quote. */
              }
              return defaultGasReserveWei;
            };
            // Accounts a paid message already holds (a payment intent, or an attempt not yet
            // cleaned up). The next intent does not select them, so they are not inventory.
            const heldByMessages = (): Set<number> =>
              new Set([
                ...(topicOwner!.canonicalRetained
                  ?.getIntents()
                  .flatMap((intent) =>
                    intent.members.map((m) => m.reservation.index)
                  ) ?? []),
                ...(topicOwner!.canonicalRetained
                  ?.getAll()
                  .filter((attempt) => !attempt.cleanupComplete)
                  .flatMap((attempt) =>
                    attempt.reservations.map((r) => r.index)
                  ) ?? []),
              ]);

            const prepareInventory: CanonicalInventoryFunder = ({
              stampValueWei,
              recipientStampKey,
              onProgress,
            }) =>
              runWalletExclusive(wallet, async () => {
                // A send changes what there is to fund: the next fund-ahead call looks again.
                fundAheadBackoffs.delete(wallet);
                // Accounts funded ahead (or left by an earlier preparation) are ready: nothing
                // is funded, quoted or reconciled, and the send goes straight to its payment.
                let ready = false;
                try {
                  // No funded account, no fee quote: there is nothing to check.
                  ready =
                    pool
                      .records()
                      .some((record) => record.status === "available") &&
                    (await pool.hasStampInventory({
                      provider,
                      stampValueWei,
                      feeReserveWei: await stampPaymentFeeReserve(),
                      heldIndices: heldByMessages(),
                    }));
                } catch {
                  ready = false;
                }
                if (ready) return [];

                // Nothing ready (a first message, or a burst): fund this message's accounts now.
                let fundingPrivateKey = mainAccount.privateKey;
                // A main account that holds a signed transfer for a contact payment is not a
                // funding source: its next nonce is that transfer's. Another source is looked
                // for exactly as when the main account is empty.
                const mainHeld = sourceIsHeld(wallet, mainAccount.address);
                try {
                  const mainBal = mainHeld
                    ? 0n
                    : await provider.getBalance(mainAccount.address);
                  if (
                    mainBal === 0n &&
                    identity.address.raw.toLowerCase() !==
                      mainAccount.address.toLowerCase()
                  ) {
                    const identBal = await provider.getBalance(
                      identity.address.raw
                    );
                    if (identBal > 0n && !sourceIsHeld(wallet, identity.address.raw)) {
                      fundingPrivateKey = identity.toPrivateKeyHex();
                    }
                  }
                  // Received coins pay for stamps like any other funds: when the main account
                  // cannot cover this stamp, the largest funded coin that can, and that no native
                  // operation holds, funds the stamp accounts instead.
                  const coinNeedWei =
                    stampValueWei +
                    BigInt(2 * STAMP_PAIR_TRANSFERS) * defaultGasReserveWei;
                  if (
                    mainBal < coinNeedWei &&
                    fundingPrivateKey === mainAccount.privateKey
                  ) {
                    await readCoins();
                    const funded = spendableCoins(coinStore.all())
                      .filter((coin) => BigInt(coin.amountWei) >= coinNeedWei)
                      .sort((a, b) =>
                        BigInt(a.amountWei) > BigInt(b.amountWei) ? -1 : 1
                      );
                    for (const coin of funded) {
                      const nonce = await provider.getTransactionCount(
                        coin.address
                      );
                      if (
                        !topicOwner!.nativeJournal!.canSelect(coin.address, nonce)
                      )
                        continue;
                      fundingPrivateKey = coin.privateKey;
                      coinsReadAtMs = 0;
                      break;
                    }
                  }
                } catch {}
                if (mainHeld && fundingPrivateKey === mainAccount.privateKey)
                  throw new Error(SOURCE_HELD_FOR_CONTACT_PAYMENT);
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
              });
            canonicalInventoryFunders.set(wallet, prepareInventory);

            // Funding ahead (#1235): the same preparation, asked for by the host between
            // messages. Never called from here: opening a wallet makes no request.
            const stampValueAhead = config.defaultStampValueWei;
            // The most one pass may move: the stamp value plus one fee reserve per transfer. A
            // reserve above this ceiling (fees so high that it exceeds the stamp it serves)
            // is not paid ahead; a send still funds its own accounts.
            const reserveCeilingWei =
              stampValueAhead > defaultGasReserveWei
                ? stampValueAhead
                : defaultGasReserveWei;
            const maxValueAheadWei =
              stampValueAhead + BigInt(STAMP_PAIR_TRANSFERS) * reserveCeilingWei;
            const notFunded = (reason: string): DirectMessageFundAheadResult => ({
              outcome: "not-funded",
              fundingTxHashes: [],
              reason,
            });
            const fundAheadPass = (): Promise<DirectMessageFundAheadResult> =>
              runWalletExclusive(wallet, async () => {
                let mainBalanceWei: bigint | undefined;
                let result: DirectMessageFundAheadResult;
                try {
                  // An earlier transfer with no observed outcome is looked at before anything
                  // else, whatever the inventory or the balance.
                  const unresolved = pool
                    .records()
                    .some((record) => record.status === "funding");
                  if (
                    !unresolved &&
                    (await pool.hasStampInventory({
                      provider,
                      stampValueWei: stampValueAhead,
                      feeReserveWei: 0n,
                      heldIndices: heldByMessages(),
                      maxCacheAgeMs: Infinity,
                    }))
                  )
                    return { outcome: "ready", fundingTxHashes: [] };
                  // Only the main account pays ahead: it is the one account the lock taken
                  // below orders. The identity-key fallback stays with a send's own funding.
                  // Not while it holds a contact payment's signed transfer.
                  if (sourceIsHeld(wallet, mainAccount.address))
                    return notFunded("source-held");
                  if (!unresolved)
                    mainBalanceWei = await provider.getBalance(
                      mainAccount.address
                    );
                  if (
                    mainBalanceWei !== undefined &&
                    mainBalanceWei < stampValueAhead
                  )
                    result = notFunded("insufficient-funds");
                  else {
                    const mainAccountSigner = new MonadAccountTxSigner({
                      privateKey: mainAccount.privateKey,
                      provider,
                      httpClient,
                    });
                    const preparation = await runMainAccountExclusive(
                      wallet,
                      () =>
                        pool.fundStampInventoryAhead({
                          mainAccountSigner,
                          provider,
                          stampValueWei: stampValueAhead,
                          // Quoted only once the pool has nothing unresolved to wait for. No
                          // recipient yet: the wallet's own key stands in for the quote.
                          gasReserveWei: () =>
                            quoteMonadStampPaymentGasReserve({
                              signer: mainAccountSigner,
                              recipientPublicKey: identity.compressedPubKey,
                            }).catch(() => defaultGasReserveWei),
                          maxValueWei: maxValueAheadWei,
                        })
                    );
                    result = {
                      outcome:
                        preparation.fundingTxHashes.length > 0
                          ? "funded"
                          : "ready",
                      fundingTxHashes: preparation.fundingTxHashes,
                    };
                  }
                } catch (error) {
                  // A funding failure is not the caller's: whatever was recorded is resumed by
                  // the next pass or the next send, and a send funds its own accounts regardless.
                  result = notFunded(
                    error instanceof FundAheadRefusedError
                      ? error.code
                      : error instanceof Error
                      ? error.message
                      : String(error)
                  );
                }
                if (result.outcome === "not-funded") {
                  const last = fundAheadBackoffs.get(wallet);
                  fundAheadBackoffs.set(wallet, {
                    result,
                    delayMs:
                      last !== undefined && last.result.reason === result.reason
                        ? Math.min(last.delayMs * 2, FUND_AHEAD_BACKOFF_MAX_MS)
                        : FUND_AHEAD_BACKOFF_MIN_MS,
                    startedAtMs: Date.now(),
                    mainBalanceWei,
                  });
                } else fundAheadBackoffs.delete(wallet);
                return result;
              });
            // Single flight: a call made while a pass runs gets that pass's answer. A call made
            // while the last pass's wait runs gets that pass's answer too, and nothing is asked.
            let fundingAhead: Promise<DirectMessageFundAheadResult> | undefined;
            stampFundersAhead.set(wallet, () => {
              const waiting = fundAheadBackoffs.get(wallet);
              const waited = Date.now() - (waiting?.startedAtMs ?? 0);
              if (waiting && waited >= 0 && waited < waiting.delayMs)
                return Promise.resolve(waiting.result);
              fundingAhead ??= fundAheadPass().finally(() => {
                fundingAhead = undefined;
              });
              return fundingAhead;
            });
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
                  messageItems: () => installedMessageItemRegistry(wallet),
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
      return requireChainContract(contractChainIdentifier(), "stateChannel");
    },

    getHtlcAddress(): string {
      return requireChainContract(contractChainIdentifier(), "htlc");
    },
  };
}

/** The default, env-configured `MonadChain` singleton -- `./index.ts`'s `activeChain` is exactly
 * this. See this file's header, "Configuration", for why reading env here (rather than in every
 * wallet client) is the right composition point. */
export const MonadChain: ActiveChain = createEvmChain(
  loadMonadChainConfigFromEnv()
);
