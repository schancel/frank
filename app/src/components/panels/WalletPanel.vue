<template>
  <div class="wallet-panel full-width column col" data-test="wallet-panel">
    <q-scroll-area
      class="wallet-list-scroll col full-width"
      data-test="wallet-list-scroll"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item class="wallet-header-item">
          <q-item-section>
            <q-item-label>{{ $t('walletPanel.title') }}</q-item-label>
          </q-item-section>
        </q-item>
        <q-separator />

        <!-- Wallets (Monad Main Wallet is pinned first) -->
        <template v-for="(wallet, index) in visibleWallets" :key="wallet.id">
          <q-separator v-if="index > 0" />
          <q-item
            clickable
            v-ripple
            dense
            :data-test="wallet.dataTest"
            :active="selectedChain === wallet.id"
            active-class="active-chat-list-item"
            class="wallet-list-item"
            @click="selectWallet(wallet.id)"
          >
            <q-item-section avatar class="wallet-icon-slot">
              <q-icon :name="wallet.icon" />
            </q-item-section>
            <q-item-section class="wallet-row-content">
              <q-item-label
                class="wallet-row-name"
                :data-test="wallet.nameDataTest"
              >
                <span
                  class="ellipsis block"
                  :data-test="wallet.nameTextDataTest"
                >
                  {{ getCustomName(wallet.id) || $t(wallet.defaultNameKey) }}
                </span>
                <q-badge
                  v-if="walletIsTestnet(wallet.id)"
                  outline
                  color="amber-9"
                  class="wallet-network-badge"
                  :label="$t('walletPanel.testnet')"
                  :data-test="wallet.badgeDataTest"
                />
              </q-item-label>
              <q-item-label
                caption
                class="wallet-row-balance ellipsis"
                :data-test="wallet.balanceDataTest"
                :title="nativeBalanceTitle(wallet.id)"
                :aria-label="nativeBalanceTitle(wallet.id)"
              >
                <q-icon
                  v-if="isBalanceStale(wallet.id)"
                  name="history"
                  size="14px"
                  class="q-mr-xs"
                  aria-hidden="true"
                  :data-test="`${wallet.id}-balance-stale-indicator`"
                />{{ nativeBalance(wallet.id) }}
                <mailbox-status-indicator
                  v-if="wallet.isMain"
                  class="q-ml-xs"
                />
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-list>
    </q-scroll-area>
    <footer class="wallet-backup-footer" data-test="wallet-backup-footer">
      <q-separator />
      <button
        type="button"
        class="wallet-backup-action"
        data-test="backup-codex32-button"
        @click="openBackup"
      >
        <q-icon name="backup" aria-hidden="true" />
        <span>{{ $t('accountRecovery.backup_account_codex32') }}</span>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, onBeforeUnmount, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeChain, onActiveChainChange } from '@frank/wallet/chain'
import { useMultichainBalance } from '../../composables/useChainBalance'
import { compactAmountText } from '../../utils/chain-amount'
import { useWalletNames } from '../../composables/useWalletNames'
import { openPage } from '../../utils/routes'
import { walletSupport } from '../../utils/wallet-support'
import { MAIN_WALLET_ID, WALLET_CONFIGS } from '../../utils/wallet-configs'
import MailboxStatusIndicator from '../chat/MailboxStatusIndicator.vue'

const isTestnet = shallowRef(activeChain.isTestnet ?? false)
onBeforeUnmount(
  onActiveChainChange(chain => {
    isTestnet.value = chain.isTestnet ?? false
  }),
)

// Availability is a configured wallet capability, independent of transient balance/RPC errors.
const visibleWallets = computed(() =>
  WALLET_CONFIGS.filter(
    wallet =>
      wallet.enabled !== false &&
      walletSupport(wallet.id, isTestnet.value).status === 'available',
  ),
)
const router = useRouter()
const route = useRoute()
const instance = getCurrentInstance()
const { getCustomName } = useWalletNames()
const { getPresentation } = useMultichainBalance()
function walletIsTestnet(wallet: string): boolean {
  return walletSupport(wallet, isTestnet.value).entry?.isTestnet ?? false
}

