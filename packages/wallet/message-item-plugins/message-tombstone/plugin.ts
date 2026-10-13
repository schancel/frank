import type { MessageTombstoneItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { messageTombstoneCodec } from './codec'

export function initMessageTombstonePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('message-tombstone', capabilities)
  registry.register<MessageTombstoneItem>({
    type: 'message-tombstone',
    hydrate: raw => raw,
    previewText: () => 'Message tombstone',
    encode: messageTombstoneCodec.encode,
    decode: messageTombstoneCodec.decode,
  })
}
