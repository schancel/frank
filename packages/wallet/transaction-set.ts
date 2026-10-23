/** Family-neutral preparation request. Construction signs and durably claims inputs; it never
 * broadcasts. Hosts must persist their complete message before exposing signed bytes. */
export interface ConstructTransactionSetRequest {
  readonly operationId: string;
  readonly amountAtomic: bigint;
  /** EVM: exact 20-byte destination. Bitcoin family: exact locking script.
   * Indices refer only to recipient transactions/outputs, never wallet-owned change. */
  readonly kdf: (transactionIndex: number, outputIndex: number) => Uint8Array;
  /** Exact execution data. Families without calldata reject even an explicitly empty value. */
  readonly calldata?: Uint8Array;
  readonly maxNativeFeeAtomic?: bigint;
}

export interface TransactionSetRecipientOutput {
  /** Native output index for UTXO transactions; EVM's single recipient transfer uses slot 0. */
  readonly outputIndex: number;
  readonly destination: Uint8Array;
  readonly amountAtomic: bigint;
}

export interface TransactionSetMember {
  readonly index: number;
  readonly rawTransaction: Uint8Array;
  readonly txId: string;
  /** Only recipient value. Embedded UTXO change never appears here. */
  readonly recipientOutputs: readonly TransactionSetRecipientOutput[];
}

/** Plain signed data, without custody keys, transaction methods or lifecycle handles. */
export interface PreparedTransactionSet {
  readonly operationId: string;
  readonly chainIdentifier: string;
  readonly bundle: readonly TransactionSetMember[];
  /** Separate wallet-owned transactions, excluding change embedded in a recipient transaction. */
  readonly otherTransactions: readonly {
    readonly rawTransaction: Uint8Array;
    readonly txId: string;
  }[];
}

export interface TransactionSetCapability {
  constructTransactionSet(request: ConstructTransactionSetRequest): Promise<PreparedTransactionSet>;
}
