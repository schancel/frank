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
 * ## `topics`: wiring the topic-post/vote/tally clients
 *
 * `post`/`vote` build a fresh `MonadTopicPostClient`/`MonadTopicVoteClient` per call from the
 * wallet's `MonadWalletHandle` bundle (same one-per-call pattern `directMessages` uses -- these
 * clients are cheap to construct and hold no state beyond the bundle itself, so there's no need to
 * cache one per wallet). `fetchByTopic` reads via the wallet's own `relayBaseUrl`; `fetchOne` reads
 * via this chain's own config `relayBaseUrl`, since -- per issue #41's own interface sketch --
 * `fetchOne` takes no `wallet` param at all (reading someone else's public topic post never needed
 * a sender identity to begin with). `viewToForumMessage` adapts `MonadTopicPostViewProto` into the
 * pre-existing `ForumMessage` shape (`../types/forum.ts`), mirroring `../registry/index.ts`'s
 * `parseWrapper` field-for-field (see that function for the Lotus-side precedent this deliberately
 * matches): `poster` <- the burn tx's EIP-55-checksummed sender address (decoded from
 * `senderAddress`'s raw 20 bytes -- `ecrecover`'d server-side, never self-asserted); `satoshis` <-
 * the relay's already-tallied `voteWeight` (wei, despite the pre-existing field's stale
 * UTXO-flavored name -- `PLAN.md`'s own M9 notes flag this exact field as needing a real
 * Monad-side rename, an explicit decision left to #42/#43, not silently made here; this ticket just
 * needs a real number in that slot to produce a working `ForumMessage`, and `voteWeight` already
 * decodes as a plain `number`, not `bigint`, so no precision loss is introduced by reusing it
 * as-is).
 */
import {
  JsonRpcProvider,
  Transaction,
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
  TopicBroadcastClient,
  TopicPostOutcomeUnknownError,
  NativeWalletHandle,
  WalletHandle,
} from "./active-chain";
import { MessageItem } from "@frank/cashweb/types/messages";
import { ForumMessage, ForumMessageEntry } from "@frank/cashweb/types/forum";
// See cashweb/wallet/monad-topic-post-client.ts's identical comment (ticket #51, Vite migration).
import __pb_broadcast_pb from "@frank/cashweb/registry/broadcast_pb";
const { BroadcastMessage, ForumPost: BroadcastForumPostPayload } =
  __pb_broadcast_pb;

