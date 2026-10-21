/**
 * The `contact-card` message item type (Issue #1573), installed by `initContactCardPlugin`.
 */
import type {
  ContactCardItem,
  MessageItem,
} from '@frank/cashweb/types/messages'

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

/** Reserved protocol sidecar appended to a human message for peer wakeup-token exchange.
 * Its UID, not the user-editable contact name, identifies its purpose. Keep it in the
 * message for token processing and replay, but exclude it from presentation. */
export function isWakeupCapabilitySidecar(item: MessageItem): boolean {
  return (
    item.type === 'contact-card' &&
    item.uid === 'frank-wakeup-capability' &&
    typeof item.wakeupTokenHex === 'string' &&
    /^[0-9a-fA-F]{64}$/.test(item.wakeupTokenHex)
  )
}
