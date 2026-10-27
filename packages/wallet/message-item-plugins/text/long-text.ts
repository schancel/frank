/**
 * Text longer than one text item holds. A text item carries at most `MAX_TEXT_STRING_BYTES`
 * (256 KiB) of UTF-8, a codec limit; a direct message carries far more. A longer text is sent as
 * several consecutive text items of one message, and a reader shows consecutive text items as
 * one continuous text: joined with nothing between them, so the text arrives byte for byte.
 *
 * Pure: no wallet, no transport. The app's composer and any bot use the same functions.
 */
import type { MessageItem, TextItem } from '@frank/cashweb/types/messages'
import { MAX_TEXT_STRING_BYTES } from '@frank/codec'

/** How far back from a piece's byte limit a line break or a space is looked for, to end the
 * piece there rather than mid-word. Only presentation for a reader that does not join pieces. */
const BOUNDARY_SEARCH_BYTES = 4096

/** UTF-8 bytes of the code unit at `i` of `text`: a surrogate pair counts 4 at its first unit
 * and 0 at its second; a lone surrogate counts 3 (it is written as U+FFFD). */
function unitBytes(text: string, i: number): number {
  const code = text.charCodeAt(i)
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 3
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = i > 0 ? text.charCodeAt(i - 1) : 0
    return prev >= 0xd800 && prev <= 0xdbff ? 0 : 3
  }
  return 3
}

/** The UTF-8 length of `text`, as `TextEncoder` writes it, without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) bytes += unitBytes(text, i)
  return bytes
}

/**
 * Splits `text` into pieces of at most `maxBytes` UTF-8 bytes each whose concatenation is
 * `text`. No piece ends inside a code point. A piece ends after the last line break, else the
 * last space, within the last 4 KiB of its limit when there is one; otherwise exactly at the
 * limit. A text that fits is one piece; the empty text is one empty piece.
 */
export function splitTextByUtf8Bytes(
  text: string,
  maxBytes: number = MAX_TEXT_STRING_BYTES,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4)
    throw new RangeError(`a text piece must hold at least one code point (${maxBytes})`)
  const pieces: string[] = []
  let start = 0
  while (start < text.length) {
    let bytes = 0
    let end = start
    // Last line break and last space seen within the search window, as piece ends.
    let lineEnd = -1
    let spaceEnd = -1
    while (end < text.length) {
      const width = unitBytes(text, end)
      // A surrogate pair is taken whole (its second unit counts 0).
      const step = width === 4 ? 2 : 1
      if (bytes + width > maxBytes) break
      bytes += width
      end += step
      if (bytes > maxBytes - BOUNDARY_SEARCH_BYTES) {
        const last = text.charCodeAt(end - 1)
        if (last === 0x0a) lineEnd = end
        else if (last === 0x20) spaceEnd = end
      }
    }
    if (end < text.length) {
      if (lineEnd > start) end = lineEnd
      else if (spaceEnd > start) end = spaceEnd
    }
    pieces.push(text.slice(start, end))
    start = end
  }
  return pieces.length === 0 ? [''] : pieces
}

/** The text items that carry `text`: one when it fits a text item, else consecutive pieces. */
export function textItemsOf(text: string): TextItem[] {
  return splitTextByUtf8Bytes(text).map(piece => ({ type: 'text', text: piece }))
}

/**
 * `items` with each text item longer than one text item holds replaced, in place, by the
 * consecutive text items that carry it (`textItemsOf`); every other item, and every text that
 * fits, is kept as it is. A reader shows the result as `items` (`joinConsecutiveTextItems`).
 * Returns the same array when nothing needs splitting. Deterministic: the same items always give
 * the same result, so a message sent again under its ID has the same bytes.
 */
export function splitLongTextItems(items: readonly MessageItem[]): MessageItem[] {
  if (
    !items.some(
      item => item.type === 'text' && item.text.length * 3 > MAX_TEXT_STRING_BYTES &&
        utf8ByteLength(item.text) > MAX_TEXT_STRING_BYTES,
    )
  )
    return items as MessageItem[]
  return items.flatMap(item =>
    item.type === 'text' && utf8ByteLength(item.text) > MAX_TEXT_STRING_BYTES
      ? textItemsOf(item.text)
      : [item],
  )
}

/**
 * A message's items as a reader shows them: each run of consecutive text items is one text item
 * holding their texts joined with nothing between them. Every other item is kept as it is, in
 * order. Returns the same array when there is nothing to join.
 */
export function joinConsecutiveTextItems<T extends MessageItem>(
  items: readonly T[],
): T[] {
  const joined = joinConsecutiveTextItemsIndexed(items)
  return joined.length === items.length
    ? (items as T[])
    : joined.map(entry => entry.item)
}

/** Each displayed item of {@link joinConsecutiveTextItems} with the index in `items` of its first
 * item, for callers that address a message's items by position. */
export function joinConsecutiveTextItemsIndexed<T extends MessageItem>(
  items: readonly T[],
): { item: T; index: number }[] {
  const out: { item: T; index: number }[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type !== 'text') {
      out.push({ item, index: i })
      continue
    }
    let j = i + 1
    while (j < items.length && items[j].type === 'text') j++
    out.push({
      item:
        j === i + 1
          ? item
          : ({
              ...item,
              text: items
                .slice(i, j)
                .map(t => (t as TextItem).text)
                .join(''),
            } as T),
      index: i,
    })
    i = j - 1
  }
  return out
}
