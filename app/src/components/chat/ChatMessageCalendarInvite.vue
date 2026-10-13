<template>
  <div
    class="calendar-invite-card q-pa-sm rounded-borders"
    data-test="calendar-invite-card"
    data-testid="calendar-invite-card"
  >
    <div class="row no-wrap items-start q-gutter-sm">
      <!-- Date Badge (Month / Day) -->
      <div
        class="calendar-date-badge column items-center justify-center rounded-borders q-px-sm q-py-xs"
        data-test="calendar-date-badge"
      >
        <div class="text-caption text-weight-bold calendar-date-month">
          {{ monthBadge }}
        </div>
        <div class="text-h6 text-weight-bold calendar-date-day">
          {{ dayBadge }}
        </div>
      </div>

      <!-- Event Details -->
      <div class="col">
        <div class="row items-center justify-between q-gutter-xs">
          <div
            class="text-subtitle2 text-weight-bold"
            data-test="calendar-invite-title"
          >
            {{ item.title }}
          </div>
          <q-badge
            v-if="item.status"
            :color="statusBadgeColor"
            data-test="calendar-invite-status"
          >
            {{ statusLabel }}
          </q-badge>
        </div>

        <div
          class="text-caption q-mt-xs"
          data-test="calendar-invite-time"
        >
          <q-icon name="schedule" size="14px" class="q-mr-xs" />
          <span>{{ formattedTimeRange }}</span>
        </div>

        <div
          v-if="item.location"
          class="text-caption q-mt-xs"
          data-test="calendar-invite-location"
        >
          <q-icon name="place" size="14px" class="q-mr-xs" />
          <span>{{ $t('calendarInvite.location') }}: {{ item.location }}</span>
        </div>

        <div
          v-if="safeUrl"
          class="text-caption q-mt-xs"
          data-test="calendar-invite-url"
        >
          <q-icon name="link" size="14px" class="q-mr-xs" />
          <a
            :href="safeUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="calendar-link"
          >
            {{ safeUrl }}
          </a>
        </div>

        <div
          class="text-caption q-mt-xs"
          data-test="calendar-invite-organizer"
        >
          <q-icon name="person" size="14px" class="q-mr-xs" />
          <span>{{ $t('calendarInvite.organizer') }}: {{ organizerDisplay }}</span>
        </div>

        <div
          v-if="item.description"
          class="text-caption q-mt-xs calendar-description"
          data-test="calendar-invite-description"
        >
          {{ item.description }}
        </div>

        <!-- Monotonic Attendee RSVP Tally -->
        <div
          class="text-caption text-weight-medium q-mt-sm"
          data-test="calendar-rsvp-tally"
          data-testid="calendar-rsvp-tally"
        >
          {{ rsvpTallyText }}
        </div>
      </div>
    </div>

    <!-- 1-Click RSVP Buttons -->
    <div
      v-if="item.status !== 'cancelled'"
      class="row items-center q-gutter-xs q-mt-sm"
      data-test="calendar-rsvp-actions"
    >
      <q-btn
        dense
        no-caps
        size="sm"
        :unelevated="currentUserStatus === 'accepted'"
        :outline="currentUserStatus !== 'accepted'"
        color="positive"
        :label="$t('calendarInvite.accept')"
        data-test="calendar-rsvp-accept"
        data-testid="calendar-rsvp-accept"
        @click="sendRsvp('accepted')"
      />
      <q-btn
        dense
        no-caps
        size="sm"
        :unelevated="currentUserStatus === 'tentative'"
        :outline="currentUserStatus !== 'tentative'"
        color="warning"
        :label="$t('calendarInvite.tentative')"
        data-test="calendar-rsvp-tentative"
        data-testid="calendar-rsvp-tentative"
        @click="sendRsvp('tentative')"
      />
      <q-btn
        dense
        no-caps
        size="sm"
        :unelevated="currentUserStatus === 'declined'"
        :outline="currentUserStatus !== 'declined'"
        color="negative"
        :label="$t('calendarInvite.decline')"
        data-test="calendar-rsvp-decline"
        data-testid="calendar-rsvp-decline"
        @click="sendRsvp('declined')"
      />
    </div>

    <!-- 1-Click Native OS (.ics) & Google Calendar Integration -->
    <div class="row items-center q-gutter-xs q-mt-xs">
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="event"
        :label="$t('calendarInvite.addToOsCalendar')"
        data-test="calendar-download-ics"
        data-testid="calendar-download-ics"
        @click="downloadIcs"
      />
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="open_in_new"
        type="a"
        :href="googleCalendarUrl"
        target="_blank"
        rel="noopener noreferrer"
        :label="$t('calendarInvite.addToGoogleCalendar')"
        data-test="calendar-google-link"
        data-testid="calendar-google-link"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type {
  CalendarInviteItem,
  CalendarRsvpItem,
  CalendarRsvpStatus,
} from '@frank/cashweb/types/messages'
import {
  buildGoogleCalendarTemplateUrl,
  downloadCalendarInviteIcs,
  tallyCalendarRsvps,
  type CalendarRsvpTally,
} from '../../utils/calendar-vcard'
import { useChatStore } from '../../stores/chats'
import { useProfileStore } from '../../stores/my-profile'

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]

