import type {
  SolanaPaymentRequest,
  SolanaPaymentOperation,
} from './solana-contact-payments/types'
import type { ExperimentalSolanaContactPayments } from './solana-contact-payments/engine'

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
  /** Same-chain message stamp reserved within this original payment operation. */
  readonly messageStamp?: {
    readonly amountAtomic: bigint
    readonly maxNativeFeeAtomic: bigint
  }
}

export interface PreparedStealthPayment {
  /** Stamp authorization belongs to this operation, not merely its wallet capability. */
  readonly messageStamp?: StealthPaymentIntent['messageStamp']
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

/** One signed transfer of a payment, as the wallet's operation journal last saw it on chain.
 * `unsent`: it has not left the wallet. `pending`: handed to the chain (or possibly handed),
 * not in a block yet. `landed`: in a block and successful. `failed`: it can never pay — it
 * reverted, or another transaction from the same account took its nonce. */
export interface StealthPaymentMemberStatus {
  readonly txHash: string
  readonly recipientAmountAtomic: bigint
  readonly state: 'unsent' | 'pending' | 'landed' | 'failed'
  readonly failure?: 'reverted' | 'replaced'
}

/** What the paying wallet's journal shows of one payment now. Read without asking the chain to
 * do anything: nothing is signed, submitted or released by reading it. */
export interface StealthPaymentStatus extends StealthPaymentProgress {
  /** Some transfer has been handed to the chain, or may have been. False: none left the wallet. */
  readonly submitted: boolean
  /** Cancelled before anything was handed to anyone: nothing was or can be paid. */
  readonly released?: true
  readonly members: readonly StealthPaymentMemberStatus[]
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
  /** Present only for a single-source quote. */
  readonly sourceAddress?: string
  /** Owner-frozen source allocations. Recipient amounts sum to amountAtomic;
   * top-level balances and estimated fee aggregate only these selected sources. */
  readonly sources?: readonly {
    readonly sourceAddress: string
    readonly recipientAmountAtomic: bigint
    readonly nativeBalanceAtomic: bigint
    readonly assetBalanceAtomic: bigint
    readonly estimatedNativeFeeAtomic: bigint
  }[]
  readonly nativeBalanceAtomic: bigint
  readonly assetBalanceAtomic: bigint
  readonly estimatedNativeFeeAtomic: bigint
  /** Quoted with a combined same-chain stamp (`messageStamp` of the quoted intent): the fee of
   * the one transfer that pays the stamp, the stamp's `maxNativeFeeAtomic` to approve.
   * `estimatedNativeFeeAtomic` then already counts what the payment does to keep the stamp
   * back, so the two together are exactly what the prepared payment and its stamp pay. */
  readonly messageStampFeeAtomic?: bigint
}

/** The payment would need more owned accounts than one operation may sign (16). Funds may be
 * sufficient; the amount is spread over too many coins. */
export class StealthPaymentMemberLimitError extends RangeError {
  constructor(readonly memberLimit: number) {
    super(`Payment cannot fit the ${memberLimit}-member limit`)
    this.name = 'StealthPaymentMemberLimitError'
  }
}

export interface StealthPaymentCapability {
  /** Native payment and same-chain stamp can share one immutable signed operation. */
  readonly supportsCombinedStamp?: true
  /** Read-only: how much of this asset a payment could draw on now, in atomic units. Records
   * nothing and reserves nothing. A wallet without it shows the amount only once quoted. */
  available?(asset: StealthPaymentAsset): Promise<bigint>
  /** Read-only chain observation; retains the operation's unsigned intent/derivation.
   * Does not sign, expose, submit, reserve funds, or authorize a fee ceiling. */
  quote?(
    intent: Omit<StealthPaymentIntent, 'maxNativeFeeAtomic' | 'messageStamp'> & {
      /** A combined same-chain stamp (`supportsCombinedStamp`, native only) to quote with the
       * payment; see `StealthPaymentQuote.messageStampFeeAtomic`. */
      readonly messageStamp?: { readonly amountAtomic: bigint }
    },
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
  /** Read-only: the journal's view of this payment (see `StealthPaymentStatus`); undefined for
   * an operation this wallet does not hold. A wallet without it cannot say. */
  status?(operationId: string): Promise<StealthPaymentStatus | undefined>
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

/** Additive Solana host declarations only. UI family-discriminated composition remains
 * a separate prerequisite; existing SECP interfaces retain their current public API. */
/** Recovery consumes owner operations without assuming a family's construction model. */
export interface StealthPaymentLifecycleCapability {
  /** The host binds the immutable sealed message digest before any external handoff. */
  expose(binding: {
    readonly operationId: string
    readonly payloadDigest: string
  }): Promise<void>
  submit(operationId: string): Promise<StealthPaymentProgress>
  reconcile(operationId: string): Promise<StealthPaymentProgress>
  /** Releases only an operation proven never exposed. Exposed uncertainty remains reserved. */
  release(operationId: string): Promise<boolean>
  /** Read-only recovery index under the operation owner; independent of chat/UI retention. */
  list(): Promise<
    readonly { readonly operationId: string; readonly payloadDigest?: string }[]
  >
}

/** Per-member derivation and explicit fee/rent policy remain with the Solana owner.
 * This declaration does not install an adapter or enable an application flow. */
export interface SolanaStealthPaymentCapability
  extends StealthPaymentLifecycleCapability {
  readonly family: 'solana'
  quoteReview(
    request: SolanaPaymentRequest,
  ): Promise<Readonly<SolanaPaymentOperation>>
  prepare(operationId: string): Promise<Readonly<SolanaPaymentOperation>>
  get(
    operationId: string,
  ): Promise<Readonly<SolanaPaymentOperation> | undefined>
}

/** Incoming Solana evidence is recorded and reconciled per original/member context.
 * The existing owner's methods keep its durable format and finality rules authoritative. */
export interface SolanaStealthPaymentReceiptCapability
  extends Pick<
    ExperimentalSolanaContactPayments,
    | 'recordIncomingClaim'
    | 'rebroadcastIncoming'
    | 'reconcileIncoming'
    | 'incomingProgress'
  > {
  readonly family: 'solana'
}
