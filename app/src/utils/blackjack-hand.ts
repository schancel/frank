/**
 * App glue for peer-to-peer blackjack. The rules live in the shared state machine
 * (`@frank/wallet/message-item-plugins/blackjack/hand`); this file only turns a chat's stored
 * messages into its events and keeps this user's seeds on this device.
 *
 * A hand's state is always folded from the chat store's messages, never from rendered bubbles,
 * so it does not matter which messages are currently on screen.
 */
import type {
  BlackjackHandItem,
  MessageItem,
} from '@frank/cashweb/types/messages'
import { BET_MESSAGE_FEE_RESERVE_WEI } from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  applyHandEvent,
  dealerStep,
  foldHand,
  handView,
  playerMoves,
  playerStep,
  roleOf,
  seedFromBytes,
  soleHandItem,
  type DealerStep,
  type HandEvent,
  type HandRejection,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'
import { heldOutgoingLocks } from './outgoing-lock'

/** What a wallet keeps back for the fees of the messages a hand still needs. */
export const HAND_FEE_RESERVE_WEI = BET_MESSAGE_FEE_RESERVE_WEI

/** The fields of a stored chat message this file reads. */
export interface HandChatMessage {
  outbound: boolean
  items: MessageItem[]
  stampValueWei?: bigint
  payloadDigest: string
  /** The digest this message will have once delivered, when it is still under a local id. */
  attemptDigest?: string
  /** Delivery state of a stored chat message; `confirmed` once the relay has it. */
  status?: string
  delivery?: { attemptDigest?: string; failureReason?: string }
}

/** One of this user's own hand messages that the other side has not received. */
export interface UndeliveredHandMessage {
  payloadDigest: string
  action: BlackjackHandItem['action']
  /** `sending`: a send or an automatic re-send is under way. `failed`: nothing is under way. */
  state: 'sending' | 'failed'
  /** A payment set was recorded for this message; the wallet can say what became of it. */
  hasAttempt: boolean
  /** Its stamp is a bet, a second bet, a payout or a refund rather than an ordinary stamp. */
  carriesMoney: boolean
}

/** Whether a stored message is one of this user's own that the other side does not have yet. A
 * message without a delivery status (not from the chat store) counts as delivered. */
const isUndeliveredOwn = (message: HandChatMessage) =>
  message.outbound &&
  message.status !== undefined &&
  message.status !== 'confirmed'

/**
 * This user's own hand messages in a chat that are not delivered: still sending, or failed
 * (also a send cut off by closing the window). A hand's state counts them as sent so that no
 * move is offered twice, so the hand cannot go on until each is delivered or discarded.
 *
 * `ordinaryStampWei` is the stamp this user's free messages are sent with; any hand message
 * whose stamp is above it carries money too, whatever its action (a reveal that pays, or one
 * folded here as owing nothing but sent with more than an ordinary stamp).
 */
export function undeliveredHandMessages(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
  ordinaryStampWei?: bigint,
): UndeliveredHandMessage[] {
  const undelivered: UndeliveredHandMessage[] = []
  for (const message of messages) {
    if (!isUndeliveredOwn(message)) continue
    const item = soleHandItem(message.items)
    if (!item) continue
    let carriesMoney =
      item.action === 'bet' ||
      item.action === 'double' ||
      item.action === 'refund'
    if (item.action === 'reveal') {
      // A reveal pays only when the player is owed something.
      const upTo = messages.slice(0, messages.indexOf(message) + 1)
      const owed = foldHand(chatHandEvents(upTo, own, peer, item.gameId)).state
        ?.owedWei
      carriesMoney = owed === undefined || owed > 0n
    }
    if (
      ordinaryStampWei !== undefined &&
      (message.stampValueWei ?? 0n) > ordinaryStampWei
    )
      carriesMoney = true
    undelivered.push({
      payloadDigest: message.payloadDigest,
      action: item.action,
      state: message.status === 'error' ? 'failed' : 'sending',
      hasAttempt:
        (message.delivery?.attemptDigest ?? message.attemptDigest) !==
        undefined,
      carriesMoney,
    })
  }
  return undelivered
}

