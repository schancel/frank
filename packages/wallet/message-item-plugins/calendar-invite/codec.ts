/**
 * A `calendar-invite` item as one canonical CBOR map, carried on the canonical direct message
 * path in the generic plugin item frame (type 27).
 */
import type {
  CalendarAttendee,
  CalendarInviteItem,
  CalendarOrganizer,
} from '@frank/cashweb/types/messages'

import {
  bool,
  cborItemCodec,
  chainAddress,
  int,
  listOf,
  oneOf,
  opt,
  req,
  str,
  struct,
  timestampMs,
} from '@frank/cashweb/message-items/cbor-fields'

export const MAX_CALENDAR_ATTENDEES = 100
export const MAX_CALENDAR_SEQUENCE = 1_000_000_000
export const MAX_RAW_ICS_BYTES = 65_536

const organizerStruct = struct<CalendarOrganizer>({
  address: req(0, chainAddress),
  name: opt(1, str(256, 1)),
  email: opt(2, str(320, 1)),
})

const attendeeStruct = struct<CalendarAttendee>({
  address: opt(0, chainAddress),
  email: opt(1, str(320, 1)),
  name: opt(2, str(256, 1)),
  role: opt(3, oneOf('req-participant', 'opt-participant', 'chair')),
  rsvp: opt(4, bool),
})

export const calendarInviteCodec = cborItemCodec<CalendarInviteItem>(
  'calendar-invite',
  {
    uid: req(0, str(256, 1)),
    sequence: req(1, int(0, MAX_CALENDAR_SEQUENCE)),
    title: req(2, str(512, 1)),
    startMs: req(3, timestampMs),
    endMs: req(4, timestampMs),
    timezone: opt(5, str(128, 1)),
    allDay: opt(6, bool),
    location: opt(7, str(1024, 1)),
    description: opt(8, str(8192)),
    url: opt(9, str(2048, 1)),
    organizer: req(10, organizerStruct),
    attendees: opt(11, listOf(attendeeStruct, MAX_CALENDAR_ATTENDEES)),
    recurrenceRule: opt(12, str(512, 1)),
    status: opt(13, oneOf('confirmed', 'tentative', 'cancelled')),
    rawIcs: opt(14, str(MAX_RAW_ICS_BYTES, 1)),
  },
)
