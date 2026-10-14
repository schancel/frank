import type { CalendarInviteItem } from '@frank/cashweb/types/messages'

import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initCalendarInvitePlugin } from './plugin'

const invite: CalendarInviteItem = {
  type: 'calendar-invite',
  uid: 'evt-1573@frank.local',
  sequence: 1,
  title: 'Protocol Sync',
  startMs: 1760400000000,
  endMs: 1760403600000,
  timezone: 'America/Los_Angeles',
  allDay: false,
  location: 'https://meet.frank.local/sync',
  description: 'Weekly architecture review',
  url: 'https://meet.frank.local/sync',
  organizer: {
    address: '0x' + 'a1'.repeat(20),
    name: 'Alice',
    email: 'alice@frank.local',
  },
  attendees: [
    {
      address: '0x' + 'b2'.repeat(20),
      name: 'Bob',
      email: 'bob@frank.local',
      role: 'req-participant',
      rsvp: true,
    },
  ],
  recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU',
  status: 'confirmed',
}

describePluginContract({
  type: 'calendar-invite',
  init: initCalendarInvitePlugin,
  samples: [
    { item: invite, preview: 'Calendar invite: Protocol Sync' },
    {
      item: {
        ...invite,
        status: 'cancelled',
      },
      preview: 'Cancelled event: Protocol Sync',
    },
  ],
})
