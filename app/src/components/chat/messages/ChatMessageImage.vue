<template>
  <template v-if="isReply">
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
