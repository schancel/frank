/** Financial operations only. The host owns message encoding, encryption and delivery. */
export type StealthPaymentAsset =
  | { readonly kind: 'native' }
  | { readonly kind: 'erc20'; readonly contractAddress: string }

export interface StealthPaymentIntent {
  readonly operationId: string
  /** Exact protocol registry identifier; never a family or presentation alias. */
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  /** The recipient's authenticated, published spend identity. */
  readonly recipientSpendPublicKey: Uint8Array
  readonly amountAtomic: bigint
  /** Native transaction fees are separate from the transferred asset and message stamp. */
  readonly maxNativeFeeAtomic: bigint
  readonly sourceAddress?: string
}

export interface PreparedStealthPayment {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  readonly amountAtomic: bigint
  readonly recipientAddress: string
  readonly ephemeralPublicKey: Uint8Array
  readonly members: readonly {
    readonly rawTransaction: string
    readonly txHash: string
    readonly recipientAmountAtomic: bigint
    readonly vout?: number
  }[]
}

export interface StealthPaymentProgress {
  /** An uncertain submission remains pending. Failure is not permission to spend again. */
  readonly status: 'pending' | 'partial' | 'succeeded' | 'failed'
  readonly intendedAmountAtomic: bigint
  /** Absent until chain evidence establishes a received amount. Never inferred from delivery. */
  readonly verifiedReceivedAmountAtomic?: bigint
  readonly nativeFeeAtomic?: bigint
}

export interface StealthPaymentCapability {
  /** Reserves inputs and durably saves signed bytes without submitting them. */
  prepare(intent: StealthPaymentIntent): Promise<PreparedStealthPayment>
  /** The host binds the immutable sealed message digest before any external handoff. */
  expose(binding: {
    readonly operationId: string
    readonly payloadDigest: string
  }): Promise<void>
  submit(operationId: string): Promise<StealthPaymentProgress>
  reconcile(operationId: string): Promise<StealthPaymentProgress>
  /** Releases only an operation proven never exposed. Exposed uncertainty remains reserved. */
  release(operationId: string): Promise<boolean>
  get(operationId: string): Promise<PreparedStealthPayment | undefined>
}

/** A claim locates funds; the adapter must verify derivation, transactions and chain state. */
export interface StealthPaymentReceiptClaim {
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  readonly recipientAddress: string
  readonly ephemeralPublicKey: Uint8Array
  readonly amountAtomic: bigint
  readonly rawTransactions: readonly string[]
  readonly payloadDigest: string
}

export interface StealthPaymentReceiptObservation
  extends StealthPaymentProgress {
  /** Receipt and ability to spend are independent: a token receipt need not carry native gas. */
  readonly spendability:
    | 'pending'
    | 'spendable'
    | 'reserved'
    | 'empty'
    | 'needs-native-gas'
}

export interface StealthPaymentReceiptCapability {
  /** Idempotently records derivation/claim evidence; never credits a claimed amount as funds. */
  record(claim: StealthPaymentReceiptClaim): Promise<void>
  /** Reads current chain evidence. An unavailable observation must reject, not invent zero. */
  observe(
    claim: StealthPaymentReceiptClaim,
  ): Promise<StealthPaymentReceiptObservation>
}
