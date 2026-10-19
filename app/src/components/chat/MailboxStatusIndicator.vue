<template>
  <negotiation-recovery-indicator v-bind="$attrs" />
  <span v-if="message" v-bind="$attrs" class="mailbox-status-indicator">
    <q-btn
      flat
      dense
      round
      size="sm"
      icon="warning"
      color="warning"
      data-testid="mailbox-status-indicator"
      :aria-label="message"
      @click.stop="detailsOpen = !detailsOpen"
    >
      <q-tooltip v-model="detailsOpen">{{ message }}</q-tooltip>
    </q-btn>
    <span class="q-sr-only" role="status" aria-live="polite">{{
      message
    }}</span>
  </span>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import NegotiationRecoveryIndicator from './NegotiationRecoveryIndicator.vue'

import { useMailboxStatusStore } from '../../stores/mailbox-status'
import { messagingState } from '../../utils/messaging-state'

const keyByState = {
  'unavailable': 'mailboxStatus.unavailable',
  'unreachable': 'mailboxStatus.unreachable',
  'rate-limited': 'mailboxStatus.rateLimited',
  'unauthorized': 'mailboxStatus.unauthorized',
} as const

/** A compact status beside the sidebar balance. The mailbox poller retains ownership of retry. */
export default defineComponent({
  name: 'MailboxStatusIndicator',
  components: { NegotiationRecoveryIndicator },
  inheritAttrs: false,
  setup() {
    return { status: useMailboxStatusStore(), messaging: messagingState }
  },
  data() {
    return { detailsOpen: false }
  },
  computed: {
    message(): string | null {
      if (this.messaging.status !== 'ready' && this.messaging.reason)
        return this.$t(`mailboxStatus.directory.${this.messaging.reason}`)
      return this.status.state === 'ok'
        ? null
        : this.$t(keyByState[this.status.state])
    },
  },
})
</script>

<style scoped>
.mailbox-status-indicator {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