/**
 * Whether an own undelivered hand message may be resumed without the user: it is not a challenge
 * or an accept (those open a commitment; only the bubble's Retry sends them again), it is the
 * newest own message of its hand (an older one was overtaken: the hand went on without it), and
 * its hand, folded without it, exists and is not over (resolved or refunded). Anything else keeps
 * the bubble's Retry only.
 */
export function mayResumeAutomatically(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
  payloadDigest: string,
): boolean {
  const message = messages.find(m => m.payloadDigest === payloadDigest)
  const item = message && soleHandItem(message.items)
  if (!message || !item) return false
  if (item.action === 'challenge' || item.action === 'accept') return false
  const ownOfHand = messages.filter(
    m => m.outbound && soleHandItem(m.items)?.gameId === item.gameId,
  )
  if (ownOfHand[ownOfHand.length - 1] !== message) return false
  const state = foldHand(
    chatHandEvents(
      messages.filter(m => m !== message),
      own,
      peer,
      item.gameId,
    ),
  ).state
  return !!state && state.phase !== 'resolved' && state.phase !== 'refunded'
}

/** What the chat store offers for an outgoing message that failed. */
export interface HandResumeStore {
  /** A retry nobody clicked (`automatic`): settles an earlier payment first, and builds one only
   * for a message cut off mid-send that provably has none. */
  retryOutgoing(params: {
    wallet: unknown
    address: string
    payloadDigest: string
    automatic: true
  }): Promise<{ state: string }>
  /** Settles a failed message's recorded payment; never builds a new one. */
  resumeOutgoing(params: {
    wallet: unknown
    address: string
    payloadDigest: string
  }): Promise<{ state: string }>
}

/**
 * Resumes this user's failed hand messages when their chat is open, each at most once per page
 * session (`attempted`), oldest first. Only a message that `mayResumeAutomatically` allows is
 * considered, and one that another tab is sending right now (its outgoing lock is held) is left
 * alone and not marked attempted:
 *
 * - A message whose stamp is an ordinary stamp (deal, hit, stand, card, a reveal that owes
 *   nothing) is sent again through `retryOutgoing({ automatic: true })`: an earlier payment for
 *   it is settled first and its bytes re-sent while it is live; a new payment is built only for a
 *   message cut off mid-send with provably no payment, never after a payment died or its fate is
 *   unknown. Otherwise nothing is sent and the bubble keeps its Retry.
 * - A message that carries money (bet, double, paying reveal, refund, or any stamp above the
 *   ordinary one) is only settled: if a payment was recorded for it and is still live at the
 *   relay the same bytes are re-sent. A new payment is never built here; the bubble shows Retry.
 *
 * Returns how many messages were handed to the store in this call (re-sent or settled, whatever
 * the outcome); the caller runs again when it is above zero, since the hand may have moved.
 */
export async function resumeHandMessages(params: {
  store: HandResumeStore
  wallet: unknown
  address: string
  own: string
  messages: readonly HandChatMessage[]
  attempted: Set<string>
  /** The stamp this user's free messages are sent with. */
  ordinaryStampWei: bigint
}): Promise<number> {
  const candidates = undeliveredHandMessages(
    params.messages,
    params.own,
    params.address,
    params.ordinaryStampWei,
  ).filter(
    message =>
      message.state === 'failed' &&
      !params.attempted.has(`resume:${message.payloadDigest}`) &&
      mayResumeAutomatically(
        params.messages,
        params.own,
        params.address,
        message.payloadDigest,
      ),
  )
  if (candidates.length === 0) return 0
  const sendingElsewhere = await heldOutgoingLocks()
  let handed = 0
  for (const message of candidates) {
    if (sendingElsewhere.has(message.payloadDigest)) continue
    const key = `resume:${message.payloadDigest}`
    if (params.attempted.has(key)) continue
    const target = {
      wallet: params.wallet,
      address: params.address,
      payloadDigest: message.payloadDigest,
    }
    if (message.carriesMoney && !message.hasAttempt) continue
    params.attempted.add(key)
    try {
      let outcome: { state: string }
      if (!message.carriesMoney) {
        console.info(
          `blackjack: resending undelivered ${message.action} ${message.payloadDigest}`,
        )
        outcome = await params.store.retryOutgoing({
          ...target,
          automatic: true,
        })
      } else {
        console.info(
          `blackjack: settling undelivered ${message.action} ${message.payloadDigest}`,
        )
        outcome = await params.store.resumeOutgoing(target)
      }
      if (outcome.state === 'busy') {
        // Someone else (another tab) is sending it right now: not ours to count; try later.
        params.attempted.delete(key)
        continue
      }
      handed++
    } catch (error) {
      // The message stays failed with its Retry; nothing was paid on a guess.
      console.warn('could not resume a blackjack message', error)
    }
  }
  return handed
}

