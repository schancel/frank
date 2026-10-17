/**
 * The `contact-card` message item type (Issue #1573), installed by `initContactCardPlugin`.
 */
import type { ContactCardItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { contactCardCodec } from './codec'

export function initContactCardPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('contact-card', capabilities)
  registry.register<ContactCardItem>({
    type: 'contact-card',
    hydrate(raw) {
      return raw
    },
    previewText(raw) {
      return `Contact card: ${raw.fullName}`
    },
    encode: contactCardCodec.encode,
    decode: contactCardCodec.decode,
  })
}
