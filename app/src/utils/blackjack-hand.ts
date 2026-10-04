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

const seedKey = (peer: string, gameId: string) =>
  `${peer.toLowerCase()}|${gameId}`

/** Keeps a dealer's seed for a hand on this device, per chat and game, so a seed is never shared
 * between two hands. Without it the dealer cannot deal or reveal (it can still refund the bet). */
export function saveSeed(peer: string, gameId: string, seed: string): void {
  const key = seedKey(peer, gameId)
  memorySeeds.set(key, seed)
  try {
    localStorage.setItem(SEED_PREFIX + key, seed)
  } catch {
    // Storage unavailable: the seed lives for this page session only.
  }
}

export function loadSeed(peer: string, gameId: string): string | undefined {
  const key = seedKey(peer, gameId)
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
    const seed = loadSeed(peer, state.gameId)
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