import { createMonadWalletMaterial } from "../monad-wallet-material";
import type {
  MonadRootBundle,
  MonadWalletMaterial,
} from "../monad-wallet-material";
import type { HDSeed } from "./active-chain";
import { MonadChangePool } from "../monad-change-pool";
import { MonadSubAccountPool } from "../monad-account-pool";
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
import { MonadAccountTxSigner } from "../monad-account-tx";
import { MonadWalletHandle } from "../monad-wallet-handle";
import {
  MonadIdentity,
  fetchMonadProfile,
  mailboxAuthFor,
} from "../monad-identity";
import {
  MonadStampClient,
  quoteMonadStampPaymentGasReserve,
  recoverMonadStampPayments,
  sweepRecoveredMonadStampPayment,
} from "../monad-stamp-client";
import { deriveMonadStampChildPrivate } from "../monad-stamp-stealth";
import { fetchMonadMessagesSince } from "@frank/cashweb/relay/monad-message-feed";
import {
  MailboxAuthParams,
  ackMonadMailboxRecovery,
  fetchMonadMailboxRecoveries,
} from "@frank/cashweb/relay/monad-mailbox-client";
import {
  buildEnvelope,
  decryptEnvelope,
  parseEnvelope,
} from "@frank/cashweb/relay/monad-message-envelope";
import {
  MonadTopicPostClient,
  MonadTopicPostAbandonedError,
  MonadTopicPostViewProto,
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

/** Reads `MonadChainConfig` from the environment (see `readEnv` just above for exactly where
 * from, and why two places), with permissive fallbacks -- see this file's header,
 * "Configuration", for why this (unlike the wallet client modules it configures) reads env
 * directly, and why it never throws on a missing var. */
export function loadMonadChainConfigFromEnv(): MonadChainConfig {
  const rpcChain = readEnv("MONAD_RPC_CHAIN") ?? "monad-testnet";
  const protocolIdentity = monadProtocolIdentity(rpcChain);
  const rawChainId = readEnv("MONAD_CHAIN_ID");
  const fakeDemoEnabled = readEnv("FRANK_FAKE_DEMO") === "true";
  let chainId: bigint | undefined;
  if (rawChainId) {
    try {
      chainId = BigInt(rawChainId);
    } catch {
      // ignore invalid env var and fallback
    }
  }

  return {
    networkId: readEnv("MONAD_NETWORK_ID") ?? rpcChain,
    rpcChain,
    // Known protocol rows are atomic: public overrides must not create a
    // mainnet route with a testnet chain ID (or the inverse).
    chainId:
      fakeDemoEnabled && rawChainId !== undefined
        ? chainId ?? -1n
        : protocolIdentity?.chainId ?? chainId ?? DEFAULT_MONAD_CHAIN_ID,
    relayBaseUrl:
      readEnv("MONAD_RELAY_BASE_URL") ??
      readEnv("E2E_DEMO_RELAY_URL") ??
      "http://127.0.0.1:8098",
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
  readonly chainKind: "monad";
  readonly networkId: string;
  readonly identity: MonadIdentity;
  close(): Promise<void>;
}

const closedWallets = new WeakSet<MonadChainWalletHandle>();
const typedWallets = new WeakSet<MonadChainWalletHandle>();
const walletMaterial = new WeakMap<
  MonadChainWalletHandle,
  MonadWalletMaterial
>();
// Facades may receive a handle created by another factory on the same configured network.
// Its key ownership and send queue travel with that handle, not with the receiving facade.
const walletSendQueues = new WeakMap<MonadChainWalletHandle, Promise<void>>();
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
      "Typed Monad messaging is unavailable until the messaging child schedule is allocated (#696)"
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
    (candidate.chainKind !== undefined && candidate.chainKind !== "monad") ||
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

/** Recovery obligations change rarely, but each read spends one of the relay's per-recipient
 * authenticated-request slots (a challenge is consumed per signed read). Polling inbox + recovery
 * every few seconds exhausts that budget, so recovery is synced at most this often per wallet. */
export const MAILBOX_RECOVERY_SYNC_INTERVAL_MS = 60_000;
const lastRecoverySync = new WeakMap<object, number>();

async function syncMailboxRecoveries(
  wallet: MonadChainWalletHandle,
  mailbox: MailboxAuthParams
): Promise<void> {
  const journal = wallet.stampPaymentJournal;
  if (journal === undefined) return;
  const now = Date.now();
  const last = lastRecoverySync.get(wallet);
  if (last !== undefined && now - last < MAILBOX_RECOVERY_SYNC_INTERVAL_MS)
    return;
  // Stamp the attempt (not just success): a failing relay must not be re-asked every poll.
  lastRecoverySync.set(wallet, now);
  let records;
  try {
    records = (await fetchMonadMailboxRecoveries(mailbox)).records;
  } catch {
    return;
  }
  const recipientPrivateKey = getBytes(wallet.identity.toPrivateKeyHex());
  for (const record of records) {
    try {
      const terminal = record.lifecycle.startsWith("terminal:");
      const confirmed = new Set(record.confirmedChildren);
      const wanted = record.canonicalMessage.stampPayments.filter(
        (payment) => terminal || confirmed.has(payment.childIndex)
      );
      for (const payment of wanted) {
        // One child at a time: an unrecoverable unconfirmed child must not block the confirmed
        // ones, while an unrecoverable confirmed child is caught by the check below.
        let recovered;
        try {
          recovered = recoverMonadStampPayments({
            message: {
              ...record.canonicalMessage,
              stampPayments: [payment],
            },
            recipientPrivateKey,
          });
        } catch {
          continue;
        }
        for (const child of recovered) {
          if (journal.get(record.payloadHashHex, child.childIndex)) continue;
          await journal.put({
            payloadHashHex: record.payloadHashHex,
            childIndex: child.childIndex,
            txHash: child.txHash,
            address: child.address,
            valueWei: child.valueWei.toString(),
            status: "discovered",
          });
        }
      }
      const confirmedJournalled = record.confirmedChildren.every(
        (index) => journal.get(record.payloadHashHex, index) !== undefined
      );
      if (terminal && journal.durable && confirmedJournalled) {
        await ackMonadMailboxRecovery({
          ...mailbox,
          payloadHashHex: record.payloadHashHex,
          obligationIdHex: record.obligationIdHex,
        });
      }
    } catch {
      // Leave the obligation unacknowledged; the next poll retries it.
    }
  }
}

/** JSON-serializes `items` for use as a direct message's plaintext -- only the item kinds that
 * have a real Monad-side meaning (see this file's header). Throws on `'stealth'`/`'p2pkh'` items,
 * which have no Monad equivalent to build (no UTXO coin selection exists on this chain -- see
 * `PLAN.md`'s M9 notes). */
export function serializeMessageItems(items: MessageItem[]): string {
  for (const item of items) {
    if (item.type === "stealth" || item.type === "p2pkh") {
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

/** Adapts a `MonadTopicPostViewProto` (`../wallet/monad-topic-tally-client.ts`) into the
 * pre-existing `ForumMessage` shape (`../types/forum.ts`) -- mirrors `../registry/index.ts`'s
 * `parseWrapper` field-for-field; see this file's header for the per-field reasoning. Returns
 * `undefined` if `view` doesn't carry a stored post (shouldn't happen for a view actually returned
 * by the relay, but keeps this function total). */
export function viewToForumMessage(
  view: MonadTopicPostViewProto
): ForumMessage | undefined {
  const stored = view.post;
  const post = stored?.post;
  if (stored === undefined || post === undefined) return undefined;

  const entries: ForumMessageEntry[] = [];
  const broadcastMessage = BroadcastMessage.deserializeBinary(
    post.encryptedPayload
  );
  for (const entry of broadcastMessage.getEntriesList()) {
    const kind = entry.getKind();
    const payload = entry.getPayload();
    if (typeof payload === "string") continue;
    if (kind === "post") {
      const forumPost = BroadcastForumPostPayload.deserializeBinary(payload);
      entries.push({
        kind: "post",
        title: forumPost.getTitle(),
        url: forumPost.getUrl(),
        message: forumPost.getMessage(),
      });
    }
  }

  const senderAddress =
    stored.senderAddress.length === 20
      ? getAddress(hexlify(stored.senderAddress))
      : hexlify(stored.senderAddress);

  return {
    poster: senderAddress,
    topic: post.topic,
    satoshis: view.voteWeight,
    entries,
    payloadDigest: bareHex(post.payloadHash),
    parentDigest:
      post.parentPostHash.length > 0 ? bareHex(post.parentPostHash) : undefined,
    timestamp: new Date(stored.timestamp),
  };
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
export function createMonadChain(config: MonadChainConfig): ActiveChain {
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
    task: () => Promise<T>
  ): Promise<T> => {
    requireOpenWallet(wallet);
    const run = (walletSendQueues.get(wallet) ?? Promise.resolve()).then(task);
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
          chainKind: "monad",
          networkId: config.chainId.toString(),
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
          burnAddress: config.stampBurnAddress,
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
  const sendDirectMessageExclusive = async (
    params: Parameters<DirectMessageClient["send"]>[0],
    wallet: MonadChainWalletHandle
  ): Promise<DirectMessageSendResult> => {
    const plaintext = serializeMessageItems(params.items);

    const recipientProfile = await fetchMonadProfile({
      relayBaseUrl: wallet.relayBaseUrl,
      address: params.recipient,
    });
    if (recipientProfile === undefined) {
      throw new Error(
        `No registered profile/pubkey found for ${params.recipient.raw}`
      );
    }

    const envelopeBytes = buildEnvelope({
      fromAddress: wallet.identity.address.raw,
      fromPrivateKey: wallet.identity.toNakamotoPrivateKey(),
      toAddress: params.recipient.raw,
      toPubKey: Buffer.from(recipientProfile.pubKey),
      plaintext,
      networkTag: config.networkTag,
    });

    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: mainPrivateKey(wallet),
      provider: wallet.provider,
      httpClient: wallet.httpClient,
    });
    const preparation = await runMainAccountExclusive(wallet, async () => {
      const gasReserveWei = await quoteMonadStampPaymentGasReserve({
        signer: mainAccountSigner,
        recipientPublicKey: recipientProfile.pubKey,
      });
      return wallet.pool.prepareStampInventory({
        mainAccountSigner,
        provider: wallet.provider,
        stampValueWei: params.stampValue ?? config.defaultStampValueWei,
        gasReserveWei,
        onProgress: params.onPreparationProgress,
      });
    });

    const stampClient = new MonadStampClient(wallet);
    const result = await stampClient.submitStampedMessage({
      encryptedPayload: envelopeBytes,
      // Ticket #57: a DM's stamp is a real payment to the recipient (mirroring Lotus's
      // `constructStampTransactions`, which derives the stamp output address from the
      // recipient's own pubkey), not a burn to the fixed dead address -- that's `topics`'
      // `post`/`vote` below, where there's no single recipient to pay.
      recipientPublicKey: recipientProfile.pubKey,
      stampValueWei: params.stampValue ?? config.defaultStampValueWei,
      onAttemptJournaled: params.onAttemptCreated,
    });

    const stampPayments =
      result.stored?.message?.stampPayments.flatMap((payment) => {
        const tx = Transaction.from(hexlify(payment.rawTx));
        return tx.hash === null || tx.to === null
          ? []
          : [
              {
                txHash: tx.hash,
                destinationAddress: tx.to,
                valueWei: tx.value,
              },
            ];
      }) ?? [];
    return {
      payloadDigest: result.payloadHashHex,
      stampValueWei: params.stampValue ?? config.defaultStampValueWei,
      stampPayments,
      preparationTxHashes: preparation.fundingTxHashes,
    };
  };

  const directMessages: DirectMessageClient = {
    async send(params): Promise<DirectMessageSendResult> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      requireLegacyMessaging(wallet);
      return runWalletExclusive(wallet, () =>
        sendDirectMessageExclusive(params, wallet)
      );
    },

    async unattributedAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      requireLegacyMessaging(wallet);
      return runWalletExclusive(wallet, async () => {
        const client = new MonadStampClient(wallet);
        await client.resumePendingAttempts({ maxAttempts: 1 });
        const known = new Set(params.knownDigests);
        return client
          .recordedAttempts()
          .map((attempt) => attempt.payloadHashHex)
          .filter((hash) => !known.has(hash));
      });
    },

    async reconcileAttempts(params) {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      requireLegacyMessaging(wallet);
      return runWalletExclusive(wallet, async () => {
        const client = new MonadStampClient(wallet);
        // Replays every journaled set byte for byte; this never signs or funds anything.
        await client.resumePendingAttempts({
          maxAttempts: params.maxPutAttempts ?? 1,
        });
        return Object.fromEntries(
          params.payloadDigests.map((digest) => [
            digest,
            client.attemptStatus(digest),
          ])
        );
      });
    },

    async fetchSince(params): Promise<DirectMessageReceived[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      requireLegacyMessaging(wallet);
      const mailbox = mailboxAuthFor(wallet.identity, wallet.relayBaseUrl);
      const stored = await fetchMonadMessagesSince({
        ...mailbox,
        sinceMs: params.sinceMs,
        onTruncated: params.onTruncated,
      });
      const myAddress = wallet.identity.address.raw.toLowerCase();
      const received: DirectMessageReceived[] = [];

      for (const record of stored) {
        if (record.message === undefined) continue;
        const envelope = parseEnvelope(record.message.encryptedPayload);
        if (envelope === undefined) continue;
        if (envelope.to.toLowerCase() !== myAddress) continue;

        const payloadHashHex = bareHex(record.message.payloadHash);
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
          // `fetchMonadProfile` returns undefined only for an authoritative HTTP 404: the
          // registry has no account for this sender at all, so no retry can ever translate the
          // row. That is terminal, unlike the transport failures below which throw and grant no
          // cursor authority. Report the row for durable quarantine so a paid envelope from a
          // permanently unregistered sender cannot pin this recipient's bounded mailbox scan;
          // a successfully decoded sibling with the same timestamp still dedupes safely.
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
          // Wrong/stale key, corrupted ciphertext, or authenticated but malformed plaintext: one
          // poison record must not reject the rest of this mailbox page.
          continue;
        }

        const stampValueWei = record.message.stampPayments.reduce(
          (sum, payment) =>
            sum + Transaction.from(hexlify(payment.rawTx)).value,
          BigInt(0)
        );
        const stampPayments = record.message.stampPayments.flatMap(
          (payment) => {
            const tx = Transaction.from(hexlify(payment.rawTx));
            return tx.hash === null || tx.to === null
              ? []
              : [
                  {
                    txHash: tx.hash,
                    destinationAddress: tx.to,
                    valueWei: tx.value,
                  },
                ];
          }
        );

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
      // Recovery is housekeeping: run it only after the messages are ready and never let a slow
      // recovery read/ack delay their delivery (the sync keeps running in the background).
      await boundedSync(syncMailboxRecoveries(wallet, mailbox));
      return received;
    },

    async listRecoveredStampPayments({ wallet }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      return (monadWallet.stampPaymentJournal?.getAll() ?? []).map(
        (record) => ({
          payloadDigest: record.payloadHashHex,
          childIndex: record.childIndex,
          txHash: record.txHash,
          address: toChainAddress(record.address),
          valueWei: BigInt(record.valueWei),
          status: record.status,
          sweepTxHash: record.sweepTxHash,
        })
      );
    },

    async sweepRecoveredStampPayment({
      wallet,
      payloadDigest,
      childIndex,
      destination,
    }) {
      const monadWallet = asMonadWallet(wallet, config.networkId);
      requireLegacyMessaging(monadWallet);
      const journal = monadWallet.stampPaymentJournal;
      if (journal === undefined) {
        throw new Error("Stamp-payment recovery journal is not configured");
      }
      const record = journal.get(payloadDigest, childIndex);
      if (record === undefined) {
        throw new Error(
          `No recovered stamp payment ${payloadDigest}:${childIndex}`
        );
      }
      if (record.status === "swept") {
        throw new Error(
          `Stamp payment ${payloadDigest}:${childIndex} was already swept`
        );
      }
      const child = deriveMonadStampChildPrivate({
        payloadHash: getBytes(`0x${payloadDigest}`),
        recipientPrivateKey: getBytes(monadWallet.identity.toPrivateKeyHex()),
        paymentIndex: childIndex,
      });
      if (child.address.toLowerCase() !== record.address.toLowerCase()) {
        throw new Error(
          `Recovered stamp-payment address ${record.address} does not match derived child ${child.address}`
        );
      }
      const childSigner = new MonadAccountTxSigner({
        privateKey: hexlify(child.privateKey),
        provider: monadWallet.provider,
        httpClient: monadWallet.httpClient,
      });
      if (record.status === "sweep-pending") {
        if (
          record.sweepTxHash === undefined ||
          record.sweepRawTx === undefined ||
          record.sweepValueWei === undefined
        ) {
          throw new Error(
            `Pending stamp-payment sweep ${payloadDigest}:${childIndex} is missing its signed intent`
          );
        }
        const status = await childSigner.getStatus(record.sweepTxHash);
        if (status === "confirmed") {
          await journal.put({
            ...record,
            status: "swept",
            sweepRawTx: undefined,
          });
          return {
            swept: true,
            txHash: record.sweepTxHash,
            valueWei: BigInt(record.sweepValueWei),
          };
        }
        if (status === "pending") {
          await childSigner.submitRaw(record.sweepRawTx, record.sweepTxHash);
          return {
            swept: false,
            reason: "pending",
            txHash: record.sweepTxHash,
          };
        }
        await journal.put({
          ...record,
          status: "discovered",
          sweepTxHash: undefined,
          sweepRawTx: undefined,
          sweepValueWei: undefined,
          sweepDestinationAddress: undefined,
        });
      }
      const outcome = await sweepRecoveredMonadStampPayment({
        payment: {
          childIndex,
          address: child.address,
          privateKey: child.privateKey,
          txHash: record.txHash,
          valueWei: BigInt(record.valueWei),
        },
        destinationAddress: destination.raw,
        provider: monadWallet.provider,
        httpClient: monadWallet.httpClient,
        signer: childSigner,
        onSigned: async (signedTx) => {
          await journal.put({
            ...record,
            status: "sweep-pending",
            sweepTxHash: signedTx.txHash,
            sweepRawTx: signedTx.rawTx,
            sweepValueWei: signedTx.value.toString(),
            sweepDestinationAddress: signedTx.to,
          });
        },
      });
      if (outcome.swept) {
        await journal.put({
          ...record,
          status: "swept",
          sweepTxHash: outcome.txHash,
          sweepRawTx: undefined,
          sweepValueWei: outcome.valueWei.toString(),
          sweepDestinationAddress: outcome.destinationAddress,
        });
        return {
          swept: true,
          txHash: outcome.txHash,
          valueWei: outcome.valueWei,
        };
      }
      return outcome;
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
  };

  const topics: TopicBroadcastClient = {
    async post(params): Promise<{ payloadDigest: string }> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const client = new MonadTopicPostClient(wallet);
      return runWalletExclusive(wallet, async () => {
        const leaseIndex = await prepareTopicBurnAccount(
          wallet,
          params.voteWeightWei,
          params.onPreparationProgress
        );
        const result = await client
          .submitTopicPost({
            topic: params.topic,
            entries: params.entries,
            parentPostHash: params.parentDigest
              ? getBytes(`0x${params.parentDigest}`)
              : undefined,
            direction: params.direction,
            burnAddress: config.stampBurnAddress,
            voteWeightWei: params.voteWeightWei,
            leaseIndex,
          })
          .catch((err: unknown) => {
            if (err instanceof MonadTopicPostAbandonedError) {
              throw new TopicPostOutcomeUnknownError(err.message, err);
            }
            return asNothingSent(err);
          });
        return { payloadDigest: result.payloadHashHex };
      });
    },

    async vote(params): Promise<void> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const client = new MonadTopicVoteClient(wallet);
      await runWalletExclusive(wallet, async () => {
        const leaseIndex = await prepareTopicBurnAccount(
          wallet,
          params.voteWeightWei,
          params.onPreparationProgress
        );
        await client
          .castVote({
            targetPayloadHash: getBytes(`0x${params.payloadDigest}`),
            direction: params.direction,
            burnAddress: config.stampBurnAddress,
            voteWeightWei: params.voteWeightWei,
            leaseIndex,
          })
          .catch(asNothingSent);
      });
    },

    async fetchByTopic(params): Promise<ForumMessage[]> {
      const wallet = asMonadWallet(params.wallet, config.networkId);
      const views = await fetchMonadTopicPostsSince({
        relayBaseUrl: wallet.relayBaseUrl,
        topic: params.topic,
        sinceMs: params.sinceMs,
      });
      const messages: ForumMessage[] = [];
      for (const view of views) {
        const message = viewToForumMessage(view);
        if (message !== undefined) messages.push(message);
      }
      return messages;
    },

    async fetchOne(payloadDigest): Promise<ForumMessage | undefined> {
      const view = await fetchMonadTopicPostView({
        relayBaseUrl: config.relayBaseUrl,
        payloadHashHex: payloadDigest,
      });
      return view ? viewToForumMessage(view) : undefined;
    },

    async discoverTopics() {
      // No wallet needed -- same "read via the chain's own configured relayBaseUrl" shape as
      // `fetchOne` above. `fetchDiscoveredTopics` itself already fails soft (`[]`), so there's
      // nothing further to catch here.
      return fetchDiscoveredTopics({ relayBaseUrl: config.relayBaseUrl });
    },
  };

  return {
    kind: "monad",
    name: "monad",
    unit: "MON",
    capabilities: {
      profiles: true,
      directMessages: true,
      topics: true,
      stealthPayments: true,
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
        let destroyProvider: (() => void) | undefined;
        let destroyHttpClient: (() => void) | undefined;
        try {
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
            chainKind: "monad",
            networkId: config.chainId.toString(),
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

          const pool = new MonadSubAccountPool({
            keyring,
            store: subAccountStore,
          });
          pool.ensureUnfundedSize(config.subAccountPoolSize);
          const pendingLeaseIndices = new Set(
            stampAttemptJournal
              .getAll()
              .flatMap((attempt) => attempt.leaseIndices)
          );
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
          const changePool = new MonadChangePool({
            keyring: changeKeyring,
            store: changeStore,
          });
          const leaseManager = new SubAccountLeaseManager(pool);
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
          const wallet: MonadChainWalletHandle = {
            chainKind: "monad",
            networkId: config.networkId,
            identity,
            async getReceiveAddress() {
              requireOpenWallet(wallet);
              return { raw: mainAccount.address };
            },
            async getBalance() {
              requireOpenWallet(wallet);
              return provider.getBalance(mainAccount.address);
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
                  const signer = new MonadAccountTxSigner({
                    privateKey: mainAccount.privateKey,
                    provider,
                    httpClient,
                  });
                  const signed = await signer.buildAndSignTransfer(
                    recipient.raw,
                    value
                  );
                  return submitNative(signed, onSigned);
                })
              );
            },
            pool,
            leaseManager,
            provider,
            httpClient,
            changePool,
            stampPaymentJournal,
            stampAttemptJournal,
            relayBaseUrl: config.relayBaseUrl,
            cborNetwork:
              config.networkTag === "MON1" ? "monad-mainnet" : "monad-testnet",
            close() {
              if (closing !== undefined) return closing;
              closedWallets.add(wallet);
              closing = (async () => {
                await walletSendQueues.get(wallet);
                try {
                  const results = await closeStores();
                  const failure = results.find(
                    (result) => result.status === "rejected"
                  );
                  if (failure?.status === "rejected") throw failure.reason;
                  walletsByIdentity.delete(identityKey);
                  if (economicOwnerKey !== undefined)
                    openTypedEvmAccounts.delete(economicOwnerKey);
                } finally {
                  provider.destroy();
                  httpClient.destroy();
                  material.dispose();
                  walletMaterial.delete(wallet);
                }
              })();
              return closing;
            },
          };
          let closing: Promise<void> | undefined;
          walletMaterial.set(wallet, material);
          mainAccountAdmissions.set(wallet, admission);
          if (material.messagingRoot !== undefined) typedWallets.add(wallet);
          if (material.messagingRoot === undefined) {
            await new MonadStampClient(wallet).resumePendingAttempts();
          }
          return wallet;
        } catch (error) {
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
  };
}

/** The default, env-configured `MonadChain` singleton -- `./index.ts`'s `activeChain` is exactly
 * this. See this file's header, "Configuration", for why reading env here (rather than in every
 * wallet client) is the right composition point. */
export const MonadChain: ActiveChain = createMonadChain(
  loadMonadChainConfigFromEnv()
);
