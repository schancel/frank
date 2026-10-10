<template>
  <span class="chat-message-text" v-html="markedMessage" @click="clicked" />
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import { renderMarkdown, purify } from '../../../utils/markdown'
import {
  expandAttachmentTokens,
  replaceAttachmentReferences,
  type PostAttachment,
} from '../../../utils/post-editor'

export default defineComponent({
  name: 'ChatMessageText',
  props: {
    text: {
      type: String,
      required: true,
    },
    // The same message's pictures that may be shown, with their position as ID. The text shows
    // one wherever it says `![name](attachment:N)`.
    attachments: {
      type: Array as PropType<PostAttachment[]>,
      default: () => [],
    },
    isReply: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['imageClick'],
  computed: {
    markedMessage() {
      // A message is someone else's content: it shows the pictures that came with it and makes
      // the browser fetch nothing. A reference with no picture stays the text it was.
      if (this.isReply) {
        // The quoted message's picture is shown beside the quote; here it is only named.
        return purify(
          replaceAttachmentReferences(this.text, alt => alt),
          [],
        )
      }
      // A chat message keeps the line breaks it was written with.
      return renderMarkdown(
        expandAttachmentTokens(this.text, this.attachments),
        this.$q.dark.isActive,
        true,
        this.attachments.map(a => a.dataUrl),
      )
    },
  },
  methods: {
    clicked(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target?.tagName !== 'IMG') return
      this.$emit('imageClick', (target as HTMLImageElement).src)
    },
  },
})
</script>
