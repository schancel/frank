import type {
  CalendarInviteItem,
  CalendarRsvpItem,
  ContactCardItem,
} from '@frank/cashweb/types/messages'

import {
  aggregateCalendarRsvps,
  buildGoogleCalendarTemplateUrl,
  buildWebcalFeedIcs,
  foldContentLine,
  parseIcsToCalendarInvite,
  parseVcfToContactCard,
  serializeCalendarInviteToIcs,
  serializeContactCardToVcf,
  tallyCalendarRsvps,
  toWebcalUrl,
  unfoldContentLines,
} from './calendar-vcard'

const ALICE = '0x' + 'a1'.repeat(20)
const BOB = '0x' + 'b2'.repeat(20)
const CAROL = '0x' + 'c3'.repeat(20)

describe('calendar-vcard utilities (Issue #1573)', () => {
  const sampleInvite: CalendarInviteItem = {
    type: 'calendar-invite',
    uid: 'evt-1573@frank.local',
    sequence: 2,
    title: 'Frank Architecture Review, Q4; Core Team',
    startMs: Date.UTC(2026, 9, 14, 17, 0, 0),
    endMs: Date.UTC(2026, 9, 14, 18, 0, 0),
    timezone: 'America/Los_Angeles',
    allDay: false,
    location: 'Room 42, Building B',
    description: 'Line 1\nLine 2; with semicolon, and comma',
    url: 'https://meet.frank.local/core-q4',
    organizer: {
      address: ALICE,
      name: 'Alice Organizer',
      email: 'alice@frank.local',
    },
    attendees: [
      {
        address: BOB,
        name: 'Bob Attendee',
        email: 'bob@frank.local',
        role: 'req-participant',
        rsvp: true,
      },
      {
        address: CAROL,
        name: 'Carol Optional',
        email: 'carol@frank.local',
        role: 'opt-participant',
        rsvp: true,
      },
    ],
    recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE',
    status: 'confirmed',
  }

  describe('RFC 5545 (.ics) synthesis and parsing', () => {
    it('serializes a CalendarInviteItem with CRLF folding and parses it back losslessly', () => {
      const rsvps: Record<string, CalendarRsvpItem> = {
        [BOB]: {
          type: 'calendar-rsvp',
          uid: sampleInvite.uid,
          sequence: 2,
          status: 'accepted',
          respondedAtMs: 1760400500000,
          attendee: { address: BOB, name: 'Bob Attendee', email: 'bob@frank.local' },
        },
      }
      const ics = serializeCalendarInviteToIcs(sampleInvite, rsvps)

      expect(ics).toContain('BEGIN:VCALENDAR\r\n')
      expect(ics).toContain('VERSION:2.0\r\n')
      expect(ics).toContain('METHOD:REQUEST\r\n')
      expect(ics).toContain('BEGIN:VEVENT\r\n')
      expect(ics).toContain('DTSTART:20261014T170000Z\r\n')
      expect(ics).toContain('DTEND:20261014T180000Z\r\n')

      // Check 75-octet line folding
      const physicalLines = ics.split('\r\n').filter(Boolean)
      const encoder = new TextEncoder()
      for (const line of physicalLines) {
        expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
      }

      // Unfolded content includes PARTSTAT=ACCEPTED for Bob and PARTSTAT=NEEDS-ACTION for Carol
      const unfolded = unfoldContentLines(ics).join('\n')
      expect(unfolded).toContain('PARTSTAT=ACCEPTED')
      expect(unfolded).toContain('PARTSTAT=NEEDS-ACTION')

      const parsed = parseIcsToCalendarInvite(ics)
      expect(parsed.uid).toBe(sampleInvite.uid)
      expect(parsed.sequence).toBe(sampleInvite.sequence)
      expect(parsed.title).toBe(sampleInvite.title)
      expect(parsed.startMs).toBe(sampleInvite.startMs)
      expect(parsed.endMs).toBe(sampleInvite.endMs)
      expect(parsed.timezone).toBe(sampleInvite.timezone)
      expect(parsed.allDay).toBe(false)
      expect(parsed.location).toBe(sampleInvite.location)
      expect(parsed.description).toBe(sampleInvite.description)
      expect(parsed.url).toBe(sampleInvite.url)
      expect(parsed.organizer).toEqual(sampleInvite.organizer)
      expect(parsed.attendees).toEqual(sampleInvite.attendees)
      expect(parsed.recurrenceRule).toBe(sampleInvite.recurrenceRule)
      expect(parsed.status).toBe('confirmed')
      expect(parsed.rawIcs).toBe(ics)
    })

    it('supports all-day events with VALUE=DATE and METHOD:CANCEL for cancelled events', () => {
      const allDayCancelled: CalendarInviteItem = {
        type: 'calendar-invite',
        uid: 'allday-1@frank.local',
        sequence: 3,
        title: 'Offsite Retreat',
        startMs: Date.UTC(2026, 10, 1, 0, 0, 0),
        endMs: Date.UTC(2026, 10, 2, 0, 0, 0),
        allDay: true,
        status: 'cancelled',
        organizer: { address: ALICE },
      }
      const ics = serializeCalendarInviteToIcs(allDayCancelled)
      expect(ics).toContain('METHOD:CANCEL\r\n')
      expect(ics).toContain('DTSTART;VALUE=DATE:20261101\r\n')
      expect(ics).toContain('DTEND;VALUE=DATE:20261102\r\n')

      const parsed = parseIcsToCalendarInvite(ics)
      expect(parsed.allDay).toBe(true)
      expect(parsed.status).toBe('cancelled')
      expect(parsed.startMs).toBe(allDayCancelled.startMs)
      expect(parsed.endMs).toBe(allDayCancelled.endMs)
    })

    it('folds multi-byte UTF-8 lines without splitting code points', () => {
      const emojiLine = 'SUMMARY:' + '🚀'.repeat(30)
      const folded = foldContentLine(emojiLine)
      const unfolded = unfoldContentLines(folded)[0]
      expect(unfolded).toBe(emojiLine)
    })
  })

  describe('monotonic RSVP aggregation', () => {
    it('aggregates RSVPs monotonically by (uid, attendee.address) where highest (sequence, respondedAtMs) wins', () => {
      const rsvps: CalendarRsvpItem[] = [
        {
          type: 'calendar-rsvp',
          uid: 'evt-1',
          sequence: 1,
          status: 'tentative',
          respondedAtMs: 1000,
          attendee: { address: BOB, name: 'Bob' },
        },
        {
          type: 'calendar-rsvp',
          uid: 'evt-1',
          sequence: 2,
          status: 'accepted',
          respondedAtMs: 900, // higher sequence wins even with earlier clock
          attendee: { address: BOB, name: 'Bob' },
        },
        {
          type: 'calendar-rsvp',
          uid: 'evt-1',
          sequence: 1,
          status: 'declined',
          respondedAtMs: 5000, // stale sequence 1 is ignored
          attendee: { address: BOB, name: 'Bob' },
        },
        {
          type: 'calendar-rsvp',
          uid: 'evt-1',
          sequence: 2,
          status: 'declined',
          respondedAtMs: 1200, // same sequence 2, newer respondedAtMs wins
          attendee: { address: CAROL, name: 'Carol' },
        },
        {
          type: 'calendar-rsvp',
          uid: 'evt-1',
          sequence: 2,
          status: 'accepted',
          respondedAtMs: 1100, // older respondedAtMs for Carol at sequence 2 loses
          attendee: { address: CAROL, name: 'Carol' },
        },
        {
          type: 'calendar-rsvp',
          uid: 'other-evt',
          sequence: 9,
          status: 'declined',
          respondedAtMs: 9999,
          attendee: { address: BOB, name: 'Bob' },
        },
      ]

      const tally = tallyCalendarRsvps('evt-1', rsvps)
      expect(tally.accepted.map(r => r.attendee.address)).toEqual([BOB])
      expect(tally.declined.map(r => r.attendee.address)).toEqual([CAROL])
      expect(tally.tentative).toHaveLength(0)
      expect(aggregateCalendarRsvps('evt-1', rsvps)[BOB.toLowerCase()].status).toBe(
        'accepted',
      )
    })
  })

  describe('Google Calendar template URL & Webcal feed', () => {
    it('builds a Google Calendar TEMPLATE deep link', () => {
      const url = buildGoogleCalendarTemplateUrl(sampleInvite)
      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe(
        'https://calendar.google.com/calendar/render',
      )
      expect(parsed.searchParams.get('action')).toBe('TEMPLATE')
      expect(parsed.searchParams.get('text')).toBe(sampleInvite.title)
      expect(parsed.searchParams.get('dates')).toBe(
        '20261014T170000Z/20261014T180000Z',
      )
      expect(parsed.searchParams.get('location')).toBe(sampleInvite.location)
      expect(parsed.searchParams.get('ctz')).toBe(sampleInvite.timezone)
    })

    it('builds a subscribable VCALENDAR webcal feed excluding cancelled invites', () => {
      const secondInvite: CalendarInviteItem = {
        ...sampleInvite,
        uid: 'evt-cancelled@frank.local',
        title: 'Cancelled Sync',
        status: 'cancelled',
      }
      const feed = buildWebcalFeedIcs([sampleInvite, secondInvite], 'My Frank Events')
      const unfolded = unfoldContentLines(feed).join('\n')
      expect(unfolded).toContain('METHOD:PUBLISH')
      expect(unfolded).toContain('X-WR-CALNAME:My Frank Events')
      expect(unfolded).toContain(`UID:${sampleInvite.uid}`)
      expect(unfolded).not.toContain('evt-cancelled@frank.local')
      expect(toWebcalUrl('https://relay.frank.local/calendar/feed.ics')).toBe(
        'webcal://relay.frank.local/calendar/feed.ics',
      )
    })
  })

  describe('RFC 6350 (.vcf) synthesis and parsing', () => {
    it('serializes a ContactCardItem to vCard 4.0 and parses it back', () => {
      const card: ContactCardItem = {
        type: 'contact-card',
        uid: 'vcard-alice-1573',
        fullName: 'Alice Nakamoto',
        frankAddress: ALICE,
        username: 'alice',
        emails: ['alice@frank.local', 'alice@example.org'],
        phones: ['+1-555-0100', '+1-555-0199'],
        organization: 'Frank Labs',
        title: 'Lead Architect',
        url: 'https://frank.local',
        note: 'Verified peer;\nKey confirmed',
        avatarDataUrl: 'data:image/png;base64,AAAA',
      }

      const vcf = serializeContactCardToVcf(card)
      expect(vcf).toContain('BEGIN:VCARD\r\n')
      expect(vcf).toContain('VERSION:4.0\r\n')
      expect(vcf).toContain(`X-FRANK-ADDRESS:${ALICE}\r\n`)
      expect(vcf).toContain('END:VCARD\r\n')

      const parsed = parseVcfToContactCard(vcf)
      expect(parsed.uid).toBe(card.uid)
      expect(parsed.fullName).toBe(card.fullName)
      expect(parsed.frankAddress).toBe(card.frankAddress)
      expect(parsed.username).toBe(card.username)
      expect(parsed.emails).toEqual(card.emails)
      expect(parsed.phones).toEqual(card.phones)
      expect(parsed.organization).toBe(card.organization)
      expect(parsed.title).toBe(card.title)
      expect(parsed.url).toBe(card.url)
      expect(parsed.note).toBe(card.note)
      expect(parsed.avatarDataUrl).toBe(card.avatarDataUrl)
      expect(parsed.rawVcard).toBe(vcf)
    })
  })
})
