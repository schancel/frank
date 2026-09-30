<template>
  <div v-if="!vetted.ok" class="text-caption text-grey q-pa-sm">
    {{ $t('chatImage.notShown', { reason: reasonText }) }}
  </div>
  <template v-else-if="isReply">
    <q-img
      fit="cover"
      height="100%"
      width="80px"
      :src="image"
      @click="showImageDialog"
    />
  </template>
  <template v-else>
    <q-dialog v-model="imageDialog">
      <image-dialog :image="image" />
    </q-dialog>
    <!-- Capped so a large delivered picture does not fill the whole chat column. -->
    <q-img
      class="q-mb-sm chat-image"
      style="max-width: 320px; max-height: 320px"
      width="100%"
      fit="contain"
      :src="image"
      @click="showImageDialog"
    />
  </template>
</template>

<script lang="ts">
import { ref } from 'vue'

import {
  DELIVERED_IMAGE_LIMITS,
  inspectImageDataUri,
} from '../../../utils/image-data-uri'
import ImageDialog from '../../../components/dialogs/ImageDialog.vue'

// inspectImageDataUri reasons (utils/image-data-uri.ts) -> chatImage.* message keys.
const REASON_KEYS: Record<string, string> = {
  'not an image': 'reasonNotAnImage',
  'too large': 'reasonTooLarge',
  'not an inline image': 'reasonNotInline',
  'unreadable image header': 'reasonUnreadableHeader',
  'empty image': 'reasonEmpty',
  'dimensions too large': 'reasonDimensionsTooLarge',
}

export default {
  props: {
    image: {
      type: String,
      default: () => '',
    },
    isReply: {
      type: Boolean,
      default: () => false,
    },
  },
  components: {
    ImageDialog,
  },
  computed: {
    // Untrusted peer content: size and declared dimensions are checked from the header BEFORE
    // the browser is asked to decode it (see utils/image-data-uri.ts).
    vetted() {
      return inspectImageDataUri(this.image, DELIVERED_IMAGE_LIMITS)
    },
    reasonText(): string {
      const v = this.vetted
      if (v.ok) return ''
      const key = REASON_KEYS[v.reason]
      return key ? this.$t(`chatImage.${key}`) : v.reason
    },
  },
  setup() {
    const imageDialog = ref(false)
    return {
      showImageDialog() {
        imageDialog.value = true
      },
      imageDialog,
    }
  },
}
</script>
