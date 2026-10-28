import type {
  OutgoingDelivery,
  OutgoingFailureReason,
} from '@frank/cashweb/types/messages'
import { fundsInPendingSendReasonText } from './funds-in-pending-send'
import { MAX_SENT_MESSAGE_BYTES } from './image-data-uri'
import { formatAttachmentSize } from './post-editor'

/**
 * Failure reasons of an outgoing message (`OutgoingFailureReason`) that a Retry cannot cure: the
 * wallet refused the message before anything was paid or handed out, and the same message is
 * refused the same way again. Such a message is offered Discard, not Retry.
 */
export function unretryableFailure(reason: string | undefined): boolean {
  return (
    reason === 'too-large' ||
    reason === 'unencodable' ||
    reason === 'payment-older-version'
  )
}

/**
 * Whether a failed outgoing message's delivery says nothing was paid for it: the wallet refused
 * it before any payment was signed or handed out. Its bubble does not show the stamp as if it
 * had been paid.
 *
 * An unretryable refusal (`unretryableFailure`) is made before anything of the attempt exists,
 * so it never records an attempt of its own. An attempt recorded on the message beside one is
 * therefore an earlier attempt of the same message (one an older version of the app made, for
 * example), which may have paid its stamp: then nothing says the stamp was not paid.
 */
export function failedBeforePayment(
  delivery:
    | Pick<OutgoingDelivery, 'failureReason' | 'attemptDigest'>
    | undefined,
): boolean {
  const reason = delivery?.failureReason
  if (unretryableFailure(reason)) return delivery?.attemptDigest === undefined
  return (
    reason === 'stamp-below-fee' ||
    reason === 'fee-exceeded' ||
    reason === 'payment-taken' ||
    reason === 'blocked' ||
    reason === 'funds-in-pending-send' ||
    reason === 'group-price-changed'
  )
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/** The unit a failure's amount (`detail`, decimal wei) is shown in. */
export interface FailureAmountUnit {
  toDisplayAmount(wei: bigint): string
  readonly unit: string
}

/**
 * The words for each failure reason when the failure kept no amount. Every reason has an entry
 * (the type requires it), so a reason added to `OutgoingFailureReason` cannot fall back to
 * generic words unnoticed. `error` has none: it says no more than "could not be sent".
 */
const FAILURE_REASON_KEYS: Record<OutgoingFailureReason, string | undefined> = {
  'unreachable': 'outgoing.reasonUnreachable',
  'unavailable': 'outgoing.reasonUnavailable',
  'rejected': 'outgoing.reasonRejected',
  'rejected-paid': 'outgoing.reasonRejectedPaid',
  'interrupted': 'outgoing.reasonInterrupted',
  'unverified': 'outgoing.reasonUnverified',
  'recovered': 'outgoing.reasonRecovered',
  'insufficient-funds': 'outgoing.reasonInsufficientFunds',
  'waiting-funds-or-chain': 'outgoing.reasonWaitingFundsOrChain',
  'funds-in-pending-send': 'outgoing.reasonFundsInPendingSendNoAmount',
  'recipient-unregistered': 'outgoing.reasonRecipientUnregistered',
  'group-price-changed': 'outgoing.reasonGroupPriceChangedNoAmount',
  'stamp-below-fee': 'outgoing.reasonStampBelowFee',
  'fee-exceeded': 'outgoing.reasonFeeExceeded',
  'payment-taken': 'outgoing.reasonPaymentTaken',
  'stamp-recovery-fee-required': 'outgoing.reasonStampRecoveryFeeRequired',
  'blocked': 'outgoing.reasonBlocked',
  'too-large': 'outgoing.reasonTooLarge',
  'unencodable': 'outgoing.reasonUnencodable',
  'payment-older-version': 'outgoing.reasonPaymentOlderVersion',
  'error': undefined,
}

const AMOUNT = /^[1-9]\d*$/

/**
 * Why an outgoing message failed, in the user's words, from its saved reason and `detail`: the
 * one mapping every view of a failed message uses (the chat bubble, a game's status line, an
 * email card). Undefined when the reason says no more than "could not be sent" (`error`) or is
 * unknown; the caller then says only that.
 */
export function outgoingFailureReasonText(
  reason: string | undefined,
  detail: string | undefined,
  t: Translate,
  chain: FailureAmountUnit,
): string | undefined {
  if (reason === undefined || !Object.hasOwn(FAILURE_REASON_KEYS, reason))
    return undefined
  const known = reason as OutgoingFailureReason
  // Larger than a message carries: names the limit the composer holds a message to.
  if (known === 'too-large')
    return t('outgoing.reasonTooLarge', {
      limit: formatAttachmentSize(MAX_SENT_MESSAGE_BYTES),
    })
  // Money of an earlier send not on the chain yet: how much, when the failure kept it.
  if (known === 'funds-in-pending-send')
    return fundsInPendingSendReasonText(
      detail,
      wei => `${chain.toDisplayAmount(wei)} ${chain.unit}`,
      t,
    )
  const amount =
    detail !== undefined && AMOUNT.test(detail)
      ? { amount: chain.toDisplayAmount(BigInt(detail)), unit: chain.unit }
      : undefined
  // A group's price rose above the one shown: names the new price its failure kept.
  if (known === 'group-price-changed' && amount)
    return t('outgoing.reasonGroupPriceChanged', amount)
  // A payment below the floor names the floor its failure kept.
  if (known === 'stamp-below-fee' && amount)
    return t('outgoing.reasonStampBelowFeeAmount', amount)
  const key = FAILURE_REASON_KEYS[known]
  return key === undefined ? undefined : t(key)
}
