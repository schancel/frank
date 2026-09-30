<template>
  <div class="row no-wrap full-height">
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
        :aria-label="$t('leftDrawer.railLabel')"
      >
        <q-tab
          name="settings"
          id="rail-tab-settings"
          aria-controls="rail-panel-settings"
          icon="settings"
          :aria-label="$t('leftDrawer.settings')"
        >
          <q-tooltip>{{ $t('leftDrawer.settings') }}</q-tooltip>
        </q-tab>
        <!-- Navigates to the active (or most recently used) chat, so this tab actually shows
        something different from "forum" in the main pane -- an earlier version of this fix
        removed navigation entirely to stop it fighting with "forum" over `/`, but that also made
        clicking it a visible no-op whenever you were already on /forum (same main content, same
        chat-list underneath, nothing about the click was ever observable). openActiveOrRecentChat
        navigates to a genuinely different, contacts-focused route instead of re-using `/`. -->
        <q-tab
          name="contacts"
          id="rail-tab-contacts"
          aria-controls="rail-panel-contacts"
          icon="contacts"
          :aria-label="contactsLabel()"
          @click="openActiveOrRecentChat"
        >
          <q-tooltip>{{ $t('leftDrawer.contacts') }}</q-tooltip>
          <q-badge
            floating
            color="secondary"
            :label="totalUnread"
            aria-hidden="true"
            class="q-my-xs"
            v-if="totalUnread !== 0"
          />
        </q-tab>

        <!-- Per-owner decision (2026-09-27, following #61): the flat groupchat-style Topics list
        is hidden in favor of the Forum's threaded view -- both still work (stores/topics.ts and
        stores/forum.ts share the same activeChain.topics data), but only Forum is surfaced in nav
        now. This tab navigates straight to /forum rather than switching local drawer content,
        since Forum is a full page/route, not another sidebar-list mode like contacts/settings. -->
        <q-tab
          name="forum"
          id="rail-tab-forum"
          aria-controls="rail-panel-forum"
          icon="forum"
          :aria-label="$t('leftDrawer.forum')"
          @click="openForumTab"
        >
          <q-tooltip>{{ $t('leftDrawer.forum') }}</q-tooltip>
        </q-tab>
      </q-tabs>
    </div>

    <!-- List column: whatever the active rail icon selects (settings panel / chat list / forum
    topics), plus the balance footer -- exactly the content this drawer showed before the icon
    rail existed, just no longer sharing a column with the tab icons themselves. -->
    <div class="column full-height col list-column">
      <settings-panel
        v-if="$status.setup"
        v-show="tab == 'settings'"
        v-bind="panelAttrs('settings')"
      />
      <div v-if="!$status.setup">
        <q-separator />
        <chat-list-link title="Login/Sign Up" route="/setup" icon="login" />
      </div>

      <chat-list
        v-show="tab == 'contacts'"
        v-bind="{ ...$attrs, ...panelAttrs('contacts') }"
        :compact="false"
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
        v-show="tab == 'forum'"
        v-bind="panelAttrs('forum')"
      >
        <q-scroll-area class="q-px-none col">
          <q-list v-bind="$attrs">
            <q-separator />
            <q-item
              v-for="name in discoveredTopicNames"
              :key="name"
              clickable
              :active="name === selectedForumTopic"
              active-class="active-chat-list-item"
              @click="browseForumTopic(name)"
            >
              <q-item-section>{{ name }}</q-item-section>
            </q-item>
            <q-item v-if="discoveredTopicNames.length === 0">
              <q-item-section class="text-grey"
                >No forums discovered yet.</q-item-section
              >
            </q-item>
          </q-list>
        </q-scroll-area>
      </div>

      <q-list v-if="$status.setup">
        <q-separator />
        <q-item clickable>
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
            <q-btn icon="email" flat round color="red" />
          </q-item-section>
        </q-item>
      </q-list>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, inject, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import ChatList from '../chat/ChatList.vue'
import ChatListLink from '../chat/ChatListLink.vue'
import SettingsPanel from '../panels/SettingsPanel.vue'
import RelayConnectDialog from '../dialogs/RelayConnectDialog.vue'

import { openChat, openPage } from '../../utils/routes'
import { useChatStore } from 'src/stores/chats'
import { useTopicStore } from 'src/stores/topics'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'

const compactCutoff = 325

