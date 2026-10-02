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
 * (`@frank/cashweb/types/user-interface.ts`), a Lotus-shaped type (`copartyPubKey` is still
 * declared as the legacy public-key class, `outpoints: Utxo[]`). `toReceivedMessageWrapper`
 * below adapts one into the other:
 * - `outpoints: []` / `stampValueWei: record.stampValueWei` -- see `stores/chats.ts`'s header for the
 *   #42 decision to add `stampValueWei` additively rather than replace `outpoints`.
 * - `copartyPubKey` needs a profile key with `toBuffer()` (not optional on
 *   `ReceivedMessageWrapper`), only used by `receiveMessages` as a placeholder for
 *   `contacts.addLoadingContact` when the sender isn't already a known contact --
 *   `contacts.refresh` (rewritten by this ticket) immediately
 *   re-fetches and overwrites it with the real profile right after. This calls
 *   `activeChain.fetchProfile` a second time per unique sender (once inside `MonadChain.fetchSince`
 *   itself, to decrypt; once here, to get bytes to wrap as a placeholder) -- a known small
 *   inefficiency, not fixed here since `ActiveChain`'s interface (owned by #41, off-limits to this
 *   ticket) has no cheaper way to ask "what pubkey did you just use to decrypt this."
 */
import { activeChain } from '@frank/wallet/chain'
import type { DirectMessageReceived, WalletHandle } from '@frank/wallet/chain'
import {
  MonadMailboxAuthError,
  MonadMailboxChallengeCapacityError,
  MonadMailboxUnavailableError,
} from '@frank/cashweb/relay/monad-mailbox-client'
import type { ReceivedMessageWrapper } from '@frank/cashweb/types/user-interface'
import { profilePubKeyFromBytes } from '../utils/profile-pubkey'
import { useChatStore } from '../stores/chats'
import { useMailboxStatusStore } from '../stores/mailbox-status'

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
    copartyPubKey: profilePubKeyFromBytes(
      senderProfile.pubKey,
    ) as ReceivedMessageWrapper['copartyPubKey'],
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
  const mailboxStatus = useMailboxStatusStore()
  let sinceMs = chats.getLastReceived ?? 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let unavailableFailures = 0
  let otherFailures = 0
  let lastErrorKey: string | undefined

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
      // stop() cannot cancel an in-flight request; a stopped poller (e.g. the wallet was
      // switched) must never deliver its messages into the shared chat store.
      if (stopped) return
      unavailableFailures = 0
      otherFailures = 0
      lastErrorKey = undefined
      mailboxStatus.setOk()
      if (received.length === 0) {
        return
      }

      const wrappers: ReceivedMessageWrapper[] = []
      let nextSinceMs = sinceMs
      let cursorBlocked = false
      for (const record of received) {
        const wrapper = await toReceivedMessageWrapper(record)
        if (stopped) return
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

      if (stopped) return
      if (wrappers.length > 0) {
        await chats.receiveMessages(wrappers)
        sinceMs = nextSinceMs
      }
    } catch (err) {
      // stop() cannot cancel an in-flight request: a poll that fails after stop() must not put a
      // problem back on screen after stop() cleared it.
      if (stopped) return
      if (err instanceof MonadMailboxChallengeCapacityError) {
        // The relay caps authenticated reads per recipient per minute; hammering only extends
        // the outage. Wait as long as the relay asked, but keep the loop alive.
        steady = false
        otherFailures = 0
        nextDelayMs = Math.max(intervalMs, err.retryAfterMs)
        mailboxStatus.setProblem('rate-limited', nextDelayMs)
        console.warn(
          `direct-message polling rate limited; retrying in ${nextDelayMs} ms`,
        )
      } else if (err instanceof MonadMailboxUnavailableError) {
        steady = false
        unavailableFailures += 1
        otherFailures = 0
        nextDelayMs = Math.min(
          MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
          intervalMs * 2 ** unavailableFailures,
        )
        mailboxStatus.setProblem('unavailable', nextDelayMs)
        console.error(
          `relay has no direct-message mailbox; retrying in ${nextDelayMs} ms`,
          err,
        )
      } else {
        // Unknown failure (401, network, ...): modest capped backoff, and log once per distinct
        // consecutive error rather than every poll.
        otherFailures += 1
        if (otherFailures > 1) {
          steady = false
          nextDelayMs = Math.min(
            MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS,
            intervalMs * 2 ** (otherFailures - 1),
          )
        }
        // A single failed poll is routine (a dropped connection); only a repeat is shown, so the
        // status does not flicker on every blip. But if a problem is already on screen (e.g. the
        // relay just answered 404), replace it with what is true now instead of leaving it up.
        // It clears on the next successful poll.
        if (otherFailures > 1 || mailboxStatus.hasProblem) {
          mailboxStatus.setProblem(
            err instanceof MonadMailboxAuthError
              ? 'unauthorized'
              : 'unreachable',
            nextDelayMs,
          )
        }
        const key =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        if (key !== lastErrorKey) {
          lastErrorKey = key
          console.error('direct-message polling failed', err)
        }
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
      // A stopped poller (e.g. the wallet was switched) must not leave its last problem on screen.
      mailboxStatus.setOk()
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** How often the background reconciliation looks at messages whose payment is pending, and the
 * longest pause it backs off to while they stay pending. */
export const OUTGOING_RECONCILE_INTERVAL_MS = 15_000
export const MAX_OUTGOING_RECONCILE_INTERVAL_MS = 120_000

export interface OutgoingReconciliation {
  stop: () => void
}

/**
 * Keeps settling outgoing messages whose stamp payment is still pending (#270). Every tick asks
 * the wallet to re-send the SAME exact bytes of each live payment attempt (free and idempotent,
 * never a new payment; see `stores/chats.ts`, `sendMessage`), and flips a message to sent when it
 * finally delivers, so the sender's copy follows reality without any user action. While something
 * stays pending the pause doubles up to {@link MAX_OUTGOING_RECONCILE_INTERVAL_MS}; with nothing
 * pending each tick is a cheap local check.
 */
export function startOutgoingReconciliation({
  wallet,
  intervalMs = OUTGOING_RECONCILE_INTERVAL_MS,
  maxIntervalMs = MAX_OUTGOING_RECONCILE_INTERVAL_MS,
}: {
  wallet: WalletHandle
  intervalMs?: number
  maxIntervalMs?: number
}): OutgoingReconciliation {
  const chats = useChatStore()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delayMs = intervalMs
  let knownPending = new Set<string>()

  const pendingIds = () => {
    const ids = new Set<string>()
    for (const chat of Object.values(chats.chats)) {
      for (const message of chat?.messages ?? []) {
        if (message.outbound && message.status === 'payment-pending') {
          ids.add(message.payloadDigest)
        }
      }
    }
    return ids
  }

  // Invariant: at most ONE timer exists, and only `schedule` arms it (clearing any previous one).
  const schedule = (ms: number) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!stopped) timer = setTimeout(() => void tick(), ms)
  }

  let ticking = false
  let resetRequested = false
  // What is pending now is not "new": seed before the first tick so a reload with a pending
  // message does not look like a fresh arrival.
  knownPending = pendingIds()

  const tick = async () => {
    ticking = true
    resetRequested = false
    let pending = 0
    try {
      pending = (await chats.reconcileOutgoing({ wallet })).pending
    } catch (err) {
      console.warn('outgoing message reconciliation failed', err)
      pending = 1
    }
    ticking = false
    knownPending = pendingIds()
    delayMs =
      pending > 0 && !resetRequested
        ? Math.min(maxIntervalMs, delayMs * 2)
        : intervalMs
    schedule(delayMs)
  }
  void tick()

  // A message that newly becomes payment-pending must not wait out a long backoff earned by an
  // older one: restart the ladder and look again after the base interval.
  const unsubscribe = chats.$onAction(({ name, after }) => {
    if (name !== 'setOutgoingState') return
    after(() => {
      const now = pendingIds()
      const isNew = [...now].some(id => !knownPending.has(id))
      knownPending = now
      if (!isNew || stopped) return
      delayMs = intervalMs
      // Mid-tick, the tick itself re-arms at the base interval; never start a second chain.
      if (ticking) resetRequested = true
      else schedule(intervalMs)
    })
  })

  return {
    stop: () => {
      stopped = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
