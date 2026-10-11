<template>
  <div class="full-width column col" data-test="wallet-panel">
    <q-scroll-area
      class="col full-width"
      :content-style="{ width: '100%', minWidth: '100%' }"
      :content-active-style="{ width: '100%', minWidth: '100%' }"
    >
      <q-list class="full-width">
        <q-separator />
        <q-item class="wallet-header-item">
          <!-- Title with the total, then the AVU note: each stays on one line, and the note
          moves to a second line when the drawer is too narrow for both. -->
          <q-item-section>
            <div class="wallet-header-row">
              <div class="wallet-header-title">
                <span class="text-subtitle1 text-weight-bold">{{
                  $t('walletPanel.title')
                }}</span>
                <span
                  v-if="portfolioTotalAvu"
                  class="text-caption text-weight-medium wallet-muted q-ml-sm"
                  data-test="portfolio-total-avu"
                >
                  ({{ portfolioTotalAvu }})
                  <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                </span>
              </div>
              <div
                class="wallet-header-note text-caption text-weight-medium text-primary cursor-pointer"
                data-test="drawer-avu-explainer-link"
                @click.stop="showAvuDialog = true"
              >
                <span>{{ $t('walletPanel.avuDrawerHeader') }}</span>
                <q-icon name="help_outline" size="13px" class="q-ml-xs" />
                <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
              </div>
            </div>
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
            class="wallet-list-item q-py-xs"
            @click="selectWallet(wallet.id)"
          >
            <q-item-section avatar>
              <q-icon :name="wallet.icon" />
            </q-item-section>
            <q-item-section>
              <q-item-label
                :data-test="wallet.nameDataTest"
                class="name-with-badge"
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
              <!-- A network the app has no wallet for says so. -->
              <q-item-label
                v-if="getWalletStatus(wallet) === 'unsupported'"
                caption
                class="wallet-muted"
                :data-test="`${wallet.id}-wallet-capability`"
              >
                {{ $t('walletPanel.notSupported') }}
              </q-item-label>
              <q-item-label
                caption
                :role="wallet.isMain ? 'status' : undefined"
                class="wallet-balance-line"
              >
                <!-- A network whose balance this app does not read yet shows a quiet dash, not
                the wording of a failed fetch; the reason is its title and accessible name. -->
                <span
                  :data-test="wallet.balanceDataTest"
                  :title="
                    isBalanceUnsupported(wallet)
                      ? $t('walletPanel.balanceUnsupported')
                      : undefined
                  "
                  :aria-label="
                    isBalanceUnsupported(wallet)
                      ? $t('walletPanel.balanceUnsupported')
                      : undefined
                  "
                  >{{ getWalletBalance(wallet) }}</span
                >
                <span
                  v-if="getWalletAvu(wallet)"
                  class="wallet-muted no-shrink"
                  :data-test="`${wallet.id}-wallet-avu`"
                >
                  <span class="wallet-avu-separator" aria-hidden="true">· </span
                  >{{ getWalletAvu(wallet) }}
                  <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                </span>
              </q-item-label>
              <q-item-label
                v-if="getWalletTokenStatusKey(wallet)"
                caption
                role="status"
                :data-test="`${wallet.id}-token-status`"
              >
                {{ $t(getWalletTokenStatusKey(wallet)) }}
              </q-item-label>
            </q-item-section>
          </q-item>

          <!-- Show observed token holdings even before native balance is known. -->
          <div
            v-if="
              selectedChain === wallet.id &&
              getWalletTokens(wallet).some(token => !token.isNative)
            "
            class="q-pl-xl q-pr-md q-py-xs bg-grey-2 dark:bg-grey-9 q-my-xs q-mx-sm rounded-borders"
            :data-test="`${wallet.id}-token-sublist`"
          >
            <div
              v-for="token in getWalletTokens(wallet)"
              :key="token.id"
              class="row items-center justify-between text-caption q-py-xs text-grey-8 dark:text-grey-3"
              :data-test="`subtoken-${token.symbol.toLowerCase()}`"
            >
              <div class="row items-center no-wrap">
                <q-icon
                  :name="token.isNative ? 'toll' : 'generating_tokens'"
                  size="13px"
                  class="q-mr-xs text-primary"
                />
                <span class="text-weight-medium">{{ token.symbol }}</span>
              </div>
              <div class="row items-center no-wrap q-gutter-x-xs">
                <span>{{ token.balanceFormatted }}</span>
                <span
                  v-if="token.avuFormatted"
                  class="text-grey-6 text-caption"
                >
                  ({{ token.avuFormatted }})
                </span>
              </div>
            </div>
          </div>

          <p
            v-if="getWalletHasStaleBalance(wallet)"
            role="status"
            :data-test="
              wallet.isMain ? 'balance-stale' : `${wallet.id}-balance-stale`
            "
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
import { useMultichainBalance } from '../../composables/useChainBalance'
import { useWalletNames } from '../../composables/useWalletNames'
import { openPage } from '../../utils/routes'
import { walletSupport } from '../../utils/wallet-support'
import RenameWalletDialog from '../wallet/RenameWalletDialog.vue'
import AvuExplainerDialog from '../wallet/AvuExplainerDialog.vue'
import { useSafeOracleStore } from '../../stores/oracle'
import { compactAmountText } from '../../utils/chain-amount'
import {
  WALLET_CONFIGS,
  WalletItemConfig,
  getWalletNetworkLabel,
} from '../../utils/wallet-configs'

