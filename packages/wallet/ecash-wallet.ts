import {
  ChainAddress,
  ChainTransaction,
  defaultNativeTransactionAttemptStore,
  NativeFeeExceededError,
  NativeTransactionRefusedError,
  nativeTransactionAttemptKey,
  NativeTransactionAttemptStore,
  NativeTransactionSubmissionError,
  NativeWalletHandle,
  runNativeTransactionExclusive,
  sameChainTransaction,
} from "./chain/chain-wallet";
import { Address } from "ecash-lib/dist/address/address";
import type { ChronikClient } from "chronik-client";
import type { DomainRoot } from "../domain-roots/src";
import {
  createEcashSeedBackend,
  snapshotEcashDomainRoot,
} from "./ecash-seed-boundary";
import type { LegacyEcashSeedOptions } from "./ecash-legacy-seed";
import type {
  ChainUtxoPool,
  ChainUtxoCoin,
  ChainUtxoOrigin,
} from "./chain-utxo-pool";

export type EcashAddressPrefix = "ecash" | "ectest" | "ecregtest";
export type EcashNetworkId =
  | "xec-mainnet"
  | "xec-testnet"
  | "ecash-mainnet"
  | "ecash-testnet";

export const ECASH_MAINNET_CHECKPOINT_HEIGHT = 661_648;
export const ECASH_MAINNET_CHECKPOINT_HASH =
  "000000000000000004284c9d8b2c8ff731efeaec6be50729bdc9bd07f910757d";
export const ECASH_TESTNET_CHECKPOINT_HEIGHT = 1_421_481;
export const ECASH_TESTNET_CHECKPOINT_HASH =
  "00000000062c7f32591d883c99fc89ebe74a83287c0f2b7ffeef72e62217d40b";
const ECASH_MAINNET_PREFIX: EcashAddressPrefix = "ecash";

export const ECASH_CHECKPOINTS: Record<
  "xec-mainnet" | "xec-testnet",
  { height: number; hash: string }
> = {
  "xec-mainnet": {
    height: ECASH_MAINNET_CHECKPOINT_HEIGHT,
    hash: ECASH_MAINNET_CHECKPOINT_HASH,
  },
  "xec-testnet": {
    height: ECASH_TESTNET_CHECKPOINT_HEIGHT,
    hash: ECASH_TESTNET_CHECKPOINT_HASH,
  },
};

export function canonicalEcashNetworkId(
  networkId: EcashNetworkId
): "xec-mainnet" | "xec-testnet" {
  return networkId === "ecash-testnet" || networkId === "xec-testnet"
    ? "xec-testnet"
    : "xec-mainnet";
}

type EcashCheckpointClient = Pick<ChronikClient, "block">;
type EcashChronikConstructor = new (urls: string[]) => ChronikClient;

async function verifyEcashChronikEndpoints(params: {
  chronik: ChronikClient;
  networkId: EcashNetworkId;
  allowStructuralTestClient: boolean;
  checkpointClientFactory?: (url: string) => EcashCheckpointClient;
}): Promise<void> {
  const proxyInterface = (
    params.chronik as ChronikClient & {
      proxyInterface?: () => {
        getEndpointArray(): ReadonlyArray<{ url: string }>;
      };
    }
  ).proxyInterface;
  let checkpointClients: ReadonlyArray<{
    label: string;
    client: EcashCheckpointClient;
  }>;
  if (typeof proxyInterface === "function") {
    const urls = Array.from(
      new Set(
        proxyInterface
          .call(params.chronik)
          .getEndpointArray()
          .map((endpoint) => endpoint.url)
      )
    );
    if (urls.length === 0) {
      throw new Error("eCash Chronik client has no configured endpoints");
    }
    checkpointClients = urls.map((url) => ({
      label: url,
      client:
        params.checkpointClientFactory?.(url) ??
        new (params.chronik.constructor as EcashChronikConstructor)([url]),
    }));
  } else if (params.allowStructuralTestClient) {
    checkpointClients = [{ label: "injected Chronik", client: params.chronik }];
  } else {
    throw new Error("eCash wallet requires chronik-client 4.3 or newer");
  }

  const canonicalId = canonicalEcashNetworkId(params.networkId);
  const checkpointSpec = ECASH_CHECKPOINTS[canonicalId];

  await Promise.all(
    checkpointClients.map(async ({ label, client }) => {
      const checkpoint = await client.block(checkpointSpec.height);
      if (checkpoint.blockInfo.hash !== checkpointSpec.hash) {
        throw new Error(
          `eCash Chronik checkpoint mismatch for ${label} at height ${checkpointSpec.height}: expected ${checkpointSpec.hash}, got ${checkpoint.blockInfo.hash}`
        );
      }
    })
  );
}

