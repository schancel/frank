<template>
  <div>
    <a-message
      v-bind="$attrs"
      :message="message"
      v-if="message && message.payloadDigest"
      :show-replies="true"
      @set-topic="$emit('set-topic', $event)"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { storeToRefs } from 'pinia'
import type { RouteLocationNormalized } from 'vue-router'

import { useForumStore, MessageWithReplies } from 'src/stores/forum'

import AMessage from '../components/forum/ForumMessage.vue'

export default defineComponent({
  setup() {
    const forumStore = useForumStore()
    const { stampPreparationStatus } = storeToRefs(forumStore)

    return {
      getMessage: forumStore.getMessage,
      fetchMessage: forumStore.fetchMessage,
      stampPreparationStatus,
    }
  },
  components: {
    AMessage,
  },
  emits: ['set-topic'],
  props: {},
  data() {
    const payloadDigest = this.$route.params.payloadDigest as string
    return {
      payloadDigest,
    }
  },
  computed: {
    message(): MessageWithReplies | null {
      const payloadDigest = this.$route.params.payloadDigest
      return typeof payloadDigest === 'string'
        ? this.getMessage(payloadDigest)
        : null
    },
  },
  async mounted() {
    this.payloadDigest = this.$route.params.payloadDigest as string
    await this.fetchMessage({
      payloadDigest: this.payloadDigest,
    })
  },
  async beforeRouteUpdate(to: RouteLocationNormalized) {
    this.payloadDigest = (to?.params?.payloadDigest as string) || ''
    await this.fetchMessage({
      payloadDigest: this.payloadDigest,
    })
  },
})
</script>
