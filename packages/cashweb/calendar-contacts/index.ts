/**
 * RFC 5545 (iCalendar `.ics`) & RFC 6350 (vCard `.vcf`) synthesis, parsing, monotonic RSVP
 * aggregation, Google Calendar template URL builder, and `webcal://` feed generator (Issue #1573).
 */
import type {
  CalendarAttendee,
  CalendarAttendeeRole,
  CalendarInviteItem,
  CalendarInviteStatus,
  CalendarOrganizer,
  CalendarRsvpItem,
  CalendarRsvpStatus,
  ContactCardItem,
} from '../types/messages'

const CRLF = '\r\n'
const MAX_ICS_LINE_OCTETS = 75
const utf8Encoder = new TextEncoder()

/**
 * Folds a single content line at 75 UTF-8 octets per RFC 5545 Section 3.1 / RFC 6350 Section 3.2
 * without splitting multi-byte UTF-8 code points across a fold boundary.
 */
export function foldContentLine(line: string): string {
  const bytes = utf8Encoder.encode(line)
  if (bytes.length <= MAX_ICS_LINE_OCTETS) {
    return line
  }
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  let maxOctets = MAX_ICS_LINE_OCTETS

  for (const char of line) {
    const charBytes = utf8Encoder.encode(char).length
    if (currentBytes + charBytes > maxOctets && current.length > 0) {
      chunks.push(current)
      current = ' ' + char
      // Continuation line starts with a single space (1 octet)
      currentBytes = 1 + charBytes
      maxOctets = MAX_ICS_LINE_OCTETS
    } else {
      current += char
      currentBytes += charBytes
    }
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks.join(CRLF)
}

/** Unfolds RFC 5545 / RFC 6350 content lines (`CRLF` or `LF` followed by space or tab). */
export function unfoldContentLines(rawText: string): string[] {
  const unfolded = rawText.replace(/\r?\n[ \t]/g, '')
  return unfolded
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.length > 0)
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\nN;,])/g, (_match, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n'
    return ch
  })
}

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function formatIcsParam(value: string): string {
  const clean = sanitizeSingleLine(value).replace(/"/g, "'")
  if (/[,;:]/.test(clean)) {
    return `"${clean}"`
  }
  return clean
}

/** Formats epoch milliseconds as `YYYYMMDDTHHMMSSZ` (UTC). */
export function formatIcsUtcDateTime(ms: number): string {
  const d = new Date(ms)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad4 = (n: number) => String(n).padStart(4, '0')
  return (
    `${pad4(d.getUTCFullYear())}` +
    `${pad2(d.getUTCMonth() + 1)}` +
    `${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}` +
    `${pad2(d.getUTCMinutes())}` +
    `${pad2(d.getUTCSeconds())}Z`
  )
}

/** Formats epoch milliseconds as `YYYYMMDD` (UTC date for `VALUE=DATE` all-day events). */
export function formatIcsUtcDate(ms: number): string {
  const d = new Date(ms)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad4 = (n: number) => String(n).padStart(4, '0')
  return (
    `${pad4(d.getUTCFullYear())}` +
    `${pad2(d.getUTCMonth() + 1)}` +
    `${pad2(d.getUTCDate())}`
  )
}

function rsvpStatusToPartstat(status?: CalendarRsvpStatus): string {
  switch (status) {
    case 'accepted':
      return 'ACCEPTED'
    case 'tentative':
      return 'TENTATIVE'
    case 'declined':
      return 'DECLINED'
    default:
      return 'NEEDS-ACTION'
  }
}

/**
 * Aggregates `CalendarRsvpItem` responses monotonically by `(uid, attendee.address)`.
 * Higher `sequence` wins; ties in `sequence` are broken by higher `respondedAtMs`.
 */
export function aggregateCalendarRsvps(
  uid: string,
  rsvps: readonly CalendarRsvpItem[],
): Record<string, CalendarRsvpItem> {
  const byAttendee: Record<string, CalendarRsvpItem> = {}
  for (const rsvp of rsvps) {
    if (!rsvp || rsvp.uid !== uid || !rsvp.attendee?.address) continue
    const key = rsvp.attendee.address.trim().toLowerCase()
    if (!key) continue
    const existing = byAttendee[key]
    if (
      !existing ||
      rsvp.sequence > existing.sequence ||
      (rsvp.sequence === existing.sequence &&
        rsvp.respondedAtMs >= existing.respondedAtMs)
    ) {
      byAttendee[key] = rsvp
    }
  }
  return byAttendee
}

export interface CalendarRsvpTally {
  accepted: CalendarRsvpItem[]
  tentative: CalendarRsvpItem[]
  declined: CalendarRsvpItem[]
  byAddress: Record<string, CalendarRsvpItem>
}

export function tallyCalendarRsvps(
  uid: string,
  rsvps: readonly CalendarRsvpItem[],
): CalendarRsvpTally {
  const byAddress = aggregateCalendarRsvps(uid, rsvps)
  const accepted: CalendarRsvpItem[] = []
  const tentative: CalendarRsvpItem[] = []
  const declined: CalendarRsvpItem[] = []
  for (const item of Object.values(byAddress)) {
    if (item.status === 'accepted') accepted.push(item)
    else if (item.status === 'tentative') tentative.push(item)
    else if (item.status === 'declined') declined.push(item)
  }
  return { accepted, tentative, declined, byAddress }
}

function serializeVeventLines(
  invite: CalendarInviteItem,
  rsvps?: Record<string, CalendarRsvpItem>,
): string[] {
  const lines: string[] = ['BEGIN:VEVENT']
  lines.push(`UID:${sanitizeSingleLine(invite.uid)}`)
  lines.push(`SEQUENCE:${Math.max(0, Math.trunc(invite.sequence || 0))}`)
  lines.push(`DTSTAMP:${formatIcsUtcDateTime(invite.startMs)}`)

  if (invite.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatIcsUtcDate(invite.startMs)}`)
    lines.push(`DTEND;VALUE=DATE:${formatIcsUtcDate(invite.endMs)}`)
  } else {
    lines.push(`DTSTART:${formatIcsUtcDateTime(invite.startMs)}`)
    lines.push(`DTEND:${formatIcsUtcDateTime(invite.endMs)}`)
    if (invite.timezone) {
      lines.push(`X-WR-TIMEZONE:${sanitizeSingleLine(invite.timezone)}`)
    }
  }

  lines.push(`SUMMARY:${escapeIcsText(invite.title)}`)

  if (invite.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(invite.description)}`)
  }
  if (invite.location) {
    lines.push(`LOCATION:${escapeIcsText(invite.location)}`)
  }
  if (invite.url) {
    lines.push(`URL:${sanitizeSingleLine(invite.url)}`)
  }
  if (invite.status) {
    lines.push(`STATUS:${invite.status.toUpperCase()}`)
  }
  if (invite.recurrenceRule) {
    const cleanRule = sanitizeSingleLine(
      invite.recurrenceRule.replace(/^RRULE:/i, ''),
    )
    if (cleanRule) {
      lines.push(`RRULE:${cleanRule}`)
    }
  }

  // Organizer
  const orgParams: string[] = []
  if (invite.organizer.name) {
    orgParams.push(`CN=${formatIcsParam(invite.organizer.name)}`)
  }
  orgParams.push(`X-FRANK-ADDRESS=${formatIcsParam(invite.organizer.address)}`)
  const orgMail =
    invite.organizer.email || `${invite.organizer.address}@frank.local`
  lines.push(`ORGANIZER;${orgParams.join(';')}:mailto:${sanitizeSingleLine(orgMail)}`)

  // Normalize RSVP lookup map
  const rsvpValues = rsvps
    ? Object.values(rsvps).filter(
        r => r && (!r.uid || r.uid === invite.uid) && r.attendee?.address,
      )
    : []
  const monotonicRsvps = aggregateCalendarRsvps(
    invite.uid,
    rsvpValues.map(r => ({ ...r, uid: invite.uid })),
  )
  const usedRsvpKeys = new Set<string>()

  const findRsvpForAttendee = (
    att: CalendarAttendee,
  ): CalendarRsvpItem | undefined => {
    if (att.address) {
      const k = att.address.trim().toLowerCase()
      if (monotonicRsvps[k]) {
        usedRsvpKeys.add(k)
        return monotonicRsvps[k]
      }
      if (rsvps?.[att.address]) {
        return rsvps[att.address]
      }
    }
    if (att.email) {
      const emailLower = att.email.trim().toLowerCase()
      for (const [k, r] of Object.entries(monotonicRsvps)) {
        if (r.attendee.email?.trim().toLowerCase() === emailLower) {
          usedRsvpKeys.add(k)
          return r
        }
      }
    }
    return undefined
  }

  const attendees: CalendarAttendee[] = [...(invite.attendees ?? [])]
  for (const att of attendees) {
    const matchedRsvp = findRsvpForAttendee(att)
    const role = (att.role || 'req-participant').toUpperCase()
    const partstat = rsvpStatusToPartstat(matchedRsvp?.status)
    const rsvpFlag = att.rsvp === false ? 'FALSE' : 'TRUE'
    const params: string[] = [
      `ROLE=${role}`,
      `PARTSTAT=${partstat}`,
      `RSVP=${rsvpFlag}`,
    ]
    const displayName = att.name || matchedRsvp?.attendee.name
    if (displayName) {
      params.push(`CN=${formatIcsParam(displayName)}`)
    }
    const addr = att.address || matchedRsvp?.attendee.address
    if (addr) {
      params.push(`X-FRANK-ADDRESS=${formatIcsParam(addr)}`)
    }
    const email =
      att.email ||
      matchedRsvp?.attendee.email ||
      `${addr || 'attendee'}@frank.local`
    lines.push(`ATTENDEE;${params.join(';')}:mailto:${sanitizeSingleLine(email)}`)
  }

  // Also include any RSVP respondents who were not listed in invite.attendees
  for (const [k, rsvp] of Object.entries(monotonicRsvps)) {
    if (usedRsvpKeys.has(k)) continue
    const params: string[] = [
      'ROLE=REQ-PARTICIPANT',
      `PARTSTAT=${rsvpStatusToPartstat(rsvp.status)}`,
      'RSVP=TRUE',
    ]
    if (rsvp.attendee.name) {
      params.push(`CN=${formatIcsParam(rsvp.attendee.name)}`)
    }
    params.push(`X-FRANK-ADDRESS=${formatIcsParam(rsvp.attendee.address)}`)
    const email = rsvp.attendee.email || `${rsvp.attendee.address}@frank.local`
    lines.push(`ATTENDEE;${params.join(';')}:mailto:${sanitizeSingleLine(email)}`)
  }

  lines.push('END:VEVENT')
  return lines
}

