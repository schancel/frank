<template>
  <q-page-container>
    <q-page class="flex flex-center text-center q-pa-md">
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
        <div class="text-body2 text-grey-7" style="max-width: 360px">
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

export default defineComponent({
  name: 'ChatPlaceholder',
  setup() {
    return { opening: computed(() => pendingChatRoute.value !== null) }
  },
  methods: {
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
</style>
