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
import {
  isSafeRelayTimestamp,
  type RelayReceiptIdentity,
} from '@frank/cashweb/relay/storage/storage'
import { profilePubKeyFromBytes } from '../utils/profile-pubkey'
import { useChatStore, walletOwnsMessage } from '../stores/chats'
import { useMailboxStatusStore } from '../stores/mailbox-status'
import { useProfileStore } from '../stores/my-profile'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import {
  registerMonadIdentityCbor,
  type MonadIdentity,
} from '@frank/wallet/monad-identity'

/** Default direct-message poll interval, in milliseconds -- within issue #42's suggested 5-10s
 * range. Configurable via `MONAD_DM_POLL_INTERVAL_MS` (see `src/boot/monad-direct-messages.ts`). */
export const DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS = 7000

/** Minimum interval between direct-message polls to prevent tight spin loops. */
export const MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS = 2500

/** Background polling interval for direct messages when tab is hidden. */
export const BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS = 30_000

/** Longest pause between polls while the relay has no mailbox (404): progressive backoff from
 * the poll interval, doubling, capped here. */
export const MAX_MAILBOX_UNAVAILABLE_BACKOFF_MS = 60_000

/** Adapts one `DirectMessageReceived` record into a `ReceivedMessageWrapper`, or `undefined` if
 * the sender's profile/pubkey can't be resolved right now (logged, not thrown -- one bad/
 * unreachable sender shouldn't drop an entire poll batch). */