/** The hand events of a chat, in chat order. `gameId` narrows to one hand. A message this user
 * sent counts from the moment it is in the chat (also while it is still sending or failed and
 * waiting for Retry), so the same move is never offered or sent twice. */
export function chatHandEvents(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
  gameId?: string,
): HandEvent[] {
  const events: HandEvent[] = []
  for (const message of messages) {
    // At most one hand item per message counts (one stamp is one amount of money).
    const item = soleHandItem(message.items)
    if (item && (gameId === undefined || item.gameId === gameId))
      events.push({
        item,
        from: message.outbound ? own : peer,
        to: message.outbound ? peer : own,
        stampWei: message.stampValueWei ?? 0n,
        digest: message.payloadDigest,
      })
  }
  return events
}

/** Every hand of a chat, folded, in the order the hands were opened. */
export function chatHands(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
): { state: HandState; rejected: HandRejection[] }[] {
  const byGame = new Map<string, HandEvent[]>()
  for (const event of chatHandEvents(messages, own, peer)) {
    const list = byGame.get(event.item.gameId) ?? []
    list.push(event)
    byGame.set(event.item.gameId, list)
  }
  const hands: { state: HandState; rejected: HandRejection[] }[] = []
  for (const events of byGame.values()) {
    const folded = foldHand(events)
    if (folded.state)
      hands.push({
        state: folded.state,
        rejected: folded.rejected.map(r => r.error),
      })
  }
  return hands
}

const SEED_PREFIX = 'frank.blackjack.seed.'
const memorySeeds = new Map<string, string>()

const seedKey = (own: string, peer: string, gameId: string) =>
  `${own.toLowerCase()}|${peer.toLowerCase()}|${gameId}`

/** Keeps this user's seed for a hand on this device, under its own account, the chat and the
 * game: a seed is never shared between two hands, and another account used in the same browser
 * profile does not find it under its own name. Both roles have one: the dealer's is committed
 * to in its challenge or accept, the player's in its bet. Without the seed a dealer cannot deal
 * or reveal (it can still refund the bet) and a player cannot move. */
export function saveSeed(
  own: string,
  peer: string,
  gameId: string,
  seed: string,
): void {
  const key = seedKey(own, peer, gameId)
  memorySeeds.set(key, seed)
  try {
    localStorage.setItem(SEED_PREFIX + key, seed)
  } catch {
    // Storage unavailable: the seed lives for this page session only.
  }
}

