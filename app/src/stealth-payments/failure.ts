import { describeWalletFailure } from '@frank/wallet/wallet-failure'

/** The financial owner proved the prepared payment was never handed to anyone who could
 * broadcast it, and released it. Only then may the user be told that nothing was sent. */
export class StealthPaymentNotSentError extends Error {
  constructor(readonly failure: unknown) {
    super(`Released before it was handed to messaging: ${String(failure)}`)
    this.name = 'StealthPaymentNotSentError'
  }
}

/** The message for a failure before any signed payment left the financial owner: reviewing
 * (read-only quotes) or a preparation the owner released. Provider and relay text (an ethers
 * dump with URLs and response bodies) stays in the console, never on screen. */
export function notSentFailureKey(error: unknown): string {
  const failure = describeWalletFailure(error)
  // A throttled or unreachable RPC: the chain's provider is busy, not the payment wrong.
  if (failure.retry === 'transient') return 'sendStealthDialog.networkBusy'
  if (failure.kind === 'insufficient-funds' || error instanceof RangeError)
    return 'sendStealthDialog.insufficientFunds'
  return 'sendStealthDialog.notSent'
}

/** The message for a failed send. Once the prepared payment was adopted by messaging (or its
 * release could not be proven) a signed transaction may have been exposed: a timeout or a 429
 * is no proof it did not land, so the message never says that nothing was sent. */
export function sendFailureKey(error: unknown): string {
  return error instanceof StealthPaymentNotSentError
    ? notSentFailureKey(error.failure)
    : 'sendStealthDialog.messageEnded'
}
