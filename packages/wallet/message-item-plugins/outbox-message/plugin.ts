import type { OutboxMessageItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { outboxMessageCodec } from './codec'

export function initOutboxMessagePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('outbox-message', capabilities)
  registry.register<OutboxMessageItem>({
    type: 'outbox-message',
    hydrate: raw => raw,
    previewText: item => item.text ?? 'Outbox message',
    encode: outboxMessageCodec.encode,
    decode: outboxMessageCodec.decode,
  })
}
