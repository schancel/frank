<template>
  <q-item :active="isActive" active-class="active-chat-list-item" clickable>
    <q-item-section avatar v-if="$status.setup" side>
      <q-avatar rounded>
        <img :src="profileAvatar(presentedAvatar, effectiveAddress)" />
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
      <div class="row items-center no-wrap ellipsis">
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
          >{{ subjectOrName }}</q-item-label
        >
        <account-badge
          v-if="effectiveAddress && !conversation?.topic"
          :address="effectiveAddress"
          :name="subjectOrName"
          :account-type="targetProfile?.accountType"
          :bot-role="targetProfile?.botRole"
          :is-bot="targetProfile?.isBot"
        />
      </div>
      <div
        class="row items-center q-gutter-xs q-my-none participant-badges"
        v-if="displayParticipants.length > 0"
      >
        <q-badge
          v-for="p in displayParticipants"
          :key="p"
          outline
          color="primary"
          class="text-caption participant-badge"
          :label="formatParticipant(p)"
        />
        <q-badge
          v-if="remainingParticipantsCount > 0"
          outline
          color="grey-6"
          class="text-caption remaining-badge"
          :label="`+${remainingParticipantsCount}`"
        />
      </div>
      <q-item-label caption lines="2">{{ latestMessageBody }}</q-item-label>
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
        :name="subjectOrName"
        @deleted="onChatDeleted"
      />
    </q-dialog>
  </q-item>
</template>

<script lang="ts">
import { type Conversation, useChatStore } from 'src/stores/chats'
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
    formatParticipant(address: string): string {
      if (sameCanonicalAddress(address, this.ownAddress)) {
        return this.$t('selfChat.you')
      }
      const profile = this.getContactProfile(address)
      if (profile?.name && profile.name !== 'Loading...') {
        return profile.name
      }
      try {
        const display = toChainDisplayAddress(address)
        if (display.length > 12) {
          return `${display.slice(0, 6)}...${display.slice(-4)}`
        }
        return display
      } catch {
        if (address.length > 12) {
          return `${address.slice(0, 6)}...${address.slice(-4)}`
        }
        return address
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
    effectiveParticipants(): string[] {
      if (
        this.conversation?.participants &&
        this.conversation.participants.length > 0
      ) {
        return this.conversation.participants
      }
      if (this.participants && this.participants.length > 0) {
        return this.participants
      }
      if (this.effectiveAddress) {
        return [this.effectiveAddress]
      }
      return []
    },
    otherParticipants(): string[] {
      return this.effectiveParticipants.filter(
        p => !sameCanonicalAddress(p, this.ownAddress),
      )
    },
    displayParticipants(): string[] {
      if (
        this.otherParticipants.length <= 1 &&
        !this.conversation?.topic &&
        !this.conversationName
      ) {
        return []
      }
      return this.otherParticipants.slice(0, 3)
    },
    remainingParticipantsCount(): number {
      if (
        this.otherParticipants.length <= 1 &&
        !this.conversation?.topic &&
        !this.conversationName
      ) {
        return 0
      }
      return Math.max(0, this.otherParticipants.length - 3)
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
    subjectOrName(): string {
      if (this.effectiveName) {
        return this.effectiveName
      }
      return this.contactName
    },
    latestMessageBody(): string {
      const target =
        this.effectiveId || this.effectiveAddress || this.chatAddress
      const info = target ? this.getLatestMessage(target) : null
      if (info === null || !info) {
        return ''
      }
      const slicedText = info.text
        .split(' ')
        .map(word => word.slice(0, 15))
        .join(' ')
      return this.$t(
        info.outbound ? 'chatList.youPrefix' : 'chatList.themPrefix',
        { text: slicedText },
      )
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
