<template>
  <div class="full-width column col" data-test="wallet-panel">
    <q-scroll-area
      class="col full-width"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item>
          <q-item-section>
            <q-item-label>{{ $t('walletPanel.title') }}</q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row items-center q-gutter-xs">
              <q-item-label
                v-if="portfolioTotalAvu"
                caption
                class="text-weight-medium text-grey-8 q-mr-xs cursor-pointer"
              >
                <span data-test="portfolio-total-avu">{{
                  portfolioTotalAvu
                }}</span>
                <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
              </q-item-label>
              <q-item-label
                caption
                class="text-weight-medium text-primary cursor-pointer flex items-center q-gutter-xs"
                data-test="drawer-avu-explainer-link"
                @click.stop="showAvuDialog = true"
              >
                <span>{{ $t('walletPanel.avuDrawerHeader') }}</span>
                <q-icon name="help_outline" size="12px" />
                <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
              </q-item-label>
            </div>
          </q-item-section>
        </q-item>
        <q-separator />

        <!-- Wallets (Monad Main Wallet is pinned first) -->
        <template v-for="(wallet, index) in WALLET_CONFIGS" :key="wallet.id">
          <q-separator v-if="index > 0" />
          <q-item
            clickable
            v-ripple
            :data-test="wallet.dataTest"
            :active="selectedChain === wallet.id"
            active-class="active-chat-list-item"
            @click="selectWallet(wallet.id)"
          >
            <q-item-section avatar>
              <q-icon :name="wallet.icon" />
            </q-item-section>
            <q-item-section>
              <q-item-label
                :data-test="wallet.nameDataTest"
                class="row items-center no-wrap"
              >
                <span
                  class="ellipsis cursor-pointer"
                  :data-test="wallet.nameTextDataTest"
                  @dblclick.stop="
                    openRenameDialog(wallet.id, getWalletDefaultName(wallet))
                  "
                >
                  {{ getCustomName(wallet.id) || getWalletDefaultName(wallet) }}
                </span>
                <q-badge
                  v-if="isTestnet"
                  outline
                  color="amber-9"
                  class="q-ml-xs text-bold no-shrink"
                  :data-test="wallet.badgeDataTest"
                >
                  {{ $t('walletPanel.testnet') }}
                </q-badge>
                <q-btn
                  flat
                  round
                  dense
                  size="xs"
                  icon="edit"
                  class="q-ml-xs rename-wallet-btn no-shrink"
                  :title="$t('walletPanel.renameWallet')"
                  :aria-label="$t('walletPanel.renameWallet')"
                  :data-test="wallet.renameBtnDataTest"
                  @click.stop="
                    openRenameDialog(wallet.id, getWalletDefaultName(wallet))
                  "
                />
              </q-item-label>
              <q-item-label caption :data-test="wallet.chainDataTest">
                {{ getWalletChainLabel(wallet) }}
              </q-item-label>
              <q-item-label
                caption
                :role="wallet.isMain ? 'status' : undefined"
                :data-test="wallet.balanceDataTest"
              >
                {{ getWalletBalance(wallet) }}
              </q-item-label>
              <q-item-label
                v-if="getWalletAvu(wallet)"
                caption
                class="text-grey-7"
              >
                <span :data-test="`${wallet.id}-wallet-avu`">{{
                  getWalletAvu(wallet)
                }}</span>
                <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
              </q-item-label>
              <q-item-label
                v-if="getWalletUnitRate(wallet)"
                caption
                class="text-grey-6"
              >
                <span :data-test="`${wallet.id}-wallet-unit-rate`">{{
                  getWalletUnitRate(wallet)
                }}</span>
                <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
              </q-item-label>
            </q-item-section>
          </q-item>
          <p
            v-if="wallet.isMain && loaded && hasError"
            role="status"
            data-test="balance-stale"
            class="q-px-md text-caption text-negative"
          >
            {{ $t('accountRecovery.balance_stale') }}
          </p>
        </template>

        <q-separator class="q-my-sm" />

        <div class="q-pa-sm">
          <q-btn
            outline
            no-caps
            color="primary"
            class="full-width"
            :label="$t('accountRecovery.backup_account_codex32')"
            data-test="backup-codex32-button"
            @click="openBackup"
          />
        </div>
      </q-list>
    </q-scroll-area>

    <rename-wallet-dialog
      v-model="showRenameDialog"
      :chain="renameChain"
      :current-name="getCustomName(renameChain)"
      :default-name="renameDefaultName"
      @save="saveWalletName"
      @reset="resetCustomName(renameChain)"
    />

    <avu-explainer-dialog v-model="showAvuDialog" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, getCurrentInstance, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeChain } from '@frank/wallet/chain'
import { accountSession, accountStatus } from '../../accounts/session'
import { useBalance } from '../../composables/useBalance'
import { useMultichainBalance } from '../../composables/useChainBalance'
import { useWalletNames } from '../../composables/useWalletNames'
import { openPage } from '../../utils/routes'
import RenameWalletDialog from '../wallet/RenameWalletDialog.vue'
import AvuExplainerDialog from '../wallet/AvuExplainerDialog.vue'
import { useSafeOracleStore } from '../../stores/oracle'
import { formatAvu } from '@frank/wallet/oracle'

