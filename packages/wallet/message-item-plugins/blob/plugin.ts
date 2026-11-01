import type { BlobItem } from '@frank/cashweb/types/messages'
import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { blobCodec } from './codec'
export function initBlobPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('blob', capabilities)
  registry.register<BlobItem>({
    type: 'blob',
    hydrate: raw => raw,
    previewText: item =>
      /^image\/(png|jpeg|gif|webp)$/.test(item.mimeType)
        ? 'Sent image'
        : 'Sent attachment',
    encode: blobCodec.encode,
    decode: blobCodec.decode,
  })
}
