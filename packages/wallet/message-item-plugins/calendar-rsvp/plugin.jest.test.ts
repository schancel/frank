import type { CalendarRsvpItem } from '@frank/cashweb/types/messages'

import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initCalendarRsvpPlugin } from './plugin'

const rsvp: CalendarRsvpItem = {
  type: 'calendar-rsvp',
  uid: 'evt-1573@frank.local',
  sequence: 1,
  status: 'accepted',
  comment: 'Looking forward to it!',
  respondedAtMs: 1760400100000,
  attendee: {
    address: '0x' + 'b2'.repeat(20),
    name: 'Bob',
    email: 'bob@frank.local',
  },
}

describePluginContract({
  type: 'calendar-rsvp',
  init: initCalendarRsvpPlugin,
  samples: [
    { item: rsvp, preview: 'RSVP (accepted): Bob' },
    {
      item: {
        ...rsvp,
        status: 'declined',
        attendee: { address: '0x' + 'b2'.repeat(20) },
      },
      preview: `RSVP (declined): ${'0x' + 'b2'.repeat(20)}`,
    },
  ],
})
