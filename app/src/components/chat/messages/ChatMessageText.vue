<template>
  <span class="chat-message-text" v-html="markedMessage" @click="clicked" />
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  ATTACHMENT_ATTRIBUTE,
  renderMarkdown,
  purify,
} from '../../../utils/markdown'
import {
  replaceAttachmentReferences,
  type PostAttachment,
} from '../../../utils/post-editor'

/** A picture's bytes as an object URL, so every reference to it shares one copy. */
function objectUrl(dataUrl: string): string | undefined {
  if (typeof URL.createObjectURL !== 'function') return undefined
  try {
    const comma = dataUrl.indexOf(',')
    const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? ''
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type }))
  } catch {
    return undefined
  }
}

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
  data() {
    return {
      // Object URLs made for this message's pictures, by data URI; revoked on unmount.
      urls: new Map<string, string>(),
    }
  },
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
      // A chat message keeps the line breaks it was written with. The pictures' bytes are not
      // in this HTML: each reference is a placeholder that `showPictures` fills in, so a
      // message that refers to one picture a thousand times stays the size of its text.
      return renderMarkdown(
        this.text,
        this.$q.dark.isActive,
        true,
        this.attachments.map(a => a.id),
      )
    },
  },
  mounted() {
    this.showPictures()
  },
  updated() {
    this.showPictures()
  },
  beforeUnmount() {
    this.urls.forEach(url => URL.revokeObjectURL(url))
    this.urls.clear()
  },
  methods: {
    attachmentOf(image: Element): PostAttachment | undefined {
      const id = image.getAttribute(ATTACHMENT_ATTRIBUTE)
      return this.attachments.find(a => a.id === id)
    },
    /** Points every placeholder at its picture: one object URL per picture, shared. */
    showPictures() {
      const root = this.$el as HTMLElement | undefined
      if (!root?.querySelectorAll) return
      root
        .querySelectorAll<HTMLImageElement>(`img[${ATTACHMENT_ATTRIBUTE}]`)
        .forEach(image => {
          const attachment = this.attachmentOf(image)
          if (!attachment) {
            image.remove()
            return
          }
          let url = this.urls.get(attachment.dataUrl)
          if (url === undefined) {
            url = objectUrl(attachment.dataUrl) ?? attachment.dataUrl
            this.urls.set(attachment.dataUrl, url)
          }
          if (image.getAttribute('src') !== url) image.setAttribute('src', url)
        })
    },
    clicked(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target?.tagName !== 'IMG') return
      const attachment = this.attachmentOf(target)
      if (attachment) this.$emit('imageClick', attachment.dataUrl)
    },
  },
})
</script>
