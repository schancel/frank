/**
 * Chain-neutral transaction-bundle vocabulary.
 *
 * A bundle is ordered but is not assumed to be atomic: account chains generally submit each
 * signed transaction separately, just as the legacy UTXO wallet broadcasts every member of its
 * transaction set. Implementations must therefore report the successfully submitted prefix when
 * a later member fails.
 */
type WalletTransactionMetadata<TMetadata> = [TMetadata] extends [never]
  ? { readonly metadata?: never }
  : { readonly metadata: TMetadata };

export type WalletTransaction<TAddress, TRawTransaction, TMetadata = never> = {
  /** Stable position used by message formats to associate a payment with its destination. */
  readonly index: number;
  readonly destination: TAddress;
  readonly value: bigint;
  readonly rawTransaction: TRawTransaction;
} & WalletTransactionMetadata<TMetadata>;

export interface WalletTransactionBundle<
  TAddress,
  TRawTransaction,
  TMetadata = never
> {
  /** Stable identity of the complete ordered payment plan, independent of transaction lifetime. */
  readonly bundleId: string;
  readonly source: TAddress;
  readonly transactions: ReadonlyArray<
    WalletTransaction<TAddress, TRawTransaction, TMetadata>
  >;
}

export interface SubmittedWalletTransaction<TAddress> {
  index: number;
  destination: TAddress;
  value: bigint;
  txId: string;
}

export interface WalletBundleSubmission<TAddress> {
  submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>;
}

export interface SubmitTransactionBundleOptions {
  /**
   * Skip an already reconciled prefix when resuming a non-atomic bundle. The caller must retain
   * or rebuild the complete bundle so implementations can still validate its signed positions.
   */
  startIndex?: number;
  /** Bundle id retained from the reconciled prefix; required when startIndex is nonzero. */
  expectedBundleId?: string;
}

import type { AccountHygieneEngine } from './account-hygiene';

/**
 * The common processing surface a chain wallet exposes to higher-level payment/message code.
 * Chain-specific build parameters and metadata remain generic rather than being flattened into a
 * misleading universal transaction format.
 */
export interface TransactionBundleCapability<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TTransferMetadata = never
> {
  readonly address: TAddress;
  getBalance(): Promise<bigint>;
  buildTransactionBundle(
    params: TTransferParams
  ): Promise<
    WalletTransactionBundle<TAddress, TRawTransaction, TTransferMetadata>
  >;
  submitTransactionBundle<TMetadata = TTransferMetadata>(
    bundle: WalletTransactionBundle<TAddress, TRawTransaction, TMetadata>,
    options?: SubmitTransactionBundleOptions
  ): Promise<WalletBundleSubmission<TAddress>>;
  /**
   * Internal autonomous account hygiene and dirty-account sweeper (Ticket #925).
   * Encapsulated beneath the wallet: callers interact with standard spend/bundle
   * methods while the hygiene engine maintains UTXO/account hygiene silently.
   */
  readonly hygiene?: AccountHygieneEngine<TAddress>;
}

/** An explicit capability layered on a wallet only when a reviewed stealth scheme is present. */
export interface StealthTransactionBundleCapability<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TStealthParams,
  TStealthMetadata
> extends TransactionBundleCapability<
    TAddress,
    TRawTransaction,
    TTransferParams
  > {
  buildStealthTransactionBundle(
    params: TStealthParams
  ): Promise<
    WalletTransactionBundle<TAddress, TRawTransaction, TStealthMetadata>
  >;
}

/** @deprecated Prefer TransactionBundleCapability; this is a capability, not the bundle data. */
export type TransactionBundleWallet<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TTransferMetadata = never
> = TransactionBundleCapability<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TTransferMetadata
>;

/** @deprecated Prefer StealthTransactionBundleCapability. */
export type StealthTransactionBundleWallet<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TStealthParams,
  TStealthMetadata
> = StealthTransactionBundleCapability<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TStealthParams,
  TStealthMetadata
>;

/**
 * A non-atomic bundle stopped after zero or more earlier transactions were accepted by the RPC.
 * The current transaction's outcome is indeterminate: a transport error can happen after the RPC
 * accepted it, so callers must reconcile `attempted.txId` before rebuilding or retrying.
 */
export class TransactionBundleSubmissionError<TAddress> extends Error {
  readonly submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>;
  readonly attempted: SubmittedWalletTransaction<TAddress>;
  readonly failedIndex: number;
  readonly reason: unknown;

  constructor(params: {
    submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>;
    attempted: SubmittedWalletTransaction<TAddress>;
    reason: unknown;
  }) {
    super(
      `transaction bundle submission outcome is unknown at index ${params.attempted.index}`
    );
    this.name = "TransactionBundleSubmissionError";
    this.submitted = [...params.submitted];
    this.attempted = params.attempted;
    this.failedIndex = params.attempted.index;
    this.reason = params.reason;
  }
}
