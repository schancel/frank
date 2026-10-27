/**
 * What one sealed direct message can carry, for a composer to refuse a message before Send
 * rather than have the wallet refuse it later.
 *
 * A direct message carries at most `MAX_DM_CIPHERTEXT_BYTES` (8 MiB) of ciphertext. A sealed one
 * is also copied, whole, into its note to self, which must fit a direct message too
 * (`requireSelfCopyFits` in canonical-dm.ts): the note holds the original's item frames plus its
 * own fields. So a sealed message's items, framed, may take the ciphertext limit less the room
 * of those fields at their widest.
 *
 * Pure constants and arithmetic: no wallet, no transport.
 */
import type { MessageItem } from '@frank/cashweb/types/messages'
import { MAX_DM_CIPHERTEXT_BYTES, MAX_MESSAGE_ITEMS_TOTAL } from '@frank/codec'
import { utf8ByteLength } from '../message-item-plugins/text/long-text'

/** Counted for each item of a message on top of its content: a text item's frame adds 25 bytes
 * to its text, an image item's 44 to its data URI, and the note to self adds a few bytes per
 * item frame it holds. */
export const DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES = 64

/**
 * The fields of a sealed message and of its note to self, at their widest, that are not counted
 * per item: the payload's message and conversation IDs, a conversation name (at most 512
 * bytes), the note's digest, recipient, time and widest stamp, the crypto-box framing, plus a
 * reply reference and the app's wakeup contact card that may ride along. The largest paid
 * sealed message of 33 text items holds 8,386,916 bytes of text, 1,692 bytes under the
 * ciphertext limit for all framing and fields together (monad-dm-cluster.livecheck.ts step 7);
 * 16 KiB leaves ample room. self-wallet-sync.jest.test.ts sends a message of exactly {@link
 * MAX_SEALED_MESSAGE_CONTENT_BYTES} with a reply, the widest subject and a wakeup card.
 */
export const SEALED_MESSAGE_FIELDS_ALLOWANCE_BYTES = 16 * 1024

/**
 * The most a sealed message's content may take: the sum, over its items, of each one's content
 * bytes (a text's UTF-8 bytes, an image's data URI) plus {@link
 * DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES}. A message within it fits both a direct message and its
 * note to self.
 */
export const MAX_SEALED_MESSAGE_CONTENT_BYTES =
  MAX_DM_CIPHERTEXT_BYTES - SEALED_MESSAGE_FIELDS_ALLOWANCE_BYTES

/**
 * What `items` take of a sealed message, counted as {@link MAX_SEALED_MESSAGE_CONTENT_BYTES}
 * counts it: a text's UTF-8 bytes, an image's data URI, and {@link
 * DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES} for every item. Other items count only their allowance;
 * the wallet still refuses, when it encodes them, a message they make too large.
 */
export function sealedMessageContentBytes(items: readonly MessageItem[]): number {
  let bytes = 0
  for (const item of items) {
    bytes += DIRECT_MESSAGE_ITEM_ALLOWANCE_BYTES
    if (item.type === 'text') bytes += utf8ByteLength(item.text)
    else if (item.type === 'image') bytes += item.image.length
  }
  return bytes
}

/** Why `items` (with long texts already split into text items) cannot be one sealed message:
 * more items than a message holds, or more content than it carries. Undefined when they fit. */
export function sealedMessageOverLimit(items: readonly MessageItem[]): string | undefined {
  if (items.length > MAX_MESSAGE_ITEMS_TOTAL)
    return `it has ${items.length} items and a message holds at most ${MAX_MESSAGE_ITEMS_TOTAL}`
  const bytes = sealedMessageContentBytes(items)
  if (bytes > MAX_SEALED_MESSAGE_CONTENT_BYTES)
    return `it takes ${bytes} bytes and a sealed message carries at most ${MAX_SEALED_MESSAGE_CONTENT_BYTES}`
  return undefined
}
