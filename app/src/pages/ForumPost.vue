<template>
  <div>
    <div
      v-if="stampPreparationStatus"
      class="full-width text-caption text-center bg-accent text-white q-py-xs q-mb-sm"
      role="status"
      data-testid="stamp-preparation-status"
    >
      {{ stampPreparationStatus }}
    </div>
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
      message: {} as Partial<MessageWithReplies>,
    }
  },
  async mounted() {
    this.payloadDigest = this.$route.params.payloadDigest as string
    const message = await this.fetchMessage({
      payloadDigest: this.payloadDigest,
    })
    if (message) {
      this.message = message
    }
  },
  async beforeRouteUpdate(to, from, next) {
    this.payloadDigest = to.params.payloadDigest as string
    const message = await this.fetchMessage({
      payloadDigest: this.payloadDigest,
    })
    if (message) {
      this.message = message
    }
    console.log('returned msg', this.message)
    next()
  },
})
</script>
