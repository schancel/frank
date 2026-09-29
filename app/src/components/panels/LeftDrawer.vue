<template>
  <div class="column full-height">
    <!-- Relay reconnect dialog -->
    <q-dialog v-if="legacyRelayEnabled" v-model="relayConnectOpen">
      <relay-connect-dialog />
    </q-dialog>

    <q-tabs v-model="tab" v-if="$status.setup">
      <q-tab v-if="$status.setup" name="settings" icon="settings" />
      <!-- Navigates to the active (or most recently used) chat, so this tab actually shows
      something different from "forum" in the main pane -- an earlier version of this fix
      removed navigation entirely to stop it fighting with "forum" over `/`, but that also made
      clicking it a visible no-op whenever you were already on /forum (same main content, same
      chat-list underneath, nothing about the click was ever observable). openActiveOrRecentChat
      navigates to a genuinely different, contacts-focused route instead of re-using `/`. -->
      <q-tab name="contacts" icon="contacts" @click="openActiveOrRecentChat">
        <q-badge
          floating
          color="secondary"
          :label="totalUnread"
          class="q-my-xs"
          v-if="totalUnread !== 0"
        />
      </q-tab>

      <!-- Per-owner decision (2026-09-27, following #61): the flat groupchat-style Topics list is
      hidden in favor of the Forum's threaded view -- both still work (stores/topics.ts and
      stores/forum.ts share the same activeChain.topics data), but only Forum is surfaced in nav
      now. This tab navigates straight to /forum rather than switching local drawer content, since
      Forum is a full page/route, not another sidebar-list mode like contacts/settings. -->
      <q-tab name="forum" icon="forum" @click="$router.push('/forum')" />
    </q-tabs>

    <settings-panel v-if="$status.setup" v-show="tab == 'settings'" />
    <div v-if="!$status.setup">
      <q-separator />
      <chat-list-link title="Login/Sign Up" route="/setup" icon="login" />
    </div>

    <chat-list v-show="tab == 'contacts'" v-bind="$attrs" :compact="false" />

    <!-- Real user-reported gap (ticket #61's own follow-up comment admitted this was a stopgap:
    "there's no forum-specific content this drawer could show instead"): clicking "forum" used to
    just fall back to showing the same chat-list as "contacts" -- so the two tabs looked and
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
    <div class="full-width column col" v-show="tab == 'forum'">
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
          <q-item-label caption>{{ formattedBalance }}</q-item-label>
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
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
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
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { legacyLotusModeEnabled } from 'src/utils/runtime-mode'

const compactCutoff = 325

export default defineComponent({
  setup() {
    const chats = useChatStore()
    const { totalUnread } = storeToRefs(chats)
    const balance = ref(0n)
    const route = useRoute()
    const router = useRouter()

    // "Contacts" tab's click target -- opens the currently active chat if there is one, else the
    // most recently active one from the sorted chat list, so this tab actually navigates
    // somewhere genuinely different from "forum" (see the template's comment on this tab for why
    // it needs to navigate at all, rather than being a pure local-display-mode switch like
    // "settings"). A brand new user with zero conversations yet has nothing to navigate to --
    // the chat-list's own "Add contacts from the drawer above..." empty state already
    // communicates that, so doing nothing here is the correct, safe fallback.
    function openActiveOrRecentChat() {
      const address =
        chats.activeChatAddr ?? chats.getSortedChatOrder[0]?.address
      if (address) {
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

    // Real user report: sent MON to their own address from an external wallet and the sidebar
    // balance never updated. Root cause was that this only ever fetched once, in `onMounted` --
    // nothing re-ran it afterwards, so any balance change (an external transfer in, a stamp
    // payment out, ...) never showed up without a full app reload. Poll instead, same lifecycle-
    // scoped `setInterval`-with-cleanup shape as `Chat.vue`'s own `window.addEventListener(
    // 'resize', ...)` / `beforeUnmount` pair.
    async function refreshBalance() {
      try {
        const wallet = await useActiveWallet()
        balance.value = await activeChain.nativeTransfers.getBalance({ wallet })
      } catch {
        // The setup route may render the drawer before a seed exists.
      }
    }
    const balancePollMs = 15000
    let balancePollHandle: ReturnType<typeof setInterval> | undefined

    onMounted(() => {
      void refreshBalance()
      balancePollHandle = setInterval(
        () => void refreshBalance(),
        balancePollMs,
      )
      // Fire-and-forget, same convention as `ForumLayout.vue`'s own identical call --
      // `refreshDiscoveredTopics` already fails soft and never throws (`stores/topics.ts`).
      // Called here too (not just there) so this list is populated even if the user never opens
      // the Forum page itself first -- the whole point is to make forums discoverable *before*
      // you already know one exists.
      topicStore.refreshDiscoveredTopics()
    })

    onUnmounted(() => {
      clearInterval(balancePollHandle)
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
      discoveredTopicNames,
      selectedForumTopic,
      browseForumTopic,
      totalUnread: totalUnread,
      formattedBalance: computed(
        () =>
          `${activeChain.toDisplayAmount(balance.value)} ${activeChain.unit}`,
      ),
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
</style>
