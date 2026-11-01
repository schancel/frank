<template>
  <chat-message-image
    v-if="imageMime"
    :data="item.data"
    :mime-type="item.mimeType"
  />
  <div v-else class="q-pa-sm">
    <q-icon name="attach_file" /> {{ item.mimeType }} · {{ item.data.length }} B
    <q-btn
      flat
      icon="download"
      :label="$t('chatImage.downloadAttachment')"
      @click="download"
    />
  </div>
</template>
<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import type { BlobItem } from '@frank/cashweb/types/messages'
import ChatMessageImage from './ChatMessageImage.vue'
export default defineComponent({
  components: { ChatMessageImage },
  props: { item: { type: Object as PropType<BlobItem>, required: true } },
  data: () => ({ downloadUrl: '' }),
  computed: {
    imageMime() {
      return /^image\/(png|jpeg|gif|webp)$/.test(this.item.mimeType)
    },
  },
  watch: {
    item() {
      this.releaseUrl()
    },
  },
  beforeUnmount() {
    this.releaseUrl()
  },
  methods: {
    releaseUrl() {
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl)
      this.downloadUrl = ''
    },
    download() {
      if (!this.downloadUrl)
        this.downloadUrl = URL.createObjectURL(
          new Blob([new Uint8Array(this.item.data)], {
            type: 'application/octet-stream',
          }),
        )
      const anchor = document.createElement('a')
      anchor.href = this.downloadUrl
      anchor.download = 'attachment.bin'
      anchor.click()
    },
  },
})
</script>
