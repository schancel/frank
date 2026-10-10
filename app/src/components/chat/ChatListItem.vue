<template>
  <q-item :active="isActive" active-class="active-chat-list-item" clickable>
    <q-item-section avatar v-if="$status.setup" side>
      <q-avatar
        rounded
        :color="isGroup ? 'primary' : undefined"
        :text-color="isGroup ? 'white' : undefined"
        :icon="isGroup ? 'group' : undefined"
      >
        <img
          v-if="!isGroup"
          :src="profileAvatar(presentedAvatar, effectiveAddress)"
        />
        <q-badge
          v-show="compact"
          v-if="!!effectiveNumUnread"
          floating
          color="secondary"
          :label="effectiveNumUnread"
          class="q-my-xs"
        />
      </q-avatar>
    </q-item-section>
    <q-item-section v-show="!compact">
      <!-- The name keeps its line; a badge that does not fit beside it moves under it instead of
      running over the time and unread count. -->
      <div class="chat-list-title" data-testid="chat-list-title">
        <q-icon
          v-if="isEmail && isVerifiedGateway"
          name="mail"
          size="15px"
          color="primary"
          class="q-mr-xs"
          data-testid="verified-email-icon"
        />
        <q-icon
          v-else-if="isEmail && !isVerifiedGateway"
          name="warning"
          size="15px"
          color="warning"
          class="q-mr-xs"
          data-testid="unverified-email-icon"
        />
        <q-badge
          v-if="isEmail && !isVerifiedGateway"
          color="warning"
          text-color="dark"
          outline
          class="q-mr-xs text-caption"
          data-testid="unverified-email-badge"
        >
          P2P
        </q-badge>
        <q-item-label
          lines="1"
          class="text-weight-medium text-body2 ellipsis"
          >{{ titleName }}</q-item-label
        >
        <account-badge
          v-if="effectiveAddress && !conversation?.topic && !isGroup"
          :address="effectiveAddress"
          :name="titleName"
          :account-type="targetProfile?.accountType"
          :bot-role="targetProfile?.botRole"
          :is-bot="targetProfile?.isBot"
        />
      </div>
      <!-- The subject tells two conversations with one peer apart; none, no line. -->
      <q-item-label
        v-if="subject"
        lines="1"
        class="text-caption text-weight-medium chat-list-subject"
        data-testid="chat-list-subject"
        >{{ subject }}</q-item-label
      >
      <q-item-label caption lines="2" class="chat-list-preview">{{
        latestMessageBody
      }}</q-item-label>
    </q-item-section>
    <q-item-section
      v-show="!compact"
      side
      class="column items-end justify-start q-gutter-xs"
    >
      <q-item-label
        caption
        v-if="formattedTimestamp"
        class="text-caption text-grey-6 text-no-wrap"
        data-testid="chat-timestamp"
      >
        {{ formattedTimestamp }}
      </q-item-label>
      <q-badge
        v-if="!!effectiveNumUnread"
        rounded
        color="secondary"
        :label="effectiveNumUnread"
      />
    </q-item-section>

    <!-- Right-click contextual menu -->
    <q-menu touch-position context-menu>
      <q-list dense style="min-width: 160px">
        <q-item clickable v-close-popup @click="openConversation">
          <q-item-section avatar>
            <q-icon name="chat" size="xs" />
          </q-item-section>
          <q-item-section>{{ $t('chatListMenu.openChat') }}</q-item-section>
        </q-item>
        <q-item
          v-if="effectiveAddress"
          clickable
          v-close-popup
          @click="viewProfile"
        >
          <q-item-section avatar>
            <q-icon name="person" size="xs" />
          </q-item-section>
          <q-item-section>{{ $t('chatListMenu.viewProfile') }}</q-item-section>
        </q-item>
        <q-item
          v-if="effectiveAddress"
          clickable
          v-close-popup
          @click="copyAddress"
        >
          <q-item-section avatar>
            <q-icon name="content_copy" size="xs" />
          </q-item-section>
          <q-item-section>{{ $t('chatListMenu.copyAddress') }}</q-item-section>
        </q-item>
        <q-separator v-if="effectiveAddress && hasNotifyToggle" />
        <q-item
          v-if="effectiveAddress && hasNotifyToggle"
          clickable
          v-close-popup
          @click="toggleNotify"
        >
          <q-item-section avatar>
            <q-icon
              :name="isMuted ? 'notifications' : 'notifications_off'"
              size="xs"
            />
          </q-item-section>
          <q-item-section>
            {{ isMuted ? $t('chatListMenu.unmute') : $t('chatListMenu.mute') }}
          </q-item-section>
        </q-item>
        <q-separator />
        <q-item
          clickable
          v-close-popup
          @click="deleteDialogOpen = true"
          class="text-negative"
        >
          <q-item-section avatar>
            <q-icon name="delete" size="xs" color="negative" />
          </q-item-section>
          <q-item-section>{{ $t('chatListMenu.deleteChat') }}</q-item-section>
        </q-item>
      </q-list>
    </q-menu>

    <!-- Delete Chat Confirmation Dialog -->
    <q-dialog v-model="deleteDialogOpen">
      <delete-chat-dialog
        :address="effectiveId"
        :name="rowLabel"
        @deleted="onChatDeleted"
      />
    </q-dialog>
  </q-item>
