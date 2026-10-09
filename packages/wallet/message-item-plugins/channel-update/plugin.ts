import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeChannelUpdate, encodeChannelUpdate } from './codec'

export function initChannelUpdatePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('channel-update', capabilities)
  registry.register<ChannelUpdateItem>({
    type: 'channel-update',
    hydrate: raw => raw,
    previewText: raw =>
      `State channel update: ${raw.appId} (seq ${raw.sequenceNumber})`,
    encode: encodeChannelUpdate,
    decode: decodeChannelUpdate,
  })
}
