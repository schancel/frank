/**
 * Failure reasons of an outgoing message (`OutgoingFailureReason`) that a Retry cannot cure: the
 * wallet refused the message before anything was paid or handed out, and the same message is
 * refused the same way again. Such a message is offered Discard, not Retry.
 */
export function unretryableFailure(reason: string | undefined): boolean {
  return reason === 'too-large' || reason === 'unencodable'
}

/**
 * Failure reasons of an outgoing message that say nothing was paid for it
 * (`OutgoingFailureReason`): the wallet refused it before any payment was signed or handed out.
 * Its bubble does not show the stamp as if it had been paid.
 */
export function failedBeforePayment(reason: string | undefined): boolean {
  return (
    reason === 'too-large' ||
    reason === 'unencodable' ||
    reason === 'stamp-below-fee' ||
    reason === 'fee-exceeded' ||
    reason === 'blocked' ||
    reason === 'funds-in-pending-send' ||
    reason === 'group-price-changed'
  )
}
