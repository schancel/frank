import { ChainUnreachableError } from '@frank/wallet/evm-block-watcher'
import { ForumRelayResponseError } from '@frank/wallet/evm-forum-operation'
import { EvmTransactionSetInsufficientFundsError } from '@frank/wallet/evm-transaction-set-types'

/** Why a vote or post did not go through, in terms the person can act on. */
export type ForumFailureReason =
  | 'no-funds'
  | 'post-not-on-relay'
  | 'relay-refused'
  | 'network'
  | 'unknown'

/** Walks the error and its causes (the wallet wraps the original error) for a known reason. */
export function forumFailureReason(err: unknown): ForumFailureReason {
  let current: unknown = err
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof EvmTransactionSetInsufficientFundsError)
      return 'no-funds'
    if (current instanceof ForumRelayResponseError)
      return current.code === 'topic_target_not_found'
        ? 'post-not-on-relay'
        : 'relay-refused'
    if (current instanceof ChainUnreachableError) return 'network'
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined
  }
  return 'unknown'
}

const KEYS: Record<ForumFailureReason, string> = {
  'no-funds': 'stampPreparation.failedNoFunds',
  'post-not-on-relay': 'stampPreparation.failedPostNotOnRelay',
  'relay-refused': 'stampPreparation.failedRelayRefused',
  'network': 'stampPreparation.failedNetwork',
  'unknown': 'stampPreparation.failedUnknown',
}

/** The plain-words line shown where "Voting…" or "Posting…" was. */
export function forumFailureText(
  err: unknown,
  t: (key: string) => string,
): string {
  return t(KEYS[forumFailureReason(err)])
}

/** After this long without an answer the status says so instead of spinning. */
export const FORUM_SLOW_MS = 30_000