/**
 * Generates standards-compliant RFC 5545 `VCALENDAR` / `VEVENT` `.ics` text with CRLF line folding
 * and `ATTENDEE;PARTSTAT=...`.
 */
export function serializeCalendarInviteToIcs(
  invite: CalendarInviteItem,
  rsvps?: Record<string, CalendarRsvpItem>,
): string {
  const method = invite.status === 'cancelled' ? 'CANCEL' : 'REQUEST'
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Frank Messenger//Calendar//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    ...serializeVeventLines(invite, rsvps),
    'END:VCALENDAR',
  ]
  return lines.map(foldContentLine).join(CRLF) + CRLF
}

interface ParsedPropertyLine {
  name: string
  params: Record<string, string>
  value: string
}

function parsePropertyLine(line: string): ParsedPropertyLine | null {
  // Find the first unquoted ':'
  let inQuotes = false
  let colonIndex = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ':' && !inQuotes) {
      colonIndex = i
      break
    }
  }
  if (colonIndex <= 0) return null

  const header = line.slice(0, colonIndex)
  const value = line.slice(colonIndex + 1)

  // Split header on unquoted ';'
  const parts: string[] = []
  let current = ''
  inQuotes = false
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ';' && !inQuotes) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)

  const rawName = parts[0].trim().toUpperCase()
  // Strip vCard group prefix if present (e.g., "item1.EMAIL" -> "EMAIL")
  const dotIdx = rawName.lastIndexOf('.')
  const name = dotIdx >= 0 ? rawName.slice(dotIdx + 1) : rawName

  const params: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].trim()
    if (!seg) continue
    const eqIdx = seg.indexOf('=')
    if (eqIdx < 0) {
      params[seg.toUpperCase()] = 'TRUE'
      continue
    }
    const pKey = seg.slice(0, eqIdx).trim().toUpperCase()
    let pVal = seg.slice(eqIdx + 1).trim()
    if (pVal.startsWith('"') && pVal.endsWith('"') && pVal.length >= 2) {
      pVal = pVal.slice(1, -1)
    }
    params[pKey] = pVal
  }

  return { name, params, value }
}

