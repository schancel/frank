<template>
  <q-card>
    <q-card-section class="row items-center">
      <q-avatar icon="delete" color="red" text-color="white" />
      <span class="q-ml-sm">{{ $t('deleteMessageDialog.message') }}</span>
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('deleteMessageDialog.cancel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :label="$t('deleteMessageDialog.delete')"
        color="primary"
        v-close-popup
        @click="deleteMessageBoth()"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { useChatStore } from 'src/stores/chats'
import { errorNotify } from 'src/utils/notifications'
import { defineComponent } from 'vue'

export default defineComponent({
  setup() {
    const chatStore = useChatStore()
    return {
      chatStore,
      deleteMessage: chatStore.deleteMessage,
    }
  },
  props: {
    address: {
      type: String,
      required: true,
    },
    payloadDigest: {
      type: String,
      required: true,
    },
    index: {
      type: Number,
      required: true,
    },
  },
  methods: {
    /** Deletes the message: its content goes, a tombstone stays so the relay cannot bring it
     * back. No money moves; what the message brought stays in the wallet's coin list. */
    async deleteMessageBoth() {
      const message = this.chatStore.messages[this.payloadDigest]
      try {
        await this.deleteMessage({
          address: this.address,
          payloadDigest: this.payloadDigest,
          ...(message?.delivery?.attemptDigest
            ? { attemptDigest: message.delivery.attemptDigest }
            : {}),
        })
      } catch (err) {
        errorNotify(err)
      }
    },
  },
})
</script>