function canonicalEcashAddress(
  input: string,
  expectedPrefix: EcashAddressPrefix = "ecash"
): string {
  try {
    const parsed = Address.fromCashAddress(input.toLowerCase());
    if (parsed.prefix !== expectedPrefix) throw new Error("wrong prefix");
    return parsed.toString().toLowerCase();
  } catch {
    throw new Error("Invalid eCash address for the configured network");
  }
}

export interface EcashBroadcastResult {
  success: boolean;
  broadcasted: string[];
  unbroadcasted?: string[];
  errors?: string[];
}

export interface EcashBuiltAction {
  readonly builtTxs: ReadonlyArray<{
    readonly txid: string;
    /** The signed transaction; its bytes are recorded before broadcast. */
    readonly tx?: { ser(): Uint8Array };
    fee?(): bigint;
  }>;
  broadcast(config?: {
    retryOnUtxoConflict?: boolean;
  }): Promise<EcashBroadcastResult>;
}

export interface EcashWalletBackend {
  readonly balanceSats: bigint;
  readonly receiveIndex: number;
  sync(): Promise<void>;
  syncAndDiscoverAddresses(): Promise<void>;
  getReceiveAddress(index: number): string;
  action(action: {
    outputs: ReadonlyArray<{ address: string; sats: bigint }>;
  }): {
    build(): EcashBuiltAction;
    /** Builds without touching the wallet's coins, to learn the fee. */
    inspect?(): { fee(): bigint };
  };
}

/**
 * The node's reason when Chronik answered and refused a broadcast; undefined otherwise. The relay
 * forwards a reason only for a 4xx from the node. An empty reason or the relay's placeholder is
 * not proof of a refusal, and neither is any other failure.
 */
function chronikRefusal(reason: unknown): string | undefined {
  const text = reason instanceof Error ? reason.message : String(reason);
  const match = /Failed getting \S+: (.*)$/s.exec(text);
  const refusal = match?.[1].trim();
  return refusal && refusal !== "upstream Chronik error" ? refusal : undefined;
}

export type EcashWalletFactory = (params: {
  domainRoot: DomainRoot<"ecash-bch-wallet">;
  chronik: ChronikClient;
  addressPrefix: EcashAddressPrefix;
}) => EcashWalletBackend | Promise<EcashWalletBackend>;

export interface EcashWalletOptions {
  chronik: ChronikClient;
  networkId: EcashNetworkId;
  /** Test seam for independently checking every URL reported by a failover client. */
  checkpointClientFactory?: (url: string) => EcashCheckpointClient;
  nativeAttemptStore?: NativeTransactionAttemptStore;
  chainUtxoPool?: ChainUtxoPool;
  getTransactionStatus?: (
    transaction: ChainTransaction
  ) => Promise<"confirmed" | "failed" | "pending" | "unknown">;
  /**
   * Sends already signed transactions (hex, in order) again. Chronik's "Failed getting <path>:
   * <reason>" error means the node answered and refused them; anything else means unknown.
   */
  rebroadcast?: (rawTransactions: ReadonlyArray<string>) => Promise<void>;
}

