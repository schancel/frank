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
import { defineComponent, ref, watch } from 'vue'
import { QBtn } from 'quasar'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import { fetchCuratedDefaultContacts } from '@frank/wallet/monad-identity'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain'
import { applyLocale } from 'src/utils/apply-locale'
import { useRelayClientStore } from 'src/stores/relay-client'
import { useAppearanceStore } from 'src/stores/appearance'
import { useProfileStore } from 'src/stores/my-profile'
import { useContactStore } from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { usePersistentStorageStore } from 'src/stores/persistent-storage'
import { applyTheme } from 'src/utils/theme'
import { openChat } from 'src/utils/routes'

import ContactBookDialog from 'src/components/dialogs/ContactBookDialog.vue'
import { accountStatus } from './accounts/session'

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
    const { darkMode, locale, theme } = storeToRefs(appearanceStore)
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
    watch(
      [darkMode, theme],
      ([isDark, currentTheme]) => {
        applyTheme(currentTheme, isDark)
      },
      { immediate: true },
    )

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
      theme,
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
      this.$status.setup = accountStatus.status === 'ready'
      if (this.$status.setup) this.loadCuratedDefaults()
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
