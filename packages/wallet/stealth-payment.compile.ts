/** Compile-time boundary checks; no adapter is installed by declaring a capability. */
import type {
  PreparedStealthPayment,
  StealthPaymentCapability,
  SolanaStealthPaymentCapability,
  SolanaStealthPaymentReceiptCapability,
  StealthPaymentIntent,
  StealthPaymentReceiptClaim,
} from './stealth-payment'
import type { SolanaPaymentOperation } from './solana-contact-payments/types'
import type { SolanaReceiptClaim } from './solana-contact-payments/receipt'
import type { ExperimentalSolanaContactPayments } from './solana-contact-payments/engine'
import type { recipientAssetPaymentFromPrepared } from './message-item-plugins/stealth-asset/from-prepared'

type Assert<T extends true> = T
type Assignable<A, B> = [A] extends [B] ? true : false
type Not<T extends boolean> = T extends true ? false : true

export type StealthFamilyBoundaryAssertions = [
  Assert<Not<Assignable<SolanaPaymentOperation, PreparedStealthPayment>>>,
  Assert<
    Not<
      Assignable<
        SolanaPaymentOperation,
        Parameters<typeof recipientAssetPaymentFromPrepared>[0]
      >
    >
  >,
  Assert<
    Not<
      Assignable<
        StealthPaymentIntent,
        Parameters<SolanaStealthPaymentCapability['prepare']>[0]
      >
    >
  >,
  Assert<
    Assignable<string, Parameters<SolanaStealthPaymentCapability['prepare']>[0]>
  >,
  Assert<
    Assignable<
      PreparedStealthPayment,
      Awaited<ReturnType<StealthPaymentCapability['prepare']>>
    >
  >,
  Assert<
    Assignable<
      ExperimentalSolanaContactPayments['quoteReview'],
      SolanaStealthPaymentCapability['quoteReview']
    >
  >,
  Assert<
    Assignable<
      ExperimentalSolanaContactPayments['prepare'],
      SolanaStealthPaymentCapability['prepare']
    >
  >,
  Assert<Not<Assignable<SolanaReceiptClaim, StealthPaymentReceiptClaim>>>,
  Assert<Not<Assignable<StealthPaymentReceiptClaim, SolanaReceiptClaim>>>,
  Assert<
    Assignable<
      ExperimentalSolanaContactPayments,
      Omit<SolanaStealthPaymentReceiptCapability, 'family'>
    >
  >,
]
