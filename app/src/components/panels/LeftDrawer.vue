<template>
  <div class="column full-height">
    <!-- Relay reconnect dialog -->
    <q-dialog v-model="relayConnectOpen">
      <relay-connect-dialog />
    </q-dialog>

    <q-tabs v-model="tab" v-if="$status.setup">
      <q-tab v-if="$status.setup" name="settings" icon="settings" />
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

    <chat-list v-show="tab == 'contacts'" v-bind="$attrs" :compact="false" />

    <q-list v-if="$status.setup">
      <q-separator />
      <q-item clickable>
        <q-item-section @click="openReceive">
          <q-item-label>{{ $t('chatList.balance') }}</q-item-label>
          <q-item-label caption>{{ formattedBalance }}</q-item-label>
        </q-item-section>
        <q-item-section
          v-if="!relayConnected"
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

    onMounted(async () => {
      try {
        const wallet = await useActiveWallet()
        balance.value = await activeChain.nativeTransfers.getBalance({ wallet })
      } catch {
        // The setup route may render the drawer before a seed exists.
      }
    })

    return {
      totalUnread: totalUnread,
      formattedBalance: computed(
        () =>
          `${activeChain.toDisplayAmount(balance.value)} ${activeChain.unit}`,
      ),
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
      tab: 'contacts',
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
