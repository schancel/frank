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
  /** Wei the message carrying the item paid its recipient, as the wallet reported it. */
  stampValueWei: bigint
}

export function chatGameItems<T extends MessageItem['type']>(
  type: T,
): ChatGameItem<Extract<MessageItem, { type: T }>>[] {
  const messages = (useChatStore().activeConversation?.messages ??
    []) as readonly {
    outbound?: boolean
    items?: readonly MessageItem[]
    stampValueWei?: bigint
  }[]
  return messages.flatMap(message =>
    (message.items ?? [])
      .filter(
        (item): item is Extract<MessageItem, { type: T }> => item.type === type,
      )
      .map(item => ({
        item,
        outbound: !!message.outbound,
        stampValueWei: message.stampValueWei ?? 0n,
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
