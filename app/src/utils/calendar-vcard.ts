/**
 * Calendar (`.ics`) & Contact (`vCard` `.vcf`) synthesis, parsing, RSVP aggregation,
 * Google Calendar template URL builder, `webcal://` feed generator, and native OS file handoff
 * utilities (Issue #1573).
 */
import type {
  CalendarInviteItem,
  CalendarRsvpItem,
  ContactCardItem,
} from '@frank/cashweb/types/messages'
import {
  aggregateCalendarRsvps,
  buildGoogleCalendarTemplateUrl,
  buildWebcalFeedIcs,
  escapeIcsText,
  foldContentLine,
  formatIcsUtcDate,
  formatIcsUtcDateTime,
  parseIcsToCalendarInvite,
  parseVcfToContactCard,
  serializeCalendarInviteToIcs,
  serializeContactCardToVcf,
  tallyCalendarRsvps,
  toWebcalUrl,
  unfoldContentLines,
  unescapeIcsText,
  type CalendarRsvpTally,
} from '@frank/cashweb/calendar-contacts'

export {
  aggregateCalendarRsvps,
  buildGoogleCalendarTemplateUrl,
  buildWebcalFeedIcs,
  escapeIcsText,
  foldContentLine,
  formatIcsUtcDate,
  formatIcsUtcDateTime,
  parseIcsToCalendarInvite,
  parseVcfToContactCard,
  serializeCalendarInviteToIcs,
  serializeContactCardToVcf,
  tallyCalendarRsvps,
  toWebcalUrl,
  unfoldContentLines,
  unescapeIcsText,
  type CalendarRsvpTally,
}

export function slugifyFilename(name: string, fallback = 'item'): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || fallback
}

export function triggerTextFileDownload(
  content: string,
  filename: string,
  mimeType: string,
): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: mimeType })
  const canObjectUrl =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
  const href = canObjectUrl
    ? URL.createObjectURL(blob)
    : `data:${mimeType},${encodeURIComponent(content)}`
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  if (canObjectUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(href)
  }
}

export function downloadCalendarInviteIcs(
  invite: CalendarInviteItem,
  rsvps?: Record<string, CalendarRsvpItem>,
): string {
  const ics = serializeCalendarInviteToIcs(invite, rsvps)
  const filename = `${slugifyFilename(invite.title, 'event')}.ics`
  triggerTextFileDownload(ics, filename, 'text/calendar;charset=utf-8')
  return ics
}

export function downloadContactCardVcf(card: ContactCardItem): string {
  const vcf = serializeContactCardToVcf(card)
  const filename = `${slugifyFilename(card.fullName, 'contact')}.vcf`
  triggerTextFileDownload(vcf, filename, 'text/vcard;charset=utf-8')
  return vcf
}
