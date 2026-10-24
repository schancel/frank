import { transactionSetFinancialCompletionReceipt, transactionSetCancellationReceipt } from '../evm-operation-completion';
import { DERIVATION_REGISTRY_ID } from "../../domain-roots/src";
import { type DefaultStampQuote } from "../oracle/stamp-policy";
import type { EvmChainConfig } from "./evm-chain-config";
import type { EvmChainWalletHandle } from "../evm-wallet-handle";
export type { EvmChainConfig } from "./evm-chain-config";
export type { EvmChainWalletHandle, EvmWalletHandle } from "../evm-wallet-handle";
import {
  nativeMemberSuperseded,
  type EvmNativeSource,
} from "../storage/evm-native-operation-journal";
import type {
  EvmWalletOperationAdmission,
} from "../storage/evm-wallet-bundle";
import {
  nativeAdmissionJournal,
  poolSpendAdmission,
} from "../evm-input-admission";
import type {
  PublicRevisionZeroInput,
  PublicRevisionZeroExport,
  PublicNextRevisionInput,
  PublicNextRevisionExport,
} from "../evm-wallet-handle";
import {
  CONTACT_PAYMENT_NAMESPACE,
  EVM_COIN_NAMESPACE,
  LevelRecordStore,
  MemoryRecordStore,
  spendableCoinTotal,
  spendableCoins,
  type ContactPayment,
  type EvmCoin,
  type RecordStore,
} from "../storage/evm-coin-store";
import {
  EVM_STEALTH_PREPARATION_NAMESPACE,
  type EvmStealthPreparation,
} from "./evm-stealth-payments";
import { EvmLegacyConsolidator } from "./evm-legacy-consolidator";
import { createLegacyTransactionSetPayments } from "./evm-legacy-transaction-set";
import { createEvmTransactionSetSubmission } from "../evm-transaction-set-submission";
import { evmTransactionSetCapability } from "../evm-transaction-set-public";
import {
  EVM_COIN_LIST_NAMESPACE,
  EvmCoinList,
  type StoredEvmListCoin,
} from "../evm-coin-list";
import { installEvmTransactionSetRuntime } from "../evm-transaction-set-runtime";
import { evmTransactionSetJournal } from "../evm-transaction-set-journal";
import { observeRetainedForumSpend } from "../evm-forum-operation";
import {
  MainAccountBusyError,
  TopicBurnPreparationError,
  asNothingSent,
  installEvmStampCoordinator,
  type MainAccountWait,
} from "../evm-stamp-coordinator";
import {
  PENDING_COIN_PROBES_PER_PASS,
  SELF_NOTE_RETRY_MS,
  SOURCE_HELD_FOR_CONTACT_PAYMENT,
  SWEEP_INCLUSION_WAIT_MS,
  TRANSFER_FAILURE_RECHECK_MS,
  consumeEvmSelfNotes,
  createEvmReceivedCoinAndContactManager,
  recordEvmReceivedCoins,
  sourceIsHeld,
} from "../evm-received-coin-manager";
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
 * ## `directMessages`
 *
 * One transport: the relay's account message routes, through `./monad-canonical-dm.ts`. A
 * wallet without typed persistent custody (a bare mnemonic) has no messaging: `send()` and
 * `fetchSince()` throw `CanonicalMessagingPendingError`. There is no protobuf envelope path.
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
  formatUnits,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  parseUnits,
  randomBytes,
  toUtf8Bytes,
} from "ethers";

import {
  ActiveChain,
  ChainAddress,
  ChainTransaction,
  DirectMessageClient,
  DirectMessageStampQuote,
  DirectMessageReceived,
  DirectMessageSendResult,
  ProfileInfo,
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
import { applyWalletSyncItem } from "../sync-dispatcher";
import { ForumMessage, ForumReadPolicy } from "../forum-model";
import { encodeForumPost } from "@frank/codec";
import {
  getChainRegistryEntry,
  requireChainContract,
  resolveChainIdentifier,
} from "./chains-registry";

import {
  createMonadWalletMaterial,
  canonicalWalletPublicBinding,
  evmWalletPoolBindingId,
} from "../evm-wallet-material";
import type {
  MonadRootBundle,
  HistoricalBip39Seed,
  MonadWalletMaterial,
} from "../evm-wallet-material";
import type { HDSeed } from "./active-chain";
import { EvmChangePool } from "../evm-change-pool";
import { EvmSubAccountPool } from "../evm-account-pool";
import { EvmSpendPool } from "../evm-spend-pool";
import { deriveDappPersona } from "../dapp-bridge/persona-keys";
import {
  EvmWallet,
  evmWalletInternals,
  type MainAccountAdmission,
} from "../evm-wallet";
import {
  BurnNotSentError,
  SubAccountLeaseManager,
} from "../evm-account-lease";
import { MonadHttpClient } from "../evm-http";
import {
  createMonadJsonRpcProvider,
  DEFAULT_MONAD_CHAIN_ID,
  monadProtocolIdentity,
} from "../evm-provider";
import type { EvmWalletHandle } from "../evm-wallet-handle";

import {
  hasUncorrelatedCanonicalPreSignIntent,
  openExistingPoolEvmWalletBundle,
  type EvmWalletPersistenceBundle,
} from "../storage/evm-wallet-bundle";
import {
  MonadIdentity,
  fetchMonadProfile,
} from "../evm-identity";
import {
  MonadCanonicalStampClient,
  quoteMonadStampPaymentGasReserve,
} from "../evm-stamp-client";
import { MailboxAuthParams } from "@frank/cashweb/relay/mailbox-client";
import {
  TopicPostClient,
  TopicPostAbandonedError,
} from "../topic-post-client";
import { TopicVoteClient } from "../topic-vote-client";
import { createEvmTopicOperations } from "../evm-topic-operations";
import {
  fetchDiscoveredTopics,
  fetchMonadTopicPostView,
  fetchMonadTopicPostsSince,
} from "../evm-topic-tally-client";
import { readViteEnv } from "./vite-env";
import {
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  createCooperativeBatchYielder,
  restoreOutgoingClaims,
  canonicalDirectMessages,
  installedMessageItemRegistry,
  type CanonicalDirectory,
  type CanonicalMessagingOwner,
} from './canonical-dm'
import {
  LevelOutgoingMessageStore,
  MemoryOutgoingMessageStore,
  noticeOldLinkState,
  type OutgoingMessageStore,
} from '../storage/outgoing-message-store'
import { waitForSpendSpacing } from "../evm-stamp-payer";
export {
  CanonicalMessagingPendingError,
  CanonicalRecipientNotPublishedError,
  CanonicalRecipientUndeliverableError,
  CanonicalRelayCannotForwardError,
  CanonicalSenderUnpublishedError,
  type CanonicalDirectory,
} from "./canonical-dm";
import {
  ChainFamily,
  type ReceivedCoinSweep,
  ContactPaymentFailedError,
  ContactPaymentPendingError,
  ContactPaymentReleasedError,
  ContactPaymentTooLargeError,
  MAX_STEALTH_ITEM_AMOUNT,
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
import {
  ChainUnreachableError,
  isChainUnreachableError,
} from "../evm-block-watcher";

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

function normalizeSignetRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.toLowerCase() === "signet.mx" &&
      (!parsed.pathname || parsed.pathname === "/")
    ) {
      return "https://relay.signet.mx";
    }
  } catch {
    // ignore invalid URL
  }
  return url;
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
          return normalizeSignetRelayUrl(stored.replace(/\/+$/, ""));
        }
      }
    } catch {
      // ignore invalid URL or storage error
    }
    return memoryCustomRelayUrl
      ? normalizeSignetRelayUrl(memoryCustomRelayUrl)
      : undefined;
  }
  return memoryCustomRelayUrl
    ? normalizeSignetRelayUrl(memoryCustomRelayUrl)
    : undefined;
}

/**
 * Persists or clears a custom relay server URL in localStorage.
 */
