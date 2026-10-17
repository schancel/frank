import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as bip39 from "bip39";
import { getBase58Decoder } from "@solana/codecs-strings";

import { HDSeed, NativeAssetChain, ChainAddress } from "./active-chain";
import { formatBaseUnit, parseBaseUnit } from "./base-unit";
import { NativeTransactionAttemptStore } from "./chain-wallet";
import { SolanaWallet, SolanaWalletConnection } from "../solana-wallet";
import { SolanaStealthSendRefusedError } from "../solana-stealth";
import type { ChainUtxoPool } from "../chain-utxo-pool";
import { getChainRegistryEntry } from "./chains-registry";

export const DEFAULT_SOLANA_BASE_FEE_LAMPORTS = 5_000n;
export const DEFAULT_SOLANA_BASE_COMPUTE_UNITS = 5_000;
export const DEFAULT_SOLANA_PER_INPUT_COMPUTE_UNITS = 1_000;
export const DEFAULT_SOLANA_PER_INSTRUCTION_COMPUTE_UNITS = 500;
export const DEFAULT_SOLANA_MIN_COMPUTE_UNITS = 2_000;
export const DEFAULT_SOLANA_MAX_COMPUTE_UNITS = 1_400_000;
export const DEFAULT_SOLANA_MIN_PRIORITY_FEE_MICRO_LAMPORTS = 0n;
export const DEFAULT_SOLANA_MAX_PRIORITY_FEE_MICRO_LAMPORTS = 1_000_000n;
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

export const SOLANA_SWEEP_DECOY_MIN_DELAY_MS = 10_000;
export const SOLANA_SWEEP_DECOY_MAX_DELAY_MS = 120_000;
export const SOLANA_SWEEP_DECOY_MEAN_DELAY_MS = 30_000;

export interface SolanaPrioritizationFeeSample {
  readonly slot: number;
  readonly prioritizationFee: number | bigint;
}

export interface SolanaChainConnection extends SolanaWalletConnection {
  getRecentPrioritizationFees?(config?: {
    lockedWritableAccounts?: PublicKey[];
  }): Promise<ReadonlyArray<SolanaPrioritizationFeeSample>>;
}

export interface SolanaComputeBudgetOptions {
  /** Explicit compute unit limit override. When omitted, computed dynamically from input/instruction counts. */
  readonly computeUnitLimit?: number;
  /** Base compute unit overhead for a transaction (default: 5,000). */
  readonly baseComputeUnits?: number;
  /** Additional compute units per input / transfer signer (default: 1,000). */
  readonly perInputComputeUnits?: number;
  /** Additional compute units per extra instruction (default: 500). */
  readonly perInstructionComputeUnits?: number;
  /** Extra instruction count beyond standard transfer instructions (default: 0). */
  readonly extraInstructionCount?: number;
  /** Minimum compute unit limit floor (default: 2,000). */
  readonly minComputeUnits?: number;
  /** Maximum compute unit limit ceiling (default: 1,400,000). */
  readonly maxComputeUnits?: number;
  /** Explicit priority fee in micro-lamports per compute unit. Overrides RPC sampling when provided. */
  readonly priorityFeeMicroLamports?: bigint;
  /** Default/fallback priority fee in micro-lamports when RPC sampling is unavailable or returns empty (default: 0n). */
  readonly defaultPriorityFeeMicroLamports?: bigint;
  /** Minimum priority fee floor in micro-lamports when clamping sampled fees (default: 0n). */
  readonly minPriorityFeeMicroLamports?: bigint;
  /** Maximum priority fee ceiling in micro-lamports (default: 1,000,000n). */
  readonly maxPriorityFeeMicroLamports?: bigint;
  /** Percentile (0..100) used when sampling recent prioritization fees (default: 50 for median). */
  readonly feePercentile?: number;
  /** Force prepending compute budget instructions on single-input legacy transfers even when priority fee is 0. */
  readonly alwaysSetComputeUnitLimit?: boolean;
}

