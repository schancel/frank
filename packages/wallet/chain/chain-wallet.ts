/** Canonical address value passed across the application/chain boundary. */
export interface ChainAddress {
  readonly raw: string;
}

/** A submitted native-chain transaction, with any prerequisite transactions it depended on. */
export interface ChainTransaction {
  /** The user-facing transaction id for the requested action. */
  readonly txHash: string;
  /** Ordered prerequisite/action ids when one logical action required more than one transaction. */
  readonly relatedTxHashes?: ReadonlyArray<string>;
}

/**
 * Submission reached the network boundary, but the caller cannot safely infer whether the
 * transaction was accepted. `transaction` is derived from the exact signed bytes, so callers can
 * reconcile that id before deciding whether to create a replacement payment.
 */
export class NativeTransactionSubmissionError extends Error {
  readonly transaction: ChainTransaction;
  readonly reason: unknown;

  constructor(params: { transaction: ChainTransaction; reason: unknown }) {
    super(
      `native transaction submission outcome is unknown for ${params.transaction.txHash}`
    );
    this.name = "NativeTransactionSubmissionError";
    this.transaction = params.transaction;
    this.reason = params.reason;
  }
}

/** Durable guard record; signed replay material may remain wallet-specific and in memory. */
export interface NativeTransactionAttemptStore {
  /** Coordination reach of this store. Cross-process stores require a host lock not yet exposed. */
  readonly coordinationScope: "single-realm" | "cross-process";
  get(key: string): ChainTransaction | undefined;
  /** Must not return until the record is durable; throw instead of degrading to volatile state. */
  put(key: string, transaction: ChainTransaction): void;
  delete(key: string): void;
}

/** Isolated store for tests and non-browser hosts that supply their own lifecycle. */
export class InMemoryNativeTransactionAttemptStore
  implements NativeTransactionAttemptStore
{
  readonly coordinationScope = "single-realm" as const;
  private readonly attempts = new Map<string, ChainTransaction>();

  get(key: string): ChainTransaction | undefined {
    return this.attempts.get(key);
  }

  put(key: string, transaction: ChainTransaction): void {
    this.attempts.set(key, transaction);
  }

  delete(key: string): void {
    this.attempts.delete(key);
  }
}

interface NativeAttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): NativeAttemptStorage | undefined {
  const host = globalThis as {
    window?: unknown;
    localStorage?: NativeAttemptStorage;
  };
  if (host.window === undefined) return undefined;
  try {
    return host.localStorage;
  } catch {
    // Privacy settings and sandboxed webviews can make localStorage access throw.
    return undefined;
  }
}

function isBrowserContext(): boolean {
  return (globalThis as { window?: unknown }).window !== undefined;
}

function parseStoredTransaction(
  serialized: string
): ChainTransaction | undefined {
  try {
    const value = JSON.parse(serialized) as Partial<ChainTransaction>;
    if (typeof value.txHash !== "string") return undefined;
    if (
      value.relatedTxHashes !== undefined &&
      (!Array.isArray(value.relatedTxHashes) ||
        value.relatedTxHashes.some((txHash) => typeof txHash !== "string"))
    ) {
      return undefined;
    }
    return {
      txHash: value.txHash,
      ...(value.relatedTxHashes === undefined
        ? {}
        : { relatedTxHashes: value.relatedTxHashes }),
    };
  } catch {
    return undefined;
  }
}

/** Browser-durable store. Non-browser senders must inject a durable host-specific implementation. */
export class DefaultNativeTransactionAttemptStore
  implements NativeTransactionAttemptStore
{
  readonly coordinationScope = "single-realm" as const;
  private readonly prefix = "frank:native-attempt:v1:";

  get(key: string): ChainTransaction | undefined {
    const storage = browserStorage();
    if (storage === undefined) {
      if (isBrowserContext()) {
        throw new Error(
          "Native transaction attempt persistence is unavailable"
        );
      }
      return undefined;
    }
    let serialized: string | null;
    try {
      serialized = storage.getItem(`${this.prefix}${key}`);
    } catch {
      throw new Error("Unable to read persisted native transaction attempts");
    }
    if (serialized === null) return undefined;
    const transaction = parseStoredTransaction(serialized);
    if (transaction === undefined) {
      throw new Error(
        `Invalid persisted native transaction attempt for ${key}`
      );
    }
    return transaction;
  }

  put(key: string, transaction: ChainTransaction): void {
    const storage = browserStorage();
    if (storage === undefined) {
      throw new Error("Native transaction attempt persistence is unavailable");
    }
    try {
      storage.setItem(`${this.prefix}${key}`, JSON.stringify(transaction));
    } catch {
      throw new Error("Unable to persist native transaction attempt");
    }
  }

  delete(key: string): void {
    const storage = browserStorage();
    if (storage === undefined) {
      throw new Error("Native transaction attempt persistence is unavailable");
    }
    try {
      storage.removeItem(`${this.prefix}${key}`);
    } catch {
      throw new Error("Unable to remove persisted native transaction attempt");
    }
  }
}

export const defaultNativeTransactionAttemptStore =
  new DefaultNativeTransactionAttemptStore();

export interface FrankIdentityHandle {
  readonly address: ChainAddress;
  readonly displayAddress: string;
}

/**
 * The wallet surface used by chain-neutral UI code. Complex build/sign/retry protocols remain
 * capabilities below this boundary; a simple native transfer is one logical operation here.
 */
