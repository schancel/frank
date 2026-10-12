/** Experimental, uncomposed Solana payment owner. No custody secrets are stored here. */
export type SolanaPaymentAsset =
  | { kind: 'native' }
  | { kind: 'spl'; mint: string; program: string; decimals: number }

export interface SolanaPaymentRequest {
  operationId: string
  chainIdentifier: string
  recipientSpendPoint: string
  asset: SolanaPaymentAsset
  amount: string
  allowDestinationAtaCreation: boolean
}

export interface SolanaPaymentIntent extends SolanaPaymentRequest {
  maxFeeLamports: string
  maxRentLamports: string
  maxNativeDebitLamports: string
}

export interface SolanaPaymentMemberContext {
  cryptoOperationId32: string
  derivationContext32: string
  memberIndex: number
}

export interface SolanaPaymentDestination {
  recipientPoint: string
  ephemeralPoint: string
  destinationOwner: string
}

export interface SolanaSpendPosition {
  /** Native account or classic SPL token account; never an EVM nonce. */
  address: string
  owner: string
  asset: SolanaPaymentAsset
  balance: string
  observedSlot: number
  /** Installed only by finalized settlement, never by an incoming receipt. */
  postSpendSignature?: string
  signingReference: SolanaSigningReference
  /** A reserved account is exclusive to one operation, including its native fee use. */
  reservedBy?: string
}

export type SolanaSigningReference =
  | { kind: 'primary' }
  | { kind: 'received'; descriptor: {
    chainIdentifier: string
    asset: SolanaPaymentAsset
    recipientSpendPoint: string
    ephemeralPoint: string
    cryptoOperationId32: string
    derivationContext32: string
    memberIndex: number
    recipientAmount: string
    publicKey: string
  } }

export interface SolanaPaymentReviewEvidence {
  /** Unreserved immutable proposal; prepare claims these exact sources or fails. */
  sourceAddresses: string[]
  blockhash: string
  lastValidBlockHeight: number
  /** Exact unsigned version-0 message quoted by canonical RPC. */
  message: string
  feeLamports: string
  rentLamports: string
}

export interface SolanaPaymentMember {
  amount: string
  destination?: SolanaPaymentDestination
  sourceAddresses: string[]
  createDestinationAta: boolean
  rentLamports: string
  maxFeeLamports: string
  maxRentLamports: string
  maxNativeDebitLamports: string
  review: SolanaPaymentReviewEvidence
}

export interface SolanaPaymentDraftMember {
  amount: string
  plannedSources: string[]
  estimatedFeeLamports: string
  destination?: SolanaPaymentDestination
}

/** Public derivation inputs, shared by incomplete review and complete operation. */
export interface SolanaPaymentPlan {
  intent: SolanaPaymentRequest
  contexts: SolanaPaymentMemberContext[]
  members: { amount: string; destination?: SolanaPaymentDestination }[]
}

export interface SolanaPaymentDraft extends SolanaPaymentPlan {
  phase: 'quoting'
  members: SolanaPaymentDraftMember[]
  sourceAddresses: []
  signed: []
  outcomes: Record<string, never>
}
export type SolanaPaymentRecord = SolanaPaymentDraft | SolanaPaymentOperation

export interface SolanaSignedPayment {
  memberIndex: number
  sourceOwner: string
  signature: string
  /** Canonical base64, complete signed original. No replacement after persistence. */
  transaction: string
  blockhash: string
  lastValidBlockHeight: number
  sourceAddresses: string[]
  destination: SolanaPaymentDestination
  amount: string
  feeLamports: string
  rentLamports: string
}

export interface SolanaPaymentOperation {
  intent: SolanaPaymentIntent
  contexts: SolanaPaymentMemberContext[]
  members: SolanaPaymentMember[]
  phase: 'quoted' | 'reserved' | 'signed' | 'exposed' | 'settled'
  sourceAddresses: string[]
  signed: SolanaSignedPayment[]
  payloadDigest?: string
  outcomes: Record<string, 'confirmed' | 'failed'>
}

/** Authenticated original evidence, never an available coin until finalized verification. */
export interface SolanaIncomingPayment {
  signature: string
  chainIdentifier: string
  asset: SolanaPaymentAsset
  amount: string
  destination: SolanaPaymentDestination
  context: SolanaPaymentMemberContext
  transaction: string
  payloadDigest: string
  status: 'pending' | 'confirmed' | 'failed'
  finalizedSlot?: number
  credit?: 'imported' | 'already-imported' | 'retired'
}

export interface SolanaPaymentSnapshot {
  format: 4
  walletId: string
  chainIdentifier: string
  positions: Record<string, SolanaSpendPosition>
  retiredThrough: Record<string, number>
  operations: Record<string, SolanaPaymentRecord>
  incoming: Record<string, SolanaIncomingPayment>
}

/** Atomic across all clients of this persistent namespace, not an engine-local mutex.
 * Callbacks are synchronous and contain no RPC/signing. Implementations must durably
 * commit before resolving; failed writes must leave the previous snapshot intact. */
export interface SolanaPaymentPersistence {
  read(): Promise<unknown | undefined>
  update<T>(mutate: (previous: unknown | undefined) => { value: SolanaPaymentSnapshot; result: T }): Promise<T>
}