function nativeBalance(wallet: string): string {
  const presentation = getPresentation(wallet)
  const observation =
    presentation.status === 'available'
      ? presentation.observation
      : presentation.status === 'unavailable'
      ? presentation.lastKnown
      : undefined
  if (observation) return compactAmountText(observation.formattedBalance)
  const key =
    presentation.status === 'loading'
      ? 'walletPanel.balanceLoading'
      : presentation.status === 'unavailable' &&
        presentation.reason === 'relay-unavailable'
      ? 'walletPanel.relayUnavailable'
      : 'walletPanel.balanceUnavailable'
  return String(instance?.proxy?.$t(key) ?? key)
}

function isBalanceStale(wallet: string): boolean {
  const presentation = getPresentation(wallet)
  return presentation.status === 'available'
    ? presentation.observation.stale === true
    : presentation.status === 'unavailable' && !!presentation.lastKnown
}
function nativeBalanceTitle(wallet: string): string {
  const amount = nativeBalance(wallet)
  return isBalanceStale(wallet)
    ? `${amount}. ${instance?.proxy?.$t('accountRecovery.balance_stale')}`
    : amount
}

defineProps<{ shown?: boolean }>()

const selectedChain = computed(() => {
  const currentPath = route?.path ?? ''
  if (currentPath.startsWith('/wallet')) {
    const parts = currentPath.toLowerCase().split('/').filter(Boolean)
    return parts[1] || MAIN_WALLET_ID
  }
  return null
})

function getRouter() {
  return (router && router.push ? router : null) || instance?.proxy?.$router
}
function selectWallet(wallet: string) {
  getRouter()?.push(wallet === MAIN_WALLET_ID ? '/wallet' : `/wallet/${wallet}`)
}
function openBackup() {
  const router = getRouter()
  if (router) return openPage(router, '/backup')
}
</script>

<style lang="scss" scoped>
.wallet-panel,
.wallet-list-scroll {
  min-height: 0;
  min-width: 0;
}
.wallet-panel {
  container-type: inline-size;
  flex-wrap: nowrap;
}
.wallet-list-item {
  height: 64px;
  min-height: 64px;
  padding: 12px;
  gap: 12px;
}
.wallet-icon-slot {
  flex: 0 0 40px;
  min-width: 40px;
  width: 40px;
  height: 40px;
  padding: 0;
  align-items: center;
  justify-content: center;
}
.wallet-icon-slot :deep(.q-icon) {
  font-size: 24px;
}
.wallet-row-content {
  min-width: 0;
}
.wallet-row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  line-height: 20px;
  height: 20px;
}
.wallet-row-name > span {
  min-width: 0;
  flex: 1 1 auto;
}
.wallet-network-badge {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 12px;
  padding: 2px 4px;
  height: 16px;
}
.wallet-row-balance {
  font-size: 13px;
  line-height: 16px;
  height: 16px;
  margin-top: 4px;
}
@container (max-width: 280px) {
  .wallet-list-item {
    height: 56px;
    min-height: 56px;
    padding: 12px;
    gap: 12px;
  }
  .wallet-icon-slot {
    flex-basis: 32px;
    min-width: 32px;
    width: 32px;
    height: 32px;
  }
  .wallet-icon-slot :deep(.q-icon) {
    font-size: 20px;
  }
  .wallet-row-name {
    font-size: 14px;
    line-height: 18px;
    height: 18px;
  }
  .wallet-row-balance {
    font-size: 12px;
    line-height: 14px;
    height: 14px;
    margin-top: 0;
  }
}
.wallet-backup-footer {
  flex: 0 0 auto;
  min-width: 0;
}
.wallet-backup-action {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  min-height: 48px;
  padding: 12px 16px;
  border: 0;
  background: transparent;
  color: var(--q-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wallet-backup-action > .q-icon {
  flex: 0 0 auto;
}
.wallet-backup-action > span {
  flex: 1 1 0%;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.wallet-backup-action:hover {
  background: var(--q-color-bg-active);
}
.wallet-backup-action:focus-visible {
  outline: 2px solid var(--q-primary);
  outline-offset: -2px;
}

.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: var(--q-primary);
}
</style>
