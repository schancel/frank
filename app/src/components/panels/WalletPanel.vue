<template>
  <div class="full-width column col" data-test="wallet-panel">
    <q-scroll-area class="col">
      <q-list>
        <q-item-label header>{{ $t('walletPanel.title') }}</q-item-label>

        <!-- Monad Main Wallet -->
        <q-item
          clickable
          v-ripple
          data-test="wallet-row"
          :active="selectedChain === 'monad'"
          active-class="active-chat-list-item"
          @click="selectWallet('monad')"
        >
          <q-item-section avatar>
            <q-icon name="account_balance_wallet" />
          </q-item-section>
          <q-item-section>
            <q-item-label data-test="wallet-name" class="row items-center">
              <span>{{ $t('walletPanel.mainWallet') }}</span>
              <q-badge
                v-if="isTestnet"
                outline
                color="amber-9"
                class="q-ml-xs text-bold"
                data-test="testnet-badge"
              >
                {{ $t('walletPanel.testnet') }}
              </q-badge>
            </q-item-label>
            <q-item-label caption role="status" data-test="wallet-balance">
              {{
                loaded
                  ? formattedBalance
                  : $t(
                      hasError
                        ? 'walletPanel.balanceUnavailable'
                        : 'walletPanel.balanceLoading',
                    )
              }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption data-test="wallet-chain">
              {{ isTestnet ? $t('walletPanel.monadTestnet') : $t('walletPanel.monad') }}
            </q-item-label>
          </q-item-section>
        </q-item>
        <p
          v-if="loaded && hasError"
          role="status"
          data-test="balance-stale"
          class="q-px-md text-caption text-negative"
        >
          {{ $t('accountRecovery.balance_stale') }}
        </p>

        <q-separator class="q-my-sm" />

        <!-- eCash Wallet -->
        <q-item
          clickable
          v-ripple
          data-test="ecash-wallet-row"
          :active="selectedChain === 'ecash'"
          active-class="active-chat-list-item"
          @click="selectWallet('ecash')"
        >
          <q-item-section avatar>
            <q-icon name="toll" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="row items-center">
              <span>{{ isTestnet ? $t('walletPanel.ecashTestnet') : $t('walletPanel.ecash') }}</span>
              <q-badge
                v-if="isTestnet"
                outline
                color="amber-9"
                class="q-ml-xs text-bold"
                data-test="ecash-testnet-badge"
              >
                {{ $t('walletPanel.testnet') }}
              </q-badge>
            </q-item-label>
            <q-item-label caption>{{ isTestnet ? $t('walletPanel.zeroTxec') : $t('walletPanel.zeroXec') }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ isTestnet ? $t('walletPanel.ecashTestnet') : $t('walletPanel.ecash') }}</q-item-label>
          </q-item-section>
        </q-item>

        <!-- Solana Wallet -->
        <q-item
          clickable
          v-ripple
          data-test="solana-wallet-row"
          :active="selectedChain === 'solana'"
          active-class="active-chat-list-item"
          @click="selectWallet('solana')"
        >
          <q-item-section avatar>
            <q-icon name="account_balance" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="row items-center">
              <span>{{ isTestnet ? $t('walletPanel.solanaTestnet') : $t('walletPanel.solana') }}</span>
              <q-badge
                v-if="isTestnet"
                outline
                color="amber-9"
                class="q-ml-xs text-bold"
                data-test="solana-testnet-badge"
              >
                {{ $t('walletPanel.testnet') }}
              </q-badge>
            </q-item-label>
            <q-item-label caption>{{ isTestnet ? $t('walletPanel.zeroTsol') : $t('walletPanel.zeroSol') }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-item-label caption>{{ isTestnet ? $t('walletPanel.solanaTestnet') : $t('walletPanel.solana') }}</q-item-label>
          </q-item-section>
        </q-item>

        <q-separator class="q-my-sm" />

        <div class="q-pa-sm">
          <q-btn
            outline
            no-caps
            color="primary"
            class="full-width"
            :label="$t('accountRecovery.backup_account_codex32')"
            data-test="backup-codex32-button"
            @click="openBackupDialog"
          />
        </div>
      </q-list>
    </q-scroll-area>

    <codex32-backup-dialog
      v-model="showBackupDialog"
      :loading="backupLoading"
      :error="backupError"
      :shares="backupShares"
      :threshold="threshold"
      :count="count"
      @cycle-scheme="cycleScheme"
      @change-scheme="setScheme"
      @close="closeBackupDialog"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeChain } from '@frank/wallet/chain'
import { useBalance } from '../../composables/useBalance'
import { useCodex32Backup } from '../../composables/useCodex32Backup'
import Codex32BackupDialog from '../wallet/Codex32BackupDialog.vue'

const isTestnet = computed(() => activeChain.isTestnet ?? false)

const router = useRouter()
const route = useRoute()

const selectedChain = computed(() => {
  const currentPath = route?.path ?? ''
  if (currentPath && currentPath.startsWith('/wallet')) {
    const chain = route?.query?.chain
    if (chain === 'ecash' || chain === 'solana') return chain
    return 'monad'
  }
  return null
})

function selectWallet(chain: 'monad' | 'ecash' | 'solana') {
  if (router) {
    if (chain === 'monad') {
      router.push('/wallet')
    } else {
      router.push({ path: '/wallet', query: { chain } })
    }
  }
}

const { loaded, hasError, formattedBalance } = useBalance()
const {
  showBackupDialog,
  backupLoading,
  backupError,
  backupShares,
  threshold,
  count,
  openBackupDialog,
  closeBackupDialog,
  cycleScheme,
  setScheme,
} = useCodex32Backup()
</script>

<style lang="scss" scoped>
.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: #f0409b;
}
</style>