export interface SweepDecoyJitterOptions {
  /** Minimum delay bound in milliseconds (default: 10,000 ms). */
  readonly minDelayMs?: number;
  /** Maximum delay bound in milliseconds (default: 120,000 ms). */
  readonly maxDelayMs?: number;
  /** Mean delay for exponential / Poisson inter-arrival sampling in milliseconds (default: 30,000 ms). */
  readonly meanDelayMs?: number;
  /** Optional uniform random generator returning [0, 1) (default: Math.random). */
  readonly randomFn?: () => number;
}

export interface ScheduleBackgroundSweepOptions extends SweepDecoyJitterOptions {
  /** Optional callback invoked if sweepFn throws or rejects. */
  readonly onError?: (error: unknown) => void;
  /** Optional callback invoked when sweepFn completes successfully. */
  readonly onComplete?: (result: unknown) => void;
  /** Optional custom timer setter for testing/injection (defaults to globalThis.setTimeout). */
  readonly setTimeoutFn?: typeof setTimeout;
  /** Optional custom timer clearer for testing/injection (defaults to globalThis.clearTimeout). */
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** Optional AbortSignal to cancel the scheduled sweep before it runs. */
  readonly signal?: AbortSignal;
}

export interface ScheduledBackgroundSweepHandle<T = unknown> {
  /** The computed Poisson decoy delay in milliseconds ([10_000, 120_000] by default). */
  readonly delayMs: number;
  /** The underlying timer identifier. */
  readonly timerId: ReturnType<typeof setTimeout>;
  /** Cancels the pending background sweep before execution. */
  cancel(): void;
  /** True if cancel() was called before the timer fired. */
  readonly cancelled: boolean;
  /** Resolves with the sweep result when the timer fires, or undefined if cancelled. */
  readonly promise: Promise<T | undefined>;
}

/**
 * Dynamically computes the Solana compute unit limit for single-input and multi-input transfers,
 * clamped between configurable `[minComputeUnits, maxComputeUnits]` bounds.
 */
export function computeSolanaComputeUnitLimit(
  params?: {
    readonly inputCount?: number;
    readonly extraInstructionCount?: number;
  } & SolanaComputeBudgetOptions
): number {
  const minUnits = Math.max(
    1,
    Math.floor(params?.minComputeUnits ?? DEFAULT_SOLANA_MIN_COMPUTE_UNITS)
  );
  const maxUnits = Math.max(
    minUnits,
    Math.floor(params?.maxComputeUnits ?? DEFAULT_SOLANA_MAX_COMPUTE_UNITS)
  );

  if (
    params?.computeUnitLimit !== undefined &&
    Number.isFinite(params.computeUnitLimit)
  ) {
    return Math.min(
      maxUnits,
      Math.max(minUnits, Math.floor(params.computeUnitLimit))
    );
  }

  const inputCount = Math.max(1, Math.floor(params?.inputCount ?? 1));
  const extraInstructions = Math.max(
    0,
    Math.floor(params?.extraInstructionCount ?? 0)
  );
  const baseUnits =
    params?.baseComputeUnits ?? DEFAULT_SOLANA_BASE_COMPUTE_UNITS;
  const perInputUnits =
    params?.perInputComputeUnits ?? DEFAULT_SOLANA_PER_INPUT_COMPUTE_UNITS;
  const perInstructionUnits =
    params?.perInstructionComputeUnits ??
    DEFAULT_SOLANA_PER_INSTRUCTION_COMPUTE_UNITS;

  const rawUnits =
    baseUnits +
    inputCount * perInputUnits +
    extraInstructions * perInstructionUnits;

  return Math.min(maxUnits, Math.max(minUnits, Math.floor(rawUnits)));
}

/**
 * Computes the priority fee in lamports for a given compute unit limit and micro-lamport price.
 * Uses ceiling division (`ceil(units * microLamports / 1_000_000)`) when positive.
 */
export function computeSolanaPriorityFeeLamports(
  computeUnits: number,
  priorityFeeMicroLamports: bigint
): bigint {
  if (
    !Number.isFinite(computeUnits) ||
    computeUnits <= 0 ||
    priorityFeeMicroLamports <= 0n
  ) {
    return 0n;
  }
  const unitsBigInt = BigInt(Math.floor(computeUnits));
  return (
    (unitsBigInt * priorityFeeMicroLamports +
      MICRO_LAMPORTS_PER_LAMPORT -
      1n) /
    MICRO_LAMPORTS_PER_LAMPORT
  );
}

