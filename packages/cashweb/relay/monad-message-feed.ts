/**
 * Recipient inbox poll for Monad direct messages (ticket #37's discovery feed, migrated to the
 * authenticated mailbox in PR #197).
 *
 * The old `GET /message/monad?since=<t>` global feed no longer exists. The relay now serves only
 * the caller's own inbox, and only against a per-request identity-key signature -- see
 * `./monad-mailbox-client.ts` for the exact wire contract (challenge, preimage, headers, cursors,
 * retry/error semantics). This module keeps the historical entry point and return shape
 * (`StoredMonadMessageProto[]`, ordered by `(timestamp, payload_hash)` ascending, `since` bound
 * inclusive) so `MonadChain.directMessages.fetchSince` and the bots keep working; what changed is
 * that the caller must now say *whose* inbox to read and provide the signing callback.
 */
import {
  MailboxAuthParams,
  MonadMailboxError,
  fetchMonadMailboxInbox,
} from './monad-mailbox-client'
// Ticket #53 (package split): the one back-edge from @frank/cashweb to @frank/wallet in this
// codebase -- type-only (erased at compile time, no runtime coupling) since this type is really
// `MonadStampClient`'s own decoded-message shape (`../../wallet/monad-stamp-client.ts`), not
// something relay/message-feed logic defines itself. `@frank/wallet` is a devDependency here
// purely for this type.
import type { StoredMonadMessageProto } from '@frank/wallet/monad-stamp-client'

/**
 * Every message the relay has delivered to `params.recipient` at or after `sinceMs` (milliseconds
 * since the Unix epoch), ordered by `(timestamp, payload_hash)` ascending, de-duplicated by
 * payload hash.
 *
 * Throws {@link MonadMailboxError} subclasses on failure -- notably
 * `MonadMailboxUnavailableError` when the relay has no mailbox (never an empty result). If a
 * page after the first fails, a prefix ending on a complete timestamp group is returned (so `since = lastTimestamp + 1` never skips rows; if no complete group exists the error is thrown) and `onTruncated` (if given) is told
 * why; the next poll continues from the newest returned timestamp.
 */
export async function fetchMonadMessagesSince(
  params: MailboxAuthParams & {
    sinceMs: number
    /** Rows per page, 1..100 (default 100, the relay maximum). */
    pageLimit?: number
    onTruncated?: (reason: MonadMailboxError) => void
  },
): Promise<StoredMonadMessageProto[]> {
  const { onTruncated, ...rest } = params
  const result = await fetchMonadMailboxInbox(rest)
  if (result.truncatedBy !== undefined) onTruncated?.(result.truncatedBy)
  return result.messages
}
