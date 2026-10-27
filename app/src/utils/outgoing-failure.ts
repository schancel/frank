/**
 * Failure reasons of an outgoing message (`OutgoingFailureReason`) that a Retry cannot cure: the
 * wallet refused the message before anything was paid or handed out, and the same message is
 * refused the same way again. Such a message is offered Discard, not Retry.
 */
export function unretryableFailure(reason: string | undefined): boolean {
  return reason === 'too-large' || reason === 'unencodable'
}