/**
 * Samples recent prioritization fees from `connection.getRecentPrioritizationFees` when available,
 * computing the configured percentile/median and clamping between `[minPriorityFeeMicroLamports, maxPriorityFeeMicroLamports]`.
 * Falls back gracefully to `defaultPriorityFeeMicroLamports` (or `0n`) if the RPC method is absent,
 * returns no samples, or throws.
 */
export async function sampleSolanaPriorityFeeMicroLamports(
  params?: {
    readonly connection?: {
      getRecentPrioritizationFees?: SolanaChainConnection["getRecentPrioritizationFees"];
    };
    readonly lockedWritableAccounts?: PublicKey[];
  } & SolanaComputeBudgetOptions
): Promise<bigint> {
  const rawFloor =
    params?.minPriorityFeeMicroLamports ??
    DEFAULT_SOLANA_MIN_PRIORITY_FEE_MICRO_LAMPORTS;
  const floor = rawFloor < 0n ? 0n : rawFloor;
  const rawCeiling =
    params?.maxPriorityFeeMicroLamports ??
    DEFAULT_SOLANA_MAX_PRIORITY_FEE_MICRO_LAMPORTS;
  const ceiling = rawCeiling >= floor ? rawCeiling : floor;

  const clampFee = (fee: bigint): bigint => {
    const nonNegative = fee < 0n ? 0n : fee;
    if (nonNegative < floor) return floor;
    if (nonNegative > ceiling) return ceiling;
    return nonNegative;
  };

  if (params?.priorityFeeMicroLamports !== undefined) {
    return clampFee(params.priorityFeeMicroLamports);
  }

  const fallbackFee = clampFee(params?.defaultPriorityFeeMicroLamports ?? 0n);
  const getRecentFees = params?.connection?.getRecentPrioritizationFees;
  if (typeof getRecentFees !== "function") {
    return fallbackFee;
  }

  try {
    const response = await getRecentFees.call(
      params?.connection,
      params?.lockedWritableAccounts
        ? { lockedWritableAccounts: params.lockedWritableAccounts }
        : undefined
    );
    if (!Array.isArray(response) || response.length === 0) {
      return fallbackFee;
    }

    const validFees: bigint[] = [];
    for (const sample of response) {
      if (sample == null) continue;
      const raw = sample.prioritizationFee;
      if (typeof raw === "bigint") {
        validFees.push(raw < 0n ? 0n : raw);
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        validFees.push(raw <= 0 ? 0n : BigInt(Math.round(raw)));
      }
    }

    if (validFees.length === 0) {
      return fallbackFee;
    }

    validFees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const percentile = Math.min(
      100,
      Math.max(0, params?.feePercentile ?? 50)
    );

    let sampled: bigint;
    if (percentile === 50) {
      const mid = Math.floor(validFees.length / 2);
      if (validFees.length % 2 === 1) {
        sampled = validFees[mid];
      } else {
        sampled = (validFees[mid - 1] + validFees[mid]) / 2n;
      }
    } else if (percentile <= 0) {
      sampled = validFees[0];
    } else if (percentile >= 100) {
      sampled = validFees[validFees.length - 1];
    } else {
      const idx = Math.min(
        validFees.length - 1,
        Math.max(0, Math.ceil((percentile / 100) * validFees.length) - 1)
      );
      sampled = validFees[idx];
    }

    if (sampled === 0n && (params?.defaultPriorityFeeMicroLamports ?? 0n) > 0n) {
      return fallbackFee;
    }

    return clampFee(sampled);
  } catch {
    return fallbackFee;
  }
}

/**
 * Builds the `ComputeBudgetProgram` instructions in canonical order:
 * 1. `SetComputeUnitLimit`
 * 2. `SetComputeUnitPrice` (when `priorityFeeMicroLamports > 0n`)
 */
