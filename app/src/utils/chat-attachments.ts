/**
 * Pictures in a direct message. The composer and the bubble use the forum editor's attachment
 * references (`![name](attachment:ID)`, utils/post-editor.ts). On the wire a message is its
 * text item followed by its image items, and `attachment:N` in the text is the Nth image item
 * of that same message, counted from 1.
 */
import type { MessageItem } from '@frank/cashweb/types/messages'

import {
  DELIVERED_IMAGE_LIMITS,
  IMAGE_REASON_KEYS,
  MAX_SENT_MESSAGE_BYTES,
  SENT_IMAGE_LIMITS,
  SENT_ITEM_ALLOWANCE_BYTES,
  inspectImageDataUri,
} from './image-data-uri'
import {
  attachmentReferenceIds,
  compressPostImage,
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
  try {
    dataUrl = (await compressPostImage(file, CHAT_IMAGE_TARGET)).dataUrl
  } catch {
    return { ok: false, name, reasonKey: 'reasonNotAnImage' }
  }
  const check = inspectImageDataUri(dataUrl, SENT_IMAGE_LIMITS)
  if (check.ok) return { ok: true, name, dataUrl }
  return {
    ok: false,
    name,
    reasonKey: IMAGE_REASON_KEYS[check.reason] ?? 'reasonNotAnImage',
  }
}

function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** What the text and pictures take of one message; compare with `MAX_SENT_MESSAGE_BYTES`. */
export function sentMessageBytes(
  text: string,
  attachments: readonly PostAttachment[],
): number {
  const textBytes = text.trim()
    ? utf8Length(text) + SENT_ITEM_ALLOWANCE_BYTES
    : 0
  return attachments.reduce(
    (sum, a) => sum + a.dataUrl.length + SENT_ITEM_ALLOWANCE_BYTES,
    textBytes,
  )
}

export function fitsOneMessage(
  text: string,
  attachments: readonly PostAttachment[],
): boolean {
  return sentMessageBytes(text, attachments) <= MAX_SENT_MESSAGE_BYTES
}

/**
 * The items of a composed message: the reply, the text with its references renumbered to the
 * order the pictures are sent in, then the pictures. No text item when there is no text.
 */
export function composeChatItems(
  text: string,
  attachments: readonly PostAttachment[],
  replyDigest?: string | null,
): MessageItem[] {
  const position = new Map(attachments.map((a, i) => [a.id, i + 1]))
  const items: MessageItem[] = []
  if (replyDigest) items.push({ type: 'reply', payloadDigest: replyDigest })
  if (text.trim()) {
    items.push({
      type: 'text',
      text: replaceAttachmentReferences(text, (alt, id) =>
        position.has(id)
          ? `![${alt}](attachment:${position.get(id)})`
          : undefined,
      ),
    })
  }
  for (const a of attachments) items.push({ type: 'image', image: a.dataUrl })
  return items
}

/**
 * A received message's pictures that may be shown: each image item that passes the vetting
 * every delivered picture gets, with its position among the message's image items as its ID.
 */
export function shownAttachments(
  items: readonly MessageItem[],
): PostAttachment[] {
  const shown: PostAttachment[] = []
  let position = 0
  for (const item of items) {
    if (item.type !== 'image') continue
    position += 1
    if (!inspectImageDataUri(item.image, DELIVERED_IMAGE_LIMITS).ok) continue
    shown.push({
      id: String(position),
      name: '',
      dataUrl: item.image,
      sizeBytes: item.image.length,
    })
  }
  return shown
}

/** Positions (from 1) of the image items that the message's text shows inline. */
export function inlinePositions(
  items: readonly MessageItem[],
  shown: readonly PostAttachment[],
): Set<number> {
  const ids = new Set(shown.map(a => a.id))
  const inline = new Set<number>()
  for (const item of items) {
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
  const photos = items.filter(item => item.type === 'image').length
  if (photos === 0) return undefined
  const text = items
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
