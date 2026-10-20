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
    <span
      class="q-sr-only"
      role="status"
      aria-live="polite"
      data-testid="outgoing-announcement"
      >{{ announced }}</span
    >
    <div
      class="outgoing-footer"
      :class="suffixPlacement"
      data-testid="outgoing-footer"
    >
      <span
        v-if="status === 'error'"
        class="outgoing-status outgoing-status--failed"
        data-testid="outgoing-failed"
      >
        <q-icon
          name="error"
          :color="inline && outbound ? undefined : 'negative'"
        />
        <span class="outgoing-status-text">
          <span>{{ $t('chatMessage.failedToSend') }}</span>
          <template v-if="failureText">
            {{ ' — '
            }}<span data-testid="outgoing-failure-reason">{{
              failureText
            }}</span>
          </template>
        </span>
      </span>
      <span
        v-else-if="status === 'payment-pending'"
        class="outgoing-status"
        data-testid="outgoing-payment-pending"
      >
        <q-icon name="schedule" />
        <span>{{ paymentText }}</span>
      </span>
      <span
        v-else-if="status === 'pending' && outbound"
        data-testid="outgoing-sending"
        >{{ sendingText }}</span
      >
      <span
        v-else-if="paymentSummaryText"
        data-testid="outgoing-payment-summary"
        >{{ paymentSummaryText }}</span
      >
      <span
        v-if="showPaymentSuccess"
        class="outgoing-payment-success"
        data-testid="outgoing-payment-success"
        >{{ $t(paymentSuccessKey) }}</span
      >
      <time
        v-if="stamp"
        data-testid="outgoing-stamp"
        :datetime="stampDatetime || undefined"
        >{{ stamp }}</time
      >
      <span data-testid="outgoing-amount" :title="amountExact || undefined">{{
        amount
      }}</span>
      <chat-message-suffix-buttons
        :status="status"
        @replyClick="$emit('replyClick')"
        @forwardClick="$emit('forwardClick')"
        @infoClick="$emit('infoClick')"
        @deleteClick="$emit('deleteClick')"
        @resendClick="$emit('resendClick')"
        @discardClick="$emit('discardClick')"
      />
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
    /** Match the bubble’s inline placement; the footer itself keeps one shared structure. */
    inline: {
      type: Boolean,
      required: false,
      default: false,
    },
    amount: {
      type: String,
      required: true,
    },
    /** Every digit of `amount`, for its title, when `amount` is a shortened figure. */
    amountExact: {
      type: String,
      required: false,
      default: '',
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
    /** The send is queued: the chain's node cannot be reached. Nothing is signed for it. */
    waitingForChain: {
      type: Boolean,
      required: false,
      default: false,
    },
    /** The send is waiting for the account's previous payment to be seen on chain. */
    waitingForPreviousPayment: {
      type: Boolean,
      required: false,
      default: false,
    },
    /** While waiting for the previous payment: blocks still to pass before this send's coin
     * may be spent, when the wallet said; -1 otherwise. */
    waitingBlocks: {
      type: Number,
      required: false,
      default: -1,
    },
    /** `DirectMessagePaymentSummary` of a sent paid message; '' when not known. */
    paymentSummary: {
      type: String,
      required: false,
      default: '',
    },
    /** Why the message failed (`OutgoingFailureReason`), shown next to "Failed to send". */
    failureReason: {
      type: String,
      required: false,
      default: '',
    },
  },
  data() {
    return {
      announced: '',
      showPaymentSuccess: false,
      paymentSuccessTimer: undefined as
        | ReturnType<typeof setTimeout>
        | undefined,
    }
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
  beforeUnmount() {
    clearTimeout(this.paymentSuccessTimer)
  },
  watch: {
    // A mounted history item stays silent. Only a newly observed success flashes beside
    // its time and amount; this timer changes presentation, never payment state.
    paymentSuccessKey(key: string) {
      clearTimeout(this.paymentSuccessTimer)
      this.showPaymentSuccess = key !== ''
      if (key) {
        this.paymentSuccessTimer = setTimeout(() => {
          this.showPaymentSuccess = false
        }, 5000)
      }
    },
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
    /** What a message being sent says: that it is being sent, or, while its payment waits for
     * the account's previous payment to be mined, that it is waiting for that. */
    sendingText(): string {
      if (this.waitingForChain) return this.$t('outgoing.waitingForChain')
      if (this.waitingForPreviousPayment && this.waitingBlocks > 0)
        return this.$t('outgoing.waitingBlocks', { blocks: this.waitingBlocks })
      return this.waitingForPreviousPayment
        ? this.$t('outgoing.waitingForPreviousPayment')
        : this.$t('outgoing.sending')
    },
    paymentSuccessKey(): string {
      if (!this.outbound || this.status !== 'confirmed') return ''
      if (this.paymentSummary === 'paid') return 'outgoing.paymentPaid'
      if (this.paymentSummary === 'repaid') return 'outgoing.paymentRepaid'
      return ''
    },
    /** The payment's state beside the amount of a sent message. */
    paymentSummaryText(): string {
      if (!this.outbound || this.status !== 'confirmed') return ''
      const keys: Record<string, string> = {
        pending: 'outgoing.paymentSent',
        mempool: 'outgoing.paymentInMempool',
        reverted: 'outgoing.paymentReverted',
        failed: 'outgoing.paymentFailed',
        unsent: 'outgoing.paymentUnsent',
      }
      const key = keys[this.paymentSummary]
      return key === undefined ? '' : this.$t(key)
    },
    paymentText(): string {
      if (this.paymentState === 'live')
        return this.$t('outgoing.paymentPending')
      if (this.paymentState === 'queued')
        return this.$t('outgoing.paymentQueued')
      return this.$t('outgoing.paymentChecking')
    },
    announcement(): string {
      if (this.status === 'pending' && this.outbound) {
        return this.sendingText
      }
      if (this.status === 'payment-pending') return this.paymentText
      if (this.status === 'error') {
        return `${this.$t('chatMessage.failedToSend')} ${
          this.failureText
        }`.trim()
      }
      if (this.showPaymentSuccess) return this.$t(this.paymentSuccessKey)
      return this.paymentSummaryText
    },
    failureText(): string {
      const keys: Record<string, string> = {
        unreachable: 'outgoing.reasonUnreachable',
        unavailable: 'outgoing.reasonUnavailable',
        rejected: 'outgoing.reasonRejected',
        interrupted: 'outgoing.reasonInterrupted',
        unverified: 'outgoing.reasonUnverified',
        recovered: 'outgoing.reasonRecovered',
      }
      keys['insufficient-funds'] = 'outgoing.reasonInsufficientFunds'
      keys['recipient-unregistered'] = 'outgoing.reasonRecipientUnregistered'
      keys['stamp-below-fee'] = 'outgoing.reasonStampBelowFee'
      const key = keys[this.failureReason]
      return key === undefined ? '' : this.$t(key)
    },
    suffixPlacement(): string {
      return this.outbound ? 'text-right' : 'text-left'
    },
  },
})
</script>

<style scoped>
.outgoing-focus-target {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.outgoing-focus-target.chat-message-inline-meta {
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
}
.outgoing-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  white-space: nowrap;
}
.outgoing-payment-success {
  min-width: 0;
  white-space: normal;
}
.outgoing-footer.text-left {
  justify-content: flex-start;
}
.outgoing-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: normal;
}
</style>
