import {
  encodeFrame,
  validateFrame,
  standaloneItemBudget,
  TYPE_MESSAGE_CONTENT_REVISION,
} from '@frank/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  encodeItemFrames,
  decodeItemFrames,
} from '@frank/wallet/message-item-plugins/wire'
import {
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
} from '@frank/cashweb/message-items/registry'
import { installMessageItemPlugin } from '@frank/cashweb/message-items/registry'
import { initTextPlugin } from '@frank/wallet/message-item-plugins/text/plugin'
import { initImagePlugin } from '@frank/wallet/message-item-plugins/image/plugin'
import { initReplyPlugin } from '@frank/wallet/message-item-plugins/reply/plugin'
import { initCalendarInvitePlugin } from '@frank/wallet/message-item-plugins/calendar-invite/plugin'
import { initCalendarRsvpPlugin } from '@frank/wallet/message-item-plugins/calendar-rsvp/plugin'
import { initContactCardPlugin } from '@frank/wallet/message-item-plugins/contact-card/plugin'

// Groups currently support conversation content. Payment and game capabilities are not installed.
const messageItems = createMessageItemRegistry()
for (const [type, init] of [
  ['text', initTextPlugin],
  ['image', initImagePlugin],
  ['reply', initReplyPlugin],
  ['calendar-invite', initCalendarInvitePlugin],
  ['calendar-rsvp', initCalendarRsvpPlugin],
  ['contact-card', initContactCardPlugin],
] as const)
  installMessageItemPlugin(
    messageItems,
    pluginCapabilitiesNotYetAvailable,
    type,
    init,
  )

/** Group content uses the same composed item codecs and limits as direct messages. */
export function encodeGroupItems(items: MessageItem[]): Uint8Array {
  const children = encodeItemFrames(messageItems, items)
  return encodeFrame(
    {
      typeId: TYPE_MESSAGE_CONTENT_REVISION,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    new Map<number, string | Uint8Array[]>([
      [0, 'frank'],
      [1, children],
    ]),
  )
}

export function decodeGroupItems(payload: Uint8Array): MessageItem[] {
  const frame = validateFrame(payload)
  if (
    frame.kind !== 'parsed' ||
    frame.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('Invalid group message content')
  return decodeItemFrames(
    messageItems,
    frame.typed.items,
    standaloneItemBudget(),
  )
}
