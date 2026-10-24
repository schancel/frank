import { CanonicalMessagingPendingError } from '@frank/wallet/chain'

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
  const isPendingMessaging =
    (typeof CanonicalMessagingPendingError === 'function' &&
      error instanceof CanonicalMessagingPendingError) ||
    (error instanceof Error &&
      (error.name === 'CanonicalMessagingPendingError' ||
        error.name === 'CanonicalMessageItemsNotInstalledError'))
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

  const errorStr =
    String(error) +
    (error instanceof Error ? ' ' + error.message : '') +
    (typeof error === 'object' && error !== null && 'info' in error
      ? ' ' + JSON.stringify((error as { info: unknown }).info)
      : '')
  const isDirectoryUnreachable =
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'OpenDirectoryError' &&
    (error as { code?: unknown }).code === 'unreachable'
  const transportError =
    typeof error === 'object' && error !== null
      ? (error as {
          code?: unknown
          status?: unknown
          statusCode?: unknown
        })
      : undefined
  const isTransientRpc =
    isDirectoryUnreachable ||
    ['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 429].some(
      code => transportError?.code === code,
    ) ||
    transportError?.status === 429 ||
    transportError?.statusCode === 429 ||
    errorStr.includes('502') ||
    errorStr.includes('503') ||
    errorStr.includes('504') ||
    errorStr.includes('429') ||
    errorStr.includes('SERVER_ERROR') ||
    errorStr.includes('TIMEOUT') ||
    errorStr.includes('invalid_rpc_upstream_response') ||
    errorStr.includes('rpc_upstream_unavailable') ||
    errorStr.includes('network') ||
    errorStr.includes('failed to fetch') ||
    errorStr.includes('Failed to fetch')

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
