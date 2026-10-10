import type { TextItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeTextItem, encodeTextItem } from './codec'

export function initTextPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('text', capabilities)
  registry.register<TextItem>({
    type: 'text',
    hydrate: raw => raw,
    previewText: raw => raw.text,
    encode: encodeTextItem,
    decode: decodeTextItem,
  })
}
