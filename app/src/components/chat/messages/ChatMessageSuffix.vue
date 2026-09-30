<template>
  <div
    v-if="status === 'error'"
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
    <div class="col-auto" role="status">
      <q-icon name="error" color="red" />{{ $t('outgoing.failed') }}
      <span v-if="failureText" data-testid="outgoing-failure-reason">
        {{ failureText }}
      </span>
      <div class="text-caption" data-testid="outgoing-retry-hint">
        {{ $t('outgoing.retryHint') }}
      </div>
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
    <div class="col-auto q-pa-xs" role="status">
      <q-icon name="schedule" />{{ $t('outgoing.paymentPending') }}
    </div>
  </div>
  <div v-else :class="['row', 'items-center', suffixPlacement]">
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
    <div class="col-auto q-pa-xs">
      {{ stamp }}
      <br />
      {{ amount }}
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
    /** Why the message failed (`OutgoingFailureReason`), shown next to "Failed to send". */
    failureReason: {
      type: String,
      required: false,
      default: '',
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