export default defineComponent({
  name: 'ChatMessageCalendarInvite',
  props: {
    item: {
      type: Object as PropType<CalendarInviteItem>,
      required: true,
    },
    address: {
      type: String,
      default: '',
    },
    rsvps: {
      type: Array as PropType<CalendarRsvpItem[]>,
      default: undefined,
    },
    attendeeAddress: {
      type: String,
      default: '',
    },
    attendeeName: {
      type: String,
      default: '',
    },
  },
  emits: ['sendFollowUp', 'rsvp'],
  data() {
    return {
      localRsvps: [] as CalendarRsvpItem[],
      currentUserStatus: null as CalendarRsvpStatus | null,
    }
  },
  computed: {
    monthBadge(): string {
      const d = new Date(this.item.startMs)
      const idx = this.item.allDay ? d.getUTCMonth() : d.getUTCMonth()
      return MONTHS[idx] ?? 'JAN'
    },
    dayBadge(): string {
      const d = new Date(this.item.startMs)
      return String(d.getUTCDate())
    },
    formattedTimeRange(): string {
      if (this.item.allDay) {
        return this.$t('calendarInvite.allDay')
      }
      const start = new Date(this.item.startMs)
      const end = new Date(this.item.endMs)
      const pad = (n: number) => String(n).padStart(2, '0')
      const datePart = `${start.getUTCFullYear()}-${pad(
        start.getUTCMonth() + 1,
      )}-${pad(start.getUTCDate())}`
      const startTime = `${pad(start.getUTCHours())}:${pad(
        start.getUTCMinutes(),
      )}`
      const endTime = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`
      const tz = this.item.timezone ? ` (${this.item.timezone})` : ' UTC'
      return `${datePart} ${startTime}–${endTime}${tz}`
    },
    safeUrl(): string {
      const u = this.item.url?.trim() ?? ''
      return /^https?:\/\//i.test(u) ? u : ''
    },
    organizerDisplay(): string {
      return (
        this.item.organizer.name ||
        this.item.organizer.email ||
        this.item.organizer.address
      )
    },
    statusLabel(): string {
      switch (this.item.status) {
        case 'cancelled':
          return this.$t('calendarInvite.statusCancelled')
        case 'tentative':
          return this.$t('calendarInvite.statusTentative')
        default:
          return this.$t('calendarInvite.statusConfirmed')
      }
    },
    statusBadgeColor(): string {
      switch (this.item.status) {
        case 'cancelled':
          return 'negative'
        case 'tentative':
          return 'warning'
        default:
          return 'positive'
      }
    },
    conversationRsvps(): CalendarRsvpItem[] {
      const collected: CalendarRsvpItem[] = []
      if (Array.isArray(this.rsvps)) {
        collected.push(...this.rsvps)
      }
      try {
        const chatStore = useChatStore()
        const conversations = Object.values(chatStore.conversations ?? {})
        for (const conv of conversations) {
          for (const msg of conv?.messages ?? []) {
            for (const msgItem of msg?.items ?? []) {
              if (
                msgItem.type === 'calendar-rsvp' &&
                msgItem.uid === this.item.uid
              ) {
                collected.push(msgItem)
              }
            }
          }
        }
      } catch {
        // Store may not be active in isolated component unit tests
      }
      collected.push(...this.localRsvps)
      return collected
    },
    rsvpTally(): CalendarRsvpTally {
      return tallyCalendarRsvps(this.item.uid, this.conversationRsvps)
    },
    rsvpTallyText(): string {
      return this.$t('calendarInvite.rsvpTally', {
        accepted: this.rsvpTally.accepted.length,
        tentative: this.rsvpTally.tentative.length,
        declined: this.rsvpTally.declined.length,
      })
    },
    googleCalendarUrl(): string {
      return buildGoogleCalendarTemplateUrl(this.item)
    },
  },
  methods: {
    resolveAttendeeIdentity(): { address: string; name?: string } {
      let address = this.attendeeAddress.trim()
      let name = this.attendeeName.trim()
      if (!name) {
        try {
          const profileStore = useProfileStore()
          name = profileStore.profile?.name?.trim() || ''
        } catch {
          // ignore
        }
      }
      if (!address) {
        address =
          this.address?.trim() || '0x1111111111111111111111111111111111111111'
      }
      return {
        address,
        ...(name ? { name } : {}),
      }
    },
    sendRsvp(status: CalendarRsvpStatus) {
      const attendee = this.resolveAttendeeIdentity()
      const rsvpItem: CalendarRsvpItem = {
        type: 'calendar-rsvp',
        uid: this.item.uid,
        sequence: this.item.sequence,
        status,
        respondedAtMs: Date.now(),
        attendee,
      }
      this.currentUserStatus = status
      this.localRsvps.push(rsvpItem)
      this.$emit('rsvp', rsvpItem)
      this.$emit('sendFollowUp', {
        items: [rsvpItem],
      })
    },
    downloadIcs() {
      downloadCalendarInviteIcs(this.item, this.rsvpTally.byAddress)
    },
  },
})
</script>

<style lang="scss" scoped>
.calendar-invite-card {
  min-width: 240px;
  max-width: 420px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  background: rgba(255, 255, 255, 0.06);
}

.calendar-date-badge {
  min-width: 52px;
  background: rgba(0, 0, 0, 0.12);
  text-align: center;
}

.calendar-date-month {
  letter-spacing: 0.06em;
  line-height: 1.1;
}

.calendar-date-day {
  line-height: 1.2;
}

.calendar-description {
  white-space: pre-line;
  opacity: 0.9;
}

.calendar-link {
  color: inherit;
  text-decoration: underline;
}
</style>