/**
 * High-level XEC wallet adapter. UTXO selection, chained transaction construction, optimistic
 * UTXO mutation, conflict recovery, and broadcast stay inside ecash-wallet instead of leaking
 * into the UI-facing wallet contract.
 */
export class EcashWallet implements NativeWalletHandle {
  readonly family = "bitcoin" as const;
  readonly chainIdentifier: string;
  readonly networkId: string;
  readonly chainUtxoPool?: ChainUtxoPool;
  private operationQueue: Promise<void> = Promise.resolve();
  private lastSubmittedNative: ChainTransaction | undefined;
  private unresolvedNative:
    | {
        built?: EcashBuiltAction;
        error: NativeTransactionSubmissionError;
      }
    | undefined;

  private readonly nativeAttemptKey: string;

  private constructor(
    private readonly backend: EcashWalletBackend,
    private readonly primaryAddress: string,
    networkId: string,
    attemptNetworkId: string,
    private readonly nativeAttemptStore: NativeTransactionAttemptStore,
    private readonly getTransactionStatus: (
      transaction: ChainTransaction
    ) => Promise<"confirmed" | "failed" | "pending" | "unknown">,
    chainUtxoPool?: ChainUtxoPool,
    private readonly rebroadcast?: (
      rawTransactions: ReadonlyArray<string>
    ) => Promise<void>
  ) {
    this.chainUtxoPool = chainUtxoPool;
    this.networkId = networkId;
    this.chainIdentifier = attemptNetworkId;
    this.nativeAttemptKey = nativeTransactionAttemptKey({
      family: "bitcoin",
      chainIdentifier: this.chainIdentifier,
      address: this.primaryAddress,
    });
    const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (persisted !== undefined) {
      this.unresolvedNative = {
        error: new NativeTransactionSubmissionError({
          transaction: persisted,
          reason: new Error("Recovered unresolved native transaction"),
        }),
      };
    }
  }

  static async fromDomainRoot(
    params: EcashWalletOptions & {
      domainRoot: DomainRoot<"ecash-bch-wallet">;
      walletFactory?: EcashWalletFactory;
    }
  ): Promise<EcashWallet> {
    // Validate and own a snapshot before the first await, endpoint probe, or SDK load.
    const domainRoot = snapshotEcashDomainRoot(params.domainRoot);
    try {
      return await EcashWallet.initialize(
        params,
        () =>
          (params.walletFactory ?? createEcashSeedBackend)({
            domainRoot,
            chronik: params.chronik,
            addressPrefix:
              canonicalEcashNetworkId(params.networkId) === "xec-testnet"
                ? "ectest"
                : ECASH_MAINNET_PREFIX,
          }),
        params.walletFactory !== undefined
      );
    } finally {
      domainRoot.bytes.fill(0);
    }
  }

  /** Legacy import only. Application activation/removal is owned by #692. */
  static async fromLegacyMnemonic(
    params: EcashWalletOptions & LegacyEcashSeedOptions
  ): Promise<EcashWallet> {
    const { legacyEcashBackendFactory } = await import("./ecash-legacy-seed");
    const createBackend = legacyEcashBackendFactory(params);
    return EcashWallet.initialize(
      params,
      createBackend,
      params.walletFactory !== undefined
    );
  }

  private static async initialize(
    params: EcashWalletOptions,
    createBackend: () => EcashWalletBackend | Promise<EcashWalletBackend>,
    allowStructuralTestClient: boolean
  ): Promise<EcashWallet> {
    await verifyEcashChronikEndpoints({
      chronik: params.chronik,
      networkId: params.networkId,
      allowStructuralTestClient,
      checkpointClientFactory: params.checkpointClientFactory,
    });
    const backend = await createBackend();
    await backend.syncAndDiscoverAddresses();
    const canonicalId = canonicalEcashNetworkId(params.networkId);
    const isTestnet = canonicalId === "xec-testnet";
    const addressPrefix: EcashAddressPrefix = isTestnet ? "ectest" : "ecash";
    const primaryAddress = canonicalEcashAddress(
      backend.getReceiveAddress(0),
      addressPrefix
    );
    const wallet = new EcashWallet(
      backend,
      primaryAddress,
      canonicalId,
      // The canonical chain identifier everywhere, including the attempt record's key. It was
      // the checkpoint hash, which no caller comparing against `xec-testnet` could match.
      canonicalId,
      params.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      params.getTransactionStatus ?? (async () => "unknown"),
      params.chainUtxoPool,
      params.rebroadcast
    );
    // Finish a send that a restart interrupted. If the indexer cannot be reached now, the next
    // send tries again before it signs anything.
    await wallet.finishInterruptedSend().catch(() => undefined);
    return wallet;
  }

