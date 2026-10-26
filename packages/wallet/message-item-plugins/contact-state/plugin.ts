import type { ContactStateItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { contactStateCodec } from './codec'

export function initContactStatePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('contact-state', capabilities)
  registry.register<ContactStateItem>({
    type: 'contact-state',
    hydrate: raw => raw,
    previewText: () => 'Contact state',
    encode: contactStateCodec.encode,
    decode: contactStateCodec.decode,
  })
}
