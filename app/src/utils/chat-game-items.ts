/**
 * The game items of the open conversation, for a game card that has to check a result against
 * what was said before it: the player's own bet or move, and the bot's other results.
 */
import type { MessageItem } from '@frank/cashweb/types/messages'

import { useChatStore } from '../stores/chats'

export interface ChatGameItem<T> {
  item: T
  /** True for an item this user sent. */
  outbound: boolean
  /** Wei the message carrying the item paid its recipient, as the wallet reported it. Not a
   * chain check. */
  stampValueWei: bigint
  /** When the message was sent or received, in milliseconds; 0 if unknown. */
  timeMs: number
  /** True for an own message whose send failed: it is in the chat with its Retry and Discard,
   * and the peer has not received it. */
  failed: boolean
}

/** How long a card waits for the bot's answer before it says plainly that none has come. */
export const BOT_ANSWER_WAIT_MS = 90_000

/**
 * `peer` is the account the card belongs to (the bot). A received item counts only if its
 * message's sender is that account: in a conversation with more than two members nobody else's
 * message can stand in for the bot's. A message that records no sender (before sender
 * attribution exists) is taken as the peer's, as it can only be in a two-party chat.
 */
export function chatGameItems<T extends MessageItem['type']>(
  type: T,
  peer?: string,
): ChatGameItem<Extract<MessageItem, { type: T }>>[] {
  const messages = (useChatStore().activeConversation?.messages ??
    []) as readonly {
    outbound?: boolean
    status?: string
    items?: readonly MessageItem[]
    stampValueWei?: bigint
    senderAddress?: string
    serverTime?: number
    receivedTime?: number
  }[]
  const fromPeer = (sender?: string) =>
    !sender || !peer || sender.toLowerCase() === peer.toLowerCase()
  return messages
    .filter(message => message.outbound || fromPeer(message.senderAddress))
    .flatMap(message =>
      (message.items ?? [])
        .filter(
          (item): item is Extract<MessageItem, { type: T }> =>
            item.type === type,
        )
        .map(item => ({
          item,
          outbound: !!message.outbound,
          stampValueWei: message.stampValueWei ?? 0n,
          timeMs: message.serverTime || message.receivedTime || 0,
          failed: !!message.outbound && message.status === 'error',
        })),
    )
}

/** A wager typed by the user, in wei; 0n for nothing, undefined for something that is not an
 * amount. */
export function parseWager(
  text: string,
  fromDisplayAmount: (amount: string) => bigint,
): bigint | undefined {
  const trimmed = text.trim()
  if (!trimmed) return 0n
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined
  try {
    return fromDisplayAmount(trimmed)
  } catch {
    return undefined
  }
}

export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
