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
import { sweepMessageFundsOnDelete } from 'src/utils/sweep-on-delete'
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
    async deleteMessageBoth() {
      const message =
        this.chatStore.messages[this.payloadDigest] ||
        (typeof this.chatStore.getMessageByPayload === 'function'
          ? this.chatStore.getMessageByPayload(this.payloadDigest)
          : undefined) ||
        Object.values(this.chatStore.conversations ?? {})
          .flatMap(c => c?.messages ?? [])
          .find(m => m?.payloadDigest === this.payloadDigest) ||
        Object.values(this.chatStore.chats ?? {})
          .flatMap(c => c?.messages ?? [])
          .find(m => m?.payloadDigest === this.payloadDigest)

      // 1. Sweep funds of message into ephemeral change accounts before deleting (inbound messages only)
      if (message && !message.outbound) {
        try {
          await sweepMessageFundsOnDelete({
            message,
            relayClient: this.$relayClient,
          })
        } catch (sweepErr) {
          console.error(
            'Failed to sweep message funds prior to delete:',
            sweepErr,
          )
        }
      }

      // 2. Delete message from relay server if relay client is available and message is inbound
      if (
        message &&
        !message.outbound &&
        !this.payloadDigest.startsWith('pending:') &&
        this.$relayClient &&
        typeof this.$relayClient.deleteMessage === 'function'
      ) {
        try {
          await this.$relayClient.deleteMessage(this.payloadDigest)
        } catch (err: any) {
          console.error('Failed to delete message on relay:', err)
          if (err.response) {
            console.error(err.response)
          }
        }
      }

      // 3. Delete message locally
      try {
        await this.deleteMessage({
          address: this.address,
          payloadDigest: this.payloadDigest,
          ...(message?.delivery?.attemptDigest
            ? { attemptDigest: message.delivery.attemptDigest }
            : {}),
        })
      } catch (err: any) {
        console.error('Failed to delete message locally:', err)
      }
    },
  },
})
</script>
