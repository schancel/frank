<template>
  <div
    ref="panelRoot"
    class="full-width column col"
    tabindex="-1"
    data-test="settings-panel"
  >
    <contact-card
      :address="myAddress"
      :name="profile.name"
      :bio="profile.bio"
      :avatar="profile.avatar"
      :acceptance-price="inbox.acceptancePrice"
    />

    <!-- Dismissible reminder for completed accounts whose phrase was never confirmed (#284) -->
    <backup-reminder @confirm="seedConfirmOpen = true" />

    <!-- Contact book dialog -->
    <q-dialog v-model="contactBookOpen">
      <contact-book-dialog
        :contact-click="
          function (address, contact) {
            return setActiveChat(address)
          }
        "
        @close-contact-search-dialog="closeContactSearchDialog"
      />
    </q-dialog>

    <!-- Seed phrase dialog -->
    <q-dialog v-model="seedPhraseOpen">
      <seed-phrase-dialog />
    </q-dialog>

    <!-- Confirm the stored recovery phrase (#284) -->
    <q-dialog v-model="seedConfirmOpen" @hide="onSeedConfirmHide">
      <seed-confirm-dialog @confirmed="onSeedConfirmed" />
    </q-dialog>

    <div class="flex-break" />
    <!-- Drawer -->
    <q-scroll-area class="col">
      <q-list>
        <q-item clickable v-ripple @click="newContact">
          <q-item-section avatar>
            <q-icon name="add_comment" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.newContact') }}</q-item-section>
        </q-item>
        <q-item clickable v-ripple @click="contactBookOpen = true">
          <q-item-section avatar>
            <q-icon name="contacts" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.contacts') }}</q-item-section>
        </q-item>

        <q-separator />

        <q-item clickable v-ripple @click="sendECash">
          <q-item-section avatar>
            <q-icon name="send" />
          </q-item-section>

          <q-item-section>
            {{ $t('SettingPanel.sendMonad') }}
          </q-item-section>
        </q-item>

        <q-item clickable v-ripple @click="receiveECash">
          <q-item-section avatar>
            <q-icon name="account_balance_wallet" />
          </q-item-section>

          <q-item-section>
            {{ $t('SettingPanel.receiveMonad') }}
          </q-item-section>
        </q-item>

        <q-separator />

        <q-item clickable v-ripple @click="openProfile">
          <q-item-section avatar>
            <q-icon name="face" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.profile') }}</q-item-section>
        </q-item>

        <q-item clickable v-ripple @click="openSettings">
          <q-item-section avatar>
            <q-icon name="tune" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.settings') }}</q-item-section>
        </q-item>
        <q-separator />

        <q-item clickable v-ripple @click="deleteForever">
          <q-item-section avatar>
            <q-icon name="delete_forever" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.wipeAndSave') }}</q-item-section>
        </q-item>

        <q-item
          clickable
          v-ripple
          @click="
            $router.push('/changelog').catch(() => {
              // Don't care. Probably duplicate route
            })
          "
        >
          <q-item-section avatar>
            <q-icon name="change_history" />
          </q-item-section>

          <q-item-section>{{ $t('SettingPanel.changeLog') }}</q-item-section>
        </q-item>
        <q-item clickable v-ripple @click="seedPhraseOpen = true">
          <q-item-section avatar>
            <q-icon name="compost" />
          </q-item-section>
          <q-item-section>{{ $t('SettingPanel.showSeed') }}</q-item-section>
        </q-item>
        <q-item
          v-if="backupUnconfirmed"
          clickable
          v-ripple
          data-test="confirm-seed-item"
          @click="seedConfirmOpen = true"
        >
          <q-item-section avatar>
            <q-icon name="fact_check" />
          </q-item-section>
          <q-item-section>{{ $t('SettingPanel.confirmSeed') }}</q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, onMounted, ref } from 'vue'

import SeedPhraseDialog from '../dialogs/SeedPhraseDialog.vue'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'
import BackupReminder from './BackupReminder.vue'
import { useWalletStore } from 'src/stores/wallet'
import { needsBackupConfirmation } from '../../utils/account-state'
import ContactCard from './ContactCard.vue'
import ContactBookDialog from '../dialogs/ContactBookDialog.vue'
import { openChat, openPage } from '../../utils/routes'
import { useChatStore } from 'src/stores/chats'
import { useProfileStore } from 'src/stores/my-profile'
import { storeToRefs } from 'pinia'
import { useActiveWallet } from 'src/composables/useActiveWallet'

export default defineComponent({
  setup() {
    const chats = useChatStore()
    const myProfile = useProfileStore()
    const { profile, inbox } = storeToRefs(myProfile)
    const seedPhraseOpen = ref(false)
    const seedConfirmOpen = ref(false)
    const panelRoot = ref<HTMLElement | null>(null)
    let justConfirmed = false
    const wallet = useWalletStore()
    const backupUnconfirmed = computed(() =>
      needsBackupConfirmation({
        seedPhrase: wallet.seedPhrase,
        name: profile.value?.name,
        seedConfirmedAt: wallet.seedConfirmedAt,
      }),
    )
    const myAddress = ref('')
    onMounted(async () => {
      try {
        myAddress.value = (await useActiveWallet()).identity.displayAddress
      } catch {
        // The setup route may render this panel before a seed exists.
      }
    })
    return {
      deleteMessage: chats.deleteMessage,
      profile,
      inbox,
      seedPhraseOpen,
      seedConfirmOpen,
      panelRoot,
      backupUnconfirmed,
      // The phrase is confirmed: close the dialog. The banner and Settings item that opened it
      // disappear with the marker, so once the dialog is gone put focus on the panel itself
      // rather than on a removed control.
      onSeedConfirmed() {
        justConfirmed = true
        seedConfirmOpen.value = false
      },
      onSeedConfirmHide() {
        if (!justConfirmed) return
        justConfirmed = false
        void nextTick(() => panelRoot.value?.focus())
      },
      myAddress,
    }
  },
  components: {
    ContactCard,
    ContactBookDialog,
    SeedPhraseDialog,
    SeedConfirmDialog,
    BackupReminder,
  },
  data() {
    return {
      contactBookOpen: false,
    }
  },
  emits: ['update:drawerOpen'],
  props: {
    drawerOpen: {
      type: Boolean,
      default: () => false,
    },
  },
  model: {
    prop: 'drawerOpen',
    event: 'update:drawerOpen',
  },
  methods: {
    closeContactSearchDialog() {
      this.contactBookOpen = false
    },
    openSettings() {
      openPage(this.$router, '/settings')
    },
    openProfile() {
      openPage(this.$router, '/profile')
    },
    receiveECash() {
      openPage(this.$router, '/receive')
    },
    sendECash() {
      openPage(this.$router, '/send')
    },
    newContact() {
      openPage(this.$router, '/add-contact')
    },
    deleteForever() {
      openPage(this.$router, '/wipe-wallet')
    },
    setActiveChat(address: string) {
      openChat(this.$router, address)
    },
  },
  computed: {
    drawerOpenModel: {
      get() {
        return this.drawerOpen
      },
      set(value: boolean) {
        this.$emit('update:drawerOpen', value)
      },
    },
  },
})
</script>
