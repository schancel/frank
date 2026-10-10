import type { ImageItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { imageCodec } from './codec'

export function initImagePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('image', capabilities)
  registry.register<ImageItem>({
    type: 'image',
    hydrate: raw => raw,
    previewText: () => 'Sent image',
    encode: imageCodec.encode,
    decode: imageCodec.decode,
  })
}
