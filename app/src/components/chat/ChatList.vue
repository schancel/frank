<template>
  <div class="full-width column col">
    <q-scroll-area class="q-px-none col">
      <q-list>
        <q-separator />
        <q-item>
          <q-item-section>
            <q-item-label>{{ $t('chatList.directMessages') }}</q-item-label>
          </q-item-section>
          <q-space />
          <q-btn
            dense
            flat
            icon="add"
            :aria-label="$t('a11y.addContact')"
            @click="() => openPage($router, '/add-contact')"
          />
        </q-item>
        <q-separator />

        <template v-if="$status.setup">
          <chat-list-item
            v-for="contact in getSortedChatOrder"
            :key="contact.address"
            :chat-address="contact.address"
            :value-unread="formatAmount(contact.totalUnreadValue)"
            :num-unread="contact.totalUnreadMessages"
            :compact="compact"
            @click="setActiveChat(contact.address)"
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
import { useChatStore } from '../../stores/chats'

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
      setActiveChat(address: string) {
        openChat(router, address)
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
  color: #f0409b;
}
</style>