export function buildSolanaComputeBudgetInstructions(params: {
  readonly units: number;
  readonly priorityFeeMicroLamports?: bigint;
  readonly includeLimitWhenZeroFee?: boolean;
}): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];
  const hasPositivePrice =
    params.priorityFeeMicroLamports !== undefined &&
    params.priorityFeeMicroLamports > 0n;
  const includeLimit = params.includeLimitWhenZeroFee ?? true;

  if (includeLimit || hasPositivePrice) {
    const safeUnits = Math.max(1, Math.floor(params.units));
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: safeUnits })
    );
  }

  if (hasPositivePrice) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: params.priorityFeeMicroLamports!,
      })
    );
  }

  return instructions;
}

/**
 * Prepends `ComputeBudgetProgram.setComputeUnitLimit` and (when priority fee > 0)
 * `ComputeBudgetProgram.setComputeUnitPrice` to the beginning of a Solana `Transaction`,
 * replacing any existing compute budget instructions so ordering is strictly preserved.
 */
export function prependSolanaComputeBudgetInstructions(
  transaction: Transaction,
  params: {
    readonly units: number;
    readonly priorityFeeMicroLamports?: bigint;
    readonly includeLimitWhenZeroFee?: boolean;
  }
): Transaction {
  const budgetIxs = buildSolanaComputeBudgetInstructions(params);
  const nonBudgetIxs = transaction.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId)
  );
  transaction.instructions = [...budgetIxs, ...nonBudgetIxs];
  return transaction;
}

/**
 * Computes a Poisson-distributed (exponential inter-arrival time) decoy delay in milliseconds
 * for non-urgent background sweeps and change consolidations, clamped to `[10_000, 120_000]` ms by default.
 *
 * Uses inverse transform sampling: `delay = -meanDelayMs * ln(1 - u)` where `u in [0, 1)`.
 */
export function computeSweepDecoyDelayMs(
  randomFnOrOptions?: (() => number) | SweepDecoyJitterOptions,
  maybeOptions?: SweepDecoyJitterOptions
): number {
  const options: SweepDecoyJitterOptions =
    typeof randomFnOrOptions === "function"
      ? { ...maybeOptions, randomFn: randomFnOrOptions }
      : randomFnOrOptions ?? maybeOptions ?? {};

  const minDelayMs = Math.max(
    0,
    Math.floor(options.minDelayMs ?? SOLANA_SWEEP_DECOY_MIN_DELAY_MS)
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.floor(options.maxDelayMs ?? SOLANA_SWEEP_DECOY_MAX_DELAY_MS)
  );
  const meanDelayMs =
    options.meanDelayMs !== undefined && options.meanDelayMs > 0
      ? options.meanDelayMs
      : SOLANA_SWEEP_DECOY_MEAN_DELAY_MS;
  const rng = options.randomFn ?? Math.random;

  const rawU = Number(rng());
  if (!Number.isFinite(rawU) || rawU <= 0) {
    return minDelayMs;
  }
  if (rawU >= 1) {
    return maxDelayMs;
  }

  const exponentialSample = -meanDelayMs * Math.log(1 - rawU);
  const rounded = Math.round(exponentialSample);
  return Math.min(maxDelayMs, Math.max(minDelayMs, rounded));
}

/**
 * Schedules a non-urgent background sweep or change consolidation callback after a
 * Poisson-distributed decoy jitter delay (clamped to `[10_000, 120_000]` ms by default).
 */
