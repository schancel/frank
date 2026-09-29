/**
 * Feeds `activeChain.directMessages` into the Pinia chat/contact stores (ticket #42 -- see
 * `PLAN.md`'s M9 section). Mirrors `./pinia-relay-adapter.ts`'s role (the business-logic layer a
 * boot file wires up at startup, see `src/boot/monad-direct-messages.ts`) but for the Monad
 * poll-based direct-message client instead of the old Lotus `RelayClient`'s WS push events.
 *
 * ## Why a poll loop lives here, not in `stores/chats.ts`
 *
 * `chats.ts`'s own `receiveMessages` action is left unchanged (per issue #42's own framing:
 * "chats.ts is mostly pure state management driven by already-parsed message objects passed in
 * from a caller"). Polling is a side-effecting, interval-driven concern that doesn't belong in a
 * Pinia action itself (nothing else in this codebase's stores owns a `setInterval`), so it lives
 * here alongside `pinia-relay-adapter.ts`'s own equivalent event-wiring role.
 *
 * ## Adapting `DirectMessageReceived` -> `ReceivedMessageWrapper`
 *
 * `activeChain.directMessages.fetchSince` returns `DirectMessageReceived[]`
 * (`@frank/wallet/chain/active-chain.ts`) -- a deliberately Monad-shaped type (see that file's header,
 * deviation 2). `chats.ts`'s `receiveMessages` action takes `ReceivedMessageWrapper[]`
 * (`@frank/cashweb/types/user-interface.ts`), a Lotus-shaped type (`copartyPubKey: PublicKey` from
 * `bitcore-lib-xpi`, `outpoints: Utxo[]`). `toReceivedMessageWrapper` below adapts one into the
 * other:
 * - `outpoints: []` / `stampValueWei: record.stampValueWei` -- see `stores/chats.ts`'s header for the
 *   #42 decision to add `stampValueWei` additively rather than replace `outpoints`.
 * - `copartyPubKey` needs an actual `PublicKey` (not optional on `ReceivedMessageWrapper`), only
 *   used by `receiveMessages` as a placeholder for `contacts.addLoadingContact` when the sender
 *   isn't already a known contact -- `contacts.refresh` (rewritten by this ticket) immediately
 *   re-fetches and overwrites it with the real profile right after. This calls
 *   `activeChain.fetchProfile` a second time per unique sender (once inside `MonadChain.fetchSince`
 *   itself, to decrypt; once here, to get bytes to wrap as a placeholder) -- a known small
 *   inefficiency, not fixed here since `ActiveChain`'s interface (owned by #41, off-limits to this
 *   ticket) has no cheaper way to ask "what pubkey did you just use to decrypt this."
 */
import { PublicKey } from 'bitcore-lib-xpi'

