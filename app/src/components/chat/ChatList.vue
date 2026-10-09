<template>
  <div class="full-width column col">
    <q-scroll-area
      class="q-px-none col full-width"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item>
          <q-item-section>
            <q-item-label>{{ $t('chatList.directMessages') }}</q-item-label>
          </q-item-section>
          <q-space />
          <q-btn
            dense
            flat
            icon="mail"
            :aria-label="$t('a11y.composeEmail')"
            data-testid="compose-email-btn"
            @click="openComposeEmail"
          />
          <q-btn
            dense
            flat
            icon="add"
            :aria-label="$t('a11y.addContact')"
            data-testid="start-conversation-btn"
            @click="openAddContact"
          />
        </q-item>
        <q-separator />

        <template v-if="$status.setup">
          <chat-list-item
            v-for="conversation in getSortedChatOrder"
            :key="conversation.id || conversation.address"
            :conversation="conversation"
            :conversation-id="conversation.id"
            :conversation-name="conversation.name || conversation.topic"
            :participants="conversation.participants"
            :timestamp="
              conversation.lastReceived ||
              conversation.updatedAt ||
              conversation.createdAt
            "
            :chat-address="conversation.address || conversation.id"
            :value-unread="formatAmount(conversation.totalUnreadValue)"
            :num-unread="conversation.totalUnreadMessages"
            :compact="compact"
            @click="selectConversation(conversation)"
          />
        </template>

        <q-item v-if="getSortedChatOrder.length === 0 && $status.setup">
          <q-item-section>
            <q-item-label>{{ $t('chatList.noContactMessage') }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { storeToRefs } from 'pinia'

import ChatListItem from './ChatListItem.vue'
import { Conversation, useChatStore } from '../../stores/chats'

import { openChat, openPage } from '../../utils/routes'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'
import { isNarrowWidth } from '../../utils/layout'
import { activeChain } from '@frank/wallet/chain'

export default defineComponent({
  emits: ['closeDrawer'],
  setup(props, { emit }) {
    const chatStore = useChatStore()
    const { getSortedChatOrder } = storeToRefs(chatStore)

    const router = useRouter()
    const $q = useQuasar()
    return {
      getSortedChatOrder,
      openPage,
      openAddContact() {
        const from =
          router.currentRoute?.value?.fullPath ||
          router.currentRoute?.value?.path ||
          ''
        const target = from.startsWith('/chat')
          ? `/add-contact?mode=conversation&from=${encodeURIComponent(from)}`
          : '/add-contact?mode=conversation'
        openPage(router, target)
      },
      openComposeEmail() {
        const from =
          router.currentRoute?.value?.fullPath ||
          router.currentRoute?.value?.path ||
          ''
        const target = from.startsWith('/chat')
          ? `/add-contact?compose=email&from=${encodeURIComponent(from)}`
          : '/add-contact?compose=email'
        openPage(router, target)
      },
      selectConversation(item: Conversation | string) {
        const target = typeof item === 'string' ? item : item.id
        chatStore.setActiveConversation(target)
        openChat(router, target)
        // Direct user feedback (2026-09-29, ticket #123): on a narrow/mobile viewport the
        // drawer this list lives in is an overlay covering the whole chat -- selecting a chat
        // used to leave that overlay open on top of the chat it just navigated to, so the chat
        // was unusable until the user separately dismissed the drawer. Same shared threshold
        // as MainLayout.vue's drawer (`utils/layout`). Desktop (>800px) never emits this: the
        // sidebar is meant to stay open there.
        if (isNarrowWidth($q.screen.width)) {
          emit('closeDrawer')
        }
      },
      setActiveChat(item: Conversation | string) {
        return this.selectConversation(item)
      },
      formatAmount(amount?: number) {
        if (!amount) {
          return
        }
        return `${activeChain.toDisplayAmount(BigInt(Math.trunc(amount)))} ${
          activeChain.unit
        }`
      },
    }
  },
  props: {
    compact: {
      type: Boolean,
      required: true,
    },
  },
  components: {
    ChatListItem,
  },
})
</script>

<style lang="scss" scoped>
.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: var(--q-primary);
}
</style>