function parseIcsDateValue(
  raw: string,
  params: Record<string, string>,
): { ms: number; allDay: boolean; timezone?: string } {
  const clean = raw.trim()
  const tzid = params.TZID
  if (params.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(clean)) {
    const year = Number(clean.slice(0, 4))
    const month = Number(clean.slice(4, 6))
    const day = Number(clean.slice(6, 8))
    const ms = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
    return {
      ms: Number.isFinite(ms) ? ms : 0,
      allDay: true,
      ...(tzid ? { timezone: tzid } : {}),
    }
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(clean)
  if (m) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    const hour = Number(m[4])
    const minute = Number(m[5])
    const second = Number(m[6])
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0)
    return {
      ms: Number.isFinite(utcGuess) ? utcGuess : 0,
      allDay: false,
      ...(tzid ? { timezone: tzid } : {}),
    }
  }

  const parsed = Date.parse(clean)
  return {
    ms: Number.isFinite(parsed) ? parsed : 0,
    allDay: false,
    ...(tzid ? { timezone: tzid } : {}),
  }
}

function extractMailto(value: string): string | undefined {
  const trimmed = value.trim()
  const m = /^mailto:(.+)$/i.exec(trimmed)
  return (m ? m[1] : trimmed).trim() || undefined
}

const VALID_CHAIN_ADDRESS = /^[0-9A-Za-z][0-9A-Za-z:_.-]{0,127}$/