export function scheduleBackgroundSweepWithJitter<T = unknown>(
  sweepFn: () => Promise<T> | T,
  options?: ScheduleBackgroundSweepOptions
): ScheduledBackgroundSweepHandle<T> {
  const delayMs = computeSweepDecoyDelayMs(options);
  const setTimer = options?.setTimeoutFn ?? setTimeout;
  const clearTimer = options?.clearTimeoutFn ?? clearTimeout;

  let isCancelled = Boolean(options?.signal?.aborted);
  let resolvePromise!: (value: T | undefined) => void;
  let rejectPromise!: (reason: unknown) => void;

  const promise = new Promise<T | undefined>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Prevent unhandled rejection warnings when callers fire-and-forget the handle.
  promise.catch(() => {});

  const timerId = setTimer(() => {
    if (isCancelled || options?.signal?.aborted) {
      isCancelled = true;
      resolvePromise(undefined);
      return;
    }
    try {
      const maybePromise = sweepFn();
      if (
        maybePromise !== null &&
        typeof maybePromise === "object" &&
        typeof (maybePromise as PromiseLike<T>).then === "function"
      ) {
        (maybePromise as PromiseLike<T>).then(
          (result) => {
            options?.onComplete?.(result);
            resolvePromise(result);
          },
          (error) => {
            if (options?.onError) {
              options.onError(error);
              resolvePromise(undefined);
            } else {
              rejectPromise(error);
            }
          }
        );
      } else {
        const result = maybePromise as T;
        options?.onComplete?.(result);
        resolvePromise(result);
      }
    } catch (error) {
      if (options?.onError) {
        options.onError(error);
        resolvePromise(undefined);
      } else {
        rejectPromise(error);
      }
    }
  }, delayMs);

  const cancel = (): void => {
    if (!isCancelled) {
      isCancelled = true;
      clearTimer(timerId);
      resolvePromise(undefined);
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      cancel();
    } else {
      options.signal.addEventListener("abort", cancel, { once: true });
    }
  }

  return {
    delayMs,
    timerId,
    cancel,
    get cancelled() {
      return isCancelled;
    },
    promise,
  };
}

export interface SolanaChainConfig {
  /** Optional chain identifier override; defaults to networkId. */
  readonly chainIdentifier?: string;
  /** Stable cluster/genesis identifier used to namespace durable transaction attempts. */
  networkId: string;
  /** Expected genesis hash, checked against the RPC before wallet construction. */
  genesisHash: string;
  connection: SolanaChainConnection;
  /** The application owns the reviewed mnemonic-to-ed25519 derivation policy. */
  deriveSigner(seed: HDSeed): Promise<Keypair> | Keypair;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  chainUtxoPool?: ChainUtxoPool;
  /** Optional compute budget and priority fee tuning configuration (#1220). */
  computeBudget?: SolanaComputeBudgetOptions;
}

