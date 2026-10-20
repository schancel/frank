<template>
  <q-dialog v-model="contactBookOpen">
    <contact-book-dialog :contact-click="contactClicked" />
  </q-dialog>

  <!-- Yielded Standby Overlay -->
  <q-dialog :model-value="tabCoordinator.isYielded" persistent>
    <q-card style="min-width: 320px; max-width: 480px" class="q-pa-md">
      <q-card-section class="row items-center q-pb-none">
        <q-avatar icon="tab" color="primary" text-color="white" />
        <div class="text-h6 q-ml-md">
          {{ $t('accountRecovery.frank_is_open_in_another_tab') }}
        </div>
      </q-card-section>
      <q-card-section class="q-pt-md">
        <p class="text-body2 text-grey-8">
          {{ $t('accountRecovery.tab_yielded_notice') }}
        </p>
        <p class="text-body2 text-grey-8">
          {{ $t('accountRecovery.multi_tab_notice') }}
        </p>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn
          color="primary"
          no-caps
          :loading="tabCoordinator.isTakingOver"
          :label="$t('accountRecovery.use_frank_here')"
          data-test="overlay-use-frank-here"
          @click="takeoverHere"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <router-view @setupCompleted="setupConnections" />
</template>

<script lang="ts">
import { computed, defineComponent, provide, ref, watch } from 'vue'
import { useNotificationPermissionOffer } from 'src/composables/useNotificationPermissionOffer'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import { fetchCuratedDefaultContacts } from '@frank/wallet/evm-identity'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/evm-chain'
import { applyLocale } from 'src/utils/apply-locale'
import { useRelayClientStore } from 'src/stores/relay-client'
import { useAppearanceStore } from 'src/stores/appearance'
import { useProfileStore } from 'src/stores/my-profile'
import { useContactStore } from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { useSettingsStore } from 'src/stores/settings'
import { usePersistentStorageStore } from 'src/stores/persistent-storage'
import { applyTheme } from 'src/utils/theme'
import { applyViewportScaleAndMetrics } from 'src/utils/mobile-viewport-scale'
import { openChat } from 'src/utils/routes'
import { isChainAddress, toChainDisplayAddress } from 'src/utils/chain-address'

import ContactBookDialog from 'src/components/dialogs/ContactBookDialog.vue'
import { useTabCoordinatorStore } from 'src/stores/tab-coordinator'
import { accountStatus } from './accounts/session'
import { messagingState, messagingWallet } from 'src/utils/identity-session'
import { activeChain } from '@frank/wallet/chain'
import {
  CHAT_SEARCH_SHORTCUT,
  createChatSearchShortcut,
} from './composables/useChatSearchShortcut'
import { useAppOracleFeed } from 'src/composables/useOracleFeed'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../src-bex/content'
import {
  extractValidBackupShares,
  restoreAccountFromExtensionBundle,
  savePendingExtensionSyncPayload,
} from 'src/utils/extension-account-sync'

