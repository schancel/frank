/**
 * The `calendar-invite` message item type (Issue #1573), installed by `initCalendarInvitePlugin`.
 */
import type { CalendarInviteItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { calendarInviteCodec } from './codec'

export function initCalendarInvitePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('calendar-invite', capabilities)
  registry.register<CalendarInviteItem>({
    type: 'calendar-invite',
    hydrate(raw) {
      return raw
    },
    previewText(raw) {
      if (raw.status === 'cancelled') {
        return `Cancelled event: ${raw.title}`
      }
      return `Calendar invite: ${raw.title}`
    },
    encode: calendarInviteCodec.encode,
    decode: calendarInviteCodec.decode,
  })
}
