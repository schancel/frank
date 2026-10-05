<template>
  <div
    v-if="message"
    class="full-width text-caption text-center bg-negative text-white q-py-xs q-px-sm"
    role="status"
    data-testid="mailbox-status"
  >
    {{ message }}
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import { useMailboxStatusStore } from '../../stores/mailbox-status'
import { messagingState } from '../../utils/messaging-state'

const keyByState = {
  'unavailable': 'mailboxStatus.unavailable',
  'unreachable': 'mailboxStatus.unreachable',
  'rate-limited': 'mailboxStatus.rateLimited',
  'unauthorized': 'mailboxStatus.unauthorized',
} as const

/** Non-blocking, screen-reader-announced status while messaging could not start (the account's
 * directory entry is not published yet) or the mailbox poll is failing (ticket #271).
 * Renders nothing while the inbox is healthy. */
export default defineComponent({
  name: 'MailboxStatusBanner',
  setup() {
    return { status: useMailboxStatusStore(), messaging: messagingState }
  },
  computed: {
    message(): string | null {
      // Messaging that never started explains itself first: nothing is being received at all.
      if (this.messaging.status !== 'ready' && this.messaging.reason)
        return this.$t(`mailboxStatus.directory.${this.messaging.reason}`)
      return this.status.state === 'ok'
        ? null
        : this.$t(keyByState[this.status.state])
    },
  },
})
</script>
