import {
  CanonicalMessagingPendingError,
  CanonicalMessageItemsNotInstalledError,
} from '@frank/wallet/chain'
import { describeWalletFailure } from '@frank/wallet/wallet-failure'
import { OpenDirectoryError } from '@frank/cashweb/relay/open-directory'

export type OutgoingRetryDecision =
  | {
      readonly kind: 'retry-messaging'
      readonly readyTimeoutMs: 5000
      readonly delayMs: number
    }
  | { readonly kind: 'retry-transport'; readonly delayMs: number }
  | { readonly kind: 'queue-unattempted' }
  | { readonly kind: 'fail' }

/** Classifies the next action only. The caller owns timing, original-attempt evidence,
 * persistence and exposure; retryability never establishes that a call had no effect. */
export function decideOutgoingRetry(
  error: unknown,
  {
    ownDigest,
    sendAttempt,
    maxSendAttempts,
    allCallsUnattempted,
    isCurrent: stillCurrent,
  }: {
    readonly ownDigest: string | undefined
    readonly sendAttempt: number
    readonly maxSendAttempts: number
    readonly allCallsUnattempted: boolean
    readonly isCurrent: () => boolean
  },
): OutgoingRetryDecision {
  const failure = describeWalletFailure(error)
  if (failure.retry === 'forbidden') return { kind: 'fail' }
  let isPendingMessaging = false
  let isDirectoryUnreachable = false
  // Owning-class checks may invoke a Proxy's prototype trap. Unknown rejections
  // must not turn classification into another exception or permission to retry.
  try {
    isPendingMessaging =
      error instanceof CanonicalMessagingPendingError ||
      error instanceof CanonicalMessageItemsNotInstalledError
    if (error instanceof OpenDirectoryError) {
      if (error.code !== 'unreachable' || error.retry !== 'transient')
        return { kind: 'fail' }
      isDirectoryUnreachable = true
    }
  } catch {
    return { kind: 'fail' }
  }
  if (
    isPendingMessaging &&
    ownDigest === undefined &&
    sendAttempt < maxSendAttempts &&
    stillCurrent()
  ) {
    return {
      kind: 'retry-messaging',
      readyTimeoutMs: 5_000,
      delayMs: sendAttempt * 500,
    }
  }

  const isTransientRpc = failure.retry === 'transient' || isDirectoryUnreachable

  if (
    isTransientRpc &&
    ownDigest === undefined &&
    sendAttempt < maxSendAttempts &&
    stillCurrent()
  ) {
    return { kind: 'retry-transport', delayMs: sendAttempt * 500 }
  }

  if (isTransientRpc && allCallsUnattempted && stillCurrent()) {
    return { kind: 'queue-unattempted' }
  }
  return { kind: 'fail' }
}