export function setCustomRelayBaseUrl(url: string | undefined): void {
  const rawCleaned =
    url && url.trim().length > 0 ? url.trim().replace(/\/+$/, "") : undefined;
  const cleaned = rawCleaned ? normalizeSignetRelayUrl(rawCleaned) : undefined;
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
    window.location.origin &&
    ["http:", "https:"].includes(window.location.protocol)
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
    const originFallback = normalizeSignetRelayUrl(window.location.origin);
    if (!configured) return originFallback;
    try {
      const parsed = new URL(configured);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return originFallback;
      }
    } catch {
      // keep configured
    }
    return normalizeSignetRelayUrl(configured);
  }
  if (
    !configured &&
    typeof window !== "undefined" &&
    window.location &&
    ["chrome-extension:", "safari-web-extension:", "moz-extension:"].includes(
      window.location.protocol
    )
  ) {
    return "https://relay.signet.mx";
  }
  return configured
    ? normalizeSignetRelayUrl(configured)
    : "http://127.0.0.1:8098";
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
    // A regtest chain is new on every start, so its contracts are deployed per run and their
    // addresses come with the run's configuration. Every other network uses the registry.
    ...(rpcChain === "monad-regtest"
      ? {
          contracts: {
            htlc: readEnv("MONAD_REGTEST_HTLC_ADDRESS"),
            stateChannel: readEnv("MONAD_REGTEST_STATE_CHANNEL_ADDRESS"),
          },
        }
      : {}),
    stampBurnAddress:
      readEnv("MONAD_STAMP_BURN_ADDRESS") ??
      "0x000000000000000000000000000000000000dEaD",
    minimumWagerValueWei: 10_000_000_000_000_000n,
    // The network's reserve-balance rule, from its registry row (Monad: 10 MON, 3 blocks).
    spendSpacingBlocks: getChainRegistryEntry(rpcChain)?.spendSpacingBlocks,
    paymentPollIntervalMs: getChainRegistryEntry(rpcChain)?.paymentPollIntervalMs,
    reserveBalanceWei: ((wei) => (wei === undefined ? undefined : BigInt(wei)))(
      getChainRegistryEntry(rpcChain)?.reserveBalanceWei
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

/** Public local evidence only. No Current, enrollment, provider or financial effects. */
export function prepareMonadRevisionZeroExport(
  wallet: NativeWalletHandle,
  input: PublicRevisionZeroInput
): PublicRevisionZeroExport {
  const internals = evmWalletInternals(wallet);
  const material = internals.material;
  if (!material?.canonicalRoles || !internals.typed || internals.closed)
    throw new Error("Revision-zero export requires live typed wallet custody");
  if (internals.canonicalUnavailable) throw internals.canonicalUnavailable;
  const installed = internals.installedCanonicalDescriptor;
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
  const internals = evmWalletInternals(wallet);
  const material = internals.material;
  if (!material?.canonicalRoles || !internals.typed || internals.closed)
    throw new Error(
      "Directory entry renewal requires live typed wallet custody"
    );
  if (internals.canonicalUnavailable) throw internals.canonicalUnavailable;
  const installed = internals.installedCanonicalDescriptor;
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
/** Opt-in bridge verifies the actual registered live typed wallet; no caller-supplied owner. */
export function canonicalMonadStampClient(
  wallet: NativeWalletHandle
): MonadCanonicalStampClient {
  const internals = evmWalletInternals(wallet);
  if (internals.canonicalUnavailable) throw internals.canonicalUnavailable;
  const create = internals.canonicalClientFactory;
  if (!create)
    throw new Error("Canonical wallet requires live typed persistent custody");
  return create();
}
// Canonical direct messages (#778). The caller installs the open directory once this account's own
// entry is published; it is never inferred from a wallet.
/** Install the caller's verified public directory for one live typed wallet. Returns its removal. */
export function installCanonicalDirectory(
  wallet: NativeWalletHandle,
  directory: CanonicalDirectory
): () => void {
  const internals = evmWalletInternals(wallet);
  const installed = internals.installedCanonicalDescriptor;
  if (!installed || !internals.canonicalMessaging || internals.closed)
    throw new Error(
      "Canonical directory requires live typed persistent custody"
    );
  if (installed.network !== directory.network)
    throw new Error(
      "Canonical directory differs from actual installed wallet network"
    );
  internals.canonicalDirectory = directory;
  return () => {
    if (internals.canonicalDirectory === directory)
      internals.canonicalDirectory = undefined;
  };
}
export {
  MainAccountBusyError,
  TopicBurnPreparationError,
} from "../evm-stamp-coordinator";
export {
  PENDING_COIN_PROBES_PER_PASS,
  SELF_NOTE_RETRY_MS,
  SOURCE_HELD_FOR_CONTACT_PAYMENT,
  SWEEP_INCLUSION_WAIT_MS,
  TRANSFER_FAILURE_RECHECK_MS,
} from "../evm-received-coin-manager";
/**
 * Scoped canonical message roles of the live typed wallet for one admitted Current of its own
 * subject. The caller disposes the result. No second copy of the wallet roots is needed.
 */
export function createCanonicalMessageRoles(
  wallet: NativeWalletHandle,
  current: import("../../directory-admission/src").Current
) {
  const internals = evmWalletInternals(wallet);
  const material = internals.material,
    installed = internals.installedCanonicalDescriptor;
  if (
    !material?.canonicalRoles ||
    !installed ||
    !internals.typed ||
    internals.closed
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
  const internals = evmWalletInternals(wallet);
  const material = internals.material;
  if (!material?.canonicalRoles || !internals.typed || internals.closed)
    return undefined;
  return material.canonicalRoles.conversationIdSalt();
}
/** Typed wallets use only the canonical path: pending is an error, never a legacy fallback. */
function canonicalMessagingFor(wallet: EvmChainWalletHandle) {
  requireOpenWallet(wallet);
  const internals = evmWalletInternals(wallet);
  if (!internals.typed) return undefined;
  const canonical = internals.canonicalMessaging;
  if (!canonical)
    throw new CanonicalMessagingPendingError(
      "Canonical direct messages require persistent typed wallet storage on a Monad network."
    );
  return canonical;
}
function nativeOperationOwner(
  wallet: EvmChainWalletHandle
): EvmLegacyConsolidator {
  requireOpenWallet(wallet);
  const owner = evmWalletInternals(wallet).nativeOperationOwner;
  if (!owner) throw new Error("Wallet has no durable native-operation owner");
  return owner;
}
/** Sends again the notes of earlier operations whose transport failed or never ran: every send
 * and resume is also a retry for them. Not waited for, and nothing it meets is this call's error. */
function retryEarlierNotes(
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
  if (evmWalletInternals(wallet).closed)
    throw new Error("Monad wallet is closed");
}

function requireLegacyMessaging(wallet: EvmChainWalletHandle): void {
  requireOpenWallet(wallet);
  if (evmWalletInternals(wallet).typed) {
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
    ((candidate.networkId !== undefined &&
      candidate.networkId !== expectedNetworkId) ||
      (candidate.chainIdentifier !== undefined &&
        candidate.chainIdentifier !== expectedNetworkId))
  ) {
    throw new Error(
      `Expected Monad network ${expectedNetworkId}, got ${
        candidate.networkId ?? candidate.chainIdentifier
      }`
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

/** Longest `fetchSince` waits for the recovery sync before returning the messages. */
export const MAILBOX_RECOVERY_SYNC_WAIT_MS = 5_000;

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

/** Pure factory: builds an `ActiveChain` from an explicit `EvmChainConfig`. See this file's
 * header, "Configuration", for why config is a param here (unlike the `MonadChain` singleton
 * below, which reads it from env). */
export function createEvmChain(config: EvmChainConfig): ActiveChain {
  const chainIdentifier = config.chainIdentifier ?? config.rpcChain;
  if (config.rpcChain !== chainIdentifier) {
    throw new Error(`EVM network mismatch: ${chainIdentifier} / ${config.rpcChain}`);
  }
  if (config.networkId !== chainIdentifier) {
    throw new Error(`EVM wallet network mismatch: ${chainIdentifier} / ${config.networkId}`);
  }
  const chainEntry = getChainRegistryEntry(chainIdentifier);
  if (!chainEntry || chainEntry.family !== "evm") {
    throw new Error(`Unsupported EVM network: ${chainIdentifier}`);
  }
  if (config.networkTag !== chainEntry.networkTag) {
    throw new Error(`EVM network tag mismatch for ${chainIdentifier}`);
  }
  if (
    chainEntry.nativeChainId === undefined ||
    BigInt(config.chainId) !== BigInt(chainEntry.nativeChainId)
  ) {
    throw new Error(`EVM chain ID mismatch for ${chainIdentifier}`);
  }
  if (chainEntry.nativeDecimals === null) {
    throw new Error(
      `${chainIdentifier} has no native coin; use its token payment adapter`
    );
  }
  if (config.unit !== undefined && config.unit !== chainEntry.unit) {
    throw new Error(`EVM unit mismatch for ${chainIdentifier}`);
  }
  if (config.name !== undefined && config.name !== chainEntry.name) {
    throw new Error(`EVM name mismatch for ${chainIdentifier}`);
  }
  const nativeDecimals = chainEntry.nativeDecimals;
  const isTestnet = chainEntry.isTestnet;
  const requirePeerSyncDelivery = (): void => {
    if (
      chainEntry.kind !== "monad" &&
      !config.emitWalletSync
    )
      throw new Error("Secondary EVM wallet sync delivery is unavailable");
  };
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
    evmWalletInternals(wallet).material?.mainAccount.privateKey ??
    wallet.identity.toPrivateKeyHex();
  // The queue topic posts, votes and native sends still run their own multi-step sequences on
  // (each is recorded across several stores). Paid messages never enter it: a message claims its
  // accounts through the pool's one synchronous claim (`MonadSubAccountPool.claim`), which is
  // also what keeps these operations and messages off each other's accounts.
  const runWalletExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: (admission?: EvmWalletOperationAdmission) => Promise<T>,
    canonical = false
  ): Promise<T> => {
    requireOpenWallet(wallet);
    const internals = evmWalletInternals(wallet);
    const run = (internals.sendQueue ?? Promise.resolve()).then(
      async () => {
        const owner = internals.privateTopicWallet?.walletState;
        if (!owner) return task();
        internals.enclosingTopicAdmission = true;
        try {
          return await (canonical
            ? owner.runCanonicalOperation(task)
            : owner.runOperation(task));
        } finally {
          internals.enclosingTopicAdmission = false;
        }
      }
    );
    internals.sendQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  // The main and identity accounts are one coin each, at one nonce. Everything that signs from
  // one takes it through the pool's one account claim (`MonadSubAccountPool.claimAccount`), the
  // same claim a paid message takes, and keeps it until the chain shows the transaction mined or
  // its nonce consumed by another: never until a task merely returns. Whoever needs a held
  // account waits its turn.
  //
  // Native sends, contract calls, consolidations and funding passes run one at a time
  // (`runNativeTransactionExclusive`) and share one holder per wallet. What keeps the claim after
  // such an operation returns is its own durable record, the native journal
  // (`EvmLegacyConsolidator.holdsSource`), plus, for a transfer the journal does not record (a
  // payment to a contact), the transaction remembered below for this session.
  const mainAccountHolder = (wallet: EvmChainWalletHandle) =>
    `${wallet.identity.address.raw.toLowerCase()}:main-account`;
  const mainAccountAddresses = (wallet: EvmChainWalletHandle) => [
    ...new Set(
      [
        evmWalletInternals(wallet).material?.mainAccount.address,
        wallet.identity.address.raw,
      ].flatMap((address) =>
        address === undefined ? [] : [address.toLowerCase()]
      )
    ),
  ];
  /** One look at the chain for each transaction this wallet's native holder signed from
   * `address` that is still undecided. Never rejects. */
  const lookAtOwnTransactions = async (
    wallet: EvmChainWalletHandle,
    address: string
  ): Promise<void> => {
    const internals = evmWalletInternals(wallet);
    if (internals.closed) return;
    await internals.nativeOperationOwner?.lookAtSource(address);
    const transfers = internals.unjournalledTransfers.get(address) ?? [];
    for (const transfer of [...transfers]) {
      try {
        const decided =
          (await wallet.provider.getTransactionReceipt(transfer.txHash)) !==
            null ||
          (await wallet.provider.getTransactionCount(address, "latest")) >
            transfer.nonce;
        if (decided) transfers.splice(transfers.indexOf(transfer), 1);
      } catch {
        // The chain could not be read: nothing is known, the account stays held.
      }
    }
  };
  /** True while something the native holder signed from `address` is undecided. No request. */
  const ownTransactionUndecided = (
    wallet: EvmChainWalletHandle,
    address: string
  ): boolean => {
    const internals = evmWalletInternals(wallet);
    return (
      sourceIsHeld(wallet, address) ||
      internals.nativeOperationOwner?.holdsSource(address) === true ||
      (internals.unjournalledTransfers.get(address)?.length ?? 0) > 0
    );
  };
  /**
   * Lets go of the main and identity accounts this wallet's native holder has, each as soon as
   * nothing it signed from that account is still undecided. With `look` the chain is asked first
   * (one look per undecided transaction); without it only what is already recorded counts.
   */
  const releaseSettledMainAccounts = async (
    wallet: EvmChainWalletHandle,
    look: boolean
  ): Promise<void> => {
    const pool = wallet.pool;
    if (typeof pool.accountClaimedBy !== "function") return;
    const holder = mainAccountHolder(wallet);
    const internals = evmWalletInternals(wallet);
    // One look a second for the wallet, however many sends are waiting for the account.
    if (look) {
      const last = internals.lastOwnLookMs;
      if (last !== undefined && Date.now() - last < 1_000) look = false;
      else internals.lastOwnLookMs = Date.now();
    }
    // The main and identity accounts, and any other account a funding run claimed under this
    // holder (a received coin or the identity account paying a topic burn or fund-ahead).
    const addresses = new Set([
      ...mainAccountAddresses(wallet),
      ...(typeof pool.accountsClaimedBy === "function"
        ? pool.accountsClaimedBy(holder)
        : []),
    ]);
    for (const address of addresses) {
      if (pool.accountClaimedBy(address) !== holder) continue;
      if (look) await lookAtOwnTransactions(wallet, address);
      // An operation is running under this holder right now: it lets go itself when it ends.
      if (internals.runningMainTasks > 0) return;
      if (!ownTransactionUndecided(wallet, address))
        pool.releaseAccountClaim(holder, address);
    }
  };
  /**
   * Takes the main and identity accounts for the native holder, waiting its turn while an
   * earlier payment is spending one: a paid message's, or (with `waitForOwn`) a transaction this
   * holder itself signed earlier. The chain is asked about that one payment at most once a
   * second, no relay request is made, and nothing times out unless the caller gave a deadline
   * (`waitMs`). A wait ends when the wallet is closed.
   */
  const holdMainAccounts = async (
    wallet: EvmChainWalletHandle,
    options: MainAccountWait & { unreservedRootsOnly?: boolean } = {}
  ): Promise<void> => {
    const pool = wallet.pool;
    const internals = evmWalletInternals(wallet);
    if (typeof pool.claimAccount !== "function") {
      internals.runningMainTasks += 1;
      return;
    }
    const holder = mainAccountHolder(wallet);
    const rootAddresses =
      options.addresses !== undefined && options.addresses.length > 0
        ? [
            ...new Set(
              options.addresses.map((address) => address.toLowerCase())
            ),
          ]
        : mainAccountAddresses(wallet);
    // Inventory-based sends may use other accounts while a shared construction owns a root.
    // Opaque own-transfers still require the complete requested root claim.
    const addresses = rootAddresses.filter(address =>
      !options.unreservedRootsOnly || !internals.coinList?.isAccountReserved(address));
    const others = () =>
      addresses.filter((address) => {
        const claimant = pool.accountClaimedBy(address);
        return (claimant !== undefined && claimant !== holder) || internals.coinList?.isAccountReserved(address) === true;
      });
    const own = () =>
      options.waitForOwn === true
        ? addresses.filter((address) =>
            ownTransactionUndecided(wallet, address)
          )
        : [];
    const deadline =
      options.waitMs === undefined ? undefined : Date.now() + options.waitMs;
    let waiting = false;
    for (;;) {
      let held = others();
      // Synchronous from the look to the claim: nobody else can take one in between.
      if (held.length === 0 && own().length === 0) {
        for (const address of addresses)
          pool.restoreAccountClaim(holder, address);
        // From this moment an operation is running under the holder: counted in the same
        // synchronous step as the claim, so a message that is waiting for the account cannot
        // take the claim for a settled leftover and let it go while this operation is still
        // waiting out the spacing below. (Seen on testnet: it did, and a native send and a
        // message payment were both signed at one nonce.)
        internals.runningMainTasks += 1;
        // Held now, so nothing else can sign from them: wait out the chain's spacing rule
        // after whatever last spent each (a message payment just mined, say).
        try {
          for (const address of addresses)
            await waitForSpendSpacing(
              wallet.provider,
              address,
              config.spendSpacingBlocks,
              { reserveBalanceWei: config.reserveBalanceWei }
            );
        } catch (error) {
          internals.runningMainTasks -= 1;
          await releaseSettledMainAccounts(wallet, false);
          throw error;
        }
        return;
      }
      if (!waiting) {
        waiting = true;
        options.onWaiting?.();
      }
      if (held.length > 0) {
        const holderOfIt = pool.accountClaimedBy(held[0]!);
        if (holderOfIt !== undefined)
          await internals.canonicalMessaging
            ?.settleHolder(holderOfIt)
            .catch(() => undefined);
      } else
        for (const address of own())
          await lookAtOwnTransactions(wallet, address);
      held = others();
      if (held.length === 0 && own().length === 0) continue;
      requireOpenWallet(wallet);
      if (deadline !== undefined && Date.now() >= deadline)
        throw new MainAccountBusyError();
      // Woken when the account is released or at the wallet's next look at the chain (the one
      // block watcher every waiter shares); a wallet with none waits a second.
      const watcher = internals.blockWatcher;
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const look = watcher
        ? watcher.next(abort.signal).catch(() => undefined)
        : new Promise((resolve) => (timer = setTimeout(resolve, 1_000)));
      // Coin-list reservations have no pool release signal. Racing an already-resolved
      // pool promise would spin in microtasks and starve the construction holding the coin.
      const poolHeld = held.find(address => pool.accountClaimedBy(address) !== undefined);
      await Promise.race([
        ...(poolHeld !== undefined ? [pool.accountReleased(poolHeld)] : []),
        look,
      ]);
      abort.abort();
      clearTimeout(timer);
    }
  };
  /**
   * A transfer signed from the identity or main account outside the native journal (a transfer
   * to a contact, a bot host's own payout): the two accounts are taken through the claim, the
   * turn and the chain's spacing are waited for, and the account `sign` reports it spent stays
   * claimed until the chain shows the transaction mined or its nonce consumed. The transfer
   * has no durable record of its own, so that hold lasts for this session only.
   */
  const runUnjournalledTransfer = <
    T extends { txHash: string; from: string; nonce: number }
  >(
    wallet: EvmChainWalletHandle,
    sign: () => Promise<T>,
    waitMs?: number
  ): Promise<T> =>
    runMainAccountExclusive(
      wallet,
      async () => {
        const sent = await sign();
        const from = sent.from.toLowerCase();
        if (mainAccountAddresses(wallet).includes(from)) {
          const transfers = evmWalletInternals(wallet).unjournalledTransfers;
          transfers.set(from, [
            ...(transfers.get(from) ?? []),
            { txHash: sent.txHash, nonce: sent.nonce },
          ]);
        }
        return sent;
      },
      { waitMs, waitForOwn: true }
    );
  const runMainAccountExclusive = <T>(
    wallet: EvmChainWalletHandle,
    task: () => Promise<T>,
    options: MainAccountWait & { unreservedRootsOnly?: boolean } = {}
  ): Promise<T> => {
    const internals = evmWalletInternals(wallet);
    let admission = internals.mainAccountAdmission;
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
      internals.mainAccountAdmission = admission;
    }
    const owner = admission;
    // Always acquire in this order: wallet queue -> native coordination -> pool funding queue.
    // Keep the durable read and all funding/signing inside the same account coordination scope.
    return runNativeTransactionExclusive(
      owner.key,
      owner.store.coordinationScope,
      async () => {
        await reconcileNativeAdmission(owner);
        // Returns holding the accounts, with this operation counted as running.
        await holdMainAccounts(wallet, options);
        try {
          return await task();
        } finally {
          internals.runningMainTasks -= 1;
          // Whatever this operation signed from the main or identity account keeps that account
          // until the chain shows it; an account it signed nothing from is free at once.
          await releaseSettledMainAccounts(wallet, false);
        }
      }
    );
  };
  const consumeSelfNotes = consumeEvmSelfNotes;
  const recordReceivedCoins = recordEvmReceivedCoins;
  const directMessages: DirectMessageClient = {
    async quoteStamp(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const quote = evmWalletInternals(wallet).canonicalStampQuoter;
      if (!quote)
        throw new CanonicalMessagingPendingError(
          "Stamp affordability requires persistent typed wallet custody."
        );
      return quote({
        stampValueWei: params.stampValue,
        excludedAddresses: params.excludedAddresses,
      });
    },
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
      const coinOwner = evmWalletInternals(wallet).receivedCoinOwner;
      const carried = params.items.flatMap((item) =>
        item.type === "stealth" && item.ephemeralPubKey
          ? [item.ephemeralPubKey.replace(/^0x/, "").toLowerCase()]
          : []
      );
      if (coinOwner === undefined || carried.length === 0)
        return canonical.send(params);
      // (1) A message carrying a released payment is refused here, before the send writes or
      // submits anything. (2) While the send runs its payments are in flight and cannot be
      // released. (3) The payment learns the message's digest before anything durable exists
      // from which those bytes could be submitted, and before a free message is handed over:
      // from that moment "no digest" no longer holds, and the payment is never released.
      const endSend = await coinOwner.beginContactSend(carried);
      let result: DirectMessageSendResult;
      try {
        const contactIdentity = coinOwner.contactMessageIdentity?.(carried);
        const carriedOperation = contactIdentity?.operationId;
        if (params.paymentOperationId && carriedOperation && params.paymentOperationId !== carriedOperation)
          throw new Error("Message carries conflicting payment operation identities");
        result = await canonical.send({
          ...params,
          ...(carriedOperation ? { paymentOperationId: carriedOperation } : {}),
          ...(contactIdentity ? {
            messageId: params.messageId ?? contactIdentity.messageId,
            onEnvelopeDurable: async (payloadDigest: string) => {
              await coinOwner.contactMessageAttempted(carried, payloadDigest);
              await params.onEnvelopeDurable?.(payloadDigest);
            },
          } : {}),
          onBeforeExposure: async (payloadDigest) => {
            await coinOwner.contactMessageAttempted(carried, payloadDigest);
            await params.onBeforeExposure?.(payloadDigest);
          },
        });
      } catch (error) {
        endSend();
        // The message could not even be paid for because its own stamp funding needs the
        // account the payment's signed transfer is held on. That is refused before the message
        // is sealed, so nothing of it exists: the payment is released (its transfer cancelled,
        // its source free) instead of waiting on itself for ever, and the caller makes the
        // payment again.
        if (
          error instanceof Error &&
          error.message === SOURCE_HELD_FOR_CONTACT_PAYMENT &&
          (await coinOwner.releaseUnsentContactPayments(carried))
        )
          throw new ContactPaymentReleasedError();
        throw error;
      } finally {
        endSend();
      }
      void coinOwner.contactMessageDelivered(result.payloadDigest);
      return result;
    },

    async deliveryOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.deliveryOf(params);
    },

    async attemptOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      return canonical.attemptOf(params);
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
      const coinOwner = evmWalletInternals(wallet).receivedCoinOwner;
      for (const [digest, status] of Object.entries(statuses))
        if (status === "delivered") void coinOwner?.contactMessageDelivered(digest);
      return statuses;
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

    async defaultStampQuote(params): Promise<DefaultStampQuote> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical) return { status: "unavailable", chainIdentifier: contractChainIdentifier(), reason: "unsupported" };
      return canonical.defaultStampQuote();
    },

    async minimumStamp(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical) throw new CanonicalMessagingPendingError();
      return canonical.minimumStamp();
    },

    chainHealth(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.chainHealth() ?? { reachable: true };
    },

    paymentsOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.paymentsOf(params.payloadDigest);
    },
    paymentSummaryOf(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return canonicalMessagingFor(wallet)?.paymentSummaryOf(params.payloadDigest);
    },

    async scanAuthenticatedMailbox(params) {
      const wallet = asMonadWallet(params.wallet, chainIdentifier);
      if (wallet.chainIdentifier !== chainIdentifier)
        throw new Error("Authenticated mailbox requires canonical chain affinity");
      const sinceMs = params.sinceMs;
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical) throw new CanonicalMessagingPendingError();
      const directory = evmWalletInternals(wallet).canonicalDirectory;
      if (directory && directory.network !== chainIdentifier)
        throw new Error("Authenticated mailbox directory has a foreign chain");
      const result = await canonical.scanAuthenticatedMailbox({ wallet, sinceMs });
      asMonadWallet(wallet, chainIdentifier);
      if (
        wallet.chainIdentifier !== chainIdentifier ||
        canonicalMessagingFor(wallet) !== canonical ||
        evmWalletInternals(wallet).canonicalDirectory !== directory
      )
        throw new Error("Authenticated mailbox session changed during scan");
      return result;
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const canonical = canonicalMessagingFor(wallet);
      if (!canonical)
        throw new CanonicalMessagingPendingError(
          "Canonical direct messages require persistent typed wallet custody on a Monad network."
        );
      const received: DirectMessageReceived[] = [];
      {
        // The coin list's own first read of the mailbox, from the start, whatever cursor the
        // host asks from: money that arrived before this coin list existed is found here. It
        // records coins only; no message of it is handed to the host. Done once: afterwards
        // every read records what it returns.
        const coinOwner = evmWalletInternals(wallet).receivedCoinOwner;
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
            if (scannedUntil > scan.sinceMs) {
              await coinOwner.recordMailboxScan({
                complete: false,
                sinceMs: scannedUntil,
              });
            }
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
        const noteYielder = createCooperativeBatchYielder();
        let noteStarted = false;
        for (const msg of canonicalReceived) {
          if (noteStarted) {
            await noteYielder.maybeYield();
          } else {
            noteStarted = true;
          }
          const taken = await consumeSelfNotes(wallet, msg, params.onForeignWalletSync);
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

      received.sort((a, b) => (a.receivedTime ?? 0) - (b.receivedTime ?? 0));
      // Payments to contacts whose message is not delivered yet are finished from here: the
      // hosts' existing mailbox poll, never at wallet open.
      const coinOwner = evmWalletInternals(wallet).receivedCoinOwner;
      void coinOwner?.resumeContactPayments();
      // Coins with no note to self yet get one: free messages, not waited for.
      void coinOwner?.noteCoins();
      // The wallet's background pass over payments the chain has not shown yet: bounded, and
      // no request at all when nothing is pending. Not awaited: the messages do not wait for it.
      void coinOwner?.checkPendingCoins();
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
            // A stealth payment, or a note about a received coin, is recorded in the coin list
            // before the record is handed on.
            void (record.items.some(
              (item) => item.type === "stealth" || item.type === "received-coin"
            )
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
      mainAccountWaitMs,
    }): Promise<{ txHash: string }> {
      asMonadWallet(wallet, config.networkId);
      requirePeerSyncDelivery();
      return wallet.sendNative({
        recipient,
        value,
        onSigned,
        mainAccountWaitMs,
      });
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

    async sendLegacy({
      wallet,
      recipient,
      value,
      onProgress,
      onSigned,
      mainAccountWaitMs,
    }) {
      const owned = asMonadWallet(wallet, config.networkId);
      requirePeerSyncDelivery();
      nativeOperationOwner(owned);
      return owned.sendLegacy!({
        recipient,
        value,
        onProgress,
        onSigned,
        mainAccountWaitMs,
      });
    },
    async estimateLegacyFee({ wallet, recipient, value }) {
      const active = asMonadWallet(wallet, config.networkId);
      if (!active.estimateLegacyFee)
        throw new Error("Legacy fee estimation requires a durable native-operation owner");
      return active.estimateLegacyFee({ recipient, value });
    },

    async sendToContact({ wallet, ...params }) {
      return asMonadWallet(wallet, config.networkId).sendToContact!(params);
    },
  };

  // Network waits retain the wallet lifetime, not its mutation queue. The shared
  // inventory reserves inputs atomically; each journal mutation takes its own short gate.
  const withTopicWallet = <T>(
    wallet: EvmChainWalletHandle,
    task: (topicWallet: EvmWalletHandle) => Promise<T>
  ): Promise<T> => {
    requireOpenWallet(wallet);
    const topicWallet = evmWalletInternals(wallet).privateTopicWallet ?? wallet;
    if (!topicWallet.walletState) throw new Error("Topics require coherent wallet persistence");
    return topicWallet.walletState.runLifetime(() => task(topicWallet));
  };
  const forumPolicy: ForumReadPolicy = {
    network:
      config.networkTag === "MON1"
        ? "monad-mainnet"
        : config.networkTag === "MONT"
        ? "monad-testnet"
        : config.networkTag === "MONR"
        ? "monad-regtest"
        : config.networkTag,
    chainId: BigInt(config.chainId),
    burnAddress: config.stampBurnAddress,
  };
  const creatorForumPolicy = (wallet: EvmWalletHandle): ForumReadPolicy => ({
    network: wallet.cborNetwork ?? forumPolicy.network,
    chainId: wallet.forumChainId ?? forumPolicy.chainId,
    burnAddress: wallet.forumBurnAddress ?? forumPolicy.burnAddress,
  });
  const reconcileTopicOperations = async (wallet: EvmWalletHandle) => {
    const operations = createEvmTopicOperations(wallet);
    await operations.reconcile("post");
    await operations.reconcile("vote");
  };
  const topics: TopicBroadcastClient = {
    async reconcileOperations(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      await withTopicWallet(wallet, async (topicWallet) => {
        await topicWallet.walletState!.runLifetime(() =>
          reconcileTopicOperations(topicWallet)
        );
      });
    },
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      return withTopicWallet(wallet, async (topicWallet) => {
        const client = new TopicPostClient({ chainIdentifier: config.networkId, topicOperations: createEvmTopicOperations(topicWallet) });
        const policy = creatorForumPolicy(topicWallet);
        return topicWallet.walletState!.runLifetime(async () => {
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
                amountAtomic: params.voteWeightWei,
              }
            )
            // Leased (the row's own status holds it now) or never used: the claim is over.
            .catch((err: unknown) => {
              if (err instanceof TopicPostAbandonedError) {
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
      await withTopicWallet(wallet, async (topicWallet) => {
        const client = new TopicVoteClient({ chainIdentifier: config.networkId, topicOperations: createEvmTopicOperations(topicWallet) });
        const policy = creatorForumPolicy(topicWallet);
        await topicWallet.walletState!.runLifetime(async () => {
          if (
            (params.direction !== "up" && params.direction !== "down") ||
            params.voteWeightWei < 1n ||
            params.voteWeightWei > 9223372036854775807n
          )
            throw new Error("Canonical vote burn must be within 1..i64::MAX");
          const targetPayloadHash = getBytes(`0x${params.payloadDigest}`);
          if (targetPayloadHash.length !== 32)
            throw new Error("Canonical vote requires a T1 digest");
          await client
            .castVote(
              {
                targetPayloadHash,
                direction: params.direction,
                amountAtomic: params.voteWeightWei,
              }
            )
            // Leased (the row's own status holds it now) or never used: the claim is over.
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
          ? creatorForumPolicy(evmWalletInternals(wallet).privateTopicWallet ?? wallet)
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
  const name = chainEntry.name;
  const unit = chainEntry.unit;
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
    minimumWagerValue: config.minimumWagerValueWei ?? 10_000_000_000_000_000n,
    defaultTopicVoteValue: config.defaultTopicVoteValueWei,

    toDisplayAmount(raw: bigint): string {
      return formatUnits(raw, nativeDecimals);
    },

    fromDisplayAmount(display: string): bigint {
      return parseUnits(display, nativeDecimals);
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
      seed: HDSeed | MonadRootBundle | HistoricalBip39Seed
    ): Promise<EvmChainWalletHandle> {
      const material = createMonadWalletMaterial(seed);
      if (config.requireBoundWalletState === true && material.canonicalRoles === undefined) {
        material.dispose();
        throw new Error("Bound EVM wallet state requires typed domain roots");
      }
      const { identity, mainAccount, keyring, changeKeyring } = material;
      const identityKey = identity.address.raw.toLowerCase();
      const mainAccountKey = mainAccount.address.toLowerCase();
      const economicOwnerKey =
        material.canonicalRoles === undefined
          ? undefined
          : `${chainIdentifier}:${config.chainId}:${mainAccountKey}`;
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
          material.canonicalRoles === undefined
            ? identityKey
            : `evm-${mainAccount.address.toLowerCase()}`;
        const storageScope =
          chainEntry.kind === "monad"
            ? storageKey
            : `${chainIdentifier}-${storageKey}`;
        const storageLocation =
          config.walletStorageLocation === false
            ? undefined
            : `${config.walletStorageLocation}-${storageScope}`;
        // Typed roots own a durable public state tuple. A previously opened state path must
        // retain both spend-pool bindings: recreating either empty pool could reuse an account.
        // Only an entirely absent path is eligible for first-time binding. Existing pre-baseline
        // unbound state fails closed rather than silently adopting potentially funded roots.
        const typedPoolBinding =
          material.canonicalRoles === undefined
            ? undefined
            : evmWalletPoolBindingId(material, chainIdentifier, BigInt(config.chainId));
        if (config.requireBoundWalletState === true) {
          if (storageLocation === undefined) {
            throw new Error('Bound wallet state requires durable storage');
          }
          if (config.walletStateExists === undefined) {
            throw new Error('Bound wallet state requires a host-owned presence check');
          }
        }
        const freshWalletState =
          config.requireBoundWalletState === true &&
          storageLocation !== undefined &&
          !config.walletStateExists!(storageLocation);
        const allowUnboundPool =
          freshWalletState || config.requireBoundWalletState !== true;
        const subAccountStore =
          storageLocation === undefined
            ? undefined
            : new LevelSubAccountPoolStore(
                storageLocation,
                typedPoolBinding,
                allowUnboundPool
              );
        const changeStore =
          storageLocation === undefined
            ? undefined
            : new LevelChangePoolStore(
                storageLocation,
                typedPoolBinding,
                allowUnboundPool
              );
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
            preparations?.close(),
            coins?.close(),
            contactPayments?.close(),
            coinListState?.close(),
            evmCoinListStore?.close(),
          ]);
        const pool = new EvmSubAccountPool({
          keyring,
          store: subAccountStore,
          mainAccountAddress: mainAccount.address,
        });
        const changePool = new EvmChangePool({
          keyring: changeKeyring,
          store: changeStore,
        });
        const leaseManager = new SubAccountLeaseManager(pool);
        let topicOwner: EvmWalletPersistenceBundle | undefined;
        let canonicalLinks: OutgoingMessageStore | undefined;
        let preparations: RecordStore<EvmStealthPreparation> | undefined;
        let coins: RecordStore<EvmCoin> | undefined;
        let contactPayments: RecordStore<ContactPayment> | undefined;
        let coinListState:
          | RecordStore<{ complete: boolean; sinceMs: number }>
          | undefined;
        let evmCoinListStore: RecordStore<StoredEvmListCoin> | undefined;
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
          topicOwner = await openExistingPoolEvmWalletBundle({
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
              if (typedPoolBinding !== undefined && freshWalletState) {
                if (subAccountStore?.bindingId() === undefined)
                  await subAccountStore!.Bind();
                if (changeStore?.bindingId() === undefined)
                  await changeStore!.Bind();
              }
            },
            nativeBinding: {
              chainIdentifier,
              nativeChainId: String(config.chainId),
              publicTuple: JSON.stringify({
                version: 1,
                registry: material.canonicalRoles?.derivationRegistry ?? DERIVATION_REGISTRY_ID,
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
              material.canonicalRoles === undefined || chainEntry.kind !== "monad"
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
                !evmWalletInternals(topicOwnerWallet).enclosingTopicAdmission
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

          const initialPoolCount = pool.records().length;
          pool.ensureUnfundedSize(config.subAccountPoolSize);
          let poolModified = pool.records().length !== initialPoolCount;
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
            ...(topicOwner.topicOperationJournal.getRetainedLegacy?.().map(row => row.leaseIndex) ?? []),
            ...stampAttemptJournal
              .getAll()
              .flatMap((attempt) => attempt.leaseIndices),
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
              poolModified = true;
            }
          }
          if (poolModified) {
            await pool.flush();
          }
          const rpcUrl = `${config.relayBaseUrl.replace(
            /\/$/,
            ""
          )}/chain-rpc/${encodeURIComponent(config.rpcChain)}/rpc`;
          const relayAuth = {
            chain: config.rpcChain,
            customer: identity.address.raw,
            subject: hexlify(identity.compressedPubKey).slice(2),
            networkTag: config.relayAuthNetworkTag ?? config.networkTag,
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
          if (storageLocation === undefined) {
            coins = new MemoryRecordStore<EvmCoin>();
            preparations = new MemoryRecordStore<EvmStealthPreparation>();
            contactPayments = new MemoryRecordStore<ContactPayment>();
            coinListState = new MemoryRecordStore<{
              complete: boolean;
              sinceMs: number;
            }>();
            evmCoinListStore = new MemoryRecordStore<StoredEvmListCoin>();
          } else {
            [coins, preparations, contactPayments, coinListState, evmCoinListStore] =
              await Promise.all([
                LevelRecordStore.open<EvmCoin>(
                  storageLocation,
                  EVM_COIN_NAMESPACE
                ),
                LevelRecordStore.open<EvmStealthPreparation>(
                  storageLocation,
                  EVM_STEALTH_PREPARATION_NAMESPACE
                ),
                LevelRecordStore.open<ContactPayment>(
                  storageLocation,
                  CONTACT_PAYMENT_NAMESPACE
                ),
                LevelRecordStore.open<{ complete: boolean; sinceMs: number }>(
                  storageLocation,
                  "received-coins-mailbox-scan"
                ),
                LevelRecordStore.open<StoredEvmListCoin>(
                  storageLocation,
                  EVM_COIN_LIST_NAMESPACE
                ),
              ]);
          }
          const scanState = coinListState;
          const coinList = await EvmCoinList.open(evmCoinListStore);
          const coinStore = coins;
          const transactionSetRuntime = installEvmTransactionSetRuntime({
            coinList,
            coinStore,
            provider,
            mainAccount,
            identity,
            pool,
            changePool,
            changeKeyring,
            journal: evmTransactionSetJournal(topicOwner),
            // The runtime's changePool allocator persisted every derivation claim before
            // signing; cancellation cleanup can retire its journal without reusing keys.
            onCancellationCheckpoint: operation => topicOwner!.runLifetime(lifetime =>
              nativeAdmissionJournal(topicOwner!.inputAdmission, lifetime).archiveCompleted(
                operation.operationId, transactionSetCancellationReceipt(operation))),
            kind: chainEntry.kind,
            knownNoCodeAddress: config.stampBurnAddress,
            spendSpacingBlocks: config.spendSpacingBlocks,
            reserveBalanceWei: config.reserveBalanceWei,
            paymentPollIntervalMs: config.paymentPollIntervalMs,
            policy: config.transactionSetPolicy,
          });
          const transactionOwner = topicOwner;
          // Delivery stays owned by the canonical/host outbox. This retires only the
          // wallet's settled inventory and successfully checkpointed self-sync work.
          const archiveCompletedFinancialOperations = async () => {
            for (const operation of transactionOwner.nativeJournal!.list()) {
              const receipt = transactionSetFinancialCompletionReceipt(operation);
              if (receipt) await transactionOwner.runLifetime(lifetime =>
                nativeAdmissionJournal(transactionOwner.inputAdmission, lifetime)
                  .archiveCompleted(operation.operationId, receipt));
            }
          };
          const { transactionSetPreparer, transactionSetLifecycle } = transactionSetRuntime;
          const transactionSetSender = createEvmTransactionSetSubmission({
            preparer: transactionSetPreparer, lifecycle: transactionSetLifecycle, provider,
            refresh: transactionSetRuntime.refresh,
            operations: () => transactionOwner.nativeJournal!.list(),
          });
          // Shared-set reconciliation must not flush legacy native operations: their
          // send/re-observation owners decide when those notes may be transported.
          const startTransactionSetSync = async (logicalId?: string) => {
            if (evmWalletInternals(wallet).closed) return;
            const operations = transactionOwner.nativeJournal!.list().filter(operation =>
              operation.kind === "transaction-set" && !operation.cancelled && operation.submissionAuthorized &&
              (logicalId === undefined || operation.preparationId === `evm-transaction-set:${logicalId}`) &&
              !operation.members.some(member => member.observation.state === "included-success" && !member.transactionSet?.inventoryApplied) &&
              (operation.members.some(member => member.observation.state === "included-success" && !member.syncApplied) ||
                transactionSetFinancialCompletionReceipt(operation) !== undefined));
            for (const operation of operations) {
              if (evmWalletInternals(wallet).closed) return;
              try {
                const started = await nativeOperationOwner(wallet).startSync(operation.operationId);
                void started.transported.catch(() => undefined);
              } catch (error) {
                // A probe may finish after close. Do not acquire another wallet lifetime
                // then; genuine checkpoint failures while open remain observable.
                if (evmWalletInternals(wallet).closed) return;
                throw error;
              }
            }
          };
          const transactionSetSubmission = {
            sendTransaction: (prepared: Parameters<typeof transactionSetSender.sendTransaction>[0]) =>
              transactionSetSender.sendTransaction(prepared).then(async result => {
                await startTransactionSetSync(prepared.operationId);
                return result;
              }).finally(() => invalidateBalanceRead()),
            reconcileAuthorized: () =>
              transactionSetSender.reconcileAuthorized().then(async results => {
                // Terminal sets with an owed sync checkpoint are absent from results.
                await startTransactionSetSync();
                return results;
              }).finally(() => invalidateBalanceRead()),
          };
          const publicTransactionSets = evmTransactionSetCapability(transactionSetPreparer, prepared => transactionSetSubmission.sendTransaction(prepared));
          const legacyTransactions = createLegacyTransactionSetPayments({
            preparer: transactionSetPreparer,
            sendTransaction: prepared => transactionSetSubmission.sendTransaction(prepared),
            refresh: transactionSetRuntime.refresh,
            operations: () => transactionOwner.nativeJournal!.list(),
            readOperation: id => transactionOwner.nativeJournal!.readOperation(id),
            getCoins: () => coinList.all().filter(coin => coin.origin !== 'legacy-subaccount' && transactionOwner.nativeJournal!.canSelect(coin.account, coin.nonce) &&
              !transactionSetRuntime.coinListSync.isDirty(coin.account) && pool.accountClaimedBy(coin.account) === undefined),
          });
          const paymentStore = contactPayments;
          const spendPool = new EvmSpendPool({
            identity,
            mainAccount,
            keyring,
            changeKeyring,
            pool,
            changePool,
            coinStore,
            nativeJournal: () => topicOwner?.nativeJournal,
            isAccountReserved: address => coinList.isAccountReserved(address),
            holdsSource: (address) =>
              evmWalletInternals(wallet).nativeOperationOwner?.holdsSource(address) === true,
          });
          const resolveSource = (source: EvmNativeSource): Wallet =>
            spendPool.resolveSource(source);
          const coinSource = (coin: EvmCoin): EvmNativeSource =>
            spendPool.coinSource(coin);
          const getSources = (): Promise<EvmNativeSource[]> =>
            spendPool.getSources();

          let primaryBalanceCache:
            | {
                mainBalance: bigint;
                identityBalance: bigint;
                changeBalance: bigint;
                cachedAtMs: number;
              }
            | undefined;
          const PRIMARY_BALANCE_CACHE_TTL_MS = 4_000;
          const balanceObsStorageKey =
            storageLocation !== undefined
              ? `frank:evm-balance-obs:${chainIdentifier}:${mainAccount.address.toLowerCase()}`
              : undefined;
          let lastBalanceObservation:
            | { balance: bigint; observedAt: number }
            | undefined = (() => {
            if (!balanceObsStorageKey) return undefined;
            try {
              const raw =
                globalThis.localStorage?.getItem(balanceObsStorageKey);
              if (!raw) return undefined;
              const parsed = JSON.parse(raw) as {
                balance?: string;
                observedAt?: number;
              };
              if (
                typeof parsed?.balance === "string" &&
                typeof parsed?.observedAt === "number"
              ) {
                return {
                  balance: BigInt(parsed.balance),
                  observedAt: parsed.observedAt,
                };
              }
            } catch {
              // Ignore localStorage access/parse errors
            }
            return undefined;
          })();

          type BalanceParts = Awaited<
            ReturnType<NonNullable<EvmChainWalletHandle["getBalanceParts"]>>
          >;
          let balancePartsRefresh: Promise<BalanceParts> | undefined;
          let balanceReadGeneration = 0;
          // Existing financial invalidations detach older display reads as well as cached totals.
          const invalidateBalanceRead = (affectedAddress?: string): void => {
            if (affectedAddress !== undefined) transactionSetRuntime.coinListSync.markDirty(affectedAddress);
            balanceReadGeneration++;
            primaryBalanceCache = undefined;
            balancePartsRefresh = undefined;
            pool.invalidateDisplayBalanceCache();
          };

          const coinAndContactManager = createEvmReceivedCoinAndContactManager({
            chainIdentifier,
            chainId: config.chainId,
            networkTag: config.networkTag,
            relayBaseUrl: config.relayBaseUrl,
            forumNetwork: forumPolicy.network,
            nativeDecimals,
            unit,
            identityKey,
            identity,
            mainAccount,
            material,
            pool,
            provider,
            coinStore,
            paymentStore,
            scanState,
            preparations,
            getWallet: () => wallet,
            getTopicOwner: () => topicOwner!,
            getSources,
            coinSource,
            invalidateBalanceRead,
            requireOpenWallet,
            canonicalMessagingFor,
            directMessages,
            runWalletExclusive,
            runMainAccountExclusive,
          });

          const readBalanceParts = async (): Promise<BalanceParts> => {
            requireOpenWallet(wallet);
            const generation = balanceReadGeneration;
            try {
              const now = Date.now();
              let mainBalance: bigint;
              let identityBalance: bigint;
              let changeBalance: bigint;

              if (
                primaryBalanceCache !== undefined &&
                now - primaryBalanceCache.cachedAtMs <
                  PRIMARY_BALANCE_CACHE_TTL_MS
              ) {
                mainBalance = primaryBalanceCache.mainBalance;
                identityBalance = primaryBalanceCache.identityBalance;
                changeBalance = primaryBalanceCache.changeBalance;
              } else {
                const readAddress = (address: string): Promise<bigint> =>
                  transactionBuilder.getBalance({ address, provider });
                // Both change and dApp subaccounts remain wallet-owned value, even though
                // ordinary payment selection may only spend the former.
                const changeAddressSet = new Set<string>();
                for (const coin of coinList.all()) {
                  if (coin.origin === "change" || coin.origin === "legacy-subaccount")
                    changeAddressSet.add(coin.account.toLowerCase());
                }
                for (const rec of changePool.records()) {
                  changeAddressSet.add(rec.address.toLowerCase());
                }
                for (const rec of changePool.recoveredAccounts()) {
                  changeAddressSet.add(rec.address.toLowerCase());
                }
                if (storageLocation !== undefined) {
                  for (const idx of [0, 1, 2, 3, 4]) {
                    changeAddressSet.add(
                      changeKeyring
                        .deriveChangeAccount(idx)
                        .address.toLowerCase()
                    );
                  }
                }
                changeAddressSet.delete(mainAccount.address.toLowerCase());
                changeAddressSet.delete(identity.address.raw.toLowerCase());
                const changeAddresses = [...changeAddressSet];
                const [nextMain, nextIdentity, ...changeBalances] =
                  await Promise.all([
                    readAddress(mainAccount.address),
                    identity.address.raw.toLowerCase() ===
                    mainAccount.address.toLowerCase()
                      ? Promise.resolve(0n)
                      : readAddress(identity.address.raw),
                    ...changeAddresses.map((addr) =>
                      readAddress(addr).catch(() => 0n)
                    ),
                  ]);
                mainBalance = nextMain;
                identityBalance = nextIdentity;
                changeBalance = changeBalances.reduce(
                  (sum, b) => sum + b,
                  0n
                );
                if (generation === balanceReadGeneration) {
                  primaryBalanceCache = {
                    mainBalance,
                    identityBalance,
                    changeBalance,
                    cachedAtMs: now,
                  };
                }
              }

              // Plus every received coin the chain shows funded. A pending coin (nothing seen on
              // the chain yet) is never counted, whatever its message said.
              // The received inventory and funded sending accounts are independent reads.
              const [, poolSending] = await Promise.all([
                coinAndContactManager.readCoins(PRIMARY_BALANCE_CACHE_TTL_MS),
                pool.availableBalanceTotal(
                  provider,
                  PRIMARY_BALANCE_CACHE_TTL_MS
                ),
              ]);
              const received = spendableCoins(coinStore.all());
              const receivedTotal = spendableCoinTotal(coinStore.all());
              const sending = poolSending + changeBalance;
              const observedAt = Date.now();
              const totalBalance =
                mainBalance + identityBalance + receivedTotal + sending;
              lastBalanceObservation = {
                balance: totalBalance,
                observedAt,
              };
              if (balanceObsStorageKey) {
                try {
                  globalThis.localStorage?.setItem(
                    balanceObsStorageKey,
                    JSON.stringify({
                      balance: totalBalance.toString(),
                      observedAt,
                    })
                  );
                } catch {
                  // Ignore localStorage quota/access errors
                }
              }
              return {
                main: mainBalance,
                profile: identityBalance,
                received: receivedTotal,
                receivedCount: received.length,
                sending,
              };
            } catch (error) {
              if (isChainUnreachableError(error)) {
                throw error instanceof ChainUnreachableError
                  ? error
                  : new ChainUnreachableError(error);
              }
              throw error;
            }
          };

          let closing: Promise<void> | undefined;
          const wallet: EvmChainWalletHandle = new EvmWallet({
            chainIdentifier,
            networkId: config.networkId,
            identity,
            spendPool,
            transactionSetSubmission,
            constructTransactionSet: request => {
              const input = { ...request,
                ...(request.calldata === undefined ? {} : { calldata: request.calldata.slice() }),
              };
              return transactionOwner.runLifetime(async () => {
                await transactionSetRuntime.refresh();
                return publicTransactionSets.constructTransactionSet(input);
              });
            },
            sendTransaction: prepared => transactionOwner.runLifetime(() => publicTransactionSets.sendTransaction(prepared)),
            transactionSetPreparer,
            transactionSetLifecycle,
            refreshTransactionSetInventory: () => transactionSetRuntime.refresh(),
            forumOperationMutation: (task) => runWalletExclusive(wallet, async () => task()),
            observeRetainedForumSpend: (rawTx) =>
              observeRetainedForumSpend(wallet, coinList, rawTx, config.spendSpacingBlocks),
            mainAccount,
            mainPrivateKey: mainAccount.privateKey,
            invalidateBalanceCache(networkTag?: string) {
              void networkTag;
              invalidateBalanceRead();
              coinAndContactManager.invalidateCoinsRead();
            },
            async getReceiveAddress() {
              requireOpenWallet(wallet);
              return { raw: mainAccount.address };
            },
            async getBalance() {
              const parts = await wallet.getBalanceParts!();
              return (
                parts.main + parts.profile + parts.received + parts.sending
              );
            },
            getBalanceObservation() {
              return lastBalanceObservation;
            },
            // The one account of where the wallet's money is: every coin a send can draw on.
            // `getBalance` is its sum, and the app's breakdown shows its rows.
            async getBalanceParts() {
              requireOpenWallet(wallet);
              if (balancePartsRefresh) return balancePartsRefresh;
              const refresh = readBalanceParts();
              balancePartsRefresh = refresh;
              const clear = () => {
                if (balancePartsRefresh === refresh)
                  balancePartsRefresh = undefined;
              };
              void refresh.then(clear, clear);
              return refresh;
            },
            getReceivedPayments: coinAndContactManager.getReceivedPayments,
            refreshReceivedPayments:
              coinAndContactManager.refreshReceivedPayments,
            getMessagePayment: coinAndContactManager.getMessagePayment,
            checkMessagePayment: coinAndContactManager.checkMessagePayment,
            sweepReceivedCoins: coinAndContactManager.sweepReceivedCoins,
            recordReceivedCoin: coinAndContactManager.recordReceivedCoin,
            noteReceivedCoins: coinAndContactManager.noteCoins,
            getContactPayments: coinAndContactManager.getContactPayments,
            sendToContact: coinAndContactManager.sendToContact,
            prepareContactPayment: coinAndContactManager.prepareContactPayment,
            resumeContactPayments: coinAndContactManager.resumeContactPayments,
            settleContactPayment: coinAndContactManager.settleContactPayment,
            retryContactPayment: coinAndContactManager.retryContactPayment,
            recordStealthPayment: (item, origin) =>
              evmWalletInternals(wallet).receivedCoinOwner!.recordStealthItem(item, {
                payloadDigest: origin?.payloadDigest,
                timestampMs: origin?.timestampMs ?? Date.now(),
              }),
            readNativeOperation(operationId) {
              requireOpenWallet(wallet);
              return transactionOwner.runLifetime(() => transactionOwner.nativeJournal!.readOperation(operationId));
            },
            getNativeOperationHistory(options) {
              requireOpenWallet(wallet);
              return transactionOwner.runLifetime(() => transactionOwner.nativeJournal!.historyPage(options));
            },
            getNativeOperations() {
              return nativeOperationOwner(wallet).listOperations();
            },
            nativeOperationSyncFailed(operationId) {
              return nativeOperationOwner(wallet).syncTransportFailed(
                operationId
              );
            },
            async flushNativeSync() {
              const owner = nativeOperationOwner(wallet);
              try {
                await owner.flushSync();
              } catch (error) {
                if (isChainUnreachableError(error)) {
                  throw error instanceof ChainUnreachableError
                    ? error
                    : new ChainUnreachableError(error);
                }
                throw error;
              }
              return owner.listOperations()
                .filter((row) => !row.cancelled && row.members.some(
                  (member) => member.signed &&
                    member.observation.state === "included-success" &&
                    !member.syncApplied
                ))
                .map((row) => row.operationId);
            },
            async resumeNativeOperation(operationId) {
              invalidateBalanceRead();
              try {
                const original = await transactionOwner.runLifetime(() => transactionOwner.nativeJournal!.readOperation(operationId));
                if (!original) throw new Error("Unknown native operation");
                if (!transactionOwner.nativeJournal!.list().some(row => row.operationId === operationId)) return original;
                // A payment to a contact is broadcast only once the relay has its message.
                if (coinAndContactManager.heldForItsMessage(operationId))
                  throw new Error(
                    "This transfer pays a contact and is broadcast once its message is delivered"
                  );
                const owner = nativeOperationOwner(wallet);
                let result: typeof original;
                if (original.kind === "transaction-set") {
                  if (!original.submissionAuthorized)
                    throw new Error("Submit the original transaction wrapper before resuming it");
                  const logicalId = original.preparationId!.slice("evm-transaction-set:".length);
                  await transactionOwner.runLifetime(async () => transactionSetSubmission.sendTransaction(
                    await transactionSetPreparer.readTransactionSet(logicalId)
                  ));
                  const settled = await transactionOwner.nativeJournal!.readOperation(operationId);
                  if (!settled) throw new Error("Missing durable native operation");
                  result = settled;
                } else {
                  result = await runWalletExclusive(wallet, (admission) =>
                    runMainAccountExclusive(wallet, () => owner.resumeOperation(operationId, admission))
                  );
                }
                // The note to this account's other devices is started, not waited for: a native
                // send or resume never waits on the relay or on a message being sent.
                if (!evmWalletInternals(wallet).closed && transactionOwner.nativeJournal!.list().some(row => row.operationId === operationId)) {
                  {
                    const noteOf = operationId;
                    retryEarlierNotes(owner, noteOf, await owner.startSync(noteOf));
                  }
                }
                return result;
              } finally {
                // A rejected or pending resume may still have changed chain balances.
                // Reads begun before or during it cannot republish those earlier totals.
                invalidateBalanceRead();
              }
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
              const internals = evmWalletInternals(wallet);
              const owner = internals.nativeOperationOwner;
              if (!owner || internals.closed) return Promise.resolve();
              // A contract call the node was seen not to know is handed to it again (the same
              // signed bytes), so a lost broadcast cannot hold the main account for good.
              return owner
                .reobservePending(() =>
                  runWalletExclusive(wallet, (admission) =>
                    owner.applyRecordedEvidence(admission)
                  )
                )
                .then(() => owner.resendMissingContractCalls())
                .then(() => transactionOwner.runLifetime(() => transactionSetSubmission.reconcileAuthorized()))
                .then(() => internals.recoverStampFunding?.())
                // What those looks showed frees the main account for whoever waits for it.
                .then(() => releaseSettledMainAccounts(wallet, false))
                .catch((error) => {
                  if (isChainUnreachableError(error)) {
                    throw error instanceof ChainUnreachableError
                      ? error
                      : new ChainUnreachableError(error);
                  }
                  throw error;
                });
            },
            async watchNativeOperation(operationId) {
              requireOpenWallet(wallet);
              const original = await transactionOwner.runLifetime(() => transactionOwner.nativeJournal!.readOperation(operationId));
              if (!original) throw new Error("Unknown native operation");
              if (!transactionOwner.nativeJournal!.list().some(row => row.operationId === operationId)) return;
              const owner = nativeOperationOwner(wallet);
              const watcher = evmWalletInternals(wallet).blockWatcher;
              // The wallet's one block watcher paces the looks; a wallet without one waits a
              // second. A watcher that was stopped means the wallet is closing.
              if (watcher) await watcher.next().catch(() => undefined);
              else await new Promise((resolve) => setTimeout(resolve, 1_000));
              requireOpenWallet(wallet);
              if (!transactionOwner.nativeJournal!.list().some(row => row.operationId === operationId)) return;
              await owner.lookAtOperation(operationId);
              invalidateBalanceRead();
              // What the look showed frees the main account for whoever waits for it.
              await releaseSettledMainAccounts(wallet, false);
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
                    !coinAndContactManager.heldForItsMessage(r.operationId) &&
                    r.members.some(
                      (m) =>
                        m.signed &&
                        m.observation.state !== "included-success" &&
                        // Its nonce went to another transaction: failed for good, nothing
                        // left to resolve or retry.
                        !nativeMemberSuperseded(m)
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
                    !coinAndContactManager.heldForItsMessage(r.operationId) &&
                    r.members.some(
                      (m) =>
                        m.signed &&
                        m.observation.state !== "included-success" &&
                        // Its nonce went to another transaction: failed for good, nothing
                        // left to resolve or retry.
                        !nativeMemberSuperseded(m)
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
              requirePeerSyncDelivery();
              params = { ...params, recipient: { ...params.recipient } };
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(
                  wallet,
                  () => owner.sendNative(params, admission),
                  { waitMs: params.mainAccountWaitMs, unreservedRootsOnly: true }
                )
              );
              invalidateBalanceRead();
              if (!evmWalletInternals(wallet).closed) {
                {
                  const noteOf = 
                  owner
                    .listOperations()
                    .find(
                      (row) =>
                        row.members[row.members.length - 1]?.signed
                          ?.transactionHash === result.txHash
                    )!.operationId
                ;
                  retryEarlierNotes(owner, noteOf, await owner.startSync(noteOf));
                }
              }
              return result;
            },
            async sendLegacy(params) {
              requirePeerSyncDelivery();
              const owner = nativeOperationOwner(wallet);
              try {
                const result = await transactionOwner.runLifetime(() => legacyTransactions.sendLegacy({ ...params, recipient: { ...params.recipient } }));
                if (!evmWalletInternals(wallet).closed) {
                  const operation = transactionOwner.nativeJournal!.list().find(row => row.members.some(member => member.signed?.transactionHash === result.txHash));
                  if (operation) retryEarlierNotes(owner, operation.operationId, await owner.startSync(operation.operationId));
                }
                return result;
              } finally { invalidateBalanceRead(); }
            },
            async ensureLegacySubAccount(ref) {
              return transactionOwner.runLifetime(async () => {
              requireOpenWallet(wallet);
              const persona = deriveDappPersona(keyring.masterNode, ref);
              const address = persona.address.toLowerCase();
              const latest = coinList.latestOf(address);
              if (!latest || latest.state === 'spent') {
                const [nonce, balance] = await Promise.all([
                  provider.getTransactionCount(address, 'latest'),
                  provider.getBalance(address, 'latest'),
                ]);
                const current = coinList.latestOf(address);
                if (!current || (current.state === 'spent' && nonce > current.nonce)) {
                  await coinList.put({
                    account: address,
                    nonce,
                    privateKey: persona.node.privateKey,
                    valueWei: balance,
                    origin: 'legacy-subaccount',
                  });
                }
              } else if (latest.origin !== 'legacy-subaccount') {
                throw new Error('Persona address belongs to another wallet coin origin');
              }
              return { raw: persona.address };
              });
            },
            async reconcileLegacySubAccountAttempt(params) {
              requireOpenWallet(wallet);
              const owned = deriveDappPersona(keyring.masterNode, params.source).address.toLowerCase();
              if (getAddress(params.account).toLowerCase() !== owned)
                throw new Error('Legacy dApp attempt does not belong to this wallet');
              const tx = Transaction.from(params.signedTransaction);
              if (!tx.signature || !tx.hash ||
                  tx.from?.toLowerCase() !== owned ||
                  tx.chainId !== BigInt(config.chainId) ||
                  tx.nonce !== params.nonce ||
                  tx.hash.toLowerCase() !== params.transactionHash.toLowerCase())
                throw new Error('Legacy dApp attempt has invalid signed bytes');
              await wallet.ensureLegacySubAccount!(params.source);
              let receipt = await provider.getTransactionReceipt(tx.hash);
              if (!receipt) {
                const known = await provider.getTransaction(tx.hash);
                if (!known) {
                  try {
                    const sent = await provider.broadcastTransaction(params.signedTransaction);
                    if (sent.hash.toLowerCase() !== tx.hash.toLowerCase())
                      throw new Error('Legacy dApp broadcast returned a different hash');
                  } catch (error) {
                    receipt = await provider.getTransactionReceipt(tx.hash);
                    const observed = receipt ?? await provider.getTransaction(tx.hash);
                    if (!observed) throw error;
                  }
                }
              }
              transactionSetRuntime.coinListSync.markDirty(owned);
              await transactionSetRuntime.coinListSync.refreshAccounts([owned]);
              invalidateBalanceRead();
              return { status: receipt ? 'included' : 'pending', transactionHash: tx.hash };
            },
            async sendLegacyFromSubAccount(params) {
              requirePeerSyncDelivery();
              if (getAddress(params.expectedSourceAddress).toLowerCase() !==
                  deriveDappPersona(keyring.masterNode, params.source).address.toLowerCase())
                throw new Error('Approved subaccount does not belong to this wallet');
              const source = await wallet.ensureLegacySubAccount!(params.source);
              const prior = await transactionSetPreparer.readOperation(params.operationId);
              if (!prior) {
                transactionSetRuntime.coinListSync.markDirty(source.raw);
                await transactionSetRuntime.coinListSync.refreshAccounts([source.raw]);
                await transactionSetRuntime.refresh();
              }
              const gasLimit = params.gasLimit ??
                (prior ? Transaction.from(prior.members[0]!.unsignedTransaction).gasLimit :
                  ((await provider.estimateGas({
                    from: source.raw,
                    to: params.recipient.raw,
                    value: params.value,
                    data: params.data ?? '0x',
                  })) * 115n / 100n));
              const prepared = await transactionOwner.runLifetime(() =>
                transactionSetPreparer.constructLegacySubAccountTransaction({
                  operationId: params.operationId,
                  sourceAddress: source.raw,
                  destination: params.recipient.raw,
                  valueWei: params.value,
                  ...(params.data === undefined ? {} : { calldata: params.data }),
                  ...(params.nonce === undefined ? {} : { nonce: params.nonce }),
                  gasLimit,
                  ...(params.type === undefined ? {} : { type: params.type }),
                  ...(params.gasPriceWei === undefined ? {} : { gasPriceWei: params.gasPriceWei }),
                  ...(params.maxFeePerGasWei === undefined ? {} : { maxFeePerGasWei: params.maxFeePerGasWei }),
                  ...(params.maxPriorityFeePerGasWei === undefined ? {} : { maxPriorityFeePerGasWei: params.maxPriorityFeePerGasWei }),
                  ...(params.maxFeeWei === undefined ? {} : { maxFeeWei: params.maxFeeWei }),
                })
              );
              await transactionSetSubmission.sendTransaction(prepared);
              invalidateBalanceRead();
              const row = await transactionSetPreparer.readOperation(params.operationId);
              if (!row) throw new Error('Missing durable subaccount operation');
              return { operationId: row.operationId, txHash: prepared.bundle[0]!.txHash };
            },
            // Contract calls (a swap and its approvals). Same queues, journal and recovery as a
            // native send; see `EvmLegacyConsolidator.sendContractCall`.
            async sendContractCall(params) {
              params = { ...params, to: { ...params.to } };
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(
                  wallet,
                  () => owner.sendContractCall(params, admission),
                  { waitMs: params.mainAccountWaitMs }
                )
              );
              invalidateBalanceRead();
              return result;
            },
            runOwnTransfer: (sign, options) =>
              runUnjournalledTransfer(wallet, sign, options?.mainAccountWaitMs),
            getContractCallFunds: () =>
              nativeOperationOwner(wallet).contractCallFunds(),
            getUnresolvedContractCalls: () =>
              nativeOperationOwner(wallet).unresolvedContractCalls(),
            evmReader: provider,
            async fundMainAccount(params) {
              const owner = nativeOperationOwner(wallet);
              const result = await runWalletExclusive(wallet, (admission) =>
                runMainAccountExclusive(
                  wallet,
                  () => owner.fundMainAccount({ ...params }, admission),
                  { waitMs: params.mainAccountWaitMs }
                )
              );
              invalidateBalanceRead();
              // The move is an ordinary legacy send to one of this wallet's own accounts: it
              // notes itself to the account's other devices exactly as `sendLegacy` does.
              if (!evmWalletInternals(wallet).closed) {
                const operation = owner
                  .listOperations()
                  .find(
                    (row) =>
                      row.members[row.members.length - 1]?.signed
                        ?.transactionHash === result.txHash
                  );
                if (operation)
                  retryEarlierNotes(
                    owner,
                    operation.operationId,
                    await owner.startSync(operation.operationId)
                  );
              }
              return result;
            },
            estimateLegacyFee: params => transactionOwner.runLifetime(() => legacyTransactions.estimateLegacyFee(params)),
            getUnresolvedLegacySend: () => [...new Map([
              ...nativeOperationOwner(wallet).getUnresolvedLegacySend(), ...legacyTransactions.getUnresolvedLegacySend(),
            ].map(row => [row.operationId, row])).values()],
            async resumeLegacySend(operationId) {
              const owner = nativeOperationOwner(wallet);
              try {
                const shared = await transactionOwner.runLifetime(() => legacyTransactions.isSharedLegacyOperation(operationId));
                const result = shared
                  ? await transactionOwner.runLifetime(() => legacyTransactions.resumeLegacySend(operationId))
                  : await runWalletExclusive(wallet, admission => runMainAccountExclusive(wallet, () => owner.resumeLegacySend(operationId, admission)));
                if (!evmWalletInternals(wallet).closed && transactionOwner.nativeJournal!.list().some(row => row.operationId === operationId))
                  retryEarlierNotes(owner, operationId, await owner.startSync(operationId));
                return result;
              } finally { invalidateBalanceRead(); }
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
              const internals = evmWalletInternals(wallet);
              internals.closed = true;
              // Every wait on the chain ends now: nothing a waiter had was signed.
              internals.blockWatcher?.stop();
              closing = (async () => {
                await transactionSetRuntime.stop();
                // A re-observation pass in flight holds the wallet lifetime: end it first, or a
                // node that never answers would hold the close.
                await internals.nativeOperationOwner?.stopReobservation();
                await internals.sendQueue;
                await internals.nativeOperationOwner?.drain();
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
                  internals.canonicalClientFactory = undefined;
                  internals.canonicalUnavailable = undefined;
                  internals.canonicalMessaging = undefined;
                  internals.recoverStampFunding = undefined;
                  internals.canonicalStampQuoter = undefined;
                  internals.canonicalDirectory = undefined;
                  internals.installedCanonicalDescriptor = undefined;
                  internals.privateTopicWallet = undefined;
                  internals.material = undefined;
                  internals.nativeOperationOwner = undefined;
                }
              })();
              return closing;
            },
          });
          evmWalletInternals(wallet).coinList = coinList;
          evmWalletInternals(wallet).transactionSetPreparer = transactionSetPreparer;
          evmWalletInternals(wallet).transactionSetLifecycle = transactionSetLifecycle;
          // Construction reservations hold before signing yields; durable journal references
          // retain those holds after persistence and across restart.
          pool.attachSpendReservation((index) => {
            const account = pool.getRecord(index)?.address;
            return (account !== undefined && coinList.isAccountReserved(account)) ||
              topicOwner!.nativeJournal!.referencesSpendIndex(index);
          });
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
          evmWalletInternals(wallet).nativeOperationOwner =
            new EvmLegacyConsolidator({
              provider,
              journal: topicOwner.nativeJournal!,
              inputAdmission: topicOwner.inputAdmission,
              runLifetime: (operation) => topicOwner!.runLifetime(operation),
              // A transfer just broadcast is watched for its block on the wallet's one watcher.
              nextLook: () =>
                evmWalletInternals(wallet).blockWatcher?.next() ??
                new Promise((resolve) => setTimeout(resolve, 500)),
              inclusionWaitMs: config.nativeInclusionWaitMs,
              // The node admits a transaction against the balance of spacing + 1 blocks ago.
              fundsSettleBlocks:
                config.spendSpacingBlocks === undefined
                  ? undefined
                  : config.spendSpacingBlocks + 1,
              transactionBuilder,
              getSources,
              sourceHeld: (source) =>
                spendPool.sourceHeld(source, mainAccountHolder(wallet)),
              claimSources: (sources) =>
                spendPool.claimSources(sources, mainAccountHolder(wallet)),
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
              onSyncCheckpoint: archiveCompletedFinancialOperations,
              onSyncTransaction: async (item, swapRecord) => {
                const messageId = getBytes(
                  keccak256(
                    toUtf8Bytes(
                      `frank-wallet-sync:${item.chainIdentifier}:${item.txHash}`
                    )
                  )
                ).slice(0, 16);
                if (config.emitWalletSync) {
                  await config.emitWalletSync(item, swapRecord, messageId);
                  return;
                }
                await directMessages.send({
                  wallet,
                  recipient: toChainAddress(identity.address.raw),
                  // A swap's record rides in the same note as its transaction: one free
                  // message, the same identity, sent and retried the same way.
                  items: swapRecord ? [item, swapRecord] : [item],
                  stampValue: 0n,
                  messageId,
                });
              },
            });
          const walletInternals = evmWalletInternals(wallet);
          await coinAndContactManager.installStealthAndContactOwners();
          // Wallet open, native operations. Local only: nothing in this block may make a network
          // request, ask for a signature or fail the open, and each step stands alone.
          // A plan that never signed (a crash or failure between the journal write and the first
          // signature) is cancelled here. That ends its reservation of its pool accounts and its
          // freeze of its source address; the journal row is retained, cancelled.
          await topicOwner
            .runLifetime((lifetime) =>
              walletInternals.nativeOperationOwner!.cancelUnsignedOperations(lifetime)
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
                hasUncorrelatedCanonicalPreSignIntent(
                  topicOwner!.canonicalRetained,
                  pool
                )
              )
                return;
              await walletInternals.nativeOperationOwner!.applyRecordedEvidence(lifetime);
            })
            .catch(() => undefined);
          // A native send, contract call or consolidation that was handed to the network and
          // that the chain has not answered for holds its main or identity account again, in
          // the same claim a paid message takes, before the wallet is handed out. No request.
          for (const address of new Set([
            material.mainAccount.address.toLowerCase(),
            identity.address.raw.toLowerCase(),
          ]))
            // Shared graphs restore their own nonce reservations. Giving an unexposed contact
            // graph a second legacy claim would outlive its cancellation and block later sends.
            // Genuine legacy operations still retain their claim independently of shared state.
            if (
              (sourceIsHeld(wallet, address) &&
                !transactionSetPreparer.isSourceReserved(address)) ||
              walletInternals.nativeOperationOwner!.holdsSource(address)
            )
              try {
                pool.restoreAccountClaim(mainAccountHolder(wallet), address);
              } catch (error) {
                // A stored message names the same account: it keeps the claim, both are kept,
                // and the chain decides both.
                console.warn(
                  `[monad-chain] ${address} is spent by an unsettled native operation and by an unsettled message payment; the chain decides both:`,
                  error
                );
              }
          topicOwnerWallet = wallet;
          walletInternals.privateTopicWallet = {
            ...wallet,
            walletState: topicOwner,
            topicOperationJournal: topicOwner.topicOperationJournal,
          };
          Object.defineProperty(wallet, "topicOperations", {
            value: createEvmTopicOperations(walletInternals.privateTopicWallet),
            enumerable: true,
          });
          if (topicOwner.canonicalUnavailable !== undefined)
            walletInternals.canonicalUnavailable = topicOwner.canonicalUnavailable;
          else if (
            material.canonicalRoles !== undefined &&
            (config.networkTag === "MONT" ||
              config.networkTag === "MON1" ||
              config.networkTag === "MONR")
          )
            walletInternals.installedCanonicalDescriptor = {
              networkTag: config.networkTag,
              network: forumPolicy.network,
              chainId: BigInt(config.chainId),
            };
          if (
            material.canonicalRoles !== undefined &&
            topicOwner.canonicalJournal !== undefined &&
            (config.networkTag === "MONT" ||
              config.networkTag === "MON1" ||
              config.networkTag === "MONR")
          ) {
            const canonicalRoles = material.canonicalRoles;
            const installedNetworkTag = config.networkTag;
            const stampPayer = installEvmStampCoordinator({
              wallet,
              topicOwner,
              canonicalRoles,
              installedNetworkTag,
              networkId: config.networkId,
              mainAccount,
              pool,
              provider,
              httpClient,
              coinList,
              coinListSync: transactionSetRuntime.coinListSync,
              blockWatcher: transactionSetRuntime.blockWatcher,
              spendSpacingBlocks: config.spendSpacingBlocks,
              reserveBalanceWei: config.reserveBalanceWei,
              sourceIsHeld,
              sourceHeldRefusalMessage: SOURCE_HELD_FOR_CONTACT_PAYMENT,
              requireOpenWallet,
              runWalletExclusive,
            });
            // State of the earlier send code is never silently ignored: named once, with how
            // to reset it. Nothing is migrated or deleted.
            let messages: OutgoingMessageStore;
            if (storageLocation !== undefined) {
              const [oldLinkResult, outgoingResult] = await Promise.allSettled([
                noticeOldLinkState(storageLocation),
                LevelOutgoingMessageStore.open(storageLocation),
              ]);
              if (outgoingResult.status === "fulfilled") {
                canonicalLinks = outgoingResult.value;
              }
              if (oldLinkResult.status === "rejected")
                throw oldLinkResult.reason;
              if (outgoingResult.status === "rejected")
                throw outgoingResult.reason;
              messages = outgoingResult.value;
            } else {
              messages = new MemoryOutgoingMessageStore();
            }
            canonicalLinks = messages;
            const messagingOwner: CanonicalMessagingOwner = {
              installedNetworkTag,
              chainId: BigInt(config.chainId),
              relayBaseUrl: config.relayBaseUrl,
              identityAddress: identity.address.raw,
              subject: bareHex(identity.compressedPubKey),
              roles: canonicalRoles,
              messages,
              payer: () => {
                requireOpenWallet(wallet);
                return stampPayer;
              },
              transactionSets: {
                preparer: transactionSetPreparer,
                lifecycle: transactionSetLifecycle,
                provider,
                refresh: () => transactionSetRuntime.refresh(),
                sendTransaction: prepared => transactionSetSubmission.sendTransaction(prepared),
                resolvePaymentOperation: async (id, amount) => {
                  const resolve = walletInternals.resolveMessagePayment;
                  if (!resolve) throw new Error("Combined payment and stamp capability is unavailable");
                  return resolve(id, amount);
                },
              },
              lifetime: (operation) => topicOwner!.runLifetime(() => operation()),
              settleOtherHolder: (holder) =>
                holder === mainAccountHolder(wallet)
                  ? releaseSettledMainAccounts(wallet, true)
                  : Promise.resolve(),
              signDigest: (digest) =>
                new Uint8Array(identity.signHash(Buffer.from(digest))),
              directory: () => walletInternals.canonicalDirectory,
              messageItems: () => installedMessageItemRegistry(wallet),
            };
            // Before the wallet is handed out: every stored message with a payment the chain
            // has not answered for holds its accounts again. No request is made.
            await restoreOutgoingClaims(messagingOwner);
            walletInternals.canonicalMessaging =
              canonicalDirectMessages(messagingOwner, async (minimumStamp) => {
                const context = { chainIdentifier: contractChainIdentifier(), minimumStamp };
                if (minimumStamp === undefined) return { status: "unavailable" as const, chainIdentifier: context.chainIdentifier, reason: "missing-fee" as const };
                return config.resolveDefaultStamp?.(context) ?? {
                  status: "unavailable" as const,
                  chainIdentifier: context.chainIdentifier,
                  reason: "missing-rate" as const,
                };
              });
          }
          walletInternals.material = material;
          walletInternals.mainAccountAdmission = admission;
          walletInternals.fundingCandidates = () =>
            spendPool.fundingCandidates();
          if (material.canonicalRoles !== undefined)
            walletInternals.typed = true;
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
      return (
        config.contracts?.stateChannel ??
        requireChainContract(contractChainIdentifier(), "stateChannel")
      );
    },

    getHtlcAddress(): string {
      return (
        config.contracts?.htlc ??
        requireChainContract(contractChainIdentifier(), "htlc")
      );
    },
  };
}
