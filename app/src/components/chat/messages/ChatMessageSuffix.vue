<template>
  <div
    class="outgoing-focus-target"
    :class="{
      'chat-message-inline-meta': inline,
      'chat-message-inline-meta--sent': inline && outbound,
      'q-message-stamp': !inline,
    }"
    tabindex="-1"
    ref="focusTarget"
    :data-testid="inline ? 'outgoing-meta' : 'outgoing-focus-target'"
  >
    <!-- Programmatic focus lands on this suffix when Retry unmounts (#429). The live region
    below stays clipped and is not a keyboard target. One persistent polite live region per
    message: it exists before its text changes, so a state change is announced once, and a
    message that merely renders (e.g. after a reload) is not announced. -->
    <span
      class="q-sr-only"
      role="status"
      aria-live="polite"
      data-testid="outgoing-announcement"
      >{{ announced }}</span
    >
    <!-- Last line of the bubble (#391): one row of time and amount, floated
         to the end of the text. No break between them, and no second row. -->
    <template v-if="inline">
      <span
        v-if="status === 'pending' && outbound"
        data-testid="outgoing-sending"
        class="q-mr-xs"
        >{{ $t('outgoing.sending') }}</span
      >
      <time
        v-if="stamp"
        data-testid="outgoing-stamp"
        :datetime="stampDatetime || undefined"
        >{{ stamp }}</time
      >
      <span data-testid="outgoing-amount">{{ amount }}</span>
      <chat-message-suffix-buttons
        v-if="status === 'confirmed'"
        :status="status"
        @replyClick="$emit('replyClick')"
        @forwardClick="$emit('forwardClick')"
        @infoClick="$emit('infoClick')"
        @deleteClick="$emit('deleteClick')"
      />
    </template>
    <div
      v-else-if="status === 'error'"
      :class="['row', 'items-center', suffixPlacement]"
      data-testid="outgoing-failed"
    >
      <div v-if="outbound" :class="buttonPlacement">
        <chat-message-suffix-buttons
          :status="status"
          @resendClick="$emit('resendClick')"
          @discardClick="$emit('discardClick')"
        />
      </div>
      <div class="col-auto">
        <q-icon name="error" color="red" />{{ $t('chatMessage.failedToSend') }}
        <span v-if="failureText" data-testid="outgoing-failure-reason">
          {{ failureText }}
        </span>
      </div>
      <div v-if="!outbound" :class="buttonPlacement">
        <chat-message-suffix-buttons
          :status="status"
          @resendClick="$emit('resendClick')"
          @discardClick="$emit('discardClick')"
        />
      </div>
    </div>
    <div
      v-else-if="status === 'payment-pending'"
      :class="['row', 'items-center', suffixPlacement]"
      data-testid="outgoing-payment-pending"
    >
      <div class="col-auto q-pa-xs">
        <q-icon name="schedule" />{{ paymentText }}
      </div>
      <!-- A passed stamp is the time, never a second copy of the status (#393). -->
      <div v-if="stamp" class="col-auto q-pa-xs" data-testid="outgoing-stamp">
        {{ stamp }}
      </div>
    </div>
    <div
      v-else
      :class="['row', 'items-center', suffixPlacement]"
      data-testid="outgoing-footer"
    >
      <!-- Button placement for sent mssages -->
      <div v-if="outbound" :class="buttonPlacement">
        <chat-message-suffix-buttons
          :status="status"
          @replyClick="$emit('replyClick')"
          @forwardClick="$emit('forwardClick')"
          @infoClick="$emit('infoClick')"
          @deleteClick="$emit('deleteClick')"
        />
      </div>
      <!-- One cluster. A break exists only when a nonempty time stamp precedes the amount. -->
      <div class="col-auto q-pa-xs" data-testid="outgoing-meta">
        <span
          v-if="status === 'pending' && outbound"
          data-testid="outgoing-sending"
          class="q-mr-xs"
          >{{ $t('outgoing.sending') }}</span
        >
        <template v-if="stamp">
          <span data-testid="outgoing-stamp">{{ stamp }}</span>
          <br />
        </template>
        <span data-testid="outgoing-amount">{{ amount }}</span>
      </div>
      <!-- Button placement for received mssages -->
      <div v-if="!outbound" :class="buttonPlacement">
        <chat-message-suffix-buttons
          :status="status"
          @replyClick="$emit('replyClick')"
          @forwardClick="$emit('forwardClick')"
          @infoClick="$emit('infoClick')"
          @deleteClick="$emit('deleteClick')"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import ChatMessageSuffixButtons from './ChatMessageSuffixButtons.vue'

export default defineComponent({
  name: 'ChatMessageSuffix',
  components: {
    ChatMessageSuffixButtons,
  },
  props: {
    stamp: {
      type: String,
      required: true,
    },
    /** Machine-readable instant for the visible stamp. Empty when there is none. */
    stampDatetime: {
      type: String,
      required: false,
      default: '',
    },
    /** Confirmed and pending sit on the last text line. Other states keep a row. */
    inline: {
      type: Boolean,
      required: false,
      default: false,
    },
    amount: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
    },
    outbound: {
      type: Boolean,
      required: true,
    },
    /** For `payment-pending`: `live` (the wallet confirmed the payment is still valid), `queued`
     * (no payment of its own yet; waiting behind another message) or `checking`. */
    paymentState: {
      type: String,
      required: false,
      default: 'checking',
    },
    /** Why the message failed (`OutgoingFailureReason`), shown next to "Failed to send". */
    failureReason: {
      type: String,
      required: false,
      default: '',
    },
  },
  data() {
    return { announced: '' }
  },
  mounted() {
    // Render the region empty, then fill it: many screen readers ignore text that is already in
    // a region when it is inserted. Only a fresh send (status 'pending') announces on mount; a
    // message that merely renders (e.g. after a reload) stays silent until its state changes.
    if (this.status === 'pending') {
      void this.$nextTick(() => {
        this.announced = this.announcement
      })
    }
  },
  watch: {
    announcement(text: string) {
      this.announced = text
    },
  },
  methods: {
    /** Moves keyboard focus to this message's visible suffix, e.g. when the button that was
     * focused (Retry) is about to disappear. The live region stays clipped and is not focused. */
    focusStatus() {
      ;(this.$refs.focusTarget as HTMLElement | undefined)?.focus()
    },
  },
  emits: [
    'replyClick',
    'forwardClick',
    'infoClick',
    'deleteClick',
    'resendClick',
    'discardClick',
  ],
  computed: {
    paymentText(): string {
      if (this.paymentState === 'live')
        return this.$t('outgoing.paymentPending')
      if (this.paymentState === 'queued')
        return this.$t('outgoing.paymentQueued')
      return this.$t('outgoing.paymentChecking')
    },
    announcement(): string {
      if (this.status === 'pending' && this.outbound) {
        return this.$t('outgoing.sending')
      }
      if (this.status === 'payment-pending') return this.paymentText
      if (this.status === 'error') {
        return `${this.$t('chatMessage.failedToSend')} ${
          this.failureText
        }`.trim()
      }
      return ''
    },
    failureText(): string {
      const keys: Record<string, string> = {
        unreachable: 'outgoing.reasonUnreachable',
        unavailable: 'outgoing.reasonUnavailable',
        rejected: 'outgoing.reasonRejected',
        interrupted: 'outgoing.reasonInterrupted',
        unverified: 'outgoing.reasonUnverified',
        recovered: 'outgoing.reasonRecovered',
        error: 'outgoing.reasonError',
      }
      keys['insufficient-funds'] = 'outgoing.reasonInsufficientFunds'
      keys['recipient-unavailable'] = 'outgoing.reasonRecipientUnavailable'
      const key = keys[this.failureReason]
      return key === undefined ? '' : this.$t(key)
    },
    suffixPlacement(): string {
      return this.outbound ? 'text-right' : 'text-left'
    },
    buttonPlacement(): string[] {
      return this.outbound
        ? ['col-grow', 'q-mr-sm', 'text-left']
        : ['col-grow', 'q-ml-sm', 'text-right']
    },
  },
})
</script>
