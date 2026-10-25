/** Family-neutral preparation request. Construction signs and durably claims inputs; it never
 * broadcasts. Hosts must persist their complete message before exposing signed bytes. */
export interface ConstructTransactionSetRequest {
  readonly operationId: string
  readonly amountAtomic: bigint
  /** EVM: exact 20-byte destination. Bitcoin family: exact locking script.
   * Indices refer only to recipient transactions/outputs, never wallet-owned change. */
  readonly kdf: (transactionIndex: number, outputIndex: number) => Uint8Array
  /** Exact execution data. Families without calldata reject even an explicitly empty value. */
  readonly calldata?: Uint8Array
  readonly maxNativeFeeAtomic?: bigint
  /** At most this many recipient transactions in `bundle`, for a consumer whose protocol
   * accepts a fixed number of payments (a group write carries exactly one). Construction fails
   * with insufficient funds rather than exceed it. */
  readonly maxRecipientTransactions?: number
}

export interface TransactionSetRecipientOutput {
  /** Native output index for UTXO transactions; EVM's single recipient transfer uses slot 0. */
  readonly outputIndex: number
  readonly destination: Uint8Array
  readonly amountAtomic: bigint
}

export interface TransactionSetMember {
  readonly index: number
  readonly rawTransaction: Uint8Array
  readonly txId: string
  /** Only recipient value. Embedded UTXO change never appears here. */
  readonly recipientOutputs: readonly TransactionSetRecipientOutput[]
}

/** Plain signed data, without custody keys, transaction methods or lifecycle handles. */
export interface PreparedTransactionSet {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly bundle: readonly TransactionSetMember[]
  /** Separate wallet-owned transactions, excluding change embedded in a recipient transaction. */
  readonly otherTransactions: readonly {
    readonly rawTransaction: Uint8Array
    readonly txId: string
  }[]
}

/** Submission/recovery reports every owned change member as well as recipient payments. */
export interface TransactionSetSubmission {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly status: 'pending' | 'confirmed' | 'failed'
  readonly pendingTransactionIds: readonly string[]
  readonly failedTransactionIds: readonly string[]
  readonly pendingReason?:
    | 'dependency-pending'
    | 'submission-uncertain'
    | 'observation-unavailable'
}

export interface TransactionSetCapability {
  constructTransactionSet(
    request: ConstructTransactionSetRequest,
  ): Promise<PreparedTransactionSet>
  sendTransaction(
    prepared: PreparedTransactionSet,
  ): Promise<TransactionSetSubmission>
  /** Give back the inputs of a constructed set that was never submitted: first read the chain
   * for every member, then release only if none was authorized or exposed and the node shows
   * none of them, pending or included. Returns false, keeping every claim, otherwise. */
  releaseTransactionSet(operationId: string): Promise<boolean>
  /** Read the chain for every member of a constructed set: true when the node shows any of
   * them pending or included. Changes no claim. */
  observeTransactionSet(operationId: string): Promise<boolean>
}
