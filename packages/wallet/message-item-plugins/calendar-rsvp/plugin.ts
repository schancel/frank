/**
 * The `calendar-rsvp` message item type (Issue #1573), installed by `initCalendarRsvpPlugin`.
 */
import type { CalendarRsvpItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { calendarRsvpCodec } from './codec'

export function initCalendarRsvpPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('calendar-rsvp', capabilities)
  registry.register<CalendarRsvpItem>({
    type: 'calendar-rsvp',
    hydrate(raw) {
      return raw
    },
    previewText(raw) {
      const who = raw.attendee.name || raw.attendee.address
      return `RSVP (${raw.status}): ${who}`
    },
    encode: calendarRsvpCodec.encode,
    decode: calendarRsvpCodec.decode,
  })
}