interface WalletItemConfig {
  id: string
  isMain?: boolean
  icon: string
  dataTest: string
  nameDataTest: string
  nameTextDataTest: string
  badgeDataTest: string
  renameBtnDataTest: string
  chainDataTest: string
  balanceDataTest: string
  defaultNameKey: string
  testnetDefaultNameKey?: string
  chainKey: string
  testnetChainKey: string
  balanceZeroKey?: string
  testnetBalanceZeroKey?: string
}

// Monad is intentionally placed first as the primary stamp wallet
const WALLET_CONFIGS: WalletItemConfig[] = [
  {
    id: 'monad',
    isMain: true,
    icon: 'account_balance_wallet',
    dataTest: 'wallet-row',
    nameDataTest: 'wallet-name',
    nameTextDataTest: 'wallet-name-text',
    badgeDataTest: 'testnet-badge',
    renameBtnDataTest: 'rename-monad-btn',
    chainDataTest: 'wallet-chain',
    balanceDataTest: 'wallet-balance',
    defaultNameKey: 'walletPanel.mainWallet',
    chainKey: 'walletPanel.monad',
    testnetChainKey: 'walletPanel.monadTestnet',
  },
  {
    id: 'ecash',
    icon: 'toll',
    dataTest: 'ecash-wallet-row',
    nameDataTest: 'ecash-wallet-name',
    nameTextDataTest: 'ecash-wallet-name-text',
    badgeDataTest: 'ecash-testnet-badge',
    renameBtnDataTest: 'rename-ecash-btn',
    chainDataTest: 'ecash-wallet-chain',
    balanceDataTest: 'ecash-wallet-balance',
    defaultNameKey: 'walletPanel.ecash',
    chainKey: 'walletPanel.ecash',
    testnetChainKey: 'walletPanel.ecashTestnet',
    balanceZeroKey: 'walletPanel.zeroXec',
    testnetBalanceZeroKey: 'walletPanel.zeroTxec',
  },
  {
    id: 'solana',
    icon: 'account_balance',
    dataTest: 'solana-wallet-row',
    nameDataTest: 'solana-wallet-name',
    nameTextDataTest: 'solana-wallet-name-text',
    badgeDataTest: 'solana-testnet-badge',
    renameBtnDataTest: 'rename-solana-btn',
    chainDataTest: 'solana-wallet-chain',
    balanceDataTest: 'solana-wallet-balance',
    defaultNameKey: 'walletPanel.solana',
    chainKey: 'walletPanel.solana',
    testnetChainKey: 'walletPanel.solanaTestnet',
    balanceZeroKey: 'walletPanel.zeroSol',
    testnetBalanceZeroKey: 'walletPanel.zeroTsol',
  },
  {
    id: 'tempo',
    icon: 'speed',
    dataTest: 'tempo-wallet-row',
    nameDataTest: 'tempo-wallet-name',
    nameTextDataTest: 'tempo-wallet-name-text',
    badgeDataTest: 'tempo-testnet-badge',
    renameBtnDataTest: 'rename-tempo-btn',
    chainDataTest: 'tempo-wallet-chain',
    balanceDataTest: 'tempo-wallet-balance',
    defaultNameKey: 'walletPanel.tempo',
    testnetDefaultNameKey: 'walletPanel.tempoTestnet',
    chainKey: 'walletPanel.tempo',
    testnetChainKey: 'walletPanel.tempoTestnet',
    balanceZeroKey: 'walletPanel.zeroUsd',
    testnetBalanceZeroKey: 'walletPanel.zeroTusd',
  },
  {
    id: 'ethereum',
    icon: 'diamond',
    dataTest: 'ethereum-wallet-row',
    nameDataTest: 'ethereum-wallet-name',
    nameTextDataTest: 'ethereum-wallet-name-text',
    badgeDataTest: 'ethereum-testnet-badge',
    renameBtnDataTest: 'rename-ethereum-btn',
    chainDataTest: 'ethereum-wallet-chain',
    balanceDataTest: 'ethereum-wallet-balance',
    defaultNameKey: 'walletPanel.ethereum',
    testnetDefaultNameKey: 'walletPanel.ethereumTestnet',
    chainKey: 'walletPanel.ethereum',
    testnetChainKey: 'walletPanel.ethereumTestnet',
    balanceZeroKey: 'walletPanel.zeroEth',
    testnetBalanceZeroKey: 'walletPanel.zeroSep',
  },
  {
    id: 'hyperliquid',
    icon: 'waves',
    dataTest: 'hyperliquid-wallet-row',
    nameDataTest: 'hyperliquid-wallet-name',
    nameTextDataTest: 'hyperliquid-wallet-name-text',
    badgeDataTest: 'hyperliquid-testnet-badge',
    renameBtnDataTest: 'rename-hyperliquid-btn',
    chainDataTest: 'hyperliquid-wallet-chain',
    balanceDataTest: 'hyperliquid-wallet-balance',
    defaultNameKey: 'walletPanel.hyperliquid',
    testnetDefaultNameKey: 'walletPanel.hyperliquidTestnet',
    chainKey: 'walletPanel.hyperliquid',
    testnetChainKey: 'walletPanel.hyperliquidTestnet',
    balanceZeroKey: 'walletPanel.zeroHype',
    testnetBalanceZeroKey: 'walletPanel.zeroThype',
  },
]