  /**
   * Settle the recorded attempt of an earlier session. A transaction the indexer already has was
   * broadcast, so the record is dropped. One it does not have is sent again unchanged: the same
   * inputs cannot pay twice. The record stays only while the outcome cannot be learned.
   */
  async finishInterruptedSend(): Promise<void> {
    return this.runExclusive(() => this.finishInterruptedSendExclusive());
  }

  private async finishInterruptedSendExclusive(): Promise<void> {
    const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey);
    if (persisted === undefined) {
      this.unresolvedNative = undefined;
      return;
    }
    // A send this session saw accepted needs nothing more.
    if (
      this.lastSubmittedNative !== undefined &&
      sameChainTransaction(persisted, this.lastSubmittedNative)
    ) {
      return;
    }
    const settle = () => {
      this.nativeAttemptStore.delete(this.nativeAttemptKey);
      this.unresolvedNative = undefined;
    };
    const status = await this.getTransactionStatus(persisted);
    if (status !== "unknown") return settle();
    const unresolved = (reason: unknown) => {
      const current = this.unresolvedNative;
      // Keep the built action of this session so an explicit retry can still send it.
      if (
        current?.built !== undefined &&
        sameChainTransaction(persisted, current.error.transaction)
      ) {
        return;
      }
      this.unresolvedNative = {
        error: new NativeTransactionSubmissionError({
          transaction: persisted,
          reason,
        }),
      };
    };
    if (
      this.rebroadcast === undefined ||
      persisted.rawTransactions === undefined ||
      persisted.rawTransactions.length === 0
    ) {
      return unresolved(new Error("Recovered unresolved native transaction"));
    }
    try {
      await this.rebroadcast(persisted.rawTransactions);
    } catch (reason) {
      // The node answered and refused: its inputs are gone or it is already mined, so these
      // bytes can never be accepted later and nothing is left to wait for.
      if (chronikRefusal(reason) !== undefined) return settle();
      return unresolved(reason);
    }
    settle();
  }

  get identity(): NativeWalletHandle["identity"] {
    return {
      address: { raw: this.primaryAddress },
      displayAddress: this.primaryAddress,
    };
  }

  getChainUtxoPool(): ChainUtxoPool | undefined {
    return this.chainUtxoPool;
  }

  registerUtxoCoin(params: {
    address: string;
    privateKey: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    origin?: ChainUtxoOrigin;
    label?: string;
    pool?: ChainUtxoPool;
  }): ChainUtxoCoin {
    const targetPool = params.pool ?? this.chainUtxoPool;
    if (!targetPool) {
      throw new Error("No ChainUtxoPool provided or attached to EcashWallet");
    }
    return targetPool.utxo.registerOutpoint({
      chain: this.chainIdentifier,
      address: params.address,
      privateKey: params.privateKey,
      txid: params.txid,
      vout: params.vout,
      balanceWei: params.satoshis,
      origin: params.origin ?? "utxo",
      label: params.label,
    });
  }

  async getReceiveAddress(): Promise<ChainAddress> {
    return this.runExclusive(async () => {
      // Discover first so receiveIndex points at the next unused address. Merely displaying an
      // address never consumes an HD index, avoiding restoration gaps from abandoned QR screens.
      await this.backend.syncAndDiscoverAddresses();
      const isTestnet =
        canonicalEcashNetworkId(this.networkId as EcashNetworkId) ===
        "xec-testnet";
      const expectedPrefix: EcashAddressPrefix = isTestnet ? "ectest" : "ecash";
      return {
        raw: canonicalEcashAddress(
          this.backend.getReceiveAddress(this.backend.receiveIndex),
          expectedPrefix
        ),
      };
    });
  }

  async getBalance(): Promise<bigint> {
    return this.runExclusive(async () => {
      await this.backend.sync();
      return this.backend.balanceSats;
    });
  }

  /** The network fee a send of `value` to `recipient` would pay right now. */
  async estimateFee(params: {
    recipient: ChainAddress;
    value: bigint;
  }): Promise<bigint> {
    return this.runExclusive(async () => {
      await this.backend.sync();
      const action = this.backend.action({
        outputs: [{ address: params.recipient.raw, sats: params.value }],
      });
      if (action.inspect === undefined) {
        throw new Error("This eCash wallet backend cannot estimate a fee");
      }
      return action.inspect().fee();
    });
  }

  getUnresolvedNativeTransaction(): ChainTransaction | undefined {
    return this.unresolvedNative?.error.transaction;
  }

  async retryUnresolvedNativeTransaction(): Promise<ChainTransaction> {
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      () =>
        this.runExclusive(async () => {
          const unresolved = this.unresolvedNative;
          if (unresolved === undefined) {
            throw new Error("No unresolved native transaction to retry");
          }
          if (unresolved.built === undefined) {
            throw new Error(
              "Recovered unresolved transaction must be reconciled by id before sending again"
            );
          }
          const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey);
          if (
            persisted === undefined ||
            !sameChainTransaction(persisted, unresolved.error.transaction)
          ) {
            this.unresolvedNative =
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
          return this.broadcastNativeAction(unresolved.built);
        })
    );
  }

  resolveUnresolvedNativeTransaction(params: {
    transaction: ChainTransaction;
    outcome: "submitted" | "not-submitted";
  }): Promise<void> {
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      async () => {
        const expected =
          this.unresolvedNative?.error.transaction ?? this.lastSubmittedNative;
        const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey);
        if (
          expected === undefined ||
          !sameChainTransaction(expected, params.transaction) ||
          persisted === undefined ||
          !sameChainTransaction(persisted, params.transaction)
        ) {
          throw new Error(
            "Transaction does not match the unresolved native attempt"
          );
        }
        this.nativeAttemptStore.delete(this.nativeAttemptKey);
        this.unresolvedNative = undefined;
        this.lastSubmittedNative = undefined;
      }
    );
  }

  async sendNative(params: {
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      () =>
        this.runExclusive(async () => {
          await this.finishInterruptedSendExclusive();
          return this.sendNativeExclusive(params);
        })
    );
  }

  private async sendNativeExclusive(params: {
    recipient: ChainAddress;
    value: bigint;
    maxFee?: bigint;
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    if (this.unresolvedNative !== undefined) {
      throw this.unresolvedNative.error;
    }
    if (params.value <= 0n) {
      throw new RangeError("Transfer value must be greater than zero");
    }
    let recipient: string;
    try {
      const isTestnet =
        canonicalEcashNetworkId(this.networkId as EcashNetworkId) ===
        "xec-testnet";
      const expectedPrefix: EcashAddressPrefix = isTestnet ? "ectest" : "ecash";
      recipient = canonicalEcashAddress(params.recipient.raw, expectedPrefix);
    } catch {
      throw new Error("Invalid eCash recipient for the configured network");
    }

    await this.backend.sync();
    const built = this.backend
      .action({
        outputs: [{ address: recipient, sats: params.value }],
      })
      .build();
    if (params.maxFee !== undefined) {
      // The reviewed fee is a ceiling. Nothing is recorded or sent when it would be exceeded;
      // the coins the SDK set aside for this build come back with its next sync.
      const fee = built.builtTxs.reduce(
        (sum, transaction) => sum + (transaction.fee?.() ?? 0n),
        0n
      );
      if (fee > params.maxFee) throw new NativeFeeExceededError(fee);
    }
    return this.broadcastNativeAction(built, params.onSigned);
  }

  /** Forget a refused attempt: it was never broadcast, so nothing is left to reconcile. */
  private refused(reason: string): NativeTransactionRefusedError {
    this.nativeAttemptStore.delete(this.nativeAttemptKey);
    this.unresolvedNative = undefined;
    return new NativeTransactionRefusedError(reason);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async broadcastNativeAction(
    built: EcashBuiltAction,
    onSigned?: (signed: ChainTransaction) => Promise<void>
  ): Promise<ChainTransaction> {
    // An automatic conflict rebuild changes the signed transaction id behind this adapter's back.
    // Reconciliation requires one exact attempt, so callers explicitly sync before the build and
    // this boundary never lets the SDK replace it during broadcast.
    const builtTxHashes = built.builtTxs.map((transaction) => transaction.txid);
    const txHash = builtTxHashes[builtTxHashes.length - 1];
    if (txHash === undefined) {
      throw new Error("eCash wallet built an empty transaction set");
    }
    const attemptedTransaction: ChainTransaction =
      builtTxHashes.length === 1
        ? { txHash }
        : { txHash, relatedTxHashes: builtTxHashes };
    const rawTransactions = built.builtTxs.map((transaction) =>
      transaction.tx === undefined
        ? undefined
        : Buffer.from(transaction.tx.ser()).toString("hex")
    );
    const recordedAttempt: ChainTransaction = rawTransactions.every(
      (raw): raw is string => raw !== undefined
    )
      ? { ...attemptedTransaction, rawTransactions }
      : attemptedTransaction;
    if (onSigned !== undefined) await onSigned(attemptedTransaction);
    const pendingError = new NativeTransactionSubmissionError({
      transaction: attemptedTransaction,
      reason: new Error("Native transaction submission is in progress"),
    });
    this.nativeAttemptStore.put(this.nativeAttemptKey, recordedAttempt);
    this.unresolvedNative = { built, error: pendingError };
    let result: EcashBroadcastResult;
    try {
      result = await built.broadcast({ retryOnUtxoConflict: false });
    } catch (reason) {
      const refusal = chronikRefusal(reason);
      if (refusal !== undefined) throw this.refused(refusal);
      const error = new NativeTransactionSubmissionError({
        transaction: attemptedTransaction,
        reason,
      });
      this.unresolvedNative = { built, error };
      throw error;
    }

    // A finalization timeout is reported as success:false even though Chronik accepted every
    // listed transaction. Treat those ids as submitted; only an empty accepted set is failure.
    if (result.broadcasted.length === 0) {
      // Every error is the node's own refusal: nothing was broadcast.
      const refusals = (result.errors ?? []).map(chronikRefusal);
      if (
        refusals.length > 0 &&
        refusals.every((refusal): refusal is string => refusal !== undefined)
      ) {
        throw this.refused(refusals[0]);
      }
      const error = new NativeTransactionSubmissionError({
        transaction: attemptedTransaction,
        reason:
          result.errors?.length === 1
            ? result.errors[0]
            : result.errors ?? "eCash broadcast failed",
      });
      this.unresolvedNative = { built, error };
      throw error;
    }

    if (
      result.broadcasted.length !== builtTxHashes.length ||
      result.broadcasted.some((txid, index) => txid !== builtTxHashes[index])
    ) {
      const error = new NativeTransactionSubmissionError({
        transaction: attemptedTransaction,
        reason: new Error("eCash backend returned unexpected transaction ids"),
      });
      this.unresolvedNative = { built, error };
      throw error;
    }

    this.lastSubmittedNative = attemptedTransaction;
    this.unresolvedNative = undefined;
    return result.broadcasted.length === 1
      ? { txHash }
      : { txHash, relatedTxHashes: [...result.broadcasted] };
  }
}
