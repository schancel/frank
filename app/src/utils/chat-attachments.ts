import {
  blobOfDataUrl,
  attachmentByteLength,
  type ChatImageAttachment,
} from './chat-binary'
/**
 * Pictures in a direct message. The composer and the bubble use the forum editor's attachment
 * references (`![name](attachment:ID)`, utils/post-editor.ts). On the wire a message is its
 * text (one text item, or consecutive ones for a long text) followed by its blob entries, and
 * `attachment:N` in the text is the Nth blob entry of that same message, counted from 1.
 */
import { isMimeType } from '@frank/codec'
import { MAX_BLOB_BYTES } from '@frank/wallet/message-item-plugins/blob/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { MAX_MESSAGE_ITEMS_TOTAL, MAX_TEXT_STRING_BYTES } from '@frank/codec'
import {
  joinConsecutiveTextItems,
  splitTextByUtf8Bytes,
  textItemsOf,
  utf8ByteLength,
} from '@frank/wallet/message-item-plugins/text/long-text'

import {
  DELIVERED_IMAGE_LIMITS,
  IMAGE_REASON_KEYS,
  MAX_SENT_MESSAGE_BYTES,
  SENT_IMAGE_LIMITS,
  SENT_ITEM_ALLOWANCE_BYTES,
  inspectImageDataUri,
  inspectImageBytes,
} from './image-data-uri'
import {
  attachmentReferenceIds,
  compressPostImage,
  formatAttachmentSize,
  replaceAttachmentReferences,
  type PostAttachment,
} from './post-editor'

/** What a picked picture is downscaled and re-encoded towards: three fit one message. */
export const CHAT_IMAGE_TARGET = { maxDimension: 1280, maxBytes: 160 * 1024 }

export type PreparedChatImage =
  | { ok: true; name: string; dataUrl: string }
  /** `reasonKey` is a `chatImage.*` message key. */
  | { ok: false; name: string; reasonKey: string }

/**
 * Downscales a picked, pasted or dropped picture with the forum's compressor, then accepts it
 * only if a recipient's app would show it and one message can hold it.
 */
export async function prepareChatImage(
  file: File | Blob,
): Promise<PreparedChatImage> {
  const name = ('name' in file && file.name) || 'image'
  let dataUrl: string
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
    if (file.size > MAX_BLOB_BYTES)
      return { ok: false, name, reasonKey: 'reasonTooLarge' }
    const mimeType = file.type || 'application/octet-stream'
    if (!isMimeType(mimeType))
      return { ok: false, name, reasonKey: 'reasonNotInline' }
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return {
      ok: true,
      name,
      dataUrl: `data:${mimeType};base64,${btoa(binary)}`,
    }
  }
  try {
    dataUrl = (await compressPostImage(file, CHAT_IMAGE_TARGET)).dataUrl
  } catch {
    return { ok: false, name, reasonKey: 'reasonNotAnImage' }
  }
  const check = inspectImageDataUri(dataUrl, SENT_IMAGE_LIMITS)
  if (check.ok)
    return attachmentByteLength(dataUrl) <= MAX_BLOB_BYTES
      ? { ok: true, name, dataUrl }
      : { ok: false, name, reasonKey: 'reasonTooLarge' }
  return {
    ok: false,
    name,
    reasonKey: IMAGE_REASON_KEYS[check.reason] ?? 'reasonNotAnImage',
  }
}

/** The text items a composed text travels as: one, or as many as it needs (`textItemsOf`). */
function textItemCount(text: string): number {
  return text.length * 3 <= MAX_TEXT_STRING_BYTES
    ? 1
    : splitTextByUtf8Bytes(text).length
}

/** What the text and pictures take of one message; compare with `MAX_SENT_MESSAGE_BYTES`. The
 * text counts its UTF-8 bytes and an allowance for each text item it travels as. */
export function sentMessageBytes(
  text: string,
  attachments: readonly PostAttachment[],
): number {
  const textBytes = text.trim()
    ? utf8ByteLength(text) + textItemCount(text) * SENT_ITEM_ALLOWANCE_BYTES
    : 0
  return attachments.reduce(
    (sum, a) =>
      sum + attachmentByteLength(a.dataUrl) + SENT_ITEM_ALLOWANCE_BYTES,
    textBytes,
  )
}

/** Items a message may hold besides its text and pictures: a reply reference and the wakeup
 * card the app may add (`outgoingWakeupItems`). */
const OTHER_ITEMS = 2

export function fitsOneMessage(
  text: string,
  attachments: readonly PostAttachment[],
): boolean {
  // A message holds at most `MAX_MESSAGE_ITEMS_TOTAL` items, whatever their size.
  if (
    attachments.length + OTHER_ITEMS + (text.trim() ? 1 : 0) >
    MAX_MESSAGE_ITEMS_TOTAL
  )
    return false
  if (
    text.trim() &&
    attachments.length + OTHER_ITEMS + textItemCount(text) >
      MAX_MESSAGE_ITEMS_TOTAL
  )
    return false
  const attachmentBytes = attachments.reduce(
    (sum, a) =>
      sum + attachmentByteLength(a.dataUrl) + SENT_ITEM_ALLOWANCE_BYTES,
    0,
  )
  // At most 3 UTF-8 bytes per UTF-16 unit, and a text item for each 128 KiB at the very least.
  if (
    attachmentBytes +
      text.length * 3 +
      (Math.ceil((text.length * 3) / (MAX_TEXT_STRING_BYTES / 2)) + 1) *
        SENT_ITEM_ALLOWANCE_BYTES <=
    MAX_SENT_MESSAGE_BYTES
  ) {
    return true
  }
  return sentMessageBytes(text, attachments) <= MAX_SENT_MESSAGE_BYTES
}

