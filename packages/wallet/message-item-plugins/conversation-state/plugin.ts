import type { ConversationStateItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { conversationStateCodec } from './codec'

export function initConversationStatePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('conversation-state', capabilities)
  registry.register<ConversationStateItem>({
    type: 'conversation-state',
    hydrate: raw => raw,
    previewText: () => 'Conversation state',
    encode: conversationStateCodec.encode,
    decode: conversationStateCodec.decode,
  })
}
