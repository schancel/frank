import {
  ChainAddress,
  ChainTransaction,
  defaultNativeTransactionAttemptStore,
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
  readonly builtTxs: ReadonlyArray<{ readonly txid: string }>;
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
  };
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
  getTransactionStatus?: (
    transaction: ChainTransaction
  ) => Promise<"confirmed" | "failed" | "pending" | "unknown">;
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
    ) => Promise<"confirmed" | "failed" | "pending" | "unknown">
  ) {
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
            addressPrefix: ECASH_MAINNET_PREFIX,
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
    const checkpointHash = ECASH_CHECKPOINTS[canonicalId].hash;
    const primaryAddress = canonicalEcashAddress(
      backend.getReceiveAddress(0),
      addressPrefix
    );
    return new EcashWallet(
      backend,
      primaryAddress,
      canonicalId,
      checkpointHash,
      params.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      params.getTransactionStatus ?? (async () => "unknown")
    );
  }

  get identity(): NativeWalletHandle["identity"] {
    return {
      address: { raw: this.primaryAddress },
      displayAddress: this.primaryAddress,
    };
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
    onSigned?: (signed: ChainTransaction) => Promise<void>;
  }): Promise<ChainTransaction> {
    return runNativeTransactionExclusive(
      this.nativeAttemptKey,
      this.nativeAttemptStore.coordinationScope,
      () =>
        this.runExclusive(async () => {
          const persisted = this.nativeAttemptStore.get(this.nativeAttemptKey);
          if (persisted === undefined) {
            this.unresolvedNative = undefined;
          } else if (
            persisted !== undefined &&
            (this.lastSubmittedNative === undefined ||
              !sameChainTransaction(persisted, this.lastSubmittedNative)) &&
            (this.unresolvedNative === undefined ||
              this.unresolvedNative.built === undefined ||
              !sameChainTransaction(
                persisted,
                this.unresolvedNative.error.transaction
              ))
          ) {
            const status = await this.getTransactionStatus(persisted);
            if (status === "confirmed" || status === "failed") {
              this.nativeAttemptStore.delete(this.nativeAttemptKey);
              this.unresolvedNative = undefined;
            } else {
              this.unresolvedNative ??= {
                error: new NativeTransactionSubmissionError({
                  transaction: persisted,
                  reason: new Error("Recovered unresolved native transaction"),
                }),
              };
            }
          }
          return this.sendNativeExclusive(params);
        })
    );
  }

  private async sendNativeExclusive(params: {
    recipient: ChainAddress;
    value: bigint;
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
    return this.broadcastNativeAction(built, params.onSigned);
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
    if (onSigned !== undefined) await onSigned(attemptedTransaction);
    const pendingError = new NativeTransactionSubmissionError({
      transaction: attemptedTransaction,
      reason: new Error("Native transaction submission is in progress"),
    });
    this.nativeAttemptStore.put(this.nativeAttemptKey, attemptedTransaction);
    this.unresolvedNative = { built, error: pendingError };
    let result: EcashBroadcastResult;
    try {
      result = await built.broadcast({ retryOnUtxoConflict: false });
    } catch (reason) {
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
