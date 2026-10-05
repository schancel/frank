<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <q-card>
        <q-card-section>
          <div class="text-h6" data-testid="wallet-name">
            {{ $t('walletPanel.mainWallet') }}
          </div>
          <div class="text-caption" data-testid="wallet-chain">
            {{ $t('walletPanel.monad') }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div
            class="text-bold text-subtitle1 text-center"
            role="status"
            aria-live="polite"
            data-testid="wallet-balance"
          >
            {{ balanceText }}
          </div>
          <div
            v-if="hasError"
            class="text-negative text-caption text-center"
            data-testid="wallet-balance-error"
          >
            {{ $t('walletPanel.balanceUnavailable') }}
          </div>
        </q-card-section>
        <q-separator />
        <q-card-section>
          <div class="row">
            <q-input
              class="fit"
              filled
              auto-grow
              v-model="displayAddress"
              readonly
            >
              <template #after>
                <q-btn
                  dense
                  color="primary"
                  flat
                  icon="content_copy"
                  :aria-label="$t('a11y.copyAddress')"
                  :disable="!displayAddress"
                  data-testid="wallet-copy-address"
                  @click="copyAddress"
                />
              </template>
            </q-input>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn
            outline
            no-caps
            :label="$t('accountRecovery.backup_account_codex32')"
            color="primary"
            data-testid="backup-codex32-button"
            @click="openBackupDialog"
          />
          <q-btn
            :label="$t('walletPanel.receive')"
            color="primary"
            data-testid="wallet-receive-action"
            @click="openReceive"
          />
          <q-btn
            :label="$t('walletPanel.send')"
            color="primary"
            data-testid="wallet-send-action"
            @click="openSend"
          />
        </q-card-actions>
      </q-card>

      <codex32-backup-dialog
        v-model="showBackupDialog"
        :loading="backupLoading"
        :error="backupError"
        :shares="backupShares"
        @close="closeBackupDialog"
      />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountStatus } from '../accounts/session'
import { useCodex32Backup } from 'src/composables/useCodex32Backup'
import Codex32BackupDialog from 'src/components/wallet/Codex32BackupDialog.vue'

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  components: { Codex32BackupDialog },
  setup() {
    const router = useRouter()
    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const { formattedBalance, loaded, hasError } = useBalance()
    const {
      showBackupDialog,
      backupLoading,
      backupError,
      backupShares,
      openBackupDialog,
      closeBackupDialog,
    } = useCodex32Backup()
    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const displayAddress = ref('')

    watch(
      () => [accountStatus.status, accountStatus.revision],
      async ([status], _previous, onCleanup) => {
        displayAddress.value = ''
        if (status !== 'ready') return
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          const wallet = await useActiveWallet()
          if (current) displayAddress.value = wallet.identity.displayAddress
        } catch (err) {
          if (current)
            errorNotify(err, { fallbackKey: 'walletPanel.failedLoadAddress' })
        }
      },
      { immediate: true, flush: 'sync' },
    )

    return {
      displayAddress,
      balanceText,
      hasError,
      showBackupDialog,
      backupLoading,
      backupError,
      backupShares,
      openBackupDialog,
      closeBackupDialog,
      async copyAddress() {
        if (!displayAddress.value) return
        try {
          await copyToClipboard(displayAddress.value)
          addressCopiedNotify()
        } catch (err) {
          errorNotify(err, { fallbackKey: 'walletPanel.unableCopyAddress' })
        }
      },
      openSend() {
        openPage(router, '/send')
      },
      openReceive() {
        openPage(router, '/receive')
      },
    }
  },
})
</script>