export interface NativeWalletHandle {
  /** Runtime discriminator identifying the chain family ("evm" | "bitcoin" | "solana"). */
  readonly family: ChainFamily;
  /** Stable configured chain identifier (e.g. "monad-testnet", "hyperliquid-mainnet", "solana-mainnet", "xec-mainnet"). */
  readonly chainIdentifier: string;
  /** Stable configured network discriminator (for example, mainnet versus testnet). */
  readonly networkId: string;
  readonly identity: FrankIdentityHandle;
  /** Attached chain-agnostic UTXO pool (if configured). */
  readonly chainUtxoPool?: import("../chain-utxo-pool").ChainUtxoPool;
  /** Address to show for a new inbound payment; may rotate independently of wallet identity. */
  getReceiveAddress(): Promise<ChainAddress>;
  getBalance(): Promise<bigint>;
  /** The exact signed attempt whose submission outcome must be resolved before a fresh send. */
  getUnresolvedNativeTransaction?(): ChainTransaction | undefined;
  /** Resubmits the exact unresolved signed bytes; never builds a replacement payment. */
  retryUnresolvedNativeTransaction?(): Promise<ChainTransaction>;
  /** Clears a blocked attempt only after the caller has reconciled its exact id with the chain. */
  resolveUnresolvedNativeTransaction?(params: {
    transaction: ChainTransaction;
    outcome: "submitted" | "not-submitted";
  }): Promise<void>;
  sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    /** Invoked after signing and before broadcast so callers can durably record the exact id. */
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction>;

  /**
   * Sends funds to an external legacy destination address, automatically aggregating
   * fragmented sub-accounts or UTXOs using the chain's appropriate consolidation strategy.
   */
  sendLegacy?(params: {
    recipient: ChainAddress;
    value: bigint;
    onProgress?: (progress: LegacySendProgress) => void;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
    priorityFeeMicroLamports?: bigint;
  }): Promise<LegacySendResult>;

  /** Computes the estimated network fee required to deliver `value` to a legacy destination. */
  estimateLegacyFee?(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<LegacyFeeEstimate>;

  /** Recovers or resumes any in-flight staging intent interrupted by an app/browser crash. */
  getUnresolvedLegacySend?(): unknown;
  resumeLegacySend?(): Promise<LegacySendResult>;
}

export type LegacySendStage =
  | { stage: "planning" }
  | { stage: "selecting-inputs"; count: number }
  | { stage: "consolidating"; completed: number; total: number; stagingTxHashes: string[] }
  | { stage: "draining"; stagingAddress: string; drainTxHash?: string }
  | { stage: "broadcasting"; txHash?: string }
  | { stage: "confirmed"; txHash: string };

export interface LegacySendProgress {
  status: LegacySendStage;
  message?: string;
}

export interface LegacyFeeEstimate {
  /** Total estimated network fees in base units (wei / satoshis / lamports). */
  totalFee: bigint;
  /** Number of fragmented accounts or UTXOs consumed. */
  inputCount: number;
  /** Intermediate consolidation fee (EVM staging only; 0n for UTXO/Solana). */
  consolidationFee?: bigint;
  /** Final delivery fee to destination. */
  deliveryFee: bigint;
}

export interface LegacySendResult {
  /** Final transaction hash that paid the recipient. */
  txHash: string;
  /** Staging transaction hashes if intermediate fan-in occurred (EVM). */
  intermediateTxHashes?: string[];
  totalValueSent: bigint;
  totalFeePaid: bigint;
}

export interface ContactSendProgress {
  stage: "resolving-keys" | "deriving-stealth" | "signing" | "broadcasting" | "confirmed";
  message?: string;
  txHash?: string;
}

export interface ContactSendResult {
  txHash: string;
  stealthAddress: string;
  value: bigint;
}

/** Minimum identity surface accepted by profile, message, and topic capabilities. */
export interface WalletHandle {
  readonly identity: FrankIdentityHandle;
}
export type ChainFamily = "evm" | "bitcoin" | "solana";

/** Stable namespace for safety records shared by multiple configured settlement networks. */
export function nativeTransactionAttemptKey(params: {
  family: ChainFamily;
  chainIdentifier: string;
  address: string;
}): string {
  if (params.chainIdentifier.trim().length === 0) {
    throw new Error("Native transaction chain identifier must not be empty");
  }
  return `${params.family}:${encodeURIComponent(params.chainIdentifier)}:${
    params.address
  }`;
}

const nativeOperationQueues = new Map<string, Promise<void>>();

/**
 * Serializes one wallet's durable-attempt transition across instances. Browser hosts require the
 * Web Locks API so separate tabs cannot overwrite or clear each other's in-flight payment.
 */
export async function runNativeTransactionExclusive<T>(
  key: string,
  coordinationScope: NativeTransactionAttemptStore["coordinationScope"],
  operation: () => Promise<T>
): Promise<T> {
  const host = globalThis as {
    window?: unknown;
    navigator?: {
      locks?: {
        request<T>(name: string, callback: () => Promise<T>): Promise<T>;
      };
    };
  };
  if (coordinationScope !== "single-realm") {
    throw new Error(
      "Cross-process native transaction stores require an external coordinator"
    );
  }
  if (host.window !== undefined) {
    if (host.navigator?.locks === undefined) {
      throw new Error(
        "Cross-context native transaction locking is unavailable"
      );
    }
    return host.navigator.locks.request(
      `frank:native-transaction:${key}`,
      operation
    );
  }

  const previous = nativeOperationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  nativeOperationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (nativeOperationQueues.get(key) === tail) {
      nativeOperationQueues.delete(key);
    }
  }
}

export function sameChainTransaction(
  left: ChainTransaction,
  right: ChainTransaction
): boolean {
  return (
    left.txHash === right.txHash &&
    JSON.stringify(left.relatedTxHashes ?? []) ===
      JSON.stringify(right.relatedTxHashes ?? [])
  );
}
