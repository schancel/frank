<template>
  <q-page-container>
    <q-page class="chat-page-background">
      <div class="column items-center q-py-lg q-px-md">
        <q-avatar size="96px" rounded :style="contactColorStyle">
          <img :src="profileAvatar(contact?.profile?.avatar, address)" />
        </q-avatar>
        <div class="text-h6 q-mt-md" :style="contactNameColorStyle">
          {{ contact?.profile?.name || $t('chatRightDrawer.unknownContact') }}
        </div>
        <div
          v-if="contact?.profile?.bio"
          class="text-body2 text-grey-7 q-mt-xs text-center"
          style="max-width: 400px"
        >
          {{ contact.profile.bio }}
        </div>
        <q-btn
          flat
          dense
          no-caps
          icon="file_copy"
          :label="displayAddress"
          class="text-caption q-mt-xs"
          @click="copyAddress()"
        />
        <div class="q-mt-md">
          <q-btn
            color="primary"
            rounded
            no-caps
            icon="chat"
            :label="$t('chatList.directMessages')"
            data-test="info-start-chat"
            @click="$emit('chat')"
          />
        </div>
      </div>

      <q-separator />

      <q-list padding>
        <q-item clickable v-ripple @click="notifications = !notifications">
          <q-item-section avatar>
            <q-icon name="notifications_none" />
          </q-item-section>
          <q-item-section>
            {{ $t('chatRightDrawer.notifications') }}
          </q-item-section>
          <q-item-section side>
            <q-toggle
              v-model="notifications"
              :aria-label="$t('chatRightDrawer.notifications')"
            />
          </q-item-section>
        </q-item>

        <q-separator spaced inset />

        <q-item clickable v-ripple @click="confirmClearOpen = true">
          <q-item-section avatar>
            <q-icon name="clear_all" />
          </q-item-section>
          <q-item-section>{{
            $t('chatRightDrawer.clearHistory')
          }}</q-item-section>
        </q-item>

        <q-item clickable v-ripple @click="confirmDeleteOpen = true">
          <q-item-section avatar>
            <q-icon name="delete" color="negative" />
          </q-item-section>
          <q-item-section class="text-negative">
            {{ $t('chatRightDrawer.deleteChat') }}
          </q-item-section>
        </q-item>
      </q-list>

      <q-dialog v-model="confirmClearOpen">
        <clear-history-dialog :address="address" :name="contact.profile.name" />
      </q-dialog>
      <q-dialog v-model="confirmDeleteOpen">
        <delete-chat-dialog
          :address="address"
          :name="contact.profile.name"
          @deleted="$emit('deleted')"
        />
      </q-dialog>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { copyToClipboard } from 'quasar'

import ClearHistoryDialog from '../dialogs/ClearHistoryDialog.vue'
import DeleteChatDialog from '../dialogs/DeleteChatDialog.vue'
import { useContactStore } from 'src/stores/contacts'
import { activeChain } from '@frank/wallet/chain'
import { pubKeyToColor } from 'src/utils/formatting'
import { profileAvatar } from 'src/utils/avatar'
import { addressCopiedNotify } from '../../utils/notifications'

/**
 * The full-pane "Info" view for a chat -- replaces `ChatRightDrawer.vue`'s narrow side drawer
 * (direct user feedback: a contact's info deserves the same amount of screen space a chat itself
 * gets, not a cramped sidebar squeezed in next to it). `ChatLayout.vue` swaps this in for
 * `<router-view>` entirely rather than rendering both side by side -- see that file's own
 * `infoOpen` state.
 */
export default defineComponent({
  name: 'ChatInfoView',
  components: {
    ClearHistoryDialog,
    DeleteChatDialog,
  },
  emits: ['deleted', 'chat'],
  setup() {
    const contactStore = useContactStore()
    return {
      setNotify: contactStore.setNotify,
      getNotify: contactStore.getNotify,
      profileAvatar,
    }
  },
  props: {
    address: {
      type: String,
      default: () => '',
    },
    contact: {
      type: Object,
      default: () => ({
        profile: { name: '', avatar: '', pubKey: null },
      }),
    },
  },
  data() {
    return {
      confirmClearOpen: false,
      confirmDeleteOpen: false,
    }
  },
  computed: {
    notifications: {
      get(): boolean {
        return this.getNotify(this.address) ?? false
      },
      set(value: string) {
        this.setNotify({ address: this.address, value: Boolean(value) })
      },
    },
    displayAddress(): string {
      const parsed = activeChain.parseAddress(this.address)
      return parsed ? activeChain.formatAddress(parsed) : this.address
    },
    // Same spoofing/impersonation cue as ChatLayout.vue's own header -- see that file's header
    // comment on `contactColorStyle` for the full "why."
    contactColorStyle() {
      const pubKey = this.contact.profile?.pubKey
      if (!pubKey) return {}
      return { boxShadow: `0 0 0 3px ${pubKeyToColor(pubKey.toBuffer())}` }
    },
    contactNameColorStyle() {
      const pubKey = this.contact.profile?.pubKey
      if (!pubKey) return {}
      return { color: pubKeyToColor(pubKey.toBuffer()) }
    },
  },
  methods: {
    copyAddress() {
      copyToClipboard(this.displayAddress)
        .then(() => addressCopiedNotify())
        .catch(() => {
          // fail
        })
    },
  },
})
</script>
