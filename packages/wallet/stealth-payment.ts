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
  /** Wire destination: EVM address bytes, or the Bitcoin-family output locking script. */
  readonly recipientDestination: Uint8Array
  readonly recipientSpendPublicKey: Uint8Array
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

/** An unsigned observation of one immutable payment intent, not a spend reservation. */
export interface StealthPaymentQuote {
  readonly operationId: string
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  readonly amountAtomic: bigint
  readonly recipientAddress: string
  readonly recipientDestination: Uint8Array
  readonly recipientSpendPublicKey: Uint8Array
  readonly ephemeralPublicKey: Uint8Array
  readonly sourceAddress?: string
  readonly nativeBalanceAtomic: bigint
  readonly assetBalanceAtomic: bigint
  readonly estimatedNativeFeeAtomic: bigint
}

export interface StealthPaymentCapability {
  /** Read-only chain observation; retains the operation's unsigned intent/derivation.
   * Does not sign, expose, submit, reserve funds, or authorize a fee ceiling. */
  quote?(
    intent: Omit<StealthPaymentIntent, 'maxNativeFeeAtomic'>,
  ): Promise<StealthPaymentQuote>
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
  /** Read-only recovery index under the operation owner; independent of chat/UI retention. */
  list(): Promise<
    readonly { readonly operationId: string; readonly payloadDigest?: string }[]
  >
}

/** A claim locates funds; the adapter must verify derivation, transactions and chain state. */
export interface StealthPaymentReceiptClaim {
  readonly chainIdentifier: string
  readonly asset: StealthPaymentAsset
  /** Family-native wire destination bytes, compared with the derived address/script by its owner. */
  readonly recipientDestination: Uint8Array
  readonly ephemeralPublicKey: Uint8Array
  readonly amountAtomic: bigint
  /** Canonical wire transaction bytes: nonempty, even-length lowercase hex without 0x. */
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
  /** Requires matching durable claim evidence; submits its original signed bytes unchanged.
   * Never signs, funds a new account, or interprets uncertain submission as failure to pay. */
  submit(claim: StealthPaymentReceiptClaim): Promise<void>
  /** Reads current chain evidence. An unavailable observation must reject, not invent zero. */
  observe(
    claim: StealthPaymentReceiptClaim,
  ): Promise<StealthPaymentReceiptObservation>
}
