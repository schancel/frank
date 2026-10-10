<template>
  <q-card>
    <q-card-section class="row items-center">
      <q-avatar icon="delete" color="red" text-color="white" />
      <span class="q-ml-sm"
        >{{ $t('deleteChatDialog.message') }} {{ name }}?</span
      >
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('deleteChatDialog.cancel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :label="$t('deleteChatDialog.delete')"
        color="negative"
        v-close-popup
        @click="onDelete"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { useChatStore } from 'src/stores/chats'
import { notifyDeleteFailure } from 'src/utils/sweep-on-delete'
import { defineComponent } from 'vue'

export default defineComponent({
  setup() {
    const chatStore = useChatStore()
    return {
      deleteChat: chatStore.deleteChat,
    }
  },
  props: {
    address: {
      type: String,
      default: () => '',
    },
    name: {
      type: String,
      default: () => '',
    },
  },
  // ChatInfoView.vue listens for this to navigate away -- once this chat is deleted, staying on
  // its now-dangling Info view (or its now-gone chat route) isn't a valid state to sit in.
  emits: ['deleted'],
  methods: {
    async onDelete() {
      try {
        await this.deleteChat(this.address)
      } catch (err) {
        // Messages whose money could not be moved to the wallet stay, so the chat stays.
        notifyDeleteFailure(err)
        return
      }
      this.$emit('deleted')
    },
  },
})
</script>
