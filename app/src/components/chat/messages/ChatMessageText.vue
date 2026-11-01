<template>
  <span
    v-external-images
    class="chat-message-text"
    @click="clicked"
    v-html="markedMessage"
  />
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { ChatImageAttachment } from '../../../utils/chat-binary'
import { getActiveChain, onActiveChainChange } from '@frank/wallet/chain'
import { fetchContactProfile } from '../../../utils/directory-peer'
import { openContactProfile } from '../../../utils/routes'
import { addressMentionTokens } from '../../../utils/address-mentions'
import {
  ATTACHMENT_ATTRIBUTE,
  renderMarkdown,
  purify,
} from '../../../utils/markdown'
import { vExternalImages } from '../../../utils/external-images'
import { replaceAttachmentReferences } from '../../../utils/post-editor'

export default defineComponent({
  name: 'ChatMessageText',
  directives: { externalImages: vExternalImages },
  props: {
    text: {
      type: String,
      required: true,
    },
    // The same message's pictures that may be shown, with their position as ID. The text shows
    // one wherever it says `![name](attachment:N)`.
    attachments: {
      type: Array as PropType<ChatImageAttachment[]>,
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
      urls: new Map<Uint8Array, string>(),
      mentionNames: {} as Record<string, string>,
      mentionGeneration: 0,
      removeChainListener: undefined as (() => void) | undefined,
    }
  },
  computed: {
    markedMessage() {
      // A message is someone else's content: it shows the pictures that came with it and makes
      // the browser fetch nothing by itself; a web picture waits for a click on its placeholder.
      // A reference with no picture stays the text it was.
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
        this.mentionNames,
      )
    },
  },
  watch: {
    attachments: {
      handler() {
        this.showPictures()
      },
      flush: 'post',
    },
    text() {
      void this.refreshMentions()
    },
    isReply() {
      void this.refreshMentions()
    },
  },
  mounted() {
    this.showPictures()
    void this.refreshMentions()
    this.removeChainListener = onActiveChainChange(() => {
      void this.refreshMentions()
    })
  },
  updated() {
    this.showPictures()
  },
  beforeUnmount() {
    this.mentionGeneration++
    this.removeChainListener?.()
    this.urls.forEach(url => URL.revokeObjectURL(url))
    this.urls.clear()
  },
  methods: {
    async refreshMentions() {
      const generation = ++this.mentionGeneration
      this.mentionNames = {}
      if (this.isReply) return
      const addresses = addressMentionTokens(this.text).addresses
      if (!addresses.length) return
      const chain = getActiveChain()
      await Promise.all(
        addresses.map(async address => {
          try {
            const parsed = chain.parseAddress(address)
            if (!parsed) return
            const profile = await fetchContactProfile(parsed)
            if (
              generation !== this.mentionGeneration ||
              getActiveChain() !== chain
            )
              return
            const name = profile?.name?.trim()
            if (name)
              this.mentionNames = { ...this.mentionNames, [address]: name }
          } catch {
            // The full address remains usable when its profile is unavailable.
          }
        }),
      )
    },
    attachmentOf(image: Element): ChatImageAttachment | undefined {
      const id = image.getAttribute(ATTACHMENT_ATTRIBUTE)
      return this.attachments.find(a => a.id === id)
    },
    /** Points every placeholder at its picture: one object URL per picture, shared. */
    showPictures() {
      const root = this.$el as HTMLElement | undefined
      if (!root?.querySelectorAll) return
      const retained = new Set(this.attachments.map(a => a.data))
      this.urls.forEach((url, data) => {
        if (!retained.has(data)) {
          URL.revokeObjectURL(url)
          this.urls.delete(data)
        }
      })
      root
        .querySelectorAll<HTMLImageElement>(`img[${ATTACHMENT_ATTRIBUTE}]`)
        .forEach(image => {
          const attachment = this.attachmentOf(image)
          if (!attachment) {
            image.remove()
            return
          }
          let url = this.urls.get(attachment.data)
          if (url === undefined) {
            url = URL.createObjectURL(
              new Blob([new Uint8Array(attachment.data)], {
                type: attachment.mimeType,
              }),
            )
            this.urls.set(attachment.data, url)
          }
          if (image.getAttribute('src') !== url) image.setAttribute('src', url)
        })
    },
    clicked(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest('a')
      const address = /^\/chat\/(0x[0-9a-f]{40})\?info=true$/i.exec(
        anchor?.getAttribute('href') ?? '',
      )?.[1]
      if (address) {
        event.preventDefault()
        void openContactProfile(this.$router, address)
        return
      }
      if (target?.tagName !== 'IMG') return
      const attachment = this.attachmentOf(target)
      if (attachment) this.$emit('imageClick', this.urls.get(attachment.data))
    },
  },
})
</script>
