import { isMimeType, MAX_PLUGIN_ITEM_PAYLOAD_BYTES } from '@frank/codec'
import type { BlobItem } from '@frank/cashweb/types/messages'
import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  type MessageItemDecodeContext,
} from '@frank/cashweb/message-items/registry'
export const MAX_BLOB_BYTES = MAX_PLUGIN_ITEM_PAYLOAD_BYTES
export const blobCodec = {
  encode(item: BlobItem): Uint8Array {
    if (
      item.type !== 'blob' ||
      !isMimeType(item.mimeType) ||
      !(item.data instanceof Uint8Array) ||
      item.data.length > MAX_BLOB_BYTES
    )
      throw new MessageItemEncodeError(
        'blob',
        'expected native bytes within 512 KiB and a canonical MIME type',
      )
    return Uint8Array.from(item.data)
  },
  decode(data: Uint8Array, context: MessageItemDecodeContext): BlobItem {
    if (
      !isMimeType(context.mimeType) ||
      !(data instanceof Uint8Array) ||
      data.length > MAX_BLOB_BYTES
    )
      throw new MessageItemDecodeError(
        'blob',
        'expected native bytes within 512 KiB and a canonical MIME type',
      )
    return {
      type: 'blob',
      mimeType: context.mimeType,
      data: Uint8Array.from(data),
    }
  },
}
