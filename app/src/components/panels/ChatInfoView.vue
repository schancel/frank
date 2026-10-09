<template>
  <q-page-container>
    <q-page class="chat-page-background">
      <div
        class="column items-center q-py-lg q-px-md"
        data-test="contact-profile-card"
      >
        <q-avatar
          size="96px"
          rounded
          :style="contactColorStyle"
          data-test="info-contact-avatar"
        >
          <img :src="profileAvatar(contact?.profile?.avatar, address)" />
        </q-avatar>
        <div
          class="text-h6 q-mt-md"
          :style="contactNameColorStyle"
          data-test="info-contact-name"
        >
          {{ contact?.profile?.name || $t('chatRightDrawer.unknownContact') }}
        </div>
        <div
          v-if="contact?.profile?.username"
          class="text-subtitle2 text-grey-7 q-mt-xs"
          data-test="info-contact-username"
        >
          @{{ formattedUsername }}
        </div>
        <div
          v-if="contact?.profile?.bio"
          class="text-body2 text-grey-7 q-mt-xs text-center"
          style="max-width: 400px"
          data-test="info-contact-bio"
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
          data-test="info-contact-address"
          :aria-label="$t('a11y.copyAddress')"
          @click="copyAddress()"
        />
        <div
          v-if="contactLinks.length > 0"
          class="q-mt-sm row q-gutter-xs justify-center items-center"
          data-test="info-contact-links"
        >
          <q-btn
            v-for="(link, index) in contactLinks"
            :key="index"
            flat
            dense
            no-caps
            size="sm"
            color="primary"
            :icon="getLinkIcon(link.type)"
            :label="link.label || link.url"
            :href="formatLinkUrl(link.url)"
            target="_blank"
            type="a"
            class="text-caption"
            data-test="info-contact-link-item"
          />
        </div>
        <div class="q-mt-md">
          <q-btn
            color="primary"
            rounded
            no-caps
            icon="chat"
            :label="$t('chat.sendMessage') || $t('chatList.directMessages')"
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

        <q-item
          clickable
          v-ripple
          :disable="!conversationId"
          @click="confirmClearOpen = !!conversationId"
        >
          <q-item-section avatar>
            <q-icon name="clear_all" />
          </q-item-section>
          <q-item-section>{{
            $t('chatRightDrawer.clearHistory')
          }}</q-item-section>
        </q-item>

        <q-item
          clickable
          v-ripple
          :disable="!conversationId"
          @click="confirmDeleteOpen = !!conversationId"
        >
          <q-item-section avatar>
            <q-icon name="delete" color="negative" />
          </q-item-section>
          <q-item-section class="text-negative">
            {{ $t('chatRightDrawer.deleteChat') }}
          </q-item-section>
        </q-item>
      </q-list>

      <q-dialog v-model="confirmClearOpen">
        <clear-history-dialog
          :address="conversationId"
          :name="contact?.profile?.name ?? ''"
        />
      </q-dialog>
      <q-dialog v-model="confirmDeleteOpen">
        <delete-chat-dialog
          :address="conversationId"
          :name="contact?.profile?.name ?? ''"
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
    conversationId: { type: String, default: '' },
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
    formattedUsername(): string {
      const u = this.contact?.profile?.username
      if (!u) return ''
      return u.startsWith('@') ? u.slice(1) : u
    },
    contactLinks(): Array<{ type: string; url: string; label?: string }> {
      const links = this.contact?.profile?.links
      return Array.isArray(links) ? links.filter(l => Boolean(l && l.url)) : []
    },
    // Same spoofing/impersonation cue as ChatLayout.vue's own header -- see that file's header
    // comment on `contactColorStyle` for the full "why."
    contactColorStyle() {
      const pubKey = this.contact?.profile?.pubKey
      if (!pubKey) return {}
      return { boxShadow: `0 0 0 3px ${pubKeyToColor(pubKey.toBuffer())}` }
    },
    contactNameColorStyle() {
      const pubKey = this.contact?.profile?.pubKey
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
    getLinkIcon(type: string): string {
      switch (type) {
        case 'website':
          return 'language'
        case 'github':
          return 'code'
        case 'x':
          return 'tag'
        case 'telegram':
          return 'send'
        case 'discord':
          return 'chat'
        default:
          return 'link'
      }
    },
    formatLinkUrl(url: string): string {
      if (!url) return '#'
      if (/^https?:\/\//i.test(url)) return url
      return `https://${url}`
    },
  },
})
</script>
