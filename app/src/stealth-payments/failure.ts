import { describeWalletFailure } from '@frank/wallet/wallet-failure'
import { StealthPaymentMemberLimitError } from '@frank/wallet/stealth-payment'
import { ContactPaymentBelowFloorError } from '@frank/wallet/chain/chain-wallet'
import { formatStealthAmount, type StealthAssetOption } from './options'
import { fundsInPendingSend } from '@frank/wallet/evm-transaction-set-types'
import { fundsInPendingSendMessage } from '../utils/funds-in-pending-send'

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
  // The money is in an earlier send's change not on the chain yet: try again in a moment.
  if (fundsInPendingSend(error))
    return 'outgoing.reasonFundsInPendingSendNoAmount'
  if (failure.kind === 'insufficient-funds')
    return 'sendStealthDialog.insufficientFunds'
  if (error instanceof StealthPaymentMemberLimitError)
    return 'sendStealthDialog.tooManyCoins'
  // Below the payment floor: named with the minimum (`notSentFailureFloorWei`), as Send to
  // Contact names it.
  if (error instanceof ContactPaymentBelowFloorError)
    return 'sendContactDialog.belowMinimum'
  // Anything else: the generic message; the caller logs the detail to the console.
  return 'sendStealthDialog.notSent'
}

/** The payment floor a payment was refused below, which `notSentFailureKey`'s message names
 * as `{amount}`; undefined for any other failure. */
export function notSentFailureFloorWei(error: unknown): bigint | undefined {
  const failure =
    error instanceof StealthPaymentNotSentError ? error.failure : error
  return failure instanceof ContactPaymentBelowFloorError
    ? failure.floorWei
    : undefined
}

/** `notSentFailureKey`'s message, translated by `t`. A payment refused below the payment floor
 * names the minimum in the native unit of the payment's asset (`assetOf`, asked only then), as
 * Send to Contact does; without the asset to name it in, the generic message. */
export function notSentFailureMessage(
  error: unknown,
  assetOf: () =>
    | Pick<StealthAssetOption, 'nativeUnit' | 'nativeDecimals'>
    | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const failure =
    error instanceof StealthPaymentNotSentError ? error.failure : error
  const floorWei = notSentFailureFloorWei(failure)
  // Money held by an earlier send names its amount, in the payment's native unit.
  if (fundsInPendingSend(failure)) {
    const option = assetOf()
    return (
      (option &&
        fundsInPendingSendMessage(
          failure,
          wei =>
            `${formatStealthAmount(wei, option.nativeDecimals)} ${
              option.nativeUnit
            }`,
          t,
        )) ??
      t(notSentFailureKey(failure))
    )
  }
  if (floorWei === undefined) return t(notSentFailureKey(failure))
  const option = assetOf()
  if (!option) return t('sendStealthDialog.notSent')
  return t(notSentFailureKey(failure), {
    amount: `${formatStealthAmount(floorWei, option.nativeDecimals)} ${
      option.nativeUnit
    }`,
  })
}

/** The message for a failed send. Once the prepared payment was adopted by messaging (or its
 * release could not be proven) a signed transaction may have been exposed: a timeout or a 429
 * is no proof it did not land, so the message never says that nothing was sent. */
/** Whether the payment was refused because its money is still in an earlier send's change
 * (`FundsInPendingSendError`), released unsent or not. */
export function refusedForPendingSend(error: unknown): boolean {
  return (
    fundsInPendingSend(
      error instanceof StealthPaymentNotSentError ? error.failure : error,
    ) !== undefined
  )
}

export function sendFailureKey(error: unknown): string {
  // Refused at construction for money still in an earlier send: nothing was signed for it.
  if (refusedForPendingSend(error))
    return 'outgoing.reasonFundsInPendingSendNoAmount'
  return error instanceof StealthPaymentNotSentError
    ? notSentFailureKey(error.failure)
    : 'sendStealthDialog.messageEnded'
}