/** "This message is too large to send: one message holds at most 8.0 MiB, and this one is
 * 9.1 MiB. …" (`chatInput.messageTooLarge`). `t` is the app's translate function. */
export function messageTooLargeText(
  text: string,
  attachments: readonly PostAttachment[],
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const bytes = sentMessageBytes(text, attachments)
  let limit = formatAttachmentSize(MAX_SENT_MESSAGE_BYTES)
  let size = formatAttachmentSize(bytes)
  // Just over the limit both round to the same figure: then both are given in bytes.
  if (limit === size) {
    limit = `${MAX_SENT_MESSAGE_BYTES} B`
    size = `${bytes} B`
  }
  return t('chatInput.messageTooLarge', { limit, size })
}

/**
 * The items of a composed message: the reply, the text with its references renumbered to the
 * order the pictures are sent in, then the native binary attachments. No text item when there is no text. A text
 * longer than one text item holds is sent as consecutive text items (`textItemsOf`), which a
 * reader shows as one text (`joinConsecutiveTextItems`).
 */
export function composeChatItems(
  text: string,
  attachments: readonly PostAttachment[],
  replyDigest?: string | null,
): MessageItem[] {
  const position = new Map(attachments.map((a, i) => [a.id, i + 1]))
  const imageIds = new Set(
    attachments
      .filter(a => /^data:image\/(png|jpeg|gif|webp);/.test(a.dataUrl))
      .map(a => a.id),
  )
  const items: MessageItem[] = []
  if (replyDigest) items.push({ type: 'reply', payloadDigest: replyDigest })
  if (text.trim()) {
    items.push(
      ...textItemsOf(
        replaceAttachmentReferences(text, (alt, id) =>
          position.has(id)
            ? imageIds.has(id)
              ? `![${alt}](attachment:${position.get(id)})`
              : alt
            : undefined,
        ),
      ),
    )
  }
  for (const a of attachments) items.push(blobOfDataUrl(a.dataUrl))
  return items
}

/**
 * A received message's pictures that may be shown: each image item that passes the vetting
 * every delivered picture gets, with its position among the message's image items as its ID.
 */
export function shownAttachments(
  items: readonly MessageItem[],
): ChatImageAttachment[] {
  const shown: ChatImageAttachment[] = []
  let position = 0
  for (const item of items) {
    if (item.type !== 'blob') continue
    position += 1
    if (!inspectImageBytes(item.data, item.mimeType, DELIVERED_IMAGE_LIMITS).ok)
      continue
    shown.push({
      id: String(position),
      name: '',
      data: item.data,
      mimeType: item.mimeType,
      sizeBytes: item.data.length,
    })
  }
  return shown
}

/** Positions (from 1) of the image items that the message's text shows inline. */
export function inlinePositions(
  items: readonly MessageItem[],
  shown: readonly ChatImageAttachment[],
): Set<number> {
  const ids = new Set(shown.map(a => a.id))
  const inline = new Set<number>()
  for (const item of joinConsecutiveTextItems(items)) {
    if (item.type !== 'text') continue
    for (const id of attachmentReferenceIds(item.text)) {
      if (ids.has(id)) inline.add(Number(id))
    }
  }
  return inline
}

/**
 * What a chat list row or a notification says about a message that carries pictures: how many,
 * and its text without the attachment references. Undefined for a message with no picture,
 * whose preview is its last item's as before.
 */
export function picturePreview(
  items: readonly MessageItem[],
): { photos: number; text: string } | undefined {
  const photos = items.filter(
    item =>
      item.type === 'blob' &&
      /^image\/(png|jpeg|gif|webp)$/.test(item.mimeType),
  ).length
  if (photos === 0) return undefined
  const text = joinConsecutiveTextItems(items)
    .flatMap(item => (item.type === 'text' ? [item.text] : []))
    .map(t => replaceAttachmentReferences(t, () => ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { photos, text }
}

/** "📷 Photo" or "📷 3 photos", then the text. `t` is the app's translate function. */
export function picturePreviewText(
  preview: { photos: number; text: string },
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const label =
    preview.photos === 1
      ? t('chatImage.onePhoto')
      : t('chatImage.manyPhotos', { count: preview.photos })
  return preview.text ? `${label} ${preview.text}` : label
}

/** Half of a UTF-16 surrogate pair with no other half: not a character, and not text the wallet
 * can send (a message's text is UTF-8). */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * The text with every lone surrogate (what a broken emoji paste leaves) replaced by U+FFFD, the
 * replacement character "�", as a browser does when it writes such text as UTF-8 and as
 * messaging apps do with broken text. Text without one is returned as it is.
 */
export function replaceLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '�')
}

export function hasLoneSurrogate(text: string): boolean {
  LONE_SURROGATE.lastIndex = 0
  const found = LONE_SURROGATE.test(text)
  LONE_SURROGATE.lastIndex = 0
  return found
}
