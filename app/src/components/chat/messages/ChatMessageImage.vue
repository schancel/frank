<template>
  <div v-if="!vetted.ok" class="text-caption text-grey q-pa-sm">
    {{ $t('chatImage.notShown', { reason: reasonText }) }}
  </div>
  <template v-else-if="isReply">
    <q-img
      fit="cover"
      height="100%"
      width="80px"
      :src="url"
      @click="showImageDialog"
    />
  </template>
  <template v-else>
    <q-dialog v-model="imageDialog">
      <image-dialog :image="url" />
    </q-dialog>
    <!-- Capped so a large delivered picture does not fill the whole chat column. -->
    <q-img
      class="q-mb-sm chat-image"
      style="max-width: 320px; max-height: 320px"
      width="100%"
      fit="contain"
      :src="url"
      @click="showImageDialog"
    />
  </template>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue'
import {
  inspectImageBytes,
  IMAGE_REASON_KEYS,
} from '../../../utils/image-data-uri'
import ImageDialog from '../../../components/dialogs/ImageDialog.vue'
export default defineComponent({
  props: {
    data: { type: Object as PropType<Uint8Array>, required: true },
    mimeType: { type: String, required: true },
    isReply: { type: Boolean, default: false },
  },
  components: { ImageDialog },
  data: () => ({ url: '', imageDialog: false }),
  computed: {
    vetted() {
      return inspectImageBytes(this.data, this.mimeType)
    },
    reasonText(): string {
      return this.vetted.ok
        ? ''
        : this.$t(`chatImage.${IMAGE_REASON_KEYS[this.vetted.reason]}`)
    },
  },
  watch: {
    data: { handler: 'refreshUrl', immediate: true },
    mimeType: 'refreshUrl',
  },
  beforeUnmount() {
    if (this.url) URL.revokeObjectURL(this.url)
  },
  methods: {
    showImageDialog() {
      this.imageDialog = true
    },
    refreshUrl() {
      if (this.url) URL.revokeObjectURL(this.url)
      this.url =
        this.vetted.ok && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(
              new Blob([new Uint8Array(this.data)], { type: this.mimeType }),
            )
          : ''
    },
  },
})
</script>
