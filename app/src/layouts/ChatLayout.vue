<template>
  <div>
    <!-- Send file dialog -->
    <!-- TODO: Move this up.  We don't need a copy of this dialog for each address (likely) -->
    <q-dialog v-model="sendFileOpen">
      <send-file-dialog :address="address" :file="image" />
    </q-dialog>

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
            @click="infoOpen = false"
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
            @click="selectMode = false"
          />
          <q-toolbar-title class="h6">{{
            $t('chatLayout.selectMessagesTitle')
          }}</q-toolbar-title>
        </template>
        <template v-else>
          <q-btn
            class="q-px-sm"
            flat
            dense
            @click="() => $emit('toggleMyDrawerOpen')"
            icon="menu"
          />
          <q-avatar rounded :style="contactColorStyle">
            <img :src="profileAvatar(contactProfile?.avatar, address)" />
          </q-avatar>
          <q-toolbar-title class="h6" :style="contactNameColorStyle">{{
            contactName
          }}</q-toolbar-title>
          <q-space />
          <q-btn class="q-px-sm" flat dense icon="more_vert">
            <q-menu anchor="bottom right" self="top right">
              <q-list style="min-width: 180px">
                <q-item clickable v-close-popup @click="infoOpen = true">
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

    <q-dialog v-model="confirmClearOpen">
      <clear-history-dialog :address="address" :name="contactProfile.name" />
    </q-dialog>
    <q-dialog v-model="confirmDeleteOpen">
      <delete-chat-dialog
        :address="address"
        :name="contactProfile.name"
        @deleted="onChatDeleted"
      />
    </q-dialog>

    <!-- Full-pane swap, not a side-by-side layout -- direct user feedback: Info deserves the same
    amount of room a chat gets, and on a narrow/mobile viewport there's no room for both panes at
    once anyway, so a single view stack (never two panes fighting for space) is the one layout
    that already works at every width. -->
    <router-view v-if="!infoOpen" @sendFileClicked="toSendFileDialog" />
    <chat-info-view
      v-else
      :address="address"
      :contact="getContact(address)"
      @deleted="onChatDeleted"
    />
  </div>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { RouteLocationNormalized } from 'vue-router'

import ChatInfoView from '../components/panels/ChatInfoView.vue'
import ClearHistoryDialog from '../components/dialogs/ClearHistoryDialog.vue'
import DeleteChatDialog from '../components/dialogs/DeleteChatDialog.vue'
import SendFileDialog from '../components/dialogs/SendFileDialog.vue'
import { useContactStore } from 'src/stores/contacts'
import { pubKeyToColor } from 'src/utils/formatting'
import { profileAvatar } from 'src/utils/avatar'
import { getOwnCanonicalAddress } from 'src/utils/own-address'

export default defineComponent({
  emits: ['toggleMyDrawerOpen'],
  components: {
    ChatInfoView,
    ClearHistoryDialog,
    DeleteChatDialog,
    SendFileDialog,
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

    return {
      getContact: contactStore.getContact,
      setNotify: contactStore.setNotify,
      getNotify: contactStore.getNotify,
      profileAvatar,
    }
  },
  data() {
    return {
      sendFileOpen: false as boolean,
      address: this.$route.params.address as string,
      // Full-pane Info swap, not a side drawer -- see this file's template header comment above
      // `router-view`/`chat-info-view` for why.
      infoOpen: false,
      // See this file's `provide()` and ChatMessageSuffixButtons.vue's own header -- gates
      // per-message delete behind an explicit mode instead of it being an always-hoverable action.
      selectMode: false,
      confirmClearOpen: false,
      confirmDeleteOpen: false,
      image: null as unknown | null,
      ownAddress: null as string | null,
    }
  },
  async mounted() {
    this.ownAddress = await getOwnCanonicalAddress()
  },
  beforeRouteUpdate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: () => void,
  ) {
    this.address = to.params.address as string
    // Switching chats while Info/select mode is active would otherwise leave the *previous*
    // chat's state showing under the new address -- always land back on a plain chat view for a
    // freshly-navigated-to address.
    this.infoOpen = false
    this.selectMode = false
    next()
  },
  methods: {
    toSendFileDialog(args: unknown) {
      this.image = args
      this.sendFileOpen = true
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
    contactProfile() {
      return this.getContact(this.address)?.profile
    },
    contactName(): string {
      return this.address === this.ownAddress
        ? this.$t('selfChat.you')
        : this.contactProfile.name
    },
    notifications: {
      get(): boolean {
        return this.getNotify(this.address) ?? false
      },
      set(value: boolean) {
        this.setNotify({ address: this.address, value })
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
    // Direct user feedback: the avatar ring alone was too easy to miss -- the same color cue is
    // now also applied to the name text itself (kept alongside the ring, not instead of it, so
    // there are two independent places a key change is visible). Same `pubKeyToColor` call, same
    // "no pubkey yet" -> no color fallback as `contactColorStyle` above.
    contactNameColorStyle() {
      const pubKey = this.contactProfile?.pubKey
      if (!pubKey) {
        return {}
      }
      return { color: pubKeyToColor(pubKey.toBuffer()) }
    },
  },
})
</script>

<style lang="scss" scoped>
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
