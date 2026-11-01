import type { BlobItem } from '@frank/cashweb/types/messages'
/** Fixtures can name local previews or arbitrary bytes; the actual wire always receives bytes. */
export function testBlob(value: string): BlobItem {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(value)
  return {
    type: 'blob',
    mimeType: match?.[1] ?? 'image/png',
    data: Uint8Array.from(
      Buffer.from(match?.[2] ?? value, match ? 'base64' : 'utf8'),
    ),
  }
}
