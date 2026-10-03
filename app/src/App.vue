<template>
  <q-btn
    v-show="false"
    @click="promptNotificationPermission"
    ref="buttonNotification"
  />
  <q-dialog v-model="contactBookOpen">
    <contact-book-dialog :contact-click="contactClicked" />
  </q-dialog>

  <router-view @setupCompleted="setupConnections" />
</template>

<script lang="ts">
import assert from 'assert'

import { defineComponent, ref, watch } from 'vue'
import { QBtn } from 'quasar'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import { registrys, networkName } from 'src/utils/constants'
import { RegistryHandler } from '@frank/cashweb/registry'
import { fetchCuratedDefaultContacts } from '@frank/wallet/monad-identity'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import { errorNotify } from 'src/utils/notifications'
import { applyLocale } from 'src/utils/apply-locale'
import { useRelayClientStore } from 'src/stores/relay-client'
import { useAppearanceStore } from 'src/stores/appearance'
import { useProfileStore } from 'src/stores/my-profile'
import { useContactStore } from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { usePersistentStorageStore } from 'src/stores/persistent-storage'
import { openChat } from 'src/utils/routes'

import ContactBookDialog from 'src/components/dialogs/ContactBookDialog.vue'
import { useWallet } from './utils/clients'
import { monadModeEnabled } from './utils/runtime-mode'
import { isSetupComplete } from 'src/utils/account-state'
import { useWalletStore } from 'src/stores/wallet'

export default defineComponent({
  components: {
    ContactBookDialog,
  },
  setup() {
    // Setup chats, contacts, etc.
    const chatStore = useChatStore()
    const relayClient = useRelayClientStore()
    const contacts = useContactStore()
    const appearanceStore = useAppearanceStore()
    const { darkMode, locale } = storeToRefs(appearanceStore)
    const myProfile = useProfileStore()

    const {
      getLastReceived: lastReceived,
      totalUnread,
      activeChatAddr,
    } = storeToRefs(chatStore)

    const router = useRouter()

    watch(activeChatAddr, newAddress => {
      // Only route to chat if address defined
      // e.g. do *not* route when navigating to Forum
      if (!newAddress) {
        return
      }
      openChat(router, newAddress)
    })

    const contactClicked = (newAddress: string) => {
      openChat(router, newAddress)
    }
    const contactBookOpen = ref(false)

    return {
      addDefaultContact: contacts.addDefaultContact,
      refreshContacts: contacts.refreshContacts,
      replaceCuratedDefaults: contacts.replaceCuratedDefaults,
      clearCuratedDefaults: contacts.clearCuratedDefaults,
      // FIXME: Some kind of race condition here where if this is computed,
      // it won't be set yet by the time the setupConnections function is called
      // after signing up or logging in.
      relayToken: () => relayClient.token,
      contactClicked,
      darkMode,
      locale,
      lastReceived,
      totalUnread,
      getRelayData: myProfile,
      buttonNotification: ref<QBtn | null>(null),
      shortcutKeyListener(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          contactBookOpen.value = !contactBookOpen.value
        }
      },
      contactBookOpen,
    }
  },
  data() {
    return {
      notificationPermission:
        typeof Notification !== 'undefined' ? Notification.permission : null,
    }
  },
  methods: {
    promptNotificationPermission() {
      if (typeof Notification === 'undefined') {
        return
      }
      try {
        Notification.requestPermission().then(
          () => (this.notificationPermission = Notification.permission),
        )
      } catch (error) {
        // Safari doesn't return a promise for requestPermissions and it
        // throws a TypeError. It takes a callback as the first argument
        // instead.
        if (error instanceof TypeError) {
          Notification.requestPermission(() => {
            this.notificationPermission = Notification.permission
          })
        } else {
          throw error
        }
      }
    },
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
      if (monadModeEnabled()) {
        const walletStore = useWalletStore()
        const profileStore = useProfileStore()
        if (
          !isSetupComplete({
            seedPhrase: walletStore.seedPhrase,
            name: profileStore.profile.name,
            seedConfirmedAt: walletStore.seedConfirmedAt,
          })
        ) {
          return
        }
        this.$status.setup = true
        this.loadCuratedDefaults()
        return
      }
      // Not currently setup. User needs to go through setup flow first
      if (!this.relayToken()) {
        return
      }
      this.$status.setup = true
      const wallet = useWallet()

      console.log('Loading')
      // Setup everything at once. This are independent processes
      try {
        if (wallet.myAddress) {
          this.$relayClient.setUpWebsocket(wallet.myAddress)
        } else {
          console.error('wallet.myAddress not setup yet in MainLayout.vue')
        }
      } catch (err) {
        console.error(err)
      }

      // Add relay-served default contacts (ticket #49) and remember which
      // addresses the relay curated for this session (#425).
      this.loadCuratedDefaults()

      // const lastReceived = this.lastReceived
      const t0 = performance.now()
      const refreshMessages = () => {
        this.$q.loading.show({ message: 'Loading messages' })
        // Wait for a connected blockchain client
        if (!this.$indexer.connected) {
          setTimeout(refreshMessages, 100)
          return
        }
        this.$relayClient
          .refresh()
          .then(() => {
            const t1 = performance.now()
            console.log(`Loading messages took ${t1 - t0}ms`)
            this.$status.loaded = true
            this.$q.loading.hide()
          })
          .catch(err => {
            console.error(err)
            setTimeout(refreshMessages, 100)
          })
      }
      refreshMessages()

      const handler = new RegistryHandler({
        wallet: wallet,
        registrys: registrys,
        networkName,
      })
      assert(wallet.myAddress, 'Address not yet defined?')

      // Update registry data if it doesn't exist.
      handler.getRelayUrl(wallet.displayAddress).catch(() => {
        if (!wallet.identityPrivKey) {
          return
        }
        handler.updateKeyMetadata(this.$relayClient.url, wallet.identityPrivKey)
      })

      // Update profile if it doesn't exist.
      this.$relayClient.getRelayData(wallet.myAddress).catch(() => {
        if (!wallet.identityPrivKey) {
          return
        }
        const relayData = this.getRelayData

        this.$relayClient
          .updateProfile(
            wallet.identityPrivKey,
            relayData.profile,
            relayData.inbox.acceptancePrice,
          )
          .catch(err => {
            console.error(err)
            // TODO: Move specialization down error displayer
            if (err.response.status === 413) {
              errorNotify(err, { fallbackKey: 'profileDialog.avatarTooLarge' })
              this.$q.loading.hide()
              throw err
            }
            errorNotify(err, {
              fallbackKey: 'profileDialog.unableContactRelay',
            })
            throw err
          })
      })
    },
  },
  created() {
    this.$q.dark.set(this.darkMode)
    // Restores the persisted locale (ticket #156) -- `appearanceStore.restored` is already
    // awaited by boot/setup-apis.ts before the app ever mounts, so `this.locale` here is already
    // the real saved value, not the store's just-initialized default.
    void applyLocale({
      $q: this.$q,
      setI18nLocale: value => {
        this.$i18n.locale = value
      },
      locale: this.locale,
    })
    this.setupConnections()
  },
  updated() {
    // Ask browser for notification permissions after any DOM update
    switch (this.notificationPermission) {
      case 'denied':
      case 'granted':
        break
      default:
        this.buttonNotification?.click()
    }
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.shortcutKeyListener)
  },
  mounted() {
    document.addEventListener('keydown', this.shortcutKeyListener)
    // Ticket #370: a returning user's stored seed should survive browser storage cleanup. Fails
    // soft (never throws) and does nothing without an account.
    void usePersistentStorageStore().ensureForAccount()
  },
})
</script>
