<template>
  <!-- Only the transient stamp-preparation banner occupies the chat viewport. Mailbox health
  is available beside the sidebar balance instead. -->
  <div class="column no-wrap full-width" data-testid="chat-banner-stack">
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
import { defineComponent, type PropType } from 'vue'

/** Transient stamp-preparation progress while sending. */
export default defineComponent({
  name: 'ChatBannerStack',
  props: {
    stampStatus: { type: String as PropType<string | null>, default: null },
  },
})
</script>
