<template>
  <span
    v-if="rendered.kind === 'plain'"
    class="chat-message-text"
    style="white-space: pre-wrap; overflow-wrap: anywhere"
    data-testid="chat-message-text-plain"
    >{{ rendered.text
    }}<em
      v-if="rendered.truncated"
      class="text-caption"
      data-testid="chat-message-text-truncated"
    >
      {{ $t('chatMessage.textTooLongToDisplay') }}</em
    ></span
  >
  <span v-else class="chat-message-text" v-html="rendered.html" />
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import {
  renderMessageText,
  type RenderedMessageText,
} from '../../../utils/markdown'

export default defineComponent({
  name: 'ChatMessageText',
  props: {
    text: {
      type: String,
      required: true,
    },
    isReply: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    rendered(): RenderedMessageText {
      return renderMessageText(this.text, this.$q.dark.isActive, this.isReply)
    },
  },
})
</script>
