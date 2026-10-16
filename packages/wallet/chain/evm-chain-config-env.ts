import { readViteEnv } from "./vite-env";
import type { EvmChainConfig } from "./evm-chain-config";
import type { OperatorCheckpoint } from "./evm-rpc-identity";
import { getChainRegistryEntry } from "./chains-registry";
import {
  DEFAULT_MONAD_CHAIN_ID,
  monadProtocolIdentity,
} from "../evm-provider";
import type { MessageItem } from "@frank/cashweb/types/messages";
import type { DirectMessageFundAheadResult } from "./active-chain";
import { BurnNotSentError } from "../evm-account-lease";

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
 * from, and why two places), with permissive fallbacks -- see `evm-chain.ts`'s header,
 * "Configuration", for why this (unlike the wallet client modules it configures) reads env
 * directly. Malformed paired checkpoint values fail visibly; inspection stays offline. */
export function loadMonadChainConfigFromEnv(overrides?: {
  isTestnet?: boolean;
  operatorCheckpoint?: OperatorCheckpoint;
}): EvmChainConfig {
  const rpcChain =
    overrides?.isTestnet !== undefined
      ? overrides.isTestnet
        ? "monad-testnet"
        : "monad-mainnet"
      : readEnv("MONAD_RPC_CHAIN") ?? "monad-testnet";
  const protocolIdentity = monadProtocolIdentity(rpcChain);
  const checkpointHeight = readEnv("EVM_OPERATOR_CHECKPOINT_BLOCK_NUMBER");
  const checkpointHash = readEnv("EVM_OPERATOR_CHECKPOINT_BLOCK_HASH");
  let operatorCheckpoint = overrides?.operatorCheckpoint;
  if (
    operatorCheckpoint === undefined &&
    (checkpointHeight !== undefined || checkpointHash !== undefined)
  ) {
    if (
      !checkpointHeight ||
      !/^[1-9][0-9]*$/.test(checkpointHeight) ||
      !Number.isSafeInteger(Number(checkpointHeight)) ||
      !checkpointHash ||
      !/^0x[0-9a-fA-F]{64}$/.test(checkpointHash)
    )
      throw new Error(
        "Invalid paired EVM operator checkpoint environment values"
      );
    operatorCheckpoint = {
      blockNumber: Number(checkpointHeight),
      blockHash: checkpointHash,
    };
  }
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
    operatorCheckpoint,
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
    stampFundingTargetWei: 10_000_000_000_000_000n,
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

/** How an operation waits for the main or identity account while an earlier payment from it has
 * not been seen on chain. By default it waits its turn, however long that is. */
export interface MainAccountWait {
  /** Give up after this long with {@link MainAccountBusyError}. Default: no limit. */
  waitMs?: number;
  /** Called once when the operation starts to wait. */
  onWaiting?: () => void;
  /** For a spender the native journal does not record (a funding pass, a transfer to a
   * contact): also wait while a transaction the native holder itself signed from the account
   * is undecided. Journal operations leave this off: the journal's own rule refuses a second
   * transaction over an undecided one at once, and a resume is the one driving it. */
  waitForOwn?: boolean;
}

/** A funding pass signs from the main account outside the native journal: it waits for whatever
 * the wallet signed from that account earlier, a native operation's transaction included. */
export const FUNDING_FROM_MAIN: MainAccountWait = { waitForOwn: true };

/** The caller's own deadline passed while the main account was still spent by an earlier payment
 * the chain has not shown. Nothing was signed; the same call can be made again. */
export class MainAccountBusyError extends Error {
  constructor() {
    super(
      "The main account is still spent by an earlier payment the chain has not shown, and the wait given for it ran out. Nothing was signed."
    );
    this.name = "MainAccountBusyError";
  }
}

export const FUND_AHEAD_BACKOFF_MIN_MS = 4_000;
export const FUND_AHEAD_BACKOFF_MAX_MS = 240_000;

export interface FundAheadBackoff {
  result: DirectMessageFundAheadResult;
  delayMs: number;
  startedAtMs: number;
  /** The main-account balance the pass saw, when it read one. */
  mainBalanceWei?: bigint;
}

/** The most pending coins one background pass asks the chain about. */
export const PENDING_COIN_PROBES_PER_PASS = 8;
/** How long the wallet waits before asking the chain a second time whether a received payment's
 * transfer really can never land. */
export const TRANSFER_FAILURE_RECHECK_MS = 2_000;
/** How long `sweepReceivedCoins` waits for its sweep to be included before answering `pending`. */
export const SWEEP_INCLUSION_WAIT_MS = 10_000;
/** Why a funding transfer was refused: its source is held by a payment to a contact. */
export const SOURCE_HELD_FOR_CONTACT_PAYMENT =
  "These funds are held for a payment to a contact whose message is being delivered";

/** Longest `fetchSince` waits for the recovery sync before returning the messages. */
export const MAILBOX_RECOVERY_SYNC_WAIT_MS = 5_000;

export async function boundedSync(sync: Promise<void>): Promise<void> {
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
export const MAX_WAITING_SELF_NOTES = 256;

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
  readonly fundingRecorded: boolean;

  constructor(
    reason: string,
    options?: {
      cause?: unknown;
      stage?: "preparing" | "signing";
      fundingRecorded?: boolean;
    }
  ) {
    const fundingRecorded = options?.fundingRecorded === true;
    super(
      options?.stage === "signing"
        ? `Could not build the burn (${reason}). Nothing was sent, and the funded account is kept. ` +
            "It is safe to try again."
        : fundingRecorded
        ? `Could not prepare an account to burn from (${reason}). Recorded funding contributions are retained on the sub-account for reconciliation, resume, or cancellation. ` +
          "It is safe to try again: a funding transaction that was already sent is reused, not repeated."
        : `Could not prepare an account to burn from (${reason}). Nothing was sent. ` +
          "It is safe to try again: a funding transaction that was already sent is reused, not repeated."
    );
    this.name = "TopicBurnPreparationError";
    this.fundingRecorded = fundingRecorded;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** A burn that failed while being built/signed (RPC hiccup after the account was funded) sent
 * nothing and left the funded account available: report it with the same "nothing sent, safe to
 * retry" message as a failed preparation. Every other error passes through untouched. */
export function asNothingSent(err: unknown): never {
  if (err instanceof BurnNotSentError) {
    throw new TopicBurnPreparationError(err.message, {
      cause: err,
      stage: "signing",
    });
  }
  throw err;
}

export { loadMonadChainConfigFromEnv as loadEvmChainConfigFromEnv };