export function createSolanaChain(config: SolanaChainConfig): NativeAssetChain {
  const isTestnet =
    config.networkId === "solana-testnet" ||
    config.networkId.includes("testnet") ||
    config.networkId.includes("devnet");
  const chainIdentifier = config.chainIdentifier ?? config.networkId;
  const metadata = getChainRegistryEntry(chainIdentifier);
  if (!metadata || metadata.family !== "solana") {
    throw new Error(`Unsupported Solana chain identifier: ${chainIdentifier}`);
  }
  const { name, unit } = metadata;
  const network = isTestnet ? "testnet" : "mainnet";

  return {
    family: "solana",
    chainIdentifier,
    name,
    unit,
    networkId: config.networkId,
    network,
    isTestnet,
    capabilities: {
      profiles: false,
      directMessages: false,
      topics: false,
      // Off until the one-time key is the recipient's alone (`SolanaStealthSendRefusedError`).
      stealthPayments: false,
      legacyConsolidation: "solana-bundle",
    },
    toDisplayAmount: (raw) => formatBaseUnit(raw, 9),
    fromDisplayAmount: (display) => parseBaseUnit(display, 9),
    addressToString: (address) => address.raw,
    transactionToString: (transaction) => transaction.txHash,
    formatAddress: (address) => address.raw,
    parseAddress(input) {
      try {
        return { raw: new PublicKey(input).toBase58() };
      } catch {
        return undefined;
      }
    },
    async createWallet(seed) {
      if (!bip39.validateMnemonic(seed.mnemonic)) {
        throw new Error("Invalid BIP-39 mnemonic");
      }
      const actualGenesisHash = await config.connection.getGenesisHash();
      if (actualGenesisHash !== config.genesisHash) {
        throw new Error(
          `Solana RPC genesis mismatch: expected ${config.genesisHash}, got ${actualGenesisHash}`
        );
      }
      return new SolanaWallet({
        connection: config.connection,
        signer: await config.deriveSigner(seed),
        chainIdentifier,
        networkId: config.networkId,
        genesisHash: config.genesisHash,
        nativeAttemptStore: config.nativeAttemptStore,
        chainUtxoPool: config.chainUtxoPool,
      });
    },
    nativeTransfers: {
      async getBalance({ wallet }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.getBalance();
      },
      async send({ wallet, recipient, value, onSigned }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        return wallet.sendNative({ recipient, value, onSigned });
      },
      async getTransactionStatus({ wallet, transaction }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }
        if (wallet.networkId !== config.networkId) {
          throw new Error(
            `Expected Solana network ${config.networkId}, got ${wallet.networkId}`
          );
        }
        const response = await config.connection.getSignatureStatus(
          transaction.txHash,
          { searchTransactionHistory: true }
        );
        if (response.value === null) return "unknown";
        if (response.value.err !== null) return "failed";
        return response.value.confirmationStatus === "confirmed" ||
          response.value.confirmationStatus === "finalized"
          ? "confirmed"
          : "pending";
      },
      async sendLegacy({
        wallet,
        recipient,
        value,
        onProgress,
        onSigned,
        priorityFeeMicroLamports,
      }) {
        if (wallet.family !== "solana") {
          throw new Error(`Expected a Solana wallet, got ${wallet.family}`);
        }

        const effectivePriorityFee =
          await sampleSolanaPriorityFeeMicroLamports({
            ...config.computeBudget,
            connection: config.connection,
            ...(priorityFeeMicroLamports !== undefined
              ? { priorityFeeMicroLamports }
              : {}),
          });

        if (wallet.chainUtxoPool) {
          const primaryBalance = await wallet.getBalance().catch(() => 0n);
          const exceedsPrimary = value > primaryBalance;
          const poolChain =
            wallet.chainUtxoPool.getCleanCoins(chainIdentifier).length > 0
              ? chainIdentifier
              : "solana";
          let selection:
            | ReturnType<typeof wallet.chainUtxoPool.selectCoins>
            | undefined;
          try {
            selection = wallet.chainUtxoPool.selectCoins({
              chain: poolChain,
              targetAmountWei: value,
            });
          } catch (err) {
            if (exceedsPrimary) {
              throw err;
            }
          }

          if (selection && (exceedsPrimary || selection.selected.length > 1)) {
            const { blockhash } = await config.connection.getLatestBlockhash();
            const changeAddress =
              (wallet as SolanaWallet).address ??
              (await wallet.getReceiveAddress()).raw;
            const units = computeSolanaComputeUnitLimit({
              ...config.computeBudget,
              inputCount: selection.selected.length,
            });
            const priorityFeeLamports = computeSolanaPriorityFeeLamports(
              units,
              effectivePriorityFee
            );
            const totalFeePaid =
              DEFAULT_SOLANA_BASE_FEE_LAMPORTS + priorityFeeLamports;

            const multiTransfer =
              await wallet.chainUtxoPool.solana.buildMultiInputTransfer({
                inputs: selection.selected,
                recipientAddress: recipient.raw,
                targetAmountLamports: value,
                changeAddress,
                recentBlockhash: blockhash,
                feeLamports: DEFAULT_SOLANA_BASE_FEE_LAMPORTS,
                priorityFeeMicroLamports:
                  effectivePriorityFee > 0n
                    ? effectivePriorityFee
                    : priorityFeeMicroLamports,
              });

            const defaultPoolUnits = Math.max(
              2000,
              1000 * selection.selected.length + 5000
            );
            if (units !== defaultPoolUnits) {
              prependSolanaComputeBudgetInstructions(
                multiTransfer.transaction,
                {
                  units,
                  priorityFeeMicroLamports: effectivePriorityFee,
                }
              );
              await multiTransfer.transaction.sign(...multiTransfer.signers);
            }

            const base58Decoder = getBase58Decoder();
            const txHash = multiTransfer.transaction.signature
              ? base58Decoder.decode(multiTransfer.transaction.signature)
              : undefined;

            if (onSigned && txHash) {
              await onSigned({ txHash });
            }

            onProgress?.({ status: { stage: "broadcasting" } });
            const serialized = await multiTransfer.transaction.serialize();
            const rpcTxHash = await config.connection.sendRawTransaction(
              serialized
            );
            const finalTxHash = rpcTxHash || txHash || "";

            for (const coin of selection.selected) {
              try {
                wallet.chainUtxoPool.markSpent(coin.id);
              } catch {}
            }

            onProgress?.({
              status: { stage: "confirmed", txHash: finalTxHash },
            });
            return {
              txHash: finalTxHash,
              totalValueSent: value,
              totalFeePaid,
              inputCount: selection.selected.length,
            };
          }
        }

        const shouldAttachSingleInputBudget =
          effectivePriorityFee > 0n ||
          config.computeBudget?.computeUnitLimit !== undefined ||
          config.computeBudget?.alwaysSetComputeUnitLimit === true;

        const maybeSigner = (wallet as SolanaWallet).signerKeypair;
        if (shouldAttachSingleInputBudget && maybeSigner) {
          const { blockhash } = await config.connection.getLatestBlockhash();
          const units = computeSolanaComputeUnitLimit({
            ...config.computeBudget,
            inputCount: 1,
          });
          const priorityFeeLamports = computeSolanaPriorityFeeLamports(
            units,
            effectivePriorityFee
          );
          const totalFeePaid =
            DEFAULT_SOLANA_BASE_FEE_LAMPORTS + priorityFeeLamports;

          const transaction = new Transaction();
          transaction.recentBlockhash =
            blockhash as Transaction["recentBlockhash"];
          transaction.feePayer = maybeSigner.publicKey;
          prependSolanaComputeBudgetInstructions(transaction, {
            units,
            priorityFeeMicroLamports: effectivePriorityFee,
          });
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: maybeSigner.publicKey,
              toPubkey: new PublicKey(recipient.raw),
              lamports: value,
            })
          );
          await transaction.sign(maybeSigner);

          const base58Decoder = getBase58Decoder();
          const txHash = transaction.signature
            ? base58Decoder.decode(transaction.signature)
            : undefined;

          if (onSigned && txHash) {
            await onSigned({ txHash });
          }

          onProgress?.({ status: { stage: "broadcasting" } });
          const serialized = await transaction.serialize();
          const rpcTxHash = await config.connection.sendRawTransaction(
            serialized
          );
          const finalTxHash = rpcTxHash || txHash || "";
          onProgress?.({
            status: { stage: "confirmed", txHash: finalTxHash },
          });
          return {
            txHash: finalTxHash,
            totalValueSent: value,
            totalFeePaid,
            inputCount: 1,
          };
        }

        onProgress?.({ status: { stage: "broadcasting" } });
        const result = await wallet.sendNative({ recipient, value, onSigned });
        onProgress?.({ status: { stage: "confirmed", txHash: result.txHash } });
        return {
          txHash: result.txHash,
          totalValueSent: value,
          totalFeePaid: DEFAULT_SOLANA_BASE_FEE_LAMPORTS,
        };
      },
      async estimateLegacyFee(params) {
        const effectivePriorityFee =
          await sampleSolanaPriorityFeeMicroLamports({
            ...config.computeBudget,
            connection: config.connection,
          });

        let inputCount = 1;
        const pool = params?.wallet?.chainUtxoPool;
        if (pool && params?.value) {
          const poolChain =
            pool.getCleanCoins(chainIdentifier).length > 0
              ? chainIdentifier
              : "solana";
          try {
            const selection = pool.selectCoins({
              chain: poolChain,
              targetAmountWei: params.value,
            });
            inputCount = selection.selected.length;
          } catch {}
        }

        const units = computeSolanaComputeUnitLimit({
          ...config.computeBudget,
          inputCount,
        });
        const priorityFeeLamports = computeSolanaPriorityFeeLamports(
          units,
          effectivePriorityFee
        );
        const totalFee =
          DEFAULT_SOLANA_BASE_FEE_LAMPORTS + priorityFeeLamports;

        return {
          totalFee,
          inputCount,
          deliveryFee: totalFee,
        };
      },
      // Refused: nothing is derived, signed or sent. See `SolanaStealthSendRefusedError`.
      async sendToContact() {
        throw new SolanaStealthSendRefusedError();
      },
    },
  };
}

