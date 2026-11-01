import { isMimeType } from '@frank/codec'
import type { BlobItem } from '@frank/cashweb/types/messages'
import { MAX_BLOB_BYTES } from '@frank/wallet/message-item-plugins/blob/codec'
export interface ChatImageAttachment {
  id: string
  name: string
  data: Uint8Array
  mimeType: string
  sizeBytes: number
}
/** Draft/compressor previews remain local data URLs; canonical message content is native bytes. */
export function blobOfDataUrl(value: string): BlobItem {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || !isMimeType(match[1]))
    throw new Error('Invalid local attachment preview')
  const binary = atob(match[2])
  if (binary.length > MAX_BLOB_BYTES)
    throw new Error('Attachment exceeds 512 KiB')
  return {
    type: 'blob',
    mimeType: match[1],
    data: Uint8Array.from(binary, c => c.charCodeAt(0)),
  }
}
export function attachmentByteLength(value: string): number {
  const base64 = value.slice(value.indexOf(',') + 1)
  return (
    Math.floor((base64.length * 3) / 4) -
    (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  )
}
