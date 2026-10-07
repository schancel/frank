<template>
  <div class="row no-wrap full-height relative-position left-drawer-root">
    <!-- Relay reconnect dialog -->
    <q-dialog v-if="legacyRelayEnabled" v-model="relayConnectOpen">
      <relay-connect-dialog />
    </q-dialog>

    <!-- Icon rail (ticket #123): a dedicated narrow column, not tabs laid out horizontally inside
    the same drawer as the chat list -- matches Telegram/WhatsApp/Signal's own left-hand nav
    strip. `q-tabs`' own `vertical` prop does the layout work; the tab names/click handlers below
    are otherwise unchanged from before this split, so none of that established navigation
    behavior (openActiveOrRecentChat, the /forum push, the unread badge) needed touching. -->
    <div
      class="column items-center icon-rail"
      v-if="$status.setup"
      data-testid="icon-rail"
    >
      <!-- WAI-ARIA tabs pattern (ticket #214): each rail item selects which list the column beside
      it shows (settings panel / chat list / forum topics -- the role="tabpanel" blocks below), and
      the contacts/forum items additionally navigate the main pane. Selecting a view is what makes
      them tabs; Settings does not navigate at all, so a nav-landmark-with-links model would be
      wrong for it. Quasar's q-tabs/q-tab supply role=tablist/tab, aria-selected and the vertical
      orientation; this file adds the tablist name and the tab <-> tabpanel wiring. -->
      <q-tabs
        v-model="tab"
        vertical
        class="col full-width"
        content-class="settings-pin-content"
        :aria-label="$t('leftDrawer.railLabel')"
      >
        <!-- Navigates to the active (or most recently used) chat -->
        <q-tab
          name="chats"
          id="rail-tab-chats"
          aria-controls="rail-panel-chats"
          icon="forum"
          :aria-label="chatsLabel()"
          @click="openActiveOrRecentChat"
        >
          <q-tooltip>{{ $t('leftDrawer.chats') }}</q-tooltip>
          <q-badge
            floating
            color="secondary"
            :label="totalUnread"
            aria-hidden="true"
            class="q-my-xs"
            v-if="totalUnread !== 0"
          />
        </q-tab>

        <q-tab
          name="forum"
          id="rail-tab-forum"
          aria-controls="rail-panel-forum"
          icon="dynamic_feed"
          :aria-label="$t('leftDrawer.forum')"
          @click="openForumTab"
        >
          <q-tooltip>{{ $t('leftDrawer.forum') }}</q-tooltip>
        </q-tab>

        <q-tab
          name="contacts"
          id="rail-tab-contacts"
          aria-controls="rail-panel-contacts"
          icon="contacts"
          :aria-label="$t('leftDrawer.contacts')"
        >
          <q-tooltip>{{ $t('leftDrawer.contacts') }}</q-tooltip>
        </q-tab>

        <q-tab
          name="wallet"
          id="rail-tab-wallet"
          aria-controls="rail-panel-wallet"
          icon="account_balance_wallet"
          class="wallet-rail-tab"
          :aria-label="$t('leftDrawer.wallet')"
        >
          <q-tooltip>{{ $t('leftDrawer.wallet') }}</q-tooltip>
        </q-tab>

        <q-tab
          name="settings"
          id="rail-tab-settings"
          aria-controls="rail-panel-settings"
          icon="settings"
          class="settings-rail-tab"
          :aria-label="$t('leftDrawer.settings')"
          @click="openSettingsTab"
        >
          <q-tooltip>{{ $t('leftDrawer.settings') }}</q-tooltip>
        </q-tab>
      </q-tabs>
    </div>

    <!-- List column: whatever the active rail icon selects (settings, chats, contacts, wallet or forum) -->
    <div class="column full-height col list-column">
      <settings-panel
        v-if="$status.setup"
        v-show="tab == 'settings'"
        v-bind="{ ...$attrs, ...panelAttrs('settings') }"
        @closeDrawer="$emit('closeDrawer')"
      />
      <div v-if="!$status.setup" class="drawer-header-item">
        <chat-list-link title="Login/Sign Up" route="/setup" icon="login" />
      </div>

      <chat-list
        v-show="tab == 'chats' && $status.setup"
        v-bind="{ ...$attrs, ...panelAttrs('chats') }"
        :compact="false"
        @closeDrawer="$emit('closeDrawer')"
      />

      <contacts-panel
        v-if="$status.setup"
        v-show="tab == 'contacts'"
        v-bind="panelAttrs('contacts')"
        @closeDrawer="$emit('closeDrawer')"
      />

      <wallet-panel
        v-if="$status.setup"
        v-show="tab == 'wallet'"
        v-bind="panelAttrs('wallet')"
      />

      <!-- Real user-reported gap (ticket #61's own follow-up comment admitted this was a stopgap:
      "there's no forum-specific content this drawer could show instead"): clicking "forum" used
      to just fall back to showing the same chat-list as "contacts" -- so the two tabs looked and
      behaved identically in the sidebar, with nothing anywhere to actually browse different
      topics/forums. This list surfaces the same relay-discovered topic data already wired up in
      ForumDrawer.vue's own "Browse Topics" section, but here in the left rail, where a user
      actually expects a per-tab list -- clicking a topic switches the Forum's selected topic and
      navigates there if not already on /forum.

      Wrapped exactly like ChatList.vue's own template (`full-width column col` +
      `q-scroll-area class="q-px-none col"`) -- an earlier version of this was a bare `q-list` with
      neither, which (a) looked visually inconsistent with the rest of this drawer (no scroll
      handling, no consistent width/column behavior) and (b) didn't fill the remaining flex space,
      so "Balance" below no longer stayed pinned to the bottom of the drawer the way it does for
      every other tab -- it just sat directly under however many topics happened to be listed. -->
      <div
        class="full-width column col"
        v-show="tab == 'forum' || !$status.setup"
        v-bind="panelAttrs('forum')"
      >
        <q-scroll-area
          class="q-px-none col full-width"
          :content-style="{ width: '100%', minWidth: '100%' }"
          :content-active-style="{ width: '100%', minWidth: '100%' }"
        >
          <q-list v-bind="$attrs" class="full-width">
            <q-separator />
            <q-item>
              <q-item-section
                class="cursor-pointer"
                @click="browseForumTopic('')"
              >
                <q-item-label>{{ $t('leftDrawer.forum') }}</q-item-label>
              </q-item-section>
              <q-space />
              <q-btn
                dense
                flat
                icon="add"
                :aria-label="$t('a11y.newPost')"
                @click="openNewPost"
              />
            </q-item>
            <q-separator />
            <q-item
              clickable
              :active="!selectedForumTopic"
              active-class="active-topic-item active-chat-list-item"
              class="topic-list-item"
              data-test="topic-all"
              @click="browseForumTopic('')"
            >
              <q-item-section avatar class="topic-avatar-section">
                <q-icon name="dynamic_feed" size="18px" />
              </q-item-section>
              <q-item-section class="topic-name-section">{{
                $t('forum.allTopics')
              }}</q-item-section>
            </q-item>
            <q-item
              v-for="name in discoveredTopicNames"
              :key="name"
              clickable
              :active="name === selectedForumTopic"
              active-class="active-topic-item active-chat-list-item"
              class="topic-list-item"
              :data-test="`topic-${name}`"
              @click="browseForumTopic(name)"
            >
              <q-item-section avatar class="topic-avatar-section">
                <span class="topic-hash">#</span>
              </q-item-section>
              <q-item-section class="topic-name-section">{{
                name
              }}</q-item-section>
            </q-item>
            <q-item v-if="discoveredTopicNames.length === 0">
              <q-item-section class="text-grey">{{
                $t('leftDrawer.noForums')
              }}</q-item-section>
            </q-item>
          </q-list>
        </q-scroll-area>
      </div>

      <!-- Keep the legacy-relay reconnect affordance while that runtime mode exists. The Wallet
      panel is the primary balance surface; this compatibility footer is not shown in Monad mode. -->
      <q-list v-if="$status.setup" class="drawer-balance-footer">
        <q-separator />
        <q-item clickable class="drawer-balance-item">
          <q-item-section @click="openReceive">
            <q-item-label>{{ $t('chatList.balance') }}</q-item-label>
            <q-item-label
              caption
              role="status"
              aria-live="polite"
              :aria-label="
                loaded
                  ? undefined
                  : $t('receiveBitcoinDialog.balanceUnavailable')
              "
              data-testid="drawer-balance"
              >{{ balanceText
              }}<template v-if="balanceStale">
                {{ ' ' + $t('chatList.balanceStale') }}</template
              ></q-item-label
            >
          </q-item-section>
          <q-item-section
            v-if="legacyRelayEnabled && !relayConnected"
            side
            clickable
            @click="relayConnectOpen = true"
          >
            <q-btn
              data-testid="relay-reconnect"
              icon="email"
              flat
              round
              color="red"
              :aria-label="$t('a11y.connectRelay')"
            />
          </q-item-section>
        </q-item>
      </q-list>
    </div>

    <!-- Desktop resize drag handle -->
    <div
      v-if="!isNarrow"
      class="drawer-resize-handle"
      data-testid="drawer-resize-handle"
      @mousedown="startResize"
    />
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, inject, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import ChatList from '../chat/ChatList.vue'
import ChatListLink from '../chat/ChatListLink.vue'
import ContactsPanel from '../panels/ContactsPanel.vue'
import SettingsPanel from '../panels/SettingsPanel.vue'
import WalletPanel from '../panels/WalletPanel.vue'
import RelayConnectDialog from '../dialogs/RelayConnectDialog.vue'

import { isNarrowWidth } from '../../utils/layout'
import { openChat, openPage } from '../../utils/routes'
import { useChatStore } from 'src/stores/chats'
import { useTopicStore } from 'src/stores/topics'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'
import { accountStatus } from '../../accounts/session'

const compactCutoff = 325

export default defineComponent({
  setup() {
    const q = inject<{ screen?: { width?: number } } | null>('_q_', null)
    const isNarrow = computed(() =>
      isNarrowWidth(
        q?.screen?.width ??
          (typeof window !== 'undefined' ? window.innerWidth : 1024),
      ),
    )
    const chats = useChatStore()
    const { totalUnread } = storeToRefs(chats)
    const route = useRoute()
    const router = useRouter()

    // "Contacts" tab's click target -- opens the currently active chat if there is one, else the
    // most recently active one from the sorted chat list, so this tab actually navigates
    // somewhere genuinely different from "forum" (see the template's comment on this tab for why
    // it needs to navigate at all, rather than being a pure local-display-mode switch like
    // "settings"). A brand new user with zero conversations yet has nothing to navigate to --
    // the chat-list's own "Add contacts from the drawer above..." empty state already
    // communicates that, so doing nothing here is the correct, safe fallback.
    // Rail-tab switches keep the mobile overlay open (the user is still browsing the drawer);
    // only picking a destination closes it. MainLayout provides the marker its router hook honors.
    const markRailNavigation = inject<() => void>(
      'markRailNavigation',
      () => undefined, // standalone (outside MainLayout): nothing to mark
    )
    function openForumTab() {
      markRailNavigation()
      maybeRefreshTopics()
      if (forum.selectedTopic) {
        forum.setSelectedTopic('')
        void (async () => {
          try {
            let wallet
            try {
              wallet = await useActiveWallet()
            } catch {
              // Public reading requires no active wallet
            }
            await forum.refreshMessages({ wallet, topic: '' })
          } catch {
            // Handled: forumStore records outageStatus; no unhandled browser exception
          }
        })()
      }
      return router.push('/forum')
    }
    function openNewPost() {
      openPage(router, '/new-post')
    }
    function openSettingsTab() {
      markRailNavigation()
      return router.push('/settings')
    }
    function openActiveOrRecentChat() {
      const target =
        chats.activeConversationId ??
        chats.activeChatAddr ??
        chats.getSortedChatOrder[0]?.id ??
        chats.getSortedChatOrder[0]?.address
      markRailNavigation()
      if (target) {
        if (typeof chats.setActiveConversation === 'function') {
          chats.setActiveConversation(target)
        }
        router.push(`/chat/${target}`)
      } else {
        router.push('/chat')
      }
    }

    // "forum" tab's own list -- real user-reported gap, see this file's template comment on the
    // `q-list v-show="tab == 'forum'"` block for the full story. `useTopicStore` already fetches
    // and holds the relay-discovered topic list (ticket #72); `useForumStore` is the separate
    // store the actual /forum page reads its selected topic from (see `ForumDrawer.vue`'s own
    // near-identical `setTopic` for the precedent this mirrors).
    const topicStore = useTopicStore()
    const forum = useForumStore()

    function maybeRefreshTopics() {
      if (route.path.startsWith('/setup') && accountStatus.status !== 'ready') {
        return
      }
      topicStore.refreshDiscoveredTopics()
    }

    const discoveredTopicNames = computed(() =>
      Object.keys(topicStore.topics).sort(),
    )
    const selectedForumTopic = computed(() => forum.selectedTopic)
    async function browseForumTopic(name: string) {
      const targetTopic = name === forum.selectedTopic ? '' : name
      forum.setSelectedTopic(targetTopic)
      if (route.path !== '/forum') {
        await router.push('/forum')
      }
      try {
        let wallet
        try {
          wallet = await useActiveWallet()
        } catch {
          // Public reading requires no active wallet
        }
        await forum.refreshMessages({ wallet, topic: targetTopic })
      } catch (error) {
        // Handled: forumStore records outageStatus; no unhandled browser exception
      }
    }

    const { formattedBalance, loaded, hasError } = useBalance()
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const balanceStale = computed(() => loaded.value && hasError.value)

    onMounted(() => {
      // Fire-and-forget, same convention as `ForumLayout.vue`'s own identical call --
      // `refreshDiscoveredTopics` already fails soft and never throws (`stores/topics.ts`).
      maybeRefreshTopics()
    })

    watch(
      () => accountStatus.status === 'ready',
      complete => {
        if (complete) {
          maybeRefreshTopics()
        }
      },
    )

    // Drives the left rail's active-tab highlight (`q-tabs v-model="tab"`). A plain, freely
    // settable ref -- NOT a computed getter/setter (an earlier version of this fix tried that,
    // and broke tab-clicking entirely: a getter re-derives on every *read*, so as long as
    // route.path still started with /forum -- true for basically the whole time you're using the
    // app, since / redirects there -- it unconditionally overrode any click to 'settings' or
    // 'contacts' right back to 'forum' before Quasar could even render the change). What's
    // actually wanted is a one-time *side effect* on route *change*, not a permanent override on
    // every read -- that's a `watch`, not a `computed`. `useRoute()`'s reactive `route` is the
    // Composition API's own, more direct seam onto routing state (vs. the Options API
    // string-path watcher an earlier attempt used, which didn't reliably fire in at least one
    // real session).
    const tab = ref<'chats' | 'contacts' | 'wallet' | 'settings' | 'forum'>(
      'chats',
    )
    watch(
      () => tab.value,
      newTab => {
        if (newTab === 'forum') {
          maybeRefreshTopics()
        }
      },
    )
    watch(
      () => route.path,
      path => {
        // `/new-post` (not `/forum/new-post`) is intentionally a top-level path -- see
        // `router/index.ts`'s own comment on `protectedRoutes` -- but is still a Forum page.
        // Only force the highlight on navigation -- never overrides a subsequent direct
        // 'settings'/'contacts' click, since this only runs when `path` itself changes. /wallet
        // gets the same treatment (#570): opening a wallet (deep link, back navigation) puts the
        // highlight back on its own rail tab.
        if (
          path.startsWith('/forum') ||
          path.startsWith('/new-post') ||
          path.startsWith('/topic')
        ) {
          tab.value = 'forum'
          maybeRefreshTopics()
        } else if (path.startsWith('/wallet')) {
          tab.value = 'wallet'
        } else if (path.startsWith('/settings')) {
          tab.value = 'settings'
        } else if (
          path.startsWith('/add-contact') ||
          path.startsWith('/contacts')
        ) {
          tab.value = 'contacts'
        } else if (path.startsWith('/chat')) {
          tab.value = 'chats'
        }
      },
      { immediate: true },
    )

    return {
      tab,
      openActiveOrRecentChat,
      openForumTab,
      openNewPost,
      openSettingsTab,
      discoveredTopicNames,
      selectedForumTopic,
      browseForumTopic,
      totalUnread: totalUnread,
      balanceText,
      balanceStale,
      loaded,
      isNarrow,
      legacyRelayEnabled: legacyLotusModeEnabled(),
      chats,
    }
  },
  emits: ['closeDrawer', 'updateWidth', 'resizing'],
  components: {
    ChatListLink,
    ChatList,
    ContactsPanel,
    SettingsPanel,
    WalletPanel,
    RelayConnectDialog,
  },
  data() {
    return {
      // `tab` itself now comes from `setup()`'s writable computed (route-driven for "forum",
      // freely settable for "contacts"/"settings") -- not declared here.
      // My Drawer
      walletOpen: false,
      relayConnectOpen: false,
      newContactOpen: false,
      //
      trueSplitterRatio: compactCutoff,
      compact: false as boolean,
      myDrawerOpen: false as boolean,
    }
  },
  methods: {
    tweak(offset: number, viewportHeight: number) {
      const height = viewportHeight - offset + 'px'
      return { height, minHeight: height }
    },
    toggleMyDrawerOpen() {
      if (this.compact) {
        this.compact = false
        this.trueSplitterRatio = compactCutoff
      }
      this.myDrawerOpen = !this.myDrawerOpen
    },
    contactClicked(address: string) {
      if (typeof this.chats?.setActiveConversation === 'function') {
        this.chats.setActiveConversation(address)
      }
      openChat(this.$router, address)
    },
    chatsLabel(): string {
      const n = this.totalUnread
      if (!n) return this.$t('leftDrawer.chats')
      return this.$t(
        n === 1 ? 'leftDrawer.chatsUnreadOne' : 'leftDrawer.chatsUnreadOther',
        { count: n },
      )
    },
    contactsLabel(): string {
      return this.$t('leftDrawer.contacts')
    },
    // Tabpanel wiring for the rail (see the tablist comment in the template). Without the rail
    // (signed-out: no tabs rendered) the list is just content, so no dangling aria-labelledby.
    panelAttrs(name: 'settings' | 'chats' | 'contacts' | 'wallet' | 'forum') {
      if (!this.$status.setup) return {}
      return {
        'id': `rail-panel-${name}`,
        'role': 'tabpanel',
        'aria-labelledby': `rail-tab-${name}`,
      }
    },
    openReceive() {
      openPage(this.$router, '/wallet')
    },
    startResize(e: MouseEvent) {
      if (this.isNarrow) return
      e.preventDefault()
      this.$emit('resizing', true)
      document.body.classList.add('resizing-drawer')

      const onMouseMove = (moveEvent: MouseEvent) => {
        const maxWidth = Math.max(260, Math.min(960, window.innerWidth - 120))
        const newWidth = Math.round(
          Math.max(260, Math.min(maxWidth, moveEvent.clientX)),
        )
        this.$emit('updateWidth', newWidth)
      }

      const onMouseUp = () => {
        this.$emit('resizing', false)
        document.body.classList.remove('resizing-drawer')
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
  },
  computed: {
    relayConnected(): boolean {
      if (!this.legacyRelayEnabled) return true
      return Boolean(
        (this as { $relay?: { connected?: boolean } }).$relay?.connected,
      )
    },
  },
})
</script>

<style lang="scss" scoped>
// Matches ChatList.vue/ChatListLink.vue/TopicListLink.vue/TopicList.vue's own identical rule --
// Vue's scoped CSS doesn't cross component boundaries, so each file rendering a
// `q-item active-class="active-chat-list-item"` needs its own copy for the class to actually
// take effect within it. Without this, the previous version fell back to a plain `text-primary`
// (text color only), which was too subtle to register as "this is selected" against the
// established, much more visible background+color pattern used everywhere else in the app.
.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: var(--q-primary);
}

.topic-list-item {
  border-radius: 8px;
  margin: 2px 8px;
  min-height: 38px;
  transition: background 0.15s ease, color 0.15s ease;
}

.topic-avatar-section {
  min-width: 24px;
  padding-right: 4px;
}

.topic-hash {
  font-weight: 700;
  font-size: 15px;
  opacity: 0.5;
}

.active-topic-item {
  background: var(--q-color-bg-active);
  color: var(--q-primary);
  font-weight: 600;

  .topic-hash {
    opacity: 1;
    color: var(--q-primary);
  }
}

// Fixed-width icon-only nav column (ticket #123) -- 72px matches the reference apps (Telegram/
// WhatsApp/Signal) this pass drew from. A faint background tint (not the same flat color as the
// list column) is what actually reads as "two columns" rather than "one column with icons on
// top" -- color alone from `body--dark`/`body--light`'s `--q-color-bg-active` was tried first and
// wasn't enough contrast against the list column's own background to register as a separate rail
// at a glance.
.icon-rail {
  width: 72px;
  min-width: 72px;
  background: var(--q-color-bg-active);
}

.wallet-rail-tab {
  margin-top: auto;
}

.settings-rail-tab {
}

// Quasar's vertical-tab rule uses `display: block !important` on this internal element, so the
// Wallet/Settings tabs' auto margin only consumes the remaining rail height after restoring a column
// flex context here. Keep short rails scrollable instead of making Settings unreachable.
.icon-rail :deep(.settings-pin-content) {
  display: flex !important;
  flex-direction: column;
  overflow-y: auto;
}

.list-column {
  min-width: 0; // allow the flex child to shrink below its content's natural width, so long chat
  // names/previews ellipsize instead of forcing the whole drawer wider than intended.
}

.drawer-header-item {
  height: 50px;
  min-height: 50px;
  max-height: 50px;
  box-sizing: border-box;
}

.drawer-balance-footer {
  height: 64px;
  min-height: 64px;
  max-height: 64px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.drawer-balance-item {
  min-height: 63px;
  height: 63px;
}

.drawer-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 50;
  background: transparent;
  transition: background-color 0.15s ease-in-out;
  &:hover,
  &:active {
    background-color: var(--q-primary);
  }
}
</style>
