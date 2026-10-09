import type { ReplyItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { replyCodec } from './codec'

export function initReplyPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('reply', capabilities)
  registry.register<ReplyItem>({
    type: 'reply',
    hydrate: raw => raw,
    // A reply's own text lives in the *replied-to* message, not this item, so the preview is a
    // generic placeholder: nothing has ever resolved and inlined the original text.
    previewText: () => 'Replied to a message',
    encode: replyCodec.encode,
    decode: replyCodec.decode,
  })
}
