<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <!-- Info is a full-pane swap (see `infoOpen` below), not a side drawer, so its own
        toolbar row is just a back arrow -- there's nothing else from the chat toolbar (avatar/
        name/overflow menu) that still applies once the chat itself isn't showing. -->
        <template v-if="infoOpen">
          <q-btn
            class="q-px-sm"
            flat
            dense
            icon="arrow_back"
            :aria-label="$t('a11y.closeInfo')"
            @click="closeInfo"
          />
          <q-toolbar-title class="h6">{{
            $t('chatLayout.infoTitle')
          }}</q-toolbar-title>
        </template>
        <!-- Select mode (see `chatSelectMode`'s `provide` below, and
        ChatMessageSuffixButtons.vue's own header) -- delete is only ever available here, never as
        an always-hoverable action on an ordinary message bubble. -->
        <template v-else-if="selectMode">
          <q-btn
            class="q-px-sm"
            flat
            dense
            icon="close"
            :aria-label="$t('a11y.exitSelectMode')"
            @click="selectMode = false"
          />
          <q-toolbar-title class="h6">{{
            $t('chatLayout.selectMessagesTitle')
          }}</q-toolbar-title>
        </template>
        <template v-else-if="!address">
          <q-btn
            class="q-px-sm"
            flat
            dense
            @click="() => $emit('toggleMyDrawerOpen')"
            icon="menu"
            :aria-label="$t('a11y.openNavigation')"
            :aria-expanded="myDrawerOpen"
          />
          <q-toolbar-title class="h6">{{
            $t('chatList.directMessages')
          }}</q-toolbar-title>
        </template>
        <template v-else>
          <q-btn
            class="q-px-sm"
            flat
            dense
            @click="() => $emit('toggleMyDrawerOpen')"
            icon="menu"
            :aria-label="$t('a11y.openNavigation')"
            :aria-expanded="myDrawerOpen"
          />
          <!-- Several people: no one person's picture or key colour stands for all of them. -->
          <q-avatar
            v-if="isGroup"
            rounded
            color="white"
            text-color="primary"
            icon="group"
            data-testid="chat-header-group-avatar"
          />
          <q-avatar v-else rounded :style="contactColorStyle">
            <img
              :src="profileAvatar(presentedAvatar, effectiveAddress || address)"
            />
          </q-avatar>
          <q-toolbar-title class="h6 chat-header-title">
            <!-- The name is in the header's own text colour: the per-key colour is a ring on
            the avatar, where it does not have to be read against the header bar. -->
            <div class="row items-center no-wrap">
              <span class="ellipsis" data-testid="chat-header-name">{{
                contactName
              }}</span>
              <account-badge
                v-if="
                  effectiveAddress && !activeConversation?.topic && !isGroup
                "
                :address="effectiveAddress"
                :account-type="targetProfile?.accountType"
                :bot-role="targetProfile?.botRole"
                :is-bot="targetProfile?.isBot"
              />
            </div>
            <!-- Under the name: how many people (only when more than two) and the subject of
            this conversation. Neither, no line. -->
            <div
              v-if="subject || isGroup"
              class="text-caption ellipsis chat-header-subject"
            >
              <span v-if="isGroup" data-testid="chat-header-participants">{{
                $t('chatLayout.participantCount', { count: participantCount })
              }}</span>
              <span v-if="isGroup && subject"> · </span>
              <span v-if="subject" data-testid="chat-header-subject">{{
                subject
              }}</span>
            </div>
          </q-toolbar-title>
          <q-space />
          <q-btn
            class="q-px-sm"
            flat
            dense
            icon="more_vert"
            :aria-label="$t('a11y.chatMenu')"
            aria-haspopup="menu"
            :aria-expanded="chatMenuOpen"
          >
            <q-menu
              anchor="bottom right"
              self="top right"
              @show="chatMenuOpen = true"
              @hide="chatMenuOpen = false"
            >
              <q-list style="min-width: 180px">
                <q-item clickable v-close-popup @click="openInfo">
                  <q-item-section avatar><q-icon name="info" /></q-item-section>
                  <q-item-section>{{ $t('chatLayout.info') }}</q-item-section>
                </q-item>
                <q-item
                  clickable
                  v-close-popup
                  @click="notifications = !notifications"
                >
                  <q-item-section avatar
                    ><q-icon
                      :name="
                        notifications ? 'notifications' : 'notifications_off'
                      "
                  /></q-item-section>
                  <q-item-section>{{
                    notifications
                      ? $t('chatLayout.mute')
                      : $t('chatLayout.unmute')
                  }}</q-item-section>
                </q-item>
                <q-item
                  v-if="activeConversation"
                  clickable
                  v-close-popup
                  data-testid="edit-conversation-subject"
                  @click="openSubjectEditor"
                >
                  <q-item-section avatar><q-icon name="edit" /></q-item-section>
                  <q-item-section>{{
                    $t('chatLayout.editSubject')
                  }}</q-item-section>
                </q-item>
                <q-item clickable v-close-popup @click="selectMode = true">
                  <q-item-section avatar
                    ><q-icon name="checklist"
                  /></q-item-section>
                  <q-item-section>{{
                    $t('chatLayout.selectMessages')
                  }}</q-item-section>
                </q-item>
                <q-separator />
                <q-item
                  clickable
                  v-close-popup
                  @click="confirmClearOpen = true"
                >
                  <q-item-section avatar
                    ><q-icon name="clear_all"
                  /></q-item-section>
                  <q-item-section>{{
                    $t('chatRightDrawer.clearHistory')
                  }}</q-item-section>
                </q-item>
                <q-item
                  clickable
                  v-close-popup
                  @click="confirmDeleteOpen = true"
                >
                  <q-item-section avatar
                    ><q-icon name="delete" color="negative"
                  /></q-item-section>
                  <q-item-section class="text-negative">{{
                    $t('chatRightDrawer.deleteChat')
                  }}</q-item-section>
                </q-item>
              </q-list>
            </q-menu>
          </q-btn>
        </template>
      </q-toolbar>
    </q-header>

    <q-dialog v-model="subjectEditorOpen" @hide="cancelSubjectEditor">
      <q-card>
        <q-card-section>
          <div class="text-h6">{{ $t('chatLayout.editSubject') }}</div>
          <q-input
            v-model="subjectDraft"
            :label="$t('chatLayout.subject')"
            data-testid="conversation-subject-input"
            autofocus
            @keydown.enter.prevent="saveSubject"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            flat
            :label="$t('chatLayout.cancelSubject')"
            data-testid="conversation-subject-cancel"
            @click="cancelSubjectEditor"
          />
          <q-btn
            color="primary"
            :label="$t('chatLayout.saveSubject')"
            data-testid="conversation-subject-save"
            @click="saveSubject"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="confirmClearOpen">
      <clear-history-dialog :address="address" :name="conversationLabel" />
    </q-dialog>
    <q-dialog v-model="confirmDeleteOpen">
      <delete-chat-dialog
        :address="address"
        :name="conversationLabel"
        @deleted="onChatDeleted"
      />
    </q-dialog>

    <!-- Full-pane swap, not a side-by-side layout -- direct user feedback: Info deserves the same
    amount of room a chat gets, and on a narrow/mobile viewport there's no room for both panes at
    once anyway, so a single view stack (never two panes fighting for space) is the one layout
    that already works at every width. -->
    <router-view v-if="!infoOpen" />
    <chat-info-view
      v-else
      :address="effectiveAddress || address"
      :conversation-id="activeConversation?.id"
      :contact="getContact(effectiveAddress || address)"
      @deleted="onChatDeleted"
      @chat="closeInfo"
    />
  </div>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { RouteLocationNormalized } from 'vue-router'

import ChatInfoView from '../components/panels/ChatInfoView.vue'
import ClearHistoryDialog from '../components/dialogs/ClearHistoryDialog.vue'
import DeleteChatDialog from '../components/dialogs/DeleteChatDialog.vue'
import AccountBadge from '../components/contacts/AccountBadge.vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { useContactStore } from 'src/stores/contacts'
import { useChatStore, type Conversation } from 'src/stores/chats'
import { useProfileStore } from 'src/stores/my-profile'
import { pubKeyToColor } from 'src/utils/formatting'
import { isChainAddress, toChainDisplayAddress } from 'src/utils/chain-address'
import { profileAvatar } from 'src/utils/avatar'
import {
  conversationSenders,
  isGroupConversation,
  otherParticipants,
} from 'src/utils/chat-attribution'
import {
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
} from 'src/utils/own-address'

export default defineComponent({
  emits: ['toggleMyDrawerOpen'],
  components: {
    ChatInfoView,
    ClearHistoryDialog,
    DeleteChatDialog,
    AccountBadge,
  },
  // `chatSelectMode`: read by ChatMessageSuffixButtons.vue (several component layers below,
  // reached through `<router-view>`'s Chat.vue/ChatMessage.vue/ChatMessageSuffix.vue -- provide/
  // inject skips having to thread a prop through all of them just for this one flag). A computed
  // wrapper (not the raw `ref`) since Options API's `data()` properties aren't refs themselves;
  // this keeps the injected value reactive to changes made via `this.selectMode = ...`.
  provide() {
    return {
      chatSelectMode: computed(() => this.selectMode),
    }
  },
  setup() {
    const contactStore = useContactStore()
    const myProfile = useProfileStore()

    return {
      myDrawerOpen: useMyDrawerOpen(),
      getContact: contactStore.getContact,
      contactStore,
      setNotify: contactStore.setNotify,
      getNotify: contactStore.getNotify,
      myProfile,
      profileAvatar,
      ownAddress: useReactiveOwnCanonicalAddress(),
    }
  },
  data() {
    return {
      address: (this.$route.params.address as string) || '',
      // Full-pane Info swap, not a side drawer -- see this file's template header comment above
      // `router-view`/`chat-info-view` for why. Can be directly opened via ?info=true query param.
      infoOpen: this.$route.query?.info === 'true',
      chatMenuOpen: false,
      subjectEditorOpen: false,
      subjectEditorId: null as string | null,
      subjectDraft: '',
      // See this file's `provide()` and ChatMessageSuffixButtons.vue's own header -- gates
      // per-message delete behind an explicit mode instead of it being an always-hoverable action.
      selectMode: false,
      confirmClearOpen: false,
      confirmDeleteOpen: false,
    }
  },
  watch: {
    '$route.fullPath'() {
      this.cancelSubjectEditor()
    },
    '$route.query.info'(val: string | undefined) {
      this.infoOpen = val === 'true'
    },
    '$route.params.address'(val: string | undefined) {
      this.address = val || ''
    },
  },
  beforeRouteUpdate(to: RouteLocationNormalized) {
    this.cancelSubjectEditor()
    this.address = (to?.params?.address as string) || ''
    // If navigating with ?info=true, show the info page; otherwise reset to plain chat view
    this.infoOpen = to?.query?.info === 'true'
    this.selectMode = false
  },
  methods: {
    openSubjectEditor() {
      const conversation = this.activeConversation
      if (!conversation) return
      this.subjectEditorId = conversation.id
      this.subjectDraft = conversation.name ?? ''
      this.subjectEditorOpen = true
    },
    cancelSubjectEditor() {
      this.subjectEditorOpen = false
      this.subjectEditorId = null
      this.subjectDraft = ''
    },
    saveSubject() {
      const id = this.subjectEditorId
      const subject = this.subjectDraft.trim()
      if (!this.subjectEditorOpen || !id || id !== this.activeConversation?.id)
        return
      useChatStore().renameConversation(id, subject)
      this.cancelSubjectEditor()
    },
    openInfo() {
      this.infoOpen = true
      if (this.$route.query?.info !== 'true') {
        void this.$router.replace({
          query: { ...(this.$route.query ?? {}), info: 'true' },
        })
      }
    },
    closeInfo() {
      this.infoOpen = false
      if (this.$route.query?.info) {
        const query = { ...this.$route.query }
        delete query.info
        void this.$router.replace({ query })
      }
    },
    // DeleteChatDialog (opened either from the overflow menu or from within the full-pane Info
    // view) emits this once the chat is actually gone -- neither the chat route nor an Info view
    // for it is a valid place to keep sitting.
    onChatDeleted() {
      this.infoOpen = false
      this.$router.push('/forum')
    },
  },
  computed: {
    activeConversation(): Conversation | null {
      if (!this.address) return null
      try {
        const chatStore = useChatStore()
        if (
          chatStore.conversations &&
          this.address in chatStore.conversations
        ) {
          return chatStore.conversations[this.address] ?? null
        }
        if (isChainAddress(this.address)) {
          return chatStore.chats[toChainDisplayAddress(this.address)] ?? null
        }
      } catch {
        //
      }
      return null
    },
    effectiveAddress(): string {
      const conv = this.activeConversation
      if (conv?.address) return conv.address
      if (conv?.participants && conv.participants.length > 0)
        return conv.participants[0]
      return this.address
    },
    contactProfile() {
      const addr = this.effectiveAddress
      return addr && isChainAddress(addr)
        ? this.getContact(addr)?.profile
        : undefined
    },
    targetProfile() {
      if (
        this.effectiveAddress &&
        sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
      ) {
        return this.myProfile.profile
      }
      return this.contactProfile
    },
    contactName(): string {
      if (!this.address) {
        return ''
      }
      const conv = this.activeConversation
      // An email thread is titled by its subject. Any other conversation is titled by its peer,
      // and its subject is shown under the name (see `subject`).
      if (conv?.kind === 'email') {
        return (
          conv.name ||
          conv.emailRecipient ||
          conv.topic ||
          this.contactProfile?.name ||
          this.effectiveAddress ||
          this.address
        )
      }
      if (this.isGroup) {
        // In this user's own notes the others are listed after "You", never instead of it.
        const names = Array.from(
          conversationSenders(
            conv,
            this.ownAddress,
            this.contactStore,
          ).values(),
        ).map(sender => sender.label)
        if (sameCanonicalAddress(this.effectiveAddress, this.ownAddress))
          names.unshift(this.$t('selfChat.you'))
        return names.join(', ')
      }
      // With no peer to name, the subject is the title itself.
      if (conv?.name && !isChainAddress(this.effectiveAddress)) return conv.name
      return sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
        ? this.$t('selfChat.you')
        : this.contactProfile?.name ?? (this.effectiveAddress || this.address)
    },
    /** Everyone in the conversation, this user included. */
    participantCount(): number {
      return (
        otherParticipants(
          this.activeConversation?.participants,
          this.ownAddress,
        ).length + 1
      )
    },
    isGroup(): boolean {
      return isGroupConversation(
        this.activeConversation?.participants,
        this.ownAddress,
        this.activeConversation?.address,
      )
    },
    subject(): string {
      const conv = this.activeConversation
      if (!conv || conv.kind === 'email') return ''
      if (!isChainAddress(this.effectiveAddress)) return ''
      return (conv.name || conv.topic || '').trim()
    },
    conversationLabel(): string {
      return this.subject
        ? `${this.contactName} \u2014 ${this.subject}`
        : this.contactName
    },
    presentedAvatar(): string | undefined {
      if (!this.effectiveAddress) {
        return undefined
      }
      return sameCanonicalAddress(this.effectiveAddress, this.ownAddress)
        ? this.myProfile.profile.avatar || this.contactProfile?.avatar
        : this.contactProfile?.avatar
    },
    notifications: {
      get(): boolean {
        return this.effectiveAddress && isChainAddress(this.effectiveAddress)
          ? this.getNotify(this.effectiveAddress) ?? false
          : false
      },
      set(value: boolean) {
        if (this.effectiveAddress && isChainAddress(this.effectiveAddress)) {
          this.setNotify({ address: this.effectiveAddress, value })
        }
      },
    },
    // Ticket #50: a spoofing/impersonation cue -- a colored ring around the contact's avatar,
    // derived from their public key. Same name/avatar with a suddenly-different ring color is
    // the tell that the underlying key changed (a genuine key rotation, #46, or someone spoofing
    // this contact's identity). No ring at all just means no pubkey is known yet for this
    // contact (e.g. a pending/unconfirmed add) -- not itself suspicious.
    contactColorStyle() {
      const pubKey = this.contactProfile?.pubKey
      if (!pubKey) {
        return {}
      }
      return { boxShadow: `0 0 0 3px ${pubKeyToColor(pubKey.toBuffer())}` }
    },
  },
})
</script>

<style lang="scss" scoped>
.chat-header-title {
  line-height: 1.2;
}
.chat-header-subject {
  font-weight: 400;
  opacity: 0.85;
}

.reply {
  padding: 5px 0;
  color: var(--q-color-text);
  background: var(--q-color-background);
  padding-left: 8px;
  border-left: 3px;
  border-left-style: solid;
  border-left-color: $primary;
}

.scroll-area-bordered {
  border-right: 1px;
  border-right-style: solid;
  border-right-color: $separator-color;
  border-bottom: 1px;
  border-bottom-style: solid;
  border-bottom-color: $separator-color;
}
</style>