import { activeChain } from '@frank/wallet/chain'
import type { DirectMessageReceived, WalletHandle } from '@frank/wallet/chain'
import {
  MonadMailboxChallengeCapacityError,
  MonadMailboxUnavailableError,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { useChatStore } from '../stores/chats'

/** Default direct-message poll interval, in milliseconds -- within issue #42's suggested 5-10s
 * range. Configurable via `MONAD_DM_POLL_INTERVAL_MS` (see `src/boot/monad-direct-messages.ts`). */
export const DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS = 7000

/** Longest pause between polls while the relay has no mailbox (404): progressive backoff from
 * the poll interval, doubling, capped here. */
export const MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS = 60_000

/** Adapts one `DirectMessageReceived` record into a `ReceivedMessageWrapper`, or `undefined` if
 * the sender's profile/pubkey can't be resolved right now (logged, not thrown -- one bad/
 * unreachable sender shouldn't drop an entire poll batch). */
export async function toReceivedMessageWrapper(
  record: DirectMessageReceived,
): Promise<ReceivedMessageWrapper | undefined> {
  const senderProfile = await activeChain.fetchProfile(record.senderAddress)
  if (senderProfile === undefined) {
    console.error(
      `direct-message polling: no profile found for sender ${record.senderAddress.raw}, skipping message ${record.payloadDigest}`,
    )
    return undefined
  }

  const copartyAddress = activeChain.formatAddress(record.senderAddress)
  const destinationAddress = activeChain.formatAddress(record.recipientAddress)
  const stampValue = Number(record.stampValueWei)

  return {
    outbound: false,
    senderAddress: copartyAddress,
    copartyAddress,
    copartyPubKey: PublicKey.fromBuffer(Buffer.from(senderProfile.pubKey)),
    index: record.payloadDigest,
    stampValue,
    message: {
      outbound: false,
      status: 'confirmed',
      items: record.items,
      serverTime: record.receivedTime,
      receivedTime: record.receivedTime,
      outpoints: [],
      stampValueWei: record.stampValueWei,
      stampPayments: record.stampPayments,
      senderAddress: copartyAddress,
      destinationAddress,
    },
  }
}

export interface DirectMessagePolling {
  stop: () => void
}

/**
 * Starts polling `activeChain.directMessages.fetchSince` for `wallet` every `intervalMs`,
 * feeding adapted results into `chats.receiveMessages` unchanged. Polls once immediately, then on
 * `intervalMs` (default {@link DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS}). Returns a handle to
 * `stop()` the loop (e.g. on logout/wallet teardown).
 *
 * `sinceMs` is tracked locally, seeded from `chats.getLastReceived` (persisted across reloads --
 * see `stores/chats.ts`'s own `storage.save`) so a fresh page load doesn't refetch a wallet's
 * entire message history, and advanced to the newest `receivedTime` seen after each successful
 * poll that returned results.
 */
export function startDirectMessagePolling({
  wallet,
  intervalMs = DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
}: {
  wallet: WalletHandle
  intervalMs?: number
}): DirectMessagePolling {
  const chats = useChatStore()
  let sinceMs = chats.getLastReceived ?? 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let unavailableFailures = 0

  // Polls are chained (next one is scheduled when this one settles), never overlapping, so the
  // delay can adapt to what the relay just told us.
  const poll = async () => {
    const startedAt = Date.now()
    let nextDelayMs = intervalMs
    let steady = true
    try {
      const received = await activeChain.directMessages.fetchSince({
        wallet,
        sinceMs,
        // The result is already cut back to a complete timestamp group, so advancing below is
        // safe; the remainder is fetched by the next poll.
        onTruncated: reason =>
          console.warn(
            'direct-message inbox page truncated; will continue',
            reason,
          ),
      })
      unavailableFailures = 0
      if (received.length === 0) {
        return
      }

      const wrappers: ReceivedMessageWrapper[] = []
      let nextSinceMs = sinceMs
      let cursorBlocked = false
      for (const record of received) {
        const wrapper = await toReceivedMessageWrapper(record)
        if (wrapper !== undefined) {
          wrappers.push(wrapper)
          // The relay's `since` bound is inclusive. Only advance through the contiguous prefix
          // that can become durable; an unresolved earlier sender profile must remain retryable.
          if (!cursorBlocked) {
            nextSinceMs = Math.max(nextSinceMs, record.receivedTime + 1)
          }
        } else {
          cursorBlocked = true
        }
      }

      if (wrappers.length > 0) {
        await chats.receiveMessages(wrappers)
        sinceMs = nextSinceMs
      }
    } catch (err) {
      if (err instanceof MonadMailboxChallengeCapacityError) {
        // The relay caps authenticated reads per recipient per minute; hammering only extends
        // the outage. Wait as long as the relay asked, but keep the loop alive.
        steady = false
        nextDelayMs = Math.max(intervalMs, err.retryAfterMs)
        console.warn(
          `direct-message polling rate limited; retrying in ${nextDelayMs} ms`,
        )
      } else if (err instanceof MonadMailboxUnavailableError) {
        steady = false
        unavailableFailures += 1
        nextDelayMs = Math.min(
          MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
          intervalMs * 2 ** unavailableFailures,
        )
        console.error(
          `relay has no direct-message mailbox; retrying in ${nextDelayMs} ms`,
          err,
        )
      } else {
        console.error('direct-message polling failed', err)
      }
    } finally {
      // Steady state keeps a fixed cadence (interval measured start to start); relay-requested
      // pauses are honoured in full.
      const delay = steady
        ? Math.max(0, nextDelayMs - (Date.now() - startedAt))
        : nextDelayMs
      if (!stopped) timer = setTimeout(() => void poll(), delay)
    }
  }

  void poll()

  return {
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