</template>

<script lang="ts">
import { type Conversation, useChatStore } from 'src/stores/chats'
import { picturePreviewText } from '../../utils/chat-attachments'
import { markdownPlainText } from '../../utils/markdown-plain-text'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { defineComponent, ref, type PropType } from 'vue'
import { copyToClipboard } from 'quasar'
import { profileAvatar } from 'src/utils/avatar'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'
import { formatConversationTimestamp } from 'src/utils/formatting'
import { isChainAddress, toChainDisplayAddress } from 'src/utils/chain-address'
import { openChat, openContactProfile } from 'src/utils/routes'
import { addressCopiedNotify } from 'src/utils/notifications'
import AccountBadge from 'src/components/contacts/AccountBadge.vue'
import {
  conversationSenders,
  isGroupConversation,
  senderOf,
  type SenderIdentity,
} from 'src/utils/chat-attribution'
import DeleteChatDialog from '../dialogs/DeleteChatDialog.vue'

export default defineComponent({
  components: {
    AccountBadge,
    DeleteChatDialog,
  },
  setup() {
    const contacts = useContactStore()
    const chats = useChatStore()
    const myProfile = useProfileStore()
    const deleteDialogOpen = ref(false)

    return {
      getContactProfile: contacts.getContactProfile,
      getLatestMessage: chats.getLatestMessage,
      chatStore: chats,
      contacts,
      chats,
      myProfile,
      deleteDialogOpen,
      profileAvatar,
      ownAddress: useReactiveOwnCanonicalAddress(),
    }
  },
  methods: {
    openConversation() {
      const target = this.effectiveId
      this.chatStore.setActiveConversation(target)
      if (this.$router) {
        openChat(this.$router, target)
      }
    },
    viewProfile() {
      if (!this.effectiveAddress) return
      if (this.$router) {
        openContactProfile(this.$router, this.effectiveAddress)
      }
    },
    copyAddress() {
      if (!this.effectiveAddress) return
      copyToClipboard(this.effectiveAddress)
        .then(() => {
          addressCopiedNotify()
        })
        .catch(() => {
          // copy failed
        })
    },
    toggleNotify() {
      if (!this.effectiveAddress) return
      const current = this.contacts.getNotify?.(this.effectiveAddress) ?? true
      this.contacts.setNotify?.({
        address: this.effectiveAddress,
        value: !current,
      })
    },
    onChatDeleted() {
      this.deleteDialogOpen = false
      if (this.isActive && this.$router) {
        this.$router.push('/chat')
      }
    },
  },
  computed: {
    isMuted(): boolean {
      if (!this.effectiveAddress) return false
      return (
        (this.contacts.getNotify?.(this.effectiveAddress) ?? true) === false
      )
    },
    hasNotifyToggle(): boolean {
      return Boolean(
        this.effectiveAddress &&
          isChainAddress(this.effectiveAddress) &&
          !sameCanonicalAddress(this.effectiveAddress, this.ownAddress),
      )
    },
    isEmail(): boolean {
      return this.conversation?.kind === 'email'
    },
    isVerifiedGateway(): boolean {
      return this.conversation?.verifiedGateway === true
    },
    effectiveAddress(): string {
      return (
        this.conversation?.address ||
        this.chatAddress ||
        this.conversation?.participants?.[0] ||
        ''
      )
    },
    effectiveId(): string {
      return (
        this.conversation?.id || this.conversationId || this.effectiveAddress
      )
    },
    effectiveName(): string {
      return (
        this.conversation?.name ||
        this.conversation?.topic ||
        this.conversationName ||
        ''
      )
    },
    /** More than two people: the row names them all and says who wrote the last message. */
    isGroup(): boolean {
      return isGroupConversation(
        this.conversation?.participants ?? this.participants,
        this.ownAddress,
        this.conversation?.address,
      )
    },
    /** Everyone but this user, as they are named in the chat itself. */
    senders(): Map<string, SenderIdentity> {
      if (!this.isGroup) return new Map()
      return conversationSenders(
        this.conversation ?? { participants: this.participants },
        this.ownAddress,
        this.contacts,
      )
    },
    effectiveNumUnread(): number {
      return this.numUnread || this.conversation?.totalUnreadMessages || 0
    },
    effectiveValueUnread(): string {
      return this.valueUnread || ''
    },
    formattedTimestamp(): string {
      const ts =
        this.timestamp ||
        this.conversation?.lastReceived ||
        this.conversation?.updatedAt ||
        this.conversation?.createdAt ||
        0
      if (!ts) return ''
      return formatConversationTimestamp(ts)
    },
    /** An email thread is titled by its subject. Any other conversation is titled by its
     * peer, with the subject (if it has one) on its own line under the name. */
    titleName(): string {
      if (this.subjectIsTitle && this.effectiveName) return this.effectiveName
      if (this.isGroup) {
        // In this user's own notes the others are listed after "You", never instead of it.
        const names = Array.from(this.senders.values()).map(
          sender => sender.label,
        )
        if (sameCanonicalAddress(this.effectiveAddress, this.ownAddress))
          names.unshift(this.$t('selfChat.you'))
        return names.join(', ')
      }
      return this.contactName
    },
    /** With no peer to name (or an email thread), the subject is the title itself. */
    subjectIsTitle(): boolean {
      return this.isEmail || !isChainAddress(this.effectiveAddress)
    },
    subject(): string {
      return this.subjectIsTitle ? '' : this.effectiveName.trim()
    },
    rowLabel(): string {
      return this.subject
        ? `${this.titleName} \u2014 ${this.subject}`
        : this.titleName
    },
    latestMessageBody(): string {
      const target =
        this.effectiveId || this.effectiveAddress || this.chatAddress
      const info = target ? this.getLatestMessage(target) : null
      if (info === null || !info) {
        return ''
      }
      // The preview is plain text: the words of the message, without its Markdown syntax.
      const photoLabel = this.$t('chatImage.onePhoto')
      const plain = markdownPlainText(info.text, photoLabel)
      const previewText = info.photos
        ? picturePreviewText({ photos: info.photos, text: plain }, this.$t)
        : plain
      // Whole words: a long one wraps inside the row (`.chat-list-preview`) instead of being
      // cut at a fixed length, which read as a clipped word ("Rock-Paper-Scis").
      const slicedText = previewText
      if (info.outbound) {
        return this.$t('chatList.youPrefix', { text: slicedText })
      }
      // With several people, "them" does not say who.
      const sender = this.isGroup
        ? senderOf(this.senders, info.senderAddress ?? '')
        : undefined
      return sender
        ? this.$t('chatList.senderPrefix', {
            name: sender.label,
            text: slicedText,
          })
        : this.$t('chatList.themPrefix', { text: slicedText })
    },
    contact() {
      return this.effectiveAddress
        ? this.getContactProfile(this.effectiveAddress)
        : { name: '', avatar: undefined }
    },
    targetProfile() {
      if (
        this.effectiveAddress &&
        sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
      ) {
        return this.myProfile.profile
      }
      return this.contact
    },
    contactName(): string {
      if (
        this.effectiveAddress &&
        sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
      ) {
        return this.$t('selfChat.you')
      }
      const rawName = this.contact?.name
      if (!rawName || rawName === 'Loading...' || rawName.trim() === '') {
        const target = this.effectiveAddress || this.effectiveId
        try {
          const display = toChainDisplayAddress(target)
          return display.length > 12
            ? `${display.slice(0, 6)}...${display.slice(-4)}`
            : display
        } catch {
          return target.length > 12
            ? `${target.slice(0, 6)}...${target.slice(-4)}`
            : target
        }
      }
      return rawName
    },
    presentedAvatar(): string | undefined {
      if (
        this.effectiveAddress &&
        sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
      ) {
        return this.myProfile.profile.avatar || this.contact?.avatar
      }
      return this.contact?.avatar
    },
    isActive(): boolean {
      const activeId = this.chatStore.activeConversationId
      if (activeId) return activeId === this.effectiveId
      return this.$route?.params?.address === this.effectiveId
    },
  },
  props: {
    conversation: {
      type: Object as PropType<Conversation>,
      required: false,
    },
    conversationId: {
      type: String,
      required: false,
      default: '',
    },
    conversationName: {
      type: String,
      required: false,
      default: '',
    },
    participants: {
      type: Array as PropType<string[]>,
      required: false,
      default: () => [],
    },
    timestamp: {
      type: Number,
      required: false,
      default: 0,
    },
    chatAddress: {
      type: String,
      required: false,
      default: '',
    },
    numUnread: {
      type: Number,
      required: false,
      default: () => 0,
    },
    valueUnread: {
      type: String,
      required: false,
      default: () => '',
    },
    compact: {
      type: Boolean,
      required: true,
    },
  },
})
</script>

<style scoped>
/* Quasar's caption colour is a fixed dark grey, unreadable on the dark sidebar: follow the row. */
.chat-list-preview {
  color: inherit;
  opacity: 0.7;
  /* An unbroken run (an address, a link) breaks where it must; the row never grows sideways. */
  overflow-wrap: anywhere;
}

.chat-list-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
  min-width: 0;
  max-width: 100%;
}

.chat-list-title > * {
  min-width: 0;
  max-width: 100%;
}

/* The gap spaces the badges here; their own left margin would indent a wrapped one. */
.chat-list-title > :deep(.q-badge),
.chat-list-title > :deep(.q-icon) {
  margin-left: 0;
  margin-right: 0;
}

.chat-list-title > :deep(.q-badge) {
  overflow: hidden;
}
</style>