const visibleWallets = computed(() =>
  WALLET_CONFIGS.filter(wallet => wallet.enabled !== false),
)

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
  return getWalletNetworkLabel(wallet, isTestnet.value, getTranslation)
}

/** No balance reader exists for this network (as opposed to a read that failed). */
function isBalanceUnsupported(wallet: WalletItemConfig): boolean {
  const presentation = getPresentation(wallet.id)
  return (
    presentation.status === 'unavailable' &&
    presentation.reason === 'unsupported' &&
    !presentation.lastKnown
  )
}

function getWalletBalance(wallet: WalletItemConfig): string {
  if (isBalanceUnsupported(wallet)) return '\u2014'
  const presentation = getPresentation(wallet.id)
  const observation =
    presentation.status === 'available'
      ? presentation.observation
      : presentation.status === 'unavailable'
      ? presentation.lastKnown
      : undefined
  return observation
    ? compactAmountText(observation.formattedBalance)
    : getTranslation(
        presentation.status === 'loading'
          ? 'walletPanel.balanceLoading'
          : 'walletPanel.balanceUnavailable',
      )
}

function getWalletHasStaleBalance(wallet: WalletItemConfig): boolean {
  const presentation = getPresentation(wallet.id)
  return presentation.status === 'unavailable' && !!presentation.lastKnown
}

function getWalletStatus(wallet: WalletItemConfig) {
  return walletSupport(wallet.id, isTestnet.value).status
}

// Derive ahead of time only the addresses that are shown as-is. Bitcoin-family wallets hand out
// their own rotating receive address, and unsupported rows show none.
const prewarmChains = () => {
  if (accountStatus?.status === 'ready') {
    for (const { id } of WALLET_CONFIGS) {
      const support = walletSupport(id, isTestnet.value)
      if (
        id === 'monad' ||
        support.status === 'unsupported' ||
        support.entry.family === 'bitcoin'
      )
        continue
      accountSession?.getChainAddress?.(id)?.catch(() => undefined)
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

const { getPresentation, getRawBalance, getTokens, getTokenObservation } =
  useMultichainBalance()

function getWalletTokens(wallet: WalletItemConfig) {
  return getTokens?.(wallet.id) || []
}

function getWalletTokenStatusKey(wallet: WalletItemConfig): string {
  const observation = getTokenObservation(wallet.id)
  if (!observation || observation.status === 'available') return ''
  if (observation.status === 'loading')
    return 'walletPanel.tokenBalancesLoading'
  return observation.lastKnown
    ? 'walletPanel.tokenBalancesStale'
    : 'walletPanel.tokenBalancesUnavailable'
}

// The drawer keeps this panel mounted behind its other tabs and says here whether it is the
// one showing.
const props = withDefaults(defineProps<{ shown?: boolean }>(), { shown: true })

const oracle = useSafeOracleStore()

// Every wallet's AVU value, the main one included, converts `getRawBalance`: the same raw
// figure its balance line shows.
function getWalletAvu(wallet: WalletItemConfig): string {
  const raw = getRawBalance?.(wallet.id)
  if (!raw) return ''
  return oracle.formatAvuAmount(wallet.id as any, raw)
}

const portfolioTotalAvu = computed(() => {
  let total = 0
  for (const w of WALLET_CONFIGS) {
    const raw = getRawBalance?.(w.id)
    if (raw) {
      total += oracle.getAvu(w.id as any, raw)
    }
  }
  return oracle.formatAvuValue('monad', total)
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
  color: var(--q-primary);
}

.no-shrink {
  flex-shrink: 0;
}

/* Quieter than its neighbour in both modes; a fixed grey was unreadable on the dark drawer. */
.wallet-muted {
  opacity: 0.75;
}

/* The network name and the balance under a wallet's name: Quasar's caption colour is a fixed
   dark grey, which could not be read on the dark drawer. */
.wallet-list-item :deep(.q-item__label--caption) {
  color: inherit;
  opacity: 0.7;
}

.wallet-header-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0 8px;
}

.wallet-header-title,
.wallet-header-note {
  white-space: nowrap;
}

.wallet-header-note {
  display: inline-flex;
  align-items: center;
}

/* The balance, then its AVU value on a line of its own: side by side they do not fit the
   drawer and the AVU value was cut off. */
.wallet-balance-line {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.wallet-balance-line > span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Only separates the two values when they are read as one run of text. */
.wallet-avu-separator {
  display: none;
}

.rename-wallet-btn {
  opacity: 0.6;
  transition: opacity 0.2s;
  &:hover {
    opacity: 1;
  }
}
</style>