export default defineComponent({
  components: {
    ContactBookDialog,
  },
  setup() {
    // AVU values stand beside balances and amounts on every screen: the oracle feed is
    // held here, once, for the life of the app (and paused while the window is hidden).
    useAppOracleFeed()
    // Setup chats, contacts, etc.
    const chatStore = useChatStore()
    const relayClient = useRelayClientStore()
    const contacts = useContactStore()
    const appearanceStore = useAppearanceStore()
    const { darkMode, locale, theme, uiScale } = storeToRefs(appearanceStore)
    const myProfile = useProfileStore()
    const settings = useSettingsStore()
    const tabCoordinator = useTabCoordinatorStore()

    useNotificationPermissionOffer(
      computed(
        () => accountStatus.status === 'ready' && !tabCoordinator.isYielded,
      ),
    )

    const takeoverHere = async () => {
      await tabCoordinator.requestTakeover()
    }

    const {
      getLastReceived: lastReceived,
      totalUnread,
      activeConversationId,
    } = storeToRefs(chatStore)

    const router = useRouter()
    const chatSearchShortcut = createChatSearchShortcut()
    provide(CHAT_SEARCH_SHORTCUT, chatSearchShortcut)

    watch(activeConversationId, conversationId => {
      // Selection, including notification clicks, routes to its exact thread owner.
      // Clearing selection while leaving chat must not navigate back into a thread.
      if (!conversationId) return
      const routeAddress = router.currentRoute.value.params.address
      const routedDefault =
        typeof routeAddress === 'string' && isChainAddress(routeAddress)
          ? chatStore.chats[toChainDisplayAddress(routeAddress)]
          : undefined
      // A committed peer route already identifies its default thread, including profile
      // queries. Other selections (such as notifications) open their exact independent ID.
      if (
        routeAddress !== conversationId &&
        routedDefault?.id !== conversationId
      ) {
        void openChat(router, conversationId)
      }
    })

    const contactClicked = (newAddress: string) => {
      openChat(router, newAddress)
    }
    const contactBookOpen = ref(false)
    watch(
      [darkMode, theme, uiScale],
      ([isDark, currentTheme, currentScale]) => {
        applyTheme(currentTheme, isDark)
        applyViewportScaleAndMetrics(currentScale)
      },
      { immediate: true },
    )

    watch(
      () => accountStatus.status,
      status => {
        if (status === 'ready') {
          const runCuratedSync = () => {
            fetchCuratedDefaultContacts({
              relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
            })
              .then(async curated => {
                contacts.replaceCuratedDefaults(curated)
                for (const contact of curated) {
                  await contacts.addDefaultContact(contact)
                }
                await contacts.refreshContacts()
              })
              .catch(err => {
                contacts.clearCuratedDefaults()
                console.error(err)
              })
          }
          if (
            typeof window !== 'undefined' &&
            window.location?.search?.includes('extMode=popup') &&
            contacts.contactList.length > 0
          ) {
            setTimeout(() => {
              if (accountStatus.status === 'ready') runCuratedSync()
            }, 5_000)
          } else {
            runCuratedSync()
          }
        }
      },
    )

    let gatewayDiscoveryWasActive = false
    watch(
      [() => accountStatus.status, () => messagingState.status],
      ([account, messaging]) => {
        const wallet = messaging === 'ready' ? messagingWallet() : undefined
        if (account !== 'ready' || !wallet) {
          // Initial hydration is read-only. Only clear a discovery that this
          // runtime actually started after an active session ends.
          if (gatewayDiscoveryWasActive) {
            settings.clearEmailGatewayDiscovery()
            gatewayDiscoveryWasActive = false
          }
          return
        }
        gatewayDiscoveryWasActive = true
        const relayBaseUrl =
          (wallet as { relayBaseUrl?: string }).relayBaseUrl ??
          loadMonadChainConfigFromEnv().relayBaseUrl
        void settings
          .refreshEmailGateway(relayBaseUrl, activeChain.chainIdentifier)
          .then(() => {
            if (settings.emailGatewayAddress) {
              chatStore.reverifyEmailGateways(settings.emailGatewayAddress)
            }
          })
      },
      { immediate: true },
    )

    return {
      addDefaultContact: contacts.addDefaultContact,
      refreshContacts: contacts.refreshContacts,
      replaceCuratedDefaults: contacts.replaceCuratedDefaults,
      clearCuratedDefaults: contacts.clearCuratedDefaults,
      hasExistingContacts: () => contacts.contactList.length > 0,
      // FIXME: Some kind of race condition here where if this is computed,
      // it won't be set yet by the time the setupConnections function is called
      // after signing up or logging in.
      relayToken: () => relayClient.token,
      contactClicked,
      darkMode,
      theme,
      locale,
      lastReceived,
      totalUnread,
      getRelayData: myProfile,
      tabCoordinator,
      takeoverHere,
      shortcutKeyListener(e: KeyboardEvent) {
        if (
          !(e.metaKey || e.ctrlKey) ||
          e.key.toLowerCase() !== 'k' ||
          e.altKey
        )
          return
        if (e.defaultPrevented || e.isComposing) return
        if (
          accountStatus.status !== 'ready' ||
          contactBookOpen.value ||
          tabCoordinator.isYielded ||
          document.querySelector('.q-dialog, .q-menu')
        )
          return
        e.preventDefault()
        if (e.repeat) return
        const path = router.currentRoute.value.path
        if (path === '/chat' || path.startsWith('/chat/')) {
          chatSearchShortcut.search()
        } else {
          contactBookOpen.value = true
        }
      },
      contactBookOpen,
    }
  },
  methods: {
    loadCuratedDefaults() {
      fetchCuratedDefaultContacts({
        relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
      })
        .then(async contacts => {
          this.replaceCuratedDefaults(contacts)
          for (const contact of contacts) {
            await this.addDefaultContact(contact)
          }
          await this.refreshContacts()
        })
        .catch(err => {
          // A failed fetch must not keep an earlier list, and must not invent one.
          this.clearCuratedDefaults()
          console.error(err)
        })
    },
    setupConnections() {
      this.$status.setup = accountStatus.status === 'ready'
      if (this.$status.setup) {
        if (
          typeof window !== 'undefined' &&
          window.location?.search?.includes('extMode=popup') &&
          this.hasExistingContacts()
        ) {
          setTimeout(() => {
            if (accountStatus.status === 'ready') this.loadCuratedDefaults()
          }, 5_000)
        } else {
          this.loadCuratedDefaults()
        }
      }
    },
    handleGlobalExtensionSyncMessage(event: MessageEvent) {
      const data = event?.data
      if (!data || typeof data !== 'object') return
      if (
        data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
        data.direction === 'to-pwa' &&
        (data.type === 'extension-sync-push' || data.type === 'sync-response')
      ) {
        const payload = data.payload ?? data.result?.syncedState ?? data.result
        const bundle = payload?.deviceSyncBundle
        if (!bundle || typeof bundle !== 'object') return
        savePendingExtensionSyncPayload({
          sasCode: String(payload?.sasCode || ''),
          deviceSyncBundle: bundle,
        })
        const currentPath = this.$route?.path || ''
        if (currentPath === '/onboard') {
          // Onboard.vue handles restoration and peer/claim migration directly
          return
        }
        const shares = extractValidBackupShares(bundle)
        if (shares.length >= 2 && accountStatus.status !== 'ready') {
          void restoreAccountFromExtensionBundle(bundle, {
            onActivated: () => {
              this.setupConnections()
              if (this.$router) {
                void this.$router.push('/forum')
              }
            },
          })
        }
      }
    },
  },
  created() {
    this.$q.dark.set(this.darkMode)
    applyTheme(this.theme, this.darkMode)
    // Restores the persisted locale (ticket #156) -- `appearanceStore.restored` is already
    // awaited by boot/setup-apis.ts before the app ever mounts, so `this.locale` here is already
    // the real saved value, not the store's just-initialized default.
    void applyLocale({
      $q: this.$q,
      setI18nLocale: value => {
        if (this.$i18n) {
          this.$i18n.locale = value
        }
      },
      locale: this.locale,
    })
    this.setupConnections()
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.shortcutKeyListener)
    if (typeof window !== 'undefined') {
      window.removeEventListener(
        'message',
        this.handleGlobalExtensionSyncMessage,
      )
    }
  },
  mounted() {
    document.addEventListener('keydown', this.shortcutKeyListener)
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.handleGlobalExtensionSyncMessage)
    }
    // Ticket #370: a returning user's stored seed should survive browser storage cleanup. Fails
    // soft (never throws) and does nothing without an account.
    void usePersistentStorageStore().ensureForAccount()
  },
})
</script>
