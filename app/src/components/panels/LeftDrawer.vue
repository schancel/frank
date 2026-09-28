<template>
  <div class="column full-height">
    <!-- Relay reconnect dialog -->
    <q-dialog v-if="legacyRelayEnabled" v-model="relayConnectOpen">
      <relay-connect-dialog />
    </q-dialog>

    <q-tabs v-model="tab" v-if="$status.setup">
      <q-tab v-if="$status.setup" name="settings" icon="settings" />
      <!-- No @click navigation here, matching "settings" -- this tab only switches the drawer's
      local display mode (the chat-list, already always in the DOM), it doesn't own a route of
      its own. It used to do `$router.push('/')`, which (via `/`'s own redirect) always navigated
      to whatever the "primary" route was -- `/topic/news` before #61, `/forum` after this fix --
      fighting with the "forum" tab below for control of `tab`'s value on every click. -->
      <q-tab name="contacts" icon="contacts">
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

    <!-- Ticket #61 (found in review): the "forum" tab navigates away entirely (it's a full
    page/route, not a sidebar-list mode) rather than switching to some 'tab == "forum"' content
    here -- so without this, clicking it left this whole drawer body blank (matched neither
    'settings' nor 'contacts'). Falling back to showing contacts is an arbitrary but reasonable
    default; there's no forum-specific content this drawer could show instead. -->
    <chat-list
      v-show="tab == 'contacts' || tab == 'forum'"
      v-bind="$attrs"
      :compact="false"
    />

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
import { computed, defineComponent, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'

import ChatList from '../chat/ChatList.vue'
import ChatListLink from '../chat/ChatListLink.vue'
import SettingsPanel from '../panels/SettingsPanel.vue'
import RelayConnectDialog from '../dialogs/RelayConnectDialog.vue'

import { openChat, openPage } from '../../utils/routes'
import { useChatStore } from 'src/stores/chats'
import { activeChain } from '@frank/wallet/chain'
import { useActiveWallet } from 'src/composables/useActiveWallet'

const compactCutoff = 325

export default defineComponent({
  setup() {
    const chats = useChatStore()
    const { totalUnread } = storeToRefs(chats)
    const balance = ref(0n)
    const route = useRoute()

    onMounted(async () => {
      try {
        const wallet = await useActiveWallet()
        balance.value = await activeChain.nativeTransfers.getBalance({ wallet })
      } catch {
        // The setup route may render the drawer before a seed exists.
      }
    })

    // Drives the left rail's active-tab highlight (`q-tabs v-model="tab"`). A writable computed,
    // not a plain `data()` ref watched from the Options API side (the previous attempt at this
    // fix) -- `useRoute()`'s reactive `route` is the Composition API's own, more direct seam onto
    // routing state, and a computed getter/setter is the standard Vue 3 pattern for a v-model
    // that needs to be driven by one source (the route, for "forum") but stay freely settable by
    // the other (a direct "contacts"/"settings" tab click, neither of which owns a route of its
    // own -- see this file's template for why "contacts" no longer navigates at all).
    const localTab = ref<'contacts' | 'settings'>('contacts')
    const tab = computed<string>({
      get() {
        // `/new-post` (not `/forum/new-post`) is intentionally a top-level path -- see
        // `router/index.ts`'s own comment on `protectedRoutes` -- but is still a Forum page.
        if (
          route.path.startsWith('/forum') ||
          route.path.startsWith('/new-post')
        ) {
          return 'forum'
        }
        return localTab.value
      },
      set(value: string) {
        if (value === 'contacts' || value === 'settings') {
          localTab.value = value
        }
        // Clicking "forum" itself navigates via the template's own `@click`, which updates
        // `route.path`, which this computed's getter already reacts to -- nothing to store here.
      },
    })

    return {
      tab,
      totalUnread: totalUnread,
      formattedBalance: computed(
        () =>
          `${activeChain.toDisplayAmount(balance.value)} ${activeChain.unit}`,
      ),
      legacyRelayEnabled:
        import.meta.env.QCLI_MONAD_SKIP_LEGACY_SETUP_GATE === 'false',
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
