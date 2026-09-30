<template>
  <!-- In-flow (not absolute) so the banners stack above the message list instead of covering it
  or each other; it takes no height when neither banner is showing. -->
  <div class="column no-wrap full-width" data-testid="chat-banner-stack">
    <mailbox-status-banner />
    <div
      v-if="stampStatus"
      class="full-width text-caption text-center bg-accent text-white q-py-xs"
      role="status"
      data-testid="stamp-preparation-status"
    >
      {{ stampStatus }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import MailboxStatusBanner from './MailboxStatusBanner.vue'

/** Status banners above the chat message list: the mailbox poll health (ticket #271) and the
 * stamp-preparation progress while sending. */
export default defineComponent({
  name: 'ChatBannerStack',
  components: { MailboxStatusBanner },
  props: {
    stampStatus: { type: String, default: null },
  },
})
</script>