/**
 * Parses RFC 5545 `.ics` text into a `CalendarInviteItem`.
 */
export function parseIcsToCalendarInvite(
  icsText: string,
  defaultOrganizerAddress = '0x0000000000000000000000000000000000000000',
): CalendarInviteItem {
  const lines = unfoldContentLines(icsText)
  if (!lines.some(l => l.toUpperCase() === 'BEGIN:VCALENDAR')) {
    throw new Error('Invalid iCalendar (.ics): missing BEGIN:VCALENDAR')
  }

  let inVevent = false
  let foundVevent = false
  let uid = ''
  let sequence = 0
  let title = ''
  let startMs: number | undefined
  let endMs: number | undefined
  let allDay: boolean | undefined
  let timezone: string | undefined
  let calendarTimezone: string | undefined
  let location: string | undefined
  let description: string | undefined
  let url: string | undefined
  let recurrenceRule: string | undefined
  let status: CalendarInviteStatus | undefined
  let organizer: CalendarOrganizer | undefined
  const attendees: CalendarAttendee[] = []

  for (const rawLine of lines) {
    const upper = rawLine.toUpperCase()
    if (upper === 'BEGIN:VEVENT') {
      inVevent = true
      foundVevent = true
      continue
    }
    if (upper === 'END:VEVENT') {
      break
    }
    const parsed = parsePropertyLine(rawLine)
    if (!parsed) continue

    if (!inVevent) {
      if (parsed.name === 'X-WR-TIMEZONE' && parsed.value.trim()) {
        calendarTimezone = parsed.value.trim()
      }
      continue
    }

    switch (parsed.name) {
      case 'UID':
        uid = unescapeIcsText(parsed.value.trim())
        break
      case 'SEQUENCE': {
        const seq = Number.parseInt(parsed.value.trim(), 10)
        if (Number.isFinite(seq) && seq >= 0) {
          sequence = seq
        }
        break
      }
      case 'SUMMARY':
        title = unescapeIcsText(parsed.value.trim())
        break
      case 'DTSTART': {
        const dt = parseIcsDateValue(parsed.value, parsed.params)
        startMs = dt.ms
        allDay = dt.allDay
        if (dt.timezone) timezone = dt.timezone
        break
      }
      case 'DTEND': {
        const dt = parseIcsDateValue(parsed.value, parsed.params)
        endMs = dt.ms
        if (dt.timezone && !timezone) timezone = dt.timezone
        break
      }
      case 'X-WR-TIMEZONE':
        if (parsed.value.trim()) timezone = parsed.value.trim()
        break
      case 'LOCATION': {
        const loc = unescapeIcsText(parsed.value.trim())
        if (loc) location = loc
        break
      }
      case 'DESCRIPTION': {
        const desc = unescapeIcsText(parsed.value)
        if (desc) description = desc
        break
      }
      case 'URL': {
        const u = parsed.value.trim()
        if (u) url = u
        break
      }
      case 'RRULE': {
        const rrule = parsed.value.trim()
        if (rrule) recurrenceRule = rrule
        break
      }
      case 'STATUS': {
        const st = parsed.value.trim().toLowerCase()
        if (st === 'confirmed' || st === 'tentative' || st === 'cancelled') {
          status = st
        }
        break
      }
      case 'ORGANIZER': {
        const mail = extractMailto(parsed.value)
        let addr = parsed.params['X-FRANK-ADDRESS']?.trim()
        let email = mail
        if (mail && mail.toLowerCase().endsWith('@frank.local')) {
          const localPart = mail.slice(0, -'@frank.local'.length)
          if (!addr && VALID_CHAIN_ADDRESS.test(localPart)) {
            addr = localPart
          }
          if (addr === localPart) {
            // Keep email only if explicitly provided or non-synthetic, or preserve if real
          }
        }
        const finalAddr =
          addr && VALID_CHAIN_ADDRESS.test(addr)
            ? addr
            : VALID_CHAIN_ADDRESS.test(defaultOrganizerAddress)
            ? defaultOrganizerAddress
            : '0x0000000000000000000000000000000000000000'
        const name = parsed.params.CN?.trim()
        organizer = {
          address: finalAddr,
          ...(name ? { name } : {}),
          ...(email && !email.toLowerCase().endsWith('@frank.local')
            ? { email }
            : email && email !== `${finalAddr}@frank.local`
            ? { email }
            : {}),
        }
        break
      }
      case 'ATTENDEE': {
        const mail = extractMailto(parsed.value)
        let addr: string | undefined = parsed.params['X-FRANK-ADDRESS']?.trim()
        if (addr && !VALID_CHAIN_ADDRESS.test(addr)) {
          addr = undefined
        }
        if (!addr && mail && mail.toLowerCase().endsWith('@frank.local')) {
          const localPart = mail.slice(0, -'@frank.local'.length)
          if (VALID_CHAIN_ADDRESS.test(localPart)) {
            addr = localPart
          }
        }
        const name = parsed.params.CN?.trim()
        const rawRole = parsed.params.ROLE?.trim().toLowerCase()
        const role: CalendarAttendeeRole | undefined =
          rawRole === 'req-participant' ||
          rawRole === 'opt-participant' ||
          rawRole === 'chair'
            ? rawRole
            : undefined
        const rawRsvp = parsed.params.RSVP?.trim().toUpperCase()
        const rsvp =
          rawRsvp === 'TRUE' ? true : rawRsvp === 'FALSE' ? false : undefined
        const email =
          mail && mail !== `${addr}@frank.local` ? mail : undefined
        const att: CalendarAttendee = {
          ...(addr ? { address: addr } : {}),
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
          ...(role ? { role } : {}),
          ...(rsvp !== undefined ? { rsvp } : {}),
        }
        if (att.address || att.email || att.name) {
          attendees.push(att)
        }
        break
      }
    }
  }

  if (!foundVevent) {
    throw new Error('Invalid iCalendar (.ics): missing VEVENT component')
  }
  if (startMs === undefined) {
    throw new Error('Invalid iCalendar (.ics): missing DTSTART')
  }
  const effectiveEndMs =
    endMs !== undefined
      ? endMs
      : startMs + (allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000)
  const effectiveTimezone = timezone || calendarTimezone

  const fallbackAddress = VALID_CHAIN_ADDRESS.test(defaultOrganizerAddress)
    ? defaultOrganizerAddress
    : '0x0000000000000000000000000000000000000000'

  return {
    type: 'calendar-invite',
    uid: uid || `ics-${startMs}@frank.local`,
    sequence,
    title: title || 'Untitled Event',
    startMs,
    endMs: effectiveEndMs,
    ...(effectiveTimezone ? { timezone: effectiveTimezone } : {}),
    ...(allDay !== undefined ? { allDay } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    organizer: organizer ?? { address: fallbackAddress },
    ...(attendees.length > 0 ? { attendees } : {}),
    ...(recurrenceRule ? { recurrenceRule } : {}),
    ...(status ? { status } : {}),
    rawIcs: icsText,
  }
}

/**
 * Builds the `https://calendar.google.com/calendar/render?action=TEMPLATE&...` deep link.
 */
export function buildGoogleCalendarTemplateUrl(
  invite: CalendarInviteItem,
): string {
  const params = new URLSearchParams()
  params.set('action', 'TEMPLATE')
  params.set('text', invite.title)
  const dates = invite.allDay
    ? `${formatIcsUtcDate(invite.startMs)}/${formatIcsUtcDate(invite.endMs)}`
    : `${formatIcsUtcDateTime(invite.startMs)}/${formatIcsUtcDateTime(
        invite.endMs,
      )}`
  params.set('dates', dates)
  if (invite.description) {
    params.set('details', invite.description)
  }
  if (invite.location) {
    params.set('location', invite.location)
  }
  if (invite.timezone) {
    params.set('ctz', invite.timezone)
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * Serializes all accepted/active events into a complete subscribable `VCALENDAR` `.ics` feed
 * for Apple Calendar / Google Calendar / Outlook (`webcal://`).
 */
export function buildWebcalFeedIcs(
  invites: CalendarInviteItem[],
  feedTitle = 'Frank Calendar',
): string {
  const activeInvites = invites.filter(inv => inv.status !== 'cancelled')
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Frank Messenger//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(feedTitle)}`,
  ]
  for (const invite of activeInvites) {
    lines.push(...serializeVeventLines(invite))
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldContentLine).join(CRLF) + CRLF
}

/** Converts an `http://` or `https://` feed URL into a `webcal://` subscription URI. */
export function toWebcalUrl(feedUrl: string): string {
  return feedUrl.trim().replace(/^https?:\/\//i, 'webcal://')
}

function escapeVcfValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

function unescapeVcfValue(value: string): string {
  return value.replace(/\\([\\nN;,])/g, (_m, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n'
    return ch
  })
}

function deriveStructuredName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ';;;;'
  if (parts.length === 1) return `;${escapeVcfValue(parts[0])};;;`
  const family = escapeVcfValue(parts[parts.length - 1])
  const given = escapeVcfValue(parts.slice(0, -1).join(' '))
  return `${family};${given};;;`
}

/**
 * Serializes a `ContactCardItem` to RFC 6350 vCard 4.0 `.vcf` format (including `X-FRANK-ADDRESS`).
 */
export function serializeContactCardToVcf(card: ContactCardItem): string {
  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    `UID:${escapeVcfValue(card.uid)}`,
    `FN:${escapeVcfValue(card.fullName)}`,
    `N:${deriveStructuredName(card.fullName)}`,
  ]
  if (card.frankAddress) {
    lines.push(`X-FRANK-ADDRESS:${sanitizeSingleLine(card.frankAddress)}`)
  }
  if (card.username) {
    lines.push(`NICKNAME:${escapeVcfValue(card.username)}`)
    lines.push(`X-FRANK-USERNAME:${escapeVcfValue(card.username)}`)
  }
  if (card.organization) {
    lines.push(`ORG:${escapeVcfValue(card.organization)}`)
  }
  if (card.title) {
    lines.push(`TITLE:${escapeVcfValue(card.title)}`)
  }
  for (const email of card.emails ?? []) {
    if (email.trim()) {
      lines.push(`EMAIL:${sanitizeSingleLine(email)}`)
    }
  }
  for (const phone of card.phones ?? []) {
    if (phone.trim()) {
      lines.push(`TEL:${sanitizeSingleLine(phone)}`)
    }
  }
  if (card.url) {
    lines.push(`URL:${sanitizeSingleLine(card.url)}`)
  }
  if (card.note) {
    lines.push(`NOTE:${escapeVcfValue(card.note)}`)
  }
  if (card.avatarDataUrl) {
    lines.push(`PHOTO:${sanitizeSingleLine(card.avatarDataUrl)}`)
  }
  lines.push('END:VCARD')
  return lines.map(foldContentLine).join(CRLF) + CRLF
}

/**
 * Parses an RFC 6350 / vCard 3.0 or 4.0 `.vcf` string into a `ContactCardItem`.
 */
export function parseVcfToContactCard(vcfText: string): ContactCardItem {
  const lines = unfoldContentLines(vcfText)
  if (!lines.some(l => l.toUpperCase() === 'BEGIN:VCARD')) {
    throw new Error('Invalid vCard (.vcf): missing BEGIN:VCARD')
  }

  let uid = ''
  let fullName = ''
  let fallbackN = ''
  let frankAddress: string | undefined
  let username: string | undefined
  const emails: string[] = []
  const phones: string[] = []
  let organization: string | undefined
  let title: string | undefined
  let url: string | undefined
  let note: string | undefined
  let avatarDataUrl: string | undefined

  for (const rawLine of lines) {
    const upper = rawLine.toUpperCase()
    if (upper === 'BEGIN:VCARD') continue
    if (upper === 'END:VCARD') break

    const parsed = parsePropertyLine(rawLine)
    if (!parsed) continue

    switch (parsed.name) {
      case 'UID':
        uid = unescapeVcfValue(parsed.value.trim())
        break
      case 'FN':
        fullName = unescapeVcfValue(parsed.value.trim())
        break
      case 'N': {
        const segments = parsed.value.split(';').map(s => unescapeVcfValue(s.trim()))
        const family = segments[0] || ''
        const given = segments[1] || ''
        fallbackN = [given, family].filter(Boolean).join(' ').trim()
        break
      }
      case 'X-FRANK-ADDRESS': {
        const addr = parsed.value.trim()
        if (VALID_CHAIN_ADDRESS.test(addr)) {
          frankAddress = addr
        }
        break
      }
      case 'X-FRANK-USERNAME':
      case 'NICKNAME': {
        const u = unescapeVcfValue(parsed.value.trim()).replace(/^@/, '')
        if (u && !username) username = u
        break
      }
      case 'EMAIL': {
        const em = parsed.value.trim()
        if (em && !emails.includes(em)) {
          emails.push(em)
        }
        break
      }
      case 'TEL': {
        const tel = parsed.value.trim().replace(/^tel:/i, '')
        if (tel && !phones.includes(tel)) {
          phones.push(tel)
        }
        break
      }
      case 'ORG': {
        const org = unescapeVcfValue(parsed.value.split(';')[0].trim())
        if (org) organization = org
        break
      }
      case 'TITLE': {
        const t = unescapeVcfValue(parsed.value.trim())
        if (t) title = t
        break
      }
      case 'URL': {
        const u = parsed.value.trim()
        if (u) url = u
        break
      }
      case 'NOTE': {
        const n = unescapeVcfValue(parsed.value)
        if (n) note = n
        break
      }
      case 'PHOTO': {
        const p = parsed.value.trim()
        if (p.startsWith('data:image/')) {
          avatarDataUrl = p
        }
        break
      }
    }
  }

  const resolvedName = fullName || fallbackN || username || 'Unknown Contact'
  const resolvedUid =
    uid ||
    `vcard-${resolvedName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'contact'}`

  return {
    type: 'contact-card',
    uid: resolvedUid,
    fullName: resolvedName,
    ...(frankAddress ? { frankAddress } : {}),
    ...(username ? { username } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(organization ? { organization } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    rawVcard: vcfText,
  }
}
