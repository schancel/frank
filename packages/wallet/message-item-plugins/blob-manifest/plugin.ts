import type { BlobManifestItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { blobManifestCodec } from './codec'

export function initBlobManifestPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('blob-manifest', capabilities)
  registry.register<BlobManifestItem>({
    type: 'blob-manifest',
    hydrate: raw => raw,
    previewText: raw =>
      raw.fileName ? `Attachment: ${raw.fileName}` : 'Encrypted attachment',
    encode: blobManifestCodec.encode,
    decode: blobManifestCodec.decode,
  })
}
