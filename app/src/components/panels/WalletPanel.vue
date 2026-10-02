<template>
  <div
    ref="panelRoot"
    class="full-width column col"
    tabindex="-1"
    data-test="wallet-panel"
  >
    <q-dialog v-model="seedPhraseOpen">
      <seed-phrase-dialog />
    </q-dialog>
    <q-dialog v-model="seedConfirmOpen" @hide="onSeedConfirmHide">
      <seed-confirm-dialog @confirmed="onSeedConfirmed" />
    </q-dialog>

    <backup-reminder @confirm="seedConfirmOpen = true" />

    <q-scroll-area class="col">
      <q-list>
        <q-item-label header>{{ $t('walletPanel.title') }}</q-item-label>
        <!-- One row per wallet (#570). The store is single-wallet today, so this list is derived
        at the UI layer rather than stored; a wallet registry arrives with the multichain /
        multi-account decisions (#385, #497). Clicking a row opens the wallet's detail view in the
        main pane, where Send/Receive live. -->
        <q-item data-test="wallet-row" clickable v-ripple @click="openWallet">
          <q-item-section avatar>
            <q-icon name="account_balance_wallet" />
          </q-item-section>
          <q-item-section>
            <q-item-label data-test="wallet-name">{{
              $t('walletPanel.mainWallet')
            }}</q-item-label>
            <q-item-label
              caption
              role="status"
              aria-live="polite"
              data-test="wallet-balance"
            >
              {{ balanceText }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption data-test="wallet-chain">{{
              $t('walletPanel.monad')
            }}</q-item-label>
          </q-item-section>
        </q-item>

        <q-separator />

        <q-item
          data-test="show-seed-item"
          clickable
          v-ripple
          @click="seedPhraseOpen = true"
        >
          <q-item-section avatar><q-icon name="key" /></q-item-section>
          <q-item-section>{{ $t('walletPanel.showSeed') }}</q-item-section>
        </q-item>
        <q-item
          v-if="backupUnconfirmed"
          clickable
          v-ripple
          data-test="confirm-seed-item"
          @click="seedConfirmOpen = true"
        >
          <q-item-section avatar><q-icon name="fact_check" /></q-item-section>
          <q-item-section>{{ $t('walletPanel.confirmSeed') }}</q-item-section>
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, nextTick, ref } from 'vue'

import BackupReminder from './BackupReminder.vue'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'
import SeedPhraseDialog from '../dialogs/SeedPhraseDialog.vue'
import { useBalance } from 'src/composables/useBalance'
import { useWalletStore } from 'src/stores/wallet'
import { useProfileStore } from 'src/stores/my-profile'
import { needsBackupConfirmation } from 'src/utils/account-state'
import { openPage } from 'src/utils/routes'

export default defineComponent({
  components: { BackupReminder, SeedConfirmDialog, SeedPhraseDialog },
  setup() {
    const wallet = useWalletStore()
    const profile = useProfileStore()
    const { formattedBalance, loaded, hasError } = useBalance()
    const seedPhraseOpen = ref(false)
    const seedConfirmOpen = ref(false)
    const panelRoot = ref<HTMLElement | null>(null)
    let justConfirmed = false

    const backupUnconfirmed = computed(() =>
      needsBackupConfirmation({
        seedPhrase: wallet.seedPhrase,
        name: profile.profile?.name,
        seedConfirmedAt: wallet.seedConfirmedAt,
      }),
    )

    return {
      seedPhraseOpen,
      seedConfirmOpen,
      panelRoot,
      backupUnconfirmed,
      formattedBalance,
      loaded,
      hasError,
      onSeedConfirmed() {
        justConfirmed = true
        seedConfirmOpen.value = false
      },
      onSeedConfirmHide() {
        if (!justConfirmed) return
        justConfirmed = false
        void nextTick(() => panelRoot.value?.focus())
      },
    }
  },
  computed: {
    balanceText(): string {
      if (!this.loaded) {
        return this.hasError
          ? this.$t('walletPanel.balanceUnavailable')
          : this.$t('walletPanel.balanceLoading')
      }
      return this.hasError
        ? this.$t('walletPanel.balanceStale', {
            balance: this.formattedBalance,
          })
        : this.formattedBalance
    },
  },
  methods: {
    openWallet() {
      openPage(this.$router, '/wallet')
    },
  },
})
</script>