export async function toReceivedMessageWrapper(
  record: DirectMessageReceived,
): Promise<ReceivedMessageWrapper | undefined> {
  const receivedTime: unknown = record.receivedTime
  if (!isSafeRelayTimestamp(receivedTime)) {
    console.error(
      `direct-message polling: unsafe relay timestamp, skipping message ${record.payloadDigest}`,
    )
    return undefined
  }
  const isOutbound = record.outbound === true
  const copartyChainAddress = isOutbound
    ? record.recipientAddress
    : record.senderAddress
  let copartyPubKey = isOutbound
    ? record.recipientPublicKey
    : record.senderPublicKey
  if (copartyPubKey === undefined) {
    const copartyProfile = await activeChain.fetchProfile(copartyChainAddress)
    if (copartyProfile === undefined) {
      if (!isOutbound) {
        console.error(
          `direct-message polling: no profile found for sender ${record.senderAddress.raw}, skipping message ${record.payloadDigest}`,
        )
        return undefined
      }
      copartyPubKey = record.senderPublicKey ?? new Uint8Array(33)
    } else {
      copartyPubKey = copartyProfile.pubKey
    }
  }

  const copartyAddress = activeChain.formatAddress(copartyChainAddress)
  const destinationAddress = activeChain.formatAddress(record.recipientAddress)
  const senderAddress = activeChain.formatAddress(record.senderAddress)
  const stampValue = Number(record.stampValueWei)

  return {
    outbound: isOutbound,
    senderAddress,
    copartyAddress,
    copartyPubKey: profilePubKeyFromBytes(
      copartyPubKey,
    ) as ReceivedMessageWrapper['copartyPubKey'],
    index: record.payloadDigest,
    stampValue,
    conversationId: record.conversationId,
    message: {
      outbound: isOutbound,
      status: 'confirmed',
      items: record.items,
      serverTime: record.receivedTime,
      receivedTime: record.receivedTime,
      outpoints: [],
      stampValueWei: record.stampValueWei,
      stampPayments: record.stampPayments,
      senderAddress,
      destinationAddress,
      conversationId: record.conversationId,
      logicalMessageId: record.messageId,
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
 * `sinceMs` is recipient-identity scoped. Its durable authority is derived by the message store
 * from the relay receipts themselves (there is no separately persisted cursor row, so saved
 * progress can never outrun a receipt that a browser crash lost). In-session, the value here
 * advances only after the corresponding relay receipts have been saved (or durably quarantined),
 * never from local/outbound message clocks.
 */
/**
 * Auto-registers the wallet's identity profile against the relay after an authentication failure
 * (e.g. relay restart or wiped profile table).
 */
export async function autoRecoverProfile(wallet: WalletHandle): Promise<void> {
  const identity = (wallet as unknown as { identity?: MonadIdentity }).identity
  if (!identity) return
  try {
    const relayBaseUrl =
      (wallet as { relayBaseUrl?: string }).relayBaseUrl ??
      loadMonadChainConfigFromEnv().relayBaseUrl
    let profile = undefined
    try {
      profile = useProfileStore().profile
    } catch {
      // Pinia store not initialized
    }
    await registerMonadIdentityCbor({
      relayBaseUrl,
      identity,
      profile,
    })
  } catch (err) {
    console.warn('auto-register profile after 401 failed', err)
  }
}

export function startDirectMessagePolling({
  wallet,
  intervalMs = DEFAULT_DIRECT_MESSAGE_POLL_INTERVAL_MS,
  onAuthRecovery,
}: {
  wallet: WalletHandle
  intervalMs?: number
  onAuthRecovery?: () => Promise<void>
}): DirectMessagePolling {
  const chats = useChatStore()
  const mailboxStatus = useMailboxStatusStore()
  const recipientAddress = activeChain.formatAddress(wallet.identity.address)
  let sinceMs = 0
  const cursorReady = chats.relayCursor(recipientAddress).then(cursor => {
    sinceMs = cursor
  })
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
      await cursorReady
      if (stopped) return
      const incompleteTimestamps: number[] = []
      // Rows the registry authoritatively has no sender account for. They are terminally
      // undeliverable; they are durably quarantined below so neither the in-session replay nor
      // the durable frontier can stay pinned behind them.
      const quarantined: RelayReceiptIdentity[] = []
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
        onIncompleteTimestamp: receivedTime => {
          if (isSafeRelayTimestamp(receivedTime)) {
            incompleteTimestamps.push(receivedTime)
          } else {
            console.error(
              'direct-message polling: unsafe incomplete relay timestamp, ignoring row',
            )
          }
        },
        onQuarantinedTimestamp: (receivedTime, payloadDigest) => {
          if (isSafeRelayTimestamp(receivedTime)) {
            quarantined.push({ payloadDigest, receivedTime })
          } else {
            console.error(
              'direct-message polling: unsafe quarantined relay timestamp, ignoring row',
            )
          }
        },
      })
      // stop() cannot cancel an in-flight request; a stopped poller (e.g. the wallet was
      // switched) must never deliver its messages into the shared chat store.
      if (stopped) return
      unavailableFailures = 0
      otherFailures = 0
      lastErrorKey = undefined
      mailboxStatus.setOk()
      if (
        received.length === 0 &&
        quarantined.length === 0 &&
        incompleteTimestamps.length === 0
      ) {
        return
      }

      const wrappers: ReceivedMessageWrapper[] = []
      // `quarantined` rows count as resolved records: they never become wrappers, but a terminal
      // row must not hold its timestamp group (or anything behind it) in replay either.
      const timestampGroups = new Map<
        number,
        { records: number; durableCandidates: number; quarantined: number }
      >()
      const groupFor = (receivedTime: number) => {
        const group = timestampGroups.get(receivedTime) ?? {
          records: 0,
          durableCandidates: 0,
          quarantined: 0,
        }
        timestampGroups.set(receivedTime, group)
        return group
      }
      for (const receivedTime of incompleteTimestamps) {
        groupFor(receivedTime).records += 1
      }
      for (const receipt of quarantined) {
        const group = groupFor(receipt.receivedTime)
        group.records += 1
        group.quarantined += 1
      }
      for (const record of received) {
        const receivedTime: unknown = record.receivedTime
        if (!isSafeRelayTimestamp(receivedTime)) {
          console.error(
            `direct-message polling: unsafe relay timestamp, skipping message ${record.payloadDigest}`,
          )
          continue
        }
        const group = groupFor(receivedTime)
        group.records += 1
        timestampGroups.set(receivedTime, group)
        const wrapper = await toReceivedMessageWrapper(record)
        if (stopped) return
        if (wrapper !== undefined) {
          wrappers.push(wrapper)
          group.durableCandidates += 1
        }
      }

      // There is no stable per-row tie-break in the relay API. Advance past a timestamp only
      // when its entire group can become durable (or is durably quarantined); otherwise stop at
      // the inclusive timestamp so successful siblings dedupe while the unresolved row is
      // fetched again.
      let nextSinceMs = sinceMs
      for (const [receivedTime, group] of [...timestampGroups].sort(
        ([left], [right]) => left - right,
      )) {
        if (group.durableCandidates + group.quarantined !== group.records) {
          nextSinceMs = Math.max(nextSinceMs, receivedTime)
          break
        }
        nextSinceMs = Math.max(nextSinceMs, receivedTime + 1)
      }

      if (stopped) return
      if (wrappers.length > 0) {
        const receiveResult = await chats.receiveMessages(
          wrappers,
          recipientAddress,
          // Delivery is queued behind a module-global mutation boundary; a poller the wallet
          // replaced while queued must not persist, mutate shared state, or notify.
          { isCancelled: () => stopped },
        )
        // The queued boundary ran after replacement: nothing was delivered, so nothing may
        // advance -- the replacement poller replays this window from its own cursor.
        if (receiveResult.cancelled) return
      }
      if (stopped) return
      if (quarantined.length > 0) {
        // Terminal rows are anchored durably before the in-session replay moves past them, so a
        // restart derives a frontier that does not re-pin the poisoned prefix.
        await chats.quarantineRelayReceipts(recipientAddress, quarantined)
      }
      // Poll-progress authority for this session. The durable frontier is derived by the message
      // store from the receipts this and earlier sessions persisted, never from local or
      // outbound clocks -- a cursor row is deliberately never written ahead of a receipt.
      sinceMs = nextSinceMs
    } catch (err) {
      // stop() cannot cancel an in-flight request: a poll that fails after stop() must not put a
      // problem back on screen after stop() cleared it.
      if (stopped) return
      const isChallengeCapacity =
        err instanceof MonadMailboxChallengeCapacityError ||
        (err as { code?: string })?.code === 'mailbox_challenge_capacity' ||
        (err as { status?: number })?.status === 429
      const isUnavailable =
        err instanceof MonadMailboxUnavailableError ||
        (err as { code?: string })?.code === 'mailbox_unavailable' ||
        (err as { status?: number })?.status === 404
      const isAuth =
        err instanceof MonadMailboxAuthError ||
        (err as { code?: string })?.code === 'mailbox_auth_failed' ||
        (err as { status?: number })?.status === 401

      if (isChallengeCapacity) {
        // The relay caps authenticated reads per recipient per minute; hammering only extends
        // the outage. Wait as long as the relay asked, but keep the loop alive.
        steady = false
        otherFailures = 0
        const retryAfterMs =
          (err as { retryAfterMs?: number })?.retryAfterMs ?? 60_000
        nextDelayMs = Math.max(intervalMs, retryAfterMs)
        mailboxStatus.setProblem('rate-limited', nextDelayMs)
        console.warn(
          `direct-message polling rate limited; retrying in ${nextDelayMs} ms`,
        )
      } else if (isUnavailable) {
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
            isAuth ? 'unauthorized' : 'unreachable',
            nextDelayMs,
          )
        }
        if (isAuth) {
          if (onAuthRecovery) {
            void onAuthRecovery().catch(() => undefined)
          } else {
            void autoRecoverProfile(wallet).catch(() => undefined)
          }
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
      // pauses are honoured in full. Floored at minFloor to prevent 0ms spin loops.
      const elapsed = Date.now() - startedAt
      const minFloor = Math.min(MIN_DIRECT_MESSAGE_POLL_INTERVAL_MS, intervalMs)
      let delay = steady
        ? Math.max(minFloor, nextDelayMs - elapsed)
        : nextDelayMs

      // If document is backgrounded/hidden, relax polling cadence to save battery/CPU.
      if (typeof document !== 'undefined' && document.hidden) {
        delay = Math.max(delay, BACKGROUND_DIRECT_MESSAGE_POLL_INTERVAL_MS)
      }

      if (!stopped) timer = setTimeout(() => void poll(), delay)
    }
  }

  const onVisibilityChange = () => {
    if (stopped) return
    if (typeof document !== 'undefined' && !document.hidden) {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      void poll()
    }
  }

  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  let unsubscribeStream: (() => void) | undefined
  try {
    unsubscribeStream = activeChain.directMessages.subscribeMailboxStream?.({
      wallet,
      onRecord: async record => {
        if (stopped) return
        const wrapper = await toReceivedMessageWrapper(record)
        if (wrapper && !stopped) {
          await chats.receiveMessages([wrapper])
        }
      },
      onError: err => {
        console.warn('direct-message stream error', err)
      },
    })
  } catch (err) {
    console.warn('direct-message stream subscription failed', err)
  }

  void poll()

  return {
    stop: () => {
      stopped = true
      unsubscribeStream?.()
      // A stopped poller (e.g. the wallet was switched) must not leave its last problem on screen.
      mailboxStatus.setOk()
      if (timer !== undefined) clearTimeout(timer)
      if (
        typeof document !== 'undefined' &&
        typeof document.removeEventListener === 'function'
      ) {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
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
        if (
          message.outbound &&
          message.status === 'payment-pending' &&
          walletOwnsMessage(wallet, message)
        ) {
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
    // Observe the serialized mutation action itself. `setOutgoingState` now delegates through
    // the delivery queue, so its outer action can settle after another action has already updated
    // `knownPending`; the exclusive action is the exact serialized state/persistence boundary.
    if (name !== 'setOutgoingStateExclusive') return
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