export function loadSeed(
  own: string,
  peer: string,
  gameId: string,
): string | undefined {
  const key = seedKey(own, peer, gameId)
  const held = memorySeeds.get(key)
  if (held) return held
  try {
    return localStorage.getItem(SEED_PREFIX + key) ?? undefined
  } catch {
    return undefined
  }
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function newSeed(): string {
  return seedFromBytes(randomBytes(32))
}

export function newGameId(): string {
  return Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join(
    '',
  )
}

/**
 * The messages this user must send now that involve no choice and pay nothing beyond an ordinary
 * stamp. As dealer: dealing, opening the link of a card, and a reveal that owes the player
 * nothing. As player: standing on a natural, which is final as dealt and only needs opening to
 * the dealer. Messages that pay (a paying reveal, a refund) are never returned here; the dealer
 * confirms those.
 * A hand with an own message the other side does not have yet (sending, failed, cut off) gets no
 * step: that message is the hand's last move until it is delivered or discarded, and the next
 * step must not reach the other side before it.
 */
export function automaticDealerSteps(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
): { key: string; item: BlackjackHandItem }[] {
  const waiting = new Set<string>()
  for (const message of messages) {
    const gameId = isUndeliveredOwn(message)
      ? soleHandItem(message.items)?.gameId
      : undefined
    if (gameId !== undefined) waiting.add(gameId)
  }
  const steps: { key: string; item: BlackjackHandItem }[] = []
  for (const { state } of chatHands(messages, own, peer)) {
    if (waiting.has(state.gameId)) continue
    const seed = loadSeed(own, peer, state.gameId)
    if (!seed) continue
    if (roleOf(state, own) === 'player') {
      const moves = playerMoves(state, seed)
      const stand =
        moves.length === 1 && moves[0] === 'stand'
          ? playerStep(state, 'stand', seed)
          : undefined
      if (stand && handView(state, seed).playerCards.length === 2)
        steps.push({ key: `${state.gameId}:${state.seen.length}`, item: stand })
      continue
    }
    if (roleOf(state, own) !== 'dealer') continue
    const step: DealerStep | undefined = dealerStep(state, seed)
    if (step && step.payWei === undefined)
      // One attempt per position in the hand: a failed send is retried by the user, not by a loop.
      steps.push({
        key: `${state.gameId}:${state.seen.length}`,
        item: step.item,
      })
  }
  return steps
}

/**
 * Whether `item` is still the hand's next message, checked against the messages saved on this
 * device as well as those in memory. Another tab of this account saves its outgoing message
 * before sending it, so a payout, refund, bet, deal or card that another tab already sent (or is
 * sending, or failed to send and may retry) is refused here instead of being sent a second time.
 * If the saved messages cannot be read the answer is no: nothing is paid on a guess.
 */
export async function handItemStillNext(params: {
  item: BlackjackHandItem
  /** The stamp the message would carry. */
  stampWei: bigint
  own: string
  peer: string
  memory: readonly HandChatMessage[]
  /** This chat's outgoing messages as saved on this device. */
  stored: () => Promise<readonly HandChatMessage[]>
}): Promise<boolean> {
  let saved: readonly HandChatMessage[]
  try {
    saved = await params.stored()
  } catch {
    return false
  }
  const known = new Set<string>()
  for (const message of params.memory) {
    known.add(message.payloadDigest)
    if (message.attemptDigest) known.add(message.attemptDigest)
  }
  const elsewhere = saved.filter(
    message =>
      message.outbound &&
      !known.has(message.payloadDigest) &&
      !(message.attemptDigest && known.has(message.attemptDigest)),
  )
  const events = chatHandEvents(
    [...params.memory, ...elsewhere],
    params.own,
    params.peer,
    params.item.gameId,
  )
  const result = applyHandEvent(foldHand(events).state, {
    item: params.item,
    from: params.own,
    to: params.peer,
    stampWei: params.stampWei,
    digest: '(not sent yet)',
  })
  return result.error === undefined
}

/** This chat's outgoing messages as saved on this device (by any tab of this account). */
export async function storedOutgoingMessages(
  peer: string,
): Promise<HandChatMessage[]> {
  const { store } = await import('../adapters/level-message-store')
  const messages: HandChatMessage[] = []
  for await (const wrapper of await (await store).getIterator()) {
    if (
      !wrapper.message ||
      !wrapper.outbound ||
      wrapper.copartyAddress.toLowerCase() !== peer.toLowerCase()
    )
      continue
    messages.push({
      outbound: true,
      items: wrapper.message.items,
      stampValueWei: wrapper.message.stampValueWei,
      payloadDigest: wrapper.index,
      attemptDigest: wrapper.message.delivery?.attemptDigest,
    })
  }
  return messages
}
