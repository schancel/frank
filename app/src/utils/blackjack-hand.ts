/**
 * App glue for peer-to-peer blackjack. The rules live in the shared state machine
 * (`@frank/wallet/message-item-plugins/blackjack/hand`); this file only turns a chat's stored
 * messages into its events and keeps a dealer's seeds on this device.
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
  roleOf,
  seedFromBytes,
  soleHandItem,
  type DealerStep,
  type HandEvent,
  type HandRejection,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

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

/**
 * This user's own hand messages in a chat that are not delivered: still sending, or failed
 * (also a send cut off by closing the window). A hand's state counts them as sent so that no
 * move is offered twice, so the hand cannot go on until each is delivered or discarded.
 */
export function undeliveredHandMessages(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
): UndeliveredHandMessage[] {
  const undelivered: UndeliveredHandMessage[] = []
  for (const message of messages) {
    if (!message.outbound || message.status === undefined) continue
    if (message.status === 'confirmed') continue
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

/** What the chat store offers for an outgoing message that failed. */
export interface HandResumeStore {
  /** A fresh send of a failed message; asks before it could pay a second time. */
  retryOutgoing(params: {
    wallet: unknown
    address: string
    payloadDigest: string
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
 * session (`attempted`), oldest first:
 *
 * - A message whose stamp is an ordinary stamp (challenge, accept, deal, hit, stand, card, a
 *   reveal that owes nothing) is sent again without asking, through the same retry a person's
 *   Retry button uses: an earlier payment for it is settled first and its bytes re-sent while it
 *   is live, and where a second payment cannot be ruled out nothing is sent and the bubble keeps
 *   its Retry.
 * - A message that carries money (bet, double, paying reveal, refund) is only settled: if a
 *   payment was recorded for it and is still live at the relay the same bytes are re-sent. A new
 *   payment is never built here; the bubble shows Retry and the user decides.
 *
 * Returns how many messages it acted on.
 */
export async function resumeHandMessages(params: {
  store: HandResumeStore
  wallet: unknown
  address: string
  own: string
  messages: readonly HandChatMessage[]
  attempted: Set<string>
}): Promise<number> {
  let acted = 0
  for (const message of undeliveredHandMessages(
    params.messages,
    params.own,
    params.address,
  )) {
    const key = `resume:${message.payloadDigest}`
    if (message.state !== 'failed' || params.attempted.has(key)) continue
    params.attempted.add(key)
    const target = {
      wallet: params.wallet,
      address: params.address,
      payloadDigest: message.payloadDigest,
    }
    try {
      if (!message.carriesMoney) await params.store.retryOutgoing(target)
      else if (message.hasAttempt) await params.store.resumeOutgoing(target)
      else continue
      acted++
    } catch (error) {
      // The message stays failed with its Retry; nothing was paid on a guess.
      console.warn('could not resume a blackjack message', error)
    }
  }
  return acted
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

/** Keeps a dealer's seed for a hand on this device, under the dealer's own account, the chat and
 * the game: a seed is never shared between two hands, and another account used in the same
 * browser profile does not find it under its own name. Without the seed the dealer cannot deal
 * or reveal (it can still refund the bet). */
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
 * The dealer messages this user must send now that involve no choice and pay nothing beyond an
 * ordinary stamp: dealing, dealing a card, and a reveal that owes the player nothing. Messages
 * that pay (a paying reveal, a refund) are never returned here; the dealer confirms those.
 */
export function automaticDealerSteps(
  messages: readonly HandChatMessage[],
  own: string,
  peer: string,
): { key: string; item: BlackjackHandItem }[] {
  const steps: { key: string; item: BlackjackHandItem }[] = []
  for (const { state } of chatHands(messages, own, peer)) {
    if (roleOf(state, own) !== 'dealer') continue
    const seed = loadSeed(own, peer, state.gameId)
    if (!seed) continue
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