const isTestnet = computed(() => activeChain.isTestnet ?? false)

const router = useRouter()
const route = useRoute()

const { getCustomName, setCustomName, resetCustomName } = useWalletNames()

const instance = getCurrentInstance()
function getTranslation(key: string): string {
  const $t = (instance?.proxy as any)?.$t
  if (typeof $t === 'function') {
    return $t(key)
  }
  return key
}

function getWalletDefaultName(wallet: WalletItemConfig): string {
  if (isTestnet.value && wallet.testnetDefaultNameKey) {
    return getTranslation(wallet.testnetDefaultNameKey)
  }
  return getTranslation(wallet.defaultNameKey)
}

function getWalletChainLabel(wallet: WalletItemConfig): string {
  return isTestnet.value
    ? getTranslation(wallet.testnetChainKey)
    : getTranslation(wallet.chainKey)
}

function getWalletBalance(wallet: WalletItemConfig): string {
  if (wallet.isMain) {
    return loaded.value
      ? formattedBalance.value
      : getTranslation(
          hasError.value
            ? 'walletPanel.balanceUnavailable'
            : 'walletPanel.balanceLoading',
        )
  }
  const chainBalance = getFormattedBalance(wallet.id)
  if (chainBalance) {
    return chainBalance
  }
  if (isTestnet.value && wallet.testnetBalanceZeroKey) {
    return getTranslation(wallet.testnetBalanceZeroKey)
  }
  return wallet.balanceZeroKey ? getTranslation(wallet.balanceZeroKey) : '0'
}

const prewarmChains = () => {
  if (accountStatus?.status === 'ready') {
    for (const chain of [
      'ecash',
      'solana',
      'tempo',
      'ethereum',
      'hyperliquid',
    ]) {
      accountSession?.getChainAddress?.(chain)?.catch(() => undefined)
    }
  }
}
onMounted(prewarmChains)
watch(() => accountStatus?.status, prewarmChains)

const showRenameDialog = ref(false)
const showAvuDialog = ref(false)
const renameChain = ref<string>('monad')
const renameDefaultName = ref('')

function openRenameDialog(chain: string, defaultName: string) {
  renameChain.value = chain
  renameDefaultName.value = defaultName
  showRenameDialog.value = true
}

function saveWalletName(name: string) {
  setCustomName(renameChain.value, name)
}

const selectedChain = computed(() => {
  const currentPath = route?.path ?? ''
  if (currentPath && currentPath.startsWith('/wallet')) {
    const parts = currentPath.toLowerCase().split('/').filter(Boolean)
    if (parts[0] === 'wallet') {
      return parts[1] || 'monad'
    }
    return (route?.params?.wallet as string)?.toLowerCase() || 'monad'
  }
  return null
})

function selectWallet(wallet: string) {
  const r = getRouter()
  if (r) {
    if (wallet === 'monad') {
      r.push('/wallet')
    } else {
      r.push(`/wallet/${wallet}`)
    }
  }
}

const { loaded, hasError, formattedBalance, balance } = useBalance()
const { getFormattedBalance, getRawBalance } = useMultichainBalance()

const oracle = useSafeOracleStore()
onMounted(() => {
  oracle.startBackgroundWorker?.()
})

function getWalletAvu(wallet: WalletItemConfig): string {
  if (wallet.isMain) {
    if (!loaded.value || !balance?.value) return ''
    return oracle.formatAvuAmount('monad', balance.value)
  }
  const raw = getRawBalance?.(wallet.id)
  if (!raw) return ''
  return oracle.formatAvuAmount(wallet.id as any, raw)
}

function getWalletUnitRate(wallet: WalletItemConfig): string {
  return oracle.formatUnitRate ? oracle.formatUnitRate(wallet.id as any) : ''
}

const portfolioTotalAvu = computed(() => {
  let total = 0
  if (loaded.value && balance?.value) {
    total += oracle.getAvu('monad', balance.value)
  }
  for (const w of WALLET_CONFIGS) {
    if (!w.isMain) {
      const raw = getRawBalance?.(w.id)
      if (raw) {
        total += oracle.getAvu(w.id as any, raw)
      }
    }
  }
  return total > 0 ? `≈ ${formatAvu(total)}` : ''
})

function getRouter() {
  return (
    (router && router.push ? router : null) || (instance?.proxy as any)?.$router
  )
}

function openBackup() {
  const r = getRouter()
  if (r) {
    return openPage(r, '/backup')
  }
}
</script>

<style lang="scss" scoped>
.active-chat-list-item {
  background: var(--q-color-bg-active);
  color: #f0409b;
}

.no-shrink {
  flex-shrink: 0;
}

.rename-wallet-btn {
  opacity: 0.6;
  transition: opacity 0.2s;
  &:hover {
    opacity: 1;
  }
}
</style>