export default defineComponent({
  setup() {
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
      return router.push('/forum')
    }
    function openActiveOrRecentChat() {
      const address =
        chats.activeChatAddr ?? chats.getSortedChatOrder[0]?.address
      if (address) {
        markRailNavigation()
        router.push(`/chat/${address}`)
      }
    }

    // "forum" tab's own list -- real user-reported gap, see this file's template comment on the
    // `q-list v-show="tab == 'forum'"` block for the full story. `useTopicStore` already fetches
    // and holds the relay-discovered topic list (ticket #72); `useForumStore` is the separate
    // store the actual /forum page reads its selected topic from (see `ForumDrawer.vue`'s own
    // near-identical `setTopic` for the precedent this mirrors).
    const topicStore = useTopicStore()
    const forum = useForumStore()
    const discoveredTopicNames = computed(() =>
      Object.keys(topicStore.topics).sort(),
    )
    const selectedForumTopic = computed(() => forum.selectedTopic)
    async function browseForumTopic(name: string) {
      forum.setSelectedTopic(name)
      if (!route.path.startsWith('/forum')) {
        await router.push('/forum')
      }
      const wallet = await useActiveWallet()
      await forum.refreshMessages({ wallet, topic: name })
    }

    // Balance polling (real user report: an external transfer never showed up without a reload)
    // now lives in the shared `useBalance` composable (ticket #213): one ref-counted loop with
    // in-flight guard, visibility/app-resume handling and backoff, shared with the Receive page.
    const { formattedBalance, loaded, hasError } = useBalance()
    // Same unknown representation as Receive: an em dash until the first successful fetch, never
    // a false "0". After a failure following a good fetch (#272) the last-known value stays,
    // marked stale, rather than flipping to a dash.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const balanceStale = computed(() => loaded.value && hasError.value)

    onMounted(() => {
      // Fire-and-forget, same convention as `ForumLayout.vue`'s own identical call --
      // `refreshDiscoveredTopics` already fails soft and never throws (`stores/topics.ts`).
      // Called here too (not just there) so this list is populated even if the user never opens
      // the Forum page itself first -- the whole point is to make forums discoverable *before*
      // you already know one exists.
      topicStore.refreshDiscoveredTopics()
    })

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
    const tab = ref<'contacts' | 'settings' | 'forum'>('contacts')
    watch(
      () => route.path,
      path => {
        // `/new-post` (not `/forum/new-post`) is intentionally a top-level path -- see
        // `router/index.ts`'s own comment on `protectedRoutes` -- but is still a Forum page.
        // Only force the highlight *into* 'forum' on navigation -- never overrides a subsequent
        // direct 'settings'/'contacts' click, since this only runs when `path` itself changes.
        if (path.startsWith('/forum') || path.startsWith('/new-post')) {
          tab.value = 'forum'
        }
      },
      { immediate: true },
    )

    return {
      tab,
      openActiveOrRecentChat,
      openForumTab,
      discoveredTopicNames,
      selectedForumTopic,
      browseForumTopic,
      totalUnread: totalUnread,
      balanceText,
      balanceStale,
      loaded,
      legacyRelayEnabled: legacyLotusModeEnabled(),
    }
  },
  components: {
    ChatListLink,
    ChatList,
    SettingsPanel,
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
      openChat(this.$router, address)
    },
    contactsLabel(): string {
      const n = this.totalUnread
      if (!n) return this.$t('leftDrawer.contacts')
      return this.$t(
        n === 1
          ? 'leftDrawer.contactsUnreadOne'
          : 'leftDrawer.contactsUnreadOther',
        { count: n },
      )
    },
    // Tabpanel wiring for the rail (see the tablist comment in the template). Without the rail
    // (signed-out: no tabs rendered) the list is just content, so no dangling aria-labelledby.
    panelAttrs(name: 'settings' | 'contacts' | 'forum') {
      if (!this.$status.setup) return {}
      return {
        'id': `rail-panel-${name}`,
        'role': 'tabpanel',
        'aria-labelledby': `rail-tab-${name}`,
      }
    },
    openReceive() {
      openPage(this.$router, '/receive')
    },
  },
  computed: {
    relayConnected(): boolean {
      return this.$relay.connected
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
  color: #f0409b;
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

.list-column {
  min-width: 0; // allow the flex child to shrink below its content's natural width, so long chat
  // names/previews ellipsize instead of forcing the whole drawer wider than intended.
}
</style>
