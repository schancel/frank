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
      <div class="row items-center no-wrap justify-between">
        <q-item-label lines="1" class="text-weight-medium text-body2">{{
          subjectOrName
        }}</q-item-label>
        <q-item-label
          caption
          v-if="formattedTimestamp"
          class="text-caption text-grey-6 q-ml-xs text-no-wrap"
          data-testid="chat-timestamp"
        >
          {{ formattedTimestamp }}
        </q-item-label>
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
    <q-item-section v-show="!compact" side>
      <q-badge
        v-if="!!effectiveValueUnread"
        color="primary"
        :label="effectiveValueUnread"
        class="q-my-xs"
      />
      <q-badge
        v-if="!!effectiveNumUnread"
        color="secondary"
        :label="effectiveNumUnread"
        class="q-my-xs"
      />
    </q-item-section>
  </q-item>
</template>

<script lang="ts">
import { type Conversation, useChatStore } from 'src/stores/chats'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { defineComponent, type PropType } from 'vue'
import { profileAvatar } from 'src/utils/avatar'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'
import { formatConversationTimestamp } from 'src/utils/formatting'
import { toChainDisplayAddress } from 'src/utils/chain-address'

export default defineComponent({
  setup() {
    const contacts = useContactStore()
    const chats = useChatStore()
    const myProfile = useProfileStore()

    return {
      getContactProfile: contacts.getContactProfile,
      getLatestMessage: chats.getLatestMessage,
      chatStore: chats,
      chats,
      myProfile,
      profileAvatar,
      ownAddress: useReactiveOwnCanonicalAddress(),
    }
  },
  methods: {
    formatParticipant(address: string): string {
      if (sameCanonicalAddress(address, this.ownAddress)) {
        return this.$t('selfChat.you')
      }
      const profile = this.getContactProfile(address)
      if (profile?.name) {
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
    displayParticipants(): string[] {
      return this.effectiveParticipants.slice(0, 3)
    },
    remainingParticipantsCount(): number {
      return Math.max(0, this.effectiveParticipants.length - 3)
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
    contactName(): string {
      if (
        this.effectiveAddress &&
        sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
      ) {
        return this.$t('selfChat.you')
      }
      return this.contact?.name ?? (this.effectiveAddress || this.effectiveId)
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
      const activeParam = this.$route?.params?.address
      if (
        activeParam &&
        (activeParam === this.effectiveAddress ||
          activeParam === this.effectiveId)
      ) {
        return true
      }
      const store = this.chatStore as
        | {
            activeConversationId?: string | null
            activeChatAddr?: string | null
          }
        | undefined
      if (
        store?.activeConversationId &&
        store.activeConversationId === this.effectiveId
      ) {
        return true
      }
      if (
        store?.activeChatAddr &&
        store.activeChatAddr === this.effectiveAddress
      ) {
        return true
      }
      return false
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
