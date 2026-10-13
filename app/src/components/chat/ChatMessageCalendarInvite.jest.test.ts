/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import ChatMessageCalendarInvite from './ChatMessageCalendarInvite.vue'
import enUS from '../../i18n/en-us'
import type {
  CalendarInviteItem,
  CalendarRsvpItem,
} from '@frank/cashweb/types/messages'

jest.mock('../../stores/chats', () => ({
  useChatStore: () => ({
    conversations: {},
  }),
}))

jest.mock('../../stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: 'Bob Builder' },
  }),
}))

const mockDownloadCalendarInviteIcs = jest.fn()
jest.mock('../../utils/calendar-vcard', () => {
  const actual = jest.requireActual('../../utils/calendar-vcard')
  return {
    ...actual,
    downloadCalendarInviteIcs: (...args: unknown[]) =>
      mockDownloadCalendarInviteIcs(...args),
  }
})

const t = (key: string, params?: Record<string, unknown>) => {
  const raw = key
    .split('.')
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)?.[k],
      enUS,
    ) as string
  if (!raw || !params) {
    return raw ?? key
  }
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
    raw,
  )
}

const sampleInvite: CalendarInviteItem = {
  type: 'calendar-invite',
  uid: 'evt-launch-sync',
  sequence: 2,
  title: 'Mainnet Launch Sync',
  startMs: 1712077200000,
  endMs: 1712080800000,
  timezone: 'UTC',
  location: 'Room 42',
  description: 'Review checklist and deployment metrics',
  organizer: {
    address: '0x1111111111111111111111111111111111111111',
    name: 'Alice Organizer',
  },
  attendees: [
    {
      address: '0x2222222222222222222222222222222222222222',
      name: 'Bob Builder',
    },
  ],
  status: 'confirmed',
}

const sampleRsvps: CalendarRsvpItem[] = [
  {
    type: 'calendar-rsvp',
    uid: 'evt-launch-sync',
    sequence: 1,
    status: 'tentative',
    respondedAtMs: 1000,
    attendee: {
      address: '0x2222222222222222222222222222222222222222',
      name: 'Bob Builder',
    },
  },
  {
    type: 'calendar-rsvp',
    uid: 'evt-launch-sync',
    sequence: 2,
    status: 'accepted',
    respondedAtMs: 2000,
    attendee: {
      address: '0x2222222222222222222222222222222222222222',
      name: 'Bob Builder',
    },
  },
]

function mountCalendarInvite() {
  return shallowMount(ChatMessageCalendarInvite, {
    props: {
      item: sampleInvite,
      address: '0x1111111111111111111111111111111111111111',
      attendeeAddress: '0x3333333333333333333333333333333333333333',
      rsvps: sampleRsvps,
    },
    global: {
      stubs: {
        QIcon: { template: '<i />' },
        QBadge: { template: '<span><slot /></span>' },
        QBtn: {
          props: ['label', 'href', 'disable'],
          template:
            '<button :data-href="href" :disabled="disable">{{ label }}<slot /></button>',
        },
      },
      mocks: {
        $t: t,
      },
    },
  })
}

describe('ChatMessageCalendarInvite', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders invite title, location, description, and tallies monotonic RSVPs', () => {
    const wrapper = mountCalendarInvite()
    expect(wrapper.find('[data-testid="calendar-invite-card"]').exists()).toBe(
      true,
    )
    expect(wrapper.text()).toContain('Mainnet Launch Sync')
    expect(wrapper.text()).toContain('Room 42')
    expect(wrapper.text()).toContain('Review checklist and deployment metrics')
    expect(wrapper.find('[data-testid="calendar-rsvp-tally"]').text()).toContain(
      '1 Accepted · 0 Tentative · 0 Declined',
    )
  })

  it('emits sendFollowUp with a calendar-rsvp message item when clicking Accept, Tentative, or Decline', async () => {
    const wrapper = mountCalendarInvite()
    await wrapper.find('[data-testid="calendar-rsvp-accept"]').trigger('click')
    expect(wrapper.emitted('sendFollowUp')).toEqual([
      [
        {
          items: [
            expect.objectContaining({
              type: 'calendar-rsvp',
              uid: 'evt-launch-sync',
              sequence: 2,
              status: 'accepted',
              attendee: {
                address: '0x3333333333333333333333333333333333333333',
                name: 'Bob Builder',
              },
            }),
          ],
        },
      ],
    ])
    expect(wrapper.find('[data-testid="calendar-rsvp-tally"]').text()).toContain(
      '2 Accepted · 0 Tentative · 0 Declined',
    )
  })

  it('downloads an RFC 5545 .ics file and provides a Google Calendar URL', async () => {
    const wrapper = mountCalendarInvite()
    await wrapper
      .find('[data-testid="calendar-download-ics"]')
      .trigger('click')
    expect(mockDownloadCalendarInviteIcs).toHaveBeenCalledTimes(1)
    expect(mockDownloadCalendarInviteIcs).toHaveBeenCalledWith(
      sampleInvite,
      expect.any(Object),
    )

    const gcalBtn = wrapper.find('[data-testid="calendar-google-link"]')
    expect(gcalBtn.attributes('data-href')).toContain(
      'https://calendar.google.com/calendar/render?action=TEMPLATE',
    )
  })
})
