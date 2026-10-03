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

export type EcashAddressPrefix = "ecash" | "ectest" | "ecregtest";
import * as bip39 from "bip39";

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
  mnemonic: string;
  chronik: unknown;
  addressPrefix: EcashAddressPrefix;
}) => EcashWalletBackend | Promise<EcashWalletBackend>;

interface EcashSdkWalletConstructor {
  fromMnemonic(
    mnemonic: string,
    chronik: unknown,
    options: { hd: true; prefix: EcashAddressPrefix }
  ): EcashWalletBackend;
}

const defaultWalletFactory: EcashWalletFactory = async ({
  mnemonic,
  chronik,
  addressPrefix,
}) => {
  // ecash-wallet 6.2.1 publishes JavaScript but no declaration entry. Dynamically importing it
  // keeps that packaging gap at this boundary while still allowing Vite to bundle the backend.
  const imported = await import("ecash-wallet");
  const sdk = imported as unknown as {
    Wallet?: unknown;
    default?: { Wallet?: unknown };
  };
  const Wallet = (sdk.Wallet ?? sdk.default?.Wallet) as
    | EcashSdkWalletConstructor
    | undefined;
  if (Wallet === undefined) {
    throw new Error("ecash-wallet did not export Wallet");
  }
  return Wallet.fromMnemonic(mnemonic, chronik, {
    hd: true,
    prefix: addressPrefix,
  });
};

/**
 * High-level XEC wallet adapter. UTXO selection, chained transaction construction, optimistic
 * UTXO mutation, conflict recovery, and broadcast stay inside ecash-wallet instead of leaking
 * into the UI-facing wallet contract.
 */
export class EcashWallet implements NativeWalletHandle {
  readonly chainKind = "ecash" as const;
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
    networkId: string,
    attemptNetworkId: string,
    private readonly nativeAttemptStore: NativeTransactionAttemptStore,
    private readonly getTransactionStatus: (
      transaction: ChainTransaction
    ) => Promise<"confirmed" | "failed" | "pending" | "unknown">
  ) {
    this.networkId = networkId;
    this.nativeAttemptKey = nativeTransactionAttemptKey({
      chainKind: "ecash",
      networkId: attemptNetworkId,
      address: this.identity.address.raw,
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

  static async fromMnemonic(params: {
    mnemonic: string;
    passphrase?: string;
    chronik: unknown;
    networkId: string;
    attemptNetworkId?: string;
    addressPrefix?: EcashAddressPrefix;
    walletFactory?: EcashWalletFactory;
    nativeAttemptStore?: NativeTransactionAttemptStore;
    getTransactionStatus?: (
      transaction: ChainTransaction
    ) => Promise<"confirmed" | "failed" | "pending" | "unknown">;
  }): Promise<EcashWallet> {
    if (params.passphrase !== undefined && params.passphrase.length > 0) {
      throw new Error(
        "The eCash wallet backend does not support BIP-39 passphrases"
      );
    }
    if (!bip39.validateMnemonic(params.mnemonic)) {
      throw new Error("Invalid BIP-39 mnemonic");
    }
    const backend = await (params.walletFactory ?? defaultWalletFactory)({
      mnemonic: params.mnemonic,
      chronik: params.chronik,
      addressPrefix: params.addressPrefix ?? "ecash",
    });
    await backend.syncAndDiscoverAddresses();
    return new EcashWallet(
      backend,
      params.networkId,
      params.attemptNetworkId ?? params.networkId,
      params.nativeAttemptStore ?? defaultNativeTransactionAttemptStore,
      params.getTransactionStatus ?? (async () => "unknown")
    );
  }

  get identity(): NativeWalletHandle["identity"] {
    const address = this.backend.getReceiveAddress(0);
    return {
      address: { raw: address },
      displayAddress: address,
    };
  }

  async getReceiveAddress(): Promise<ChainAddress> {
    return this.runExclusive(async () => {
      // Discover first so receiveIndex points at the next unused address. Merely displaying an
      // address never consumes an HD index, avoiding restoration gaps from abandoned QR screens.
      await this.backend.syncAndDiscoverAddresses();
      return { raw: this.backend.getReceiveAddress(this.backend.receiveIndex) };
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

    await this.backend.sync();
    const built = this.backend
      .action({
        outputs: [{ address: params.recipient.raw, sats: params.value }],
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
