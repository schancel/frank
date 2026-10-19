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
        @click="$emit('cancel')"
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
import { type Conversation, useChatStore } from 'src/stores/chats'
import { defineComponent, type PropType } from 'vue'
import { accountSession } from 'src/accounts/session'
import { toChainDisplayAddress } from 'src/utils/chain-address'

export default defineComponent({
  emits: ['cancel', 'deleted'],
  setup() {
    const chatStore = useChatStore()
    return {
      chatStore,
      deleteChat: chatStore.deleteChat,
    }
  },
  props: {
    afterDelete: {
      type: Function as PropType<(conversationId: string) => void>,
      required: true,
    },
    address: {
      type: String,
      default: () => '',
    },
    name: {
      type: String,
      default: () => '',
    },
  },
  // Consumers navigate only after this confirmed deletion, retaining its canonical identity.
  methods: {
    async onDelete() {
      // Capture completion before awaiting: the filtered list can unmount this dialog.
      const afterDelete = this.afterDelete
      const target = this.address
      let conversation: Conversation | undefined =
        this.chatStore.conversations[target]
      if (!conversation) {
        try {
          conversation = this.chatStore.chats[toChainDisplayAddress(target)]
        } catch {
          return
        }
      }
      if (!conversation) return
      const id = conversation.id
      const { revision, account } = accountSession.state
      const conversations = this.chatStore.conversations
      await this.deleteChat(id)
      if (
        accountSession.state.revision !== revision ||
        accountSession.state.account !== account ||
        this.chatStore.conversations !== conversations
      )
        return
      afterDelete(id)
      this.$emit('deleted', id)
    },
  },
})
</script>
