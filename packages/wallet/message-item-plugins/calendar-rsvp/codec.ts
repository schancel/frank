/**
 * A `calendar-rsvp` item as one canonical CBOR map, carried on the canonical direct message
 * path in the generic plugin item frame (type 27).
 */
import type {
  CalendarOrganizer,
  CalendarRsvpItem,
} from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  int,
  oneOf,
  opt,
  req,
  str,
  struct,
  timestampMs,
} from '@frank/cashweb/message-items/cbor-fields'
import { MAX_CALENDAR_SEQUENCE } from '../calendar-invite/codec'

const attendeePartyStruct = struct<CalendarOrganizer>({
  address: req(0, chainAddress),
  name: opt(1, str(256, 1)),
  email: opt(2, str(320, 1)),
})

export const calendarRsvpCodec = cborItemCodec<CalendarRsvpItem>(
  'calendar-rsvp',
  {
    uid: req(0, str(256, 1)),
    sequence: req(1, int(0, MAX_CALENDAR_SEQUENCE)),
    status: req(2, oneOf('accepted', 'tentative', 'declined')),
    comment: opt(3, str(1024)),
    respondedAtMs: req(4, timestampMs),
    attendee: req(5, attendeePartyStruct),
  },
)
