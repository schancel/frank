/**
 * Chain-neutral transaction-bundle vocabulary.
 *
 * A bundle is ordered but is not assumed to be atomic: account chains generally submit each
 * signed transaction separately, just as the legacy UTXO wallet broadcasts every member of its
 * transaction set. Implementations must therefore report the successfully submitted prefix when
 * a later member fails.
 */
export interface WalletTransaction<TAddress, TRawTransaction, TMetadata = never> {
  /** Stable position used by message formats to associate a payment with its destination. */
  index: number
  destination: TAddress
  value: bigint
  rawTransaction: TRawTransaction
  metadata?: TMetadata
}

export interface WalletTransactionBundle<
  TAddress,
  TRawTransaction,
  TMetadata = never,
> {
  source: TAddress
  transactions: ReadonlyArray<
    WalletTransaction<TAddress, TRawTransaction, TMetadata>
  >
}

export interface SubmittedWalletTransaction<TAddress> {
  index: number
  destination: TAddress
  value: bigint
  txId: string
}

export interface WalletBundleSubmission<TAddress> {
  submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>
}

/**
 * The common processing surface a chain wallet exposes to higher-level payment/message code.
 * Chain-specific build parameters and metadata remain generic rather than being flattened into a
 * misleading universal transaction format.
 */
export interface TransactionBundleWallet<
  TAddress,
  TRawTransaction,
  TTransferParams,
  TStealthParams,
  TTransferMetadata = never,
  TStealthMetadata = never,
> {
  readonly address: TAddress
  getBalance(): Promise<bigint>
  buildTransactionBundle(
    params: TTransferParams,
  ): Promise<
    WalletTransactionBundle<TAddress, TRawTransaction, TTransferMetadata>
  >
  buildStealthTransactionBundle(
    params: TStealthParams,
  ): Promise<
    WalletTransactionBundle<TAddress, TRawTransaction, TStealthMetadata>
  >
  submitTransactionBundle(
    bundle: WalletTransactionBundle<
      TAddress,
      TRawTransaction,
      TTransferMetadata | TStealthMetadata
    >,
  ): Promise<WalletBundleSubmission<TAddress>>
}

/** A non-atomic bundle failed after zero or more earlier transactions were accepted by the RPC. */
export class TransactionBundleSubmissionError<TAddress> extends Error {
  readonly submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>
  readonly failedIndex: number
  readonly reason: unknown

  constructor(params: {
    submitted: ReadonlyArray<SubmittedWalletTransaction<TAddress>>
    failedIndex: number
    reason: unknown
  }) {
    super(`transaction bundle submission failed at index ${params.failedIndex}`)
    this.name = 'TransactionBundleSubmissionError'
    this.submitted = [...params.submitted]
    this.failedIndex = params.failedIndex
    this.reason = params.reason
  }
}
