<template>
  <div v-if="!vetted.ok" class="text-caption text-grey q-pa-sm">
    Image not shown ({{ vetted.reason }})
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
