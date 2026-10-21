<template>
  <q-page-container>
    <!-- Phone: /chat is the conversation list itself (the Messages tab), with the bottom bar;
    the drawer behind the header's menu button keeps contacts and channels. Wide: the list is
    already in the sidebar, so this pane only invites picking one. -->
    <q-page
      v-if="narrow && !opening"
      class="column no-wrap chat-list-page"
      :style-fn="pageStyle"
      data-testid="chat-list-page"
    >
      <chat-list :compact="false" class="col" />
    </q-page>
    <q-page v-else class="flex flex-center text-center q-pa-md">
      <!-- A conversation was clicked and is on its way: say so, not "select a conversation". -->
      <div
        v-if="opening"
        class="column items-center q-gutter-md"
        role="status"
        data-testid="chat-opening"
      >
        <q-spinner size="3rem" color="primary" />
        <div class="text-body2 chat-placeholder-muted">
          {{ $t('chatList.openingConversation') }}
        </div>
      </div>
      <div v-else class="column items-center q-gutter-md">
        <q-icon name="chat" size="4rem" color="primary" />
        <div class="text-h6 text-weight-medium">
          {{ $t('chatList.directMessages') }}
        </div>
        <div class="text-body2 chat-placeholder-muted" style="max-width: 360px">
          {{ $t('chatList.selectChatOrAddContact') }}
        </div>
        <q-btn
          color="primary"
          no-caps
          icon="person_add"
          :label="$t('newContactDialog.newContact')"
          @click="openAddContact"
        />
      </div>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { openPage } from 'src/utils/routes'
import { pendingChatRoute } from 'src/router/pending-chat'
import { isNarrowWidth, viewportPageStyle } from 'src/utils/layout'
import { getEffectiveScreenWidth } from 'src/utils/mobile-viewport-scale'
import ChatList from 'src/components/chat/ChatList.vue'

export default defineComponent({
  name: 'ChatPlaceholder',
  components: { ChatList },
  setup() {
    return { opening: computed(() => pendingChatRoute.value !== null) }
  },
  computed: {
    narrow(): boolean {
      const raw =
        this.$q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return isNarrowWidth(getEffectiveScreenWidth(raw))
    },
  },
  methods: {
    pageStyle: viewportPageStyle,
    openAddContact() {
      openPage(this.$router, '/add-contact')
    },
  },
})
</script>

<style lang="scss" scoped>
.chat-placeholder-muted {
  opacity: 0.7;
}
.chat-list-page {
  min-height: 0;
  overflow: hidden;
}
</style>
