import { MAX_TEXT_STRING_BYTES } from '@frank/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'

/**
 * The most UTF-8 bytes one text item of a direct message may hold. This is the canonical codec's
 * own text-string limit (a type-17 text item is refused by `parseFrame` above it), not a number
 * chosen here: anything longer can never be encoded, let alone delivered.
 */
export const MAX_MESSAGE_TEXT_BYTES = MAX_TEXT_STRING_BYTES

/** True when `text` is longer than the canonical limit, without encoding it unless needed. */
export function textExceedsLimit(text: string): boolean {
  // Every UTF-16 code unit is at least one UTF-8 byte, and at most three.
  if (text.length > MAX_MESSAGE_TEXT_BYTES) return true
  if (text.length * 3 <= MAX_MESSAGE_TEXT_BYTES) return false
  return new TextEncoder().encode(text).length > MAX_MESSAGE_TEXT_BYTES
}

export function itemsExceedTextLimit(items: readonly MessageItem[]): boolean {
  return items.some(item => item.type === 'text' && textExceedsLimit(item.text))
}
