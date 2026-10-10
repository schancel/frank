<template>
  <div>
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          data-test="wallet-menu-btn"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-toolbar-title class="q-py-xs">
          <div class="row items-center no-wrap" data-testid="wallet-name">
            <span
              class="text-weight-bold ellipsis"
              data-testid="wallet-name-text"
            >
              {{
                getCustomName(selectedWallet) ||
                (currentWalletConfig
                  ? $t(currentWalletConfig.defaultNameKey)
                  : $t('walletPanel.mainWallet'))
              }}
            </span>
            <q-badge
              v-if="isTestnet"
              outline
              color="white"
              :label="$t('walletPanel.testnet')"
              class="q-ml-xs text-bold"
              data-testid="wallet-testnet-badge"
            />
          </div>
          <div
            class="text-caption text-white ellipsis"
            style="line-height: 1.1; opacity: 0.85"
            data-testid="wallet-chain"
          >
            {{
              currentWalletConfig
                ? getWalletNetworkLabel(currentWalletConfig, isTestnet, $t)
                : isTestnet
                ? $t('walletPanel.monadTestnet')
                : $t('walletPanel.monad')
            }}
          </div>
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-ma-none q-pa-none">
        <!-- The content is held to the viewport width: the tab bar scrolls inside it instead of
        widening the whole page past a phone's screen. -->
        <q-scroll-area
          class="absolute full-width full-height"
          :content-style="{ width: '100%', minWidth: '100%' }"
          :content-active-style="{ width: '100%', minWidth: '100%' }"
        >
          <div class="wallet-scroll-content">
            <q-card
              flat
              class="wallet-content-card bg-transparent"
              style="max-width: 680px; width: 100%; margin: 0 auto"
            >
              <q-tabs
                v-model="activeTab"
                dense
                no-caps
                class="text-grey-7"
                active-color="primary"
                indicator-color="primary"
                align="justify"
                narrow-indicator
                outside-arrows
                data-testid="wallet-tabs"
              >
                <q-tab
                  name="balance"
                  icon="account_balance_wallet"
                  :label="$t('walletPanel.tabBalance')"
                  data-testid="wallet-tab-balance"
                />
                <q-tab
                  name="swap"
                  icon="swap_horiz"
                  :label="$t('walletPanel.tabSwap')"
                  data-testid="wallet-tab-swap"
                />
                <q-tab
                  name="parity"
                  icon="show_chart"
                  :label="$t('walletPanel.tabParity')"
                  data-testid="wallet-tab-parity"
                />
              </q-tabs>
              <q-separator />

              <q-tab-panels
                v-model="activeTab"
                animated
                class="bg-transparent col column"
                data-testid="wallet-tab-panels"
              >
                <q-tab-panel name="balance" class="q-pa-none">
                  <q-card-section class="q-py-sm">
                    <div
                      class="text-subtitle1 text-center"
                      :class="
                        balanceUnsupported
                          ? 'text-body2 text-grey-7'
                          : 'text-bold'
                      "
                      role="status"
                      aria-live="polite"
                      data-testid="wallet-balance"
                      :title="balanceTitle"
                    >
                      {{
                        balanceObservation
                          ? balanceObservation.cordoned
                            ? balanceObservation.cordoned.formattedTotal
                            : balanceObservation.formattedBalance
                          : $t(
                              balancePresentation.status === 'loading'
                                ? 'walletPanel.balanceLoading'
                                : balanceUnsupported
                                ? 'walletPanel.balanceUnsupported'
                                : 'walletPanel.balanceUnavailable',
                            )
                      }}
                      <span
                        v-if="balanceObservation && balanceObservation.cordoned"
                        class="text-weight-regular text-grey-7 wallet-balance-bracket"
                        data-testid="wallet-balance-cordoned"
                      >
                        ({{
                          $t('walletPanel.cordoned', {
                            amount: balanceObservation.cordoned.formattedAmount,
                          })
                        }})
                        <q-tooltip>{{
                          $t('walletPanel.cordonedTooltip')
                        }}</q-tooltip>
                      </span>
                    </div>
                    <div
                      class="text-caption text-primary cursor-pointer flex items-center justify-center q-gutter-xs q-mt-xs"
                      data-testid="wallet-unit-rate-avu"
                      @click="showAvuDialog = true"
                    >
                      <span>{{ currentUnitRateAvu }}</span>
                      <q-icon name="help_outline" size="14px" />
                      <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                    </div>
                    <div
                      v-if="currentWalletAvu"
                      class="text-caption text-grey-7 text-center q-mt-xs cursor-pointer flex items-center justify-center q-gutter-xs"
                      data-testid="wallet-balance-avu"
                      @click="showAvuDialog = true"
                    >
                      <span>{{ currentWalletAvu }}</span>
                      <q-icon name="help_outline" size="14px" />
                      <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                    </div>
                    <div
                      v-if="currentWalletHasError"
                      class="text-negative text-caption text-center"
                      data-testid="wallet-balance-error"
                    >
                      {{ $t('walletPanel.balanceUnavailable') }}
                    </div>
                  </q-card-section>
                  <q-separator />
                  <q-card-section
                    v-if="walletStatus === 'unsupported'"
                    data-testid="wallet-unsupported"
                  >
                    <!-- No address: money sent to a chain the app cannot read would be invisible. -->
                    <q-banner dense rounded class="bg-grey-2 text-grey-9">
                      <template #avatar>
                        <q-icon name="block" color="grey-7" />
                      </template>
                      {{ $t('walletPanel.walletUnsupported') }}
                    </q-banner>
                  </q-card-section>
                  <q-card-section v-else>
                    <div
                      class="row justify-center items-center"
                      style="min-height: 300px"
                      data-testid="wallet-qr-container"
                    >
                      <qrcode-vue
                        v-if="displayAddress"
                        style="margin-left: auto; margin-right: auto"
                        :value="displayAddress"
                        :size="300"
                        level="H"
                        data-testid="wallet-qr"
                      />
                      <q-skeleton
                        v-else
                        size="300px"
                        square
                        data-testid="wallet-qr-skeleton"
                      />
                    </div>
                    <div class="row q-mt-md">
                      <q-input
                        class="fit"
                        filled
                        auto-grow
                        :loading="!displayAddress"
                        v-model="displayAddress"
                        readonly
                      >
                        <template #append>
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
                    <q-card-actions
                      align="right"
                      class="q-px-none q-pt-md bg-transparent"
                    >
                      <q-btn
                        no-caps
                        outline
                        color="primary"
                        :label="$t('walletPanel.sendToContact')"
                        :disable="selectedWallet !== 'monad'"
                        data-testid="wallet-contact-send-action"
                        @click="openSendContact"
                      />
                      <q-btn
                        v-if="walletStatus === 'send'"
                        no-caps
                        :label="$t(sendLabel.key, sendLabel.params ?? {})"
                        color="primary"
                        :disable="!sendChainIdentifier"
                        data-testid="wallet-send-action"
                        data-test="wallet-legacy-send-action"
                        @click="openSend"
                      />
                      <q-badge
                        v-else
                        outline
                        color="grey-7"
                        class="q-ml-sm q-py-xs"
                        :label="$t('walletPanel.receiveOnly')"
                        data-testid="wallet-receive-only"
                      >
                        <q-tooltip>{{
                          $t('walletPanel.receiveOnlyTooltip')
                        }}</q-tooltip>
                      </q-badge>
                    </q-card-actions>
                  </q-card-section>

                  <q-card-section data-testid="wallet-native-operations">
                    <div class="text-subtitle2 text-weight-bold">
                      {{ $t('nativeOperation.listTitle') }}
                    </div>
                    <p
                      v-if="nativeOperations.status !== 'available'"
                      role="status"
                    >
                      {{ $t(`nativeOperation.${nativeOperations.status}`) }}
                    </p>
                    <template v-else>
                      <p v-if="!nativeOperations.operations.length">
                        {{ $t('nativeOperation.empty') }}
                      </p>
                      <details
                        v-for="operation in nativeOperations.operations"
                        :key="operation.operationId"
                        data-testid="wallet-native-operation"
                      >
                        <summary>
                          {{
                            $t(`nativeOperation.${operation.payment}`, {
                              network: operation.chainIdentifier,
                            })
                          }}
                          — {{ $t('nativeOperation.viewTransfer') }}
                        </summary>
                        <p>{{ operation.operationId }}</p>
                        <p>
                          {{ $t('nativeOperation.intendedAmount') }}:
                          {{ nativeAmount(operation.intendedValueWei) }}
                          {{ nativeUnit }}
                        </p>
                        <p class="text-break">{{ operation.recipient }}</p>
                        <p>
                          {{
                            $t(`nativeOperation.fee${operation.feeCoverage}`, {
                              amount: nativeAmount(operation.observedFeeWei),
                              unit: nativeUnit,
                            })
                          }}
                        </p>
                        <p
                          v-for="(member, index) in operation.members"
                          :key="index"
                          class="text-break"
                        >
                          {{ member.transactionHash }}
                          <span v-if="member.blockNumber !== undefined">{{
                            $t('nativeOperation.block', {
                              block: member.blockNumber,
                            })
                          }}</span>
                        </p>
                        <p
                          class="text-caption text-grey-7"
                          data-testid="wallet-native-operation-sync"
                        >
                          {{
                            $t(
                              operation.sharing === 'shared'
                                ? 'nativeOperation.syncShared'
                                : operation.sharing === 'failed'
                                ? 'nativeOperation.syncFailed'
                                : 'nativeOperation.syncNotShared',
                            )
                          }}
                        </p>
                        <p
                          v-if="operation.payment !== 'included'"
                          data-testid="wallet-native-operation-recovery"
                        >
                          {{ $t('nativeOperation.recoveryUnavailable') }}
                        </p>
                      </details>
                    </template>
                  </q-card-section>

                  <!-- Assets & Tokens Card -->
                  <div class="q-px-md q-pt-md">
                    <q-card
                      flat
                      bordered
                      class="q-pa-md bg-transparent"
                      data-testid="wallet-tokens-card"
                    >
                      <div class="row items-center justify-between q-mb-sm">
                        <div class="row items-center q-gutter-x-xs">
                          <q-icon
                            name="account_balance_wallet"
                            size="18px"
                            color="primary"
                          />
                          <span class="text-subtitle2 text-weight-bold">
                            {{ $t('walletPanel.assetsAndTokens') }}
                          </span>
                        </div>
                        <q-badge outline color="primary" class="text-bold">
                          {{ activeTokens.length }}
                          {{ activeTokens.length === 1 ? 'Asset' : 'Assets' }}
                        </q-badge>
                      </div>

                      <p
                        v-if="tokenStatusKey"
                        role="status"
                        class="text-caption text-grey-7"
                        data-testid="wallet-token-status"
                      >
                        {{ $t(tokenStatusKey) }}
                      </p>

                      <q-list separator class="rounded-borders">
                        <q-item
                          v-for="token in activeTokens"
                          :key="token.id"
                          class="q-px-none q-py-sm"
                          :data-testid="`wallet-token-item-${token.symbol.toLowerCase()}`"
                        >
                          <q-item-section avatar top>
                            <q-avatar
                              size="36px"
                              :color="
                                token.isNative ? 'primary' : 'deep-purple'
                              "
                              text-color="white"
                              :icon="
                                token.isNative ? 'toll' : 'generating_tokens'
                              "
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label class="text-weight-bold">
                              {{ token.symbol }}
                              <span
                                class="text-caption text-grey-7 font-weight-normal q-ml-xs"
                              >
                                · {{ token.name }}
                              </span>
                            </q-item-label>
                            <q-item-label caption class="ellipsis text-grey-6">
                              <span
                                v-if="!token.isNative && token.mintOrAddress"
                              >
                                {{ $t('walletPanel.tokenMint') }}:
                                {{ token.mintOrAddress.slice(0, 8) }}...{{
                                  token.mintOrAddress.slice(-6)
                                }}
                              </span>
                              <span v-else>
                                {{ $t('walletPanel.nativeCoin') }}
                              </span>
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-item-label class="text-weight-bolder text-right">
                              {{ token.balanceFormatted }}
                            </q-item-label>
                            <q-item-label
                              caption
                              class="text-grey-7 text-right"
                            >
                              {{ token.avuFormatted }}
                            </q-item-label>
                          </q-item-section>
                        </q-item>
                      </q-list>
                    </q-card>
                  </div>

                  <!-- Recent Activity / Transactions Card -->
                  <div class="q-px-md q-pt-md q-pb-lg">
                    <q-card
                      flat
                      bordered
                      class="q-pa-md bg-transparent"
                      data-testid="wallet-activity-card"
                    >
                      <div class="row items-center justify-between q-mb-sm">
                        <div class="row items-center q-gutter-x-xs">
                          <q-icon name="history" size="18px" color="primary" />
                          <span class="text-subtitle2 text-weight-bold">
                            {{ $t('walletPanel.recentActivity') }}
                          </span>
                        </div>
                      </div>

                      <div
                        v-if="recentSwaps.length === 0"
                        class="text-center text-caption text-grey-6 q-py-md"
                        data-testid="wallet-activity-empty"
                      >
                        <q-icon
                          name="receipt_long"
                          size="32px"
                          color="grey-5"
                          class="q-mb-xs block q-mx-auto"
                        />
                        {{ $t('walletPanel.noRecentActivity') }}
                      </div>

                      <q-list
                        v-else
                        separator
                        class="rounded-borders"
                        data-testid="wallet-activity-list"
                      >
                        <q-item
                          v-for="swap in recentSwaps"
                          :key="swap.id"
                          class="q-px-none q-py-sm"
                          data-testid="wallet-activity-item"
                        >
                          <q-item-section avatar top>
                            <q-avatar
                              size="32px"
                              color="primary"
                              text-color="white"
                              icon="swap_horiz"
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label class="text-weight-bold">
                              {{ swap.fromAmount }} {{ swap.fromAsset }} →
                              {{ swap.toAmount }} {{ swap.toAsset }}
                            </q-item-label>
                            <q-item-label caption class="text-grey-7">
                              {{ swap.route }} ·
                              {{ formatSwapTime(swap.timestamp) }}
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-badge color="positive" outline class="text-bold">
                              {{ swap.status.toUpperCase() }}
                            </q-badge>
                            <a
                              v-if="getExplorerLink(swap)"
                              :href="getExplorerLink(swap)"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="text-caption text-primary q-mt-xs text-right cursor-pointer"
                              style="text-decoration: underline"
                            >
                              {{ $t('walletPanel.viewInExplorer') }}
                            </a>
                          </q-item-section>
                        </q-item>
                      </q-list>
                    </q-card>
                  </div>
                </q-tab-panel>

                <q-tab-panel name="swap" class="q-pa-none">
                  <d-app-swap-view :selected-wallet="selectedWallet" />
                </q-tab-panel>

                <q-tab-panel name="parity" class="q-pa-none">
                  <avu-parity-chart :selected-wallet="selectedWallet" />
                </q-tab-panel>
              </q-tab-panels>
            </q-card>
          </div>
        </q-scroll-area>
      </q-page>

      <avu-explainer-dialog v-model="showAvuDialog" />
    </q-page-container>
  </div>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import QrcodeVue from 'qrcode.vue'
import AvuExplainerDialog from 'src/components/wallet/AvuExplainerDialog.vue'
import AvuParityChart from 'src/components/wallet/AvuParityChart.vue'
import DAppSwapView from 'src/components/wallet/DAppSwapView.vue'
import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useChainBalance } from 'src/composables/useChainBalance'
import { useMyDrawerOpen } from 'src/composables/useMyDrawerOpen'
import { useWalletNames } from 'src/composables/useWalletNames'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountSession, accountStatus } from '../accounts/session'
import {
  inspectNativeTransferOperations,
  type NativeOperationInspection,
} from 'src/accounts/native-transfer'
import { activeChain, onActiveChainChange } from '@frank/wallet/chain'
import { useSafeOracleStore } from 'src/stores/oracle'
import { useSwapHistory } from 'src/composables/useSwapHistory'
import { getExplorerUrl } from 'src/utils/explorer'
import type { SwapRecord } from 'src/stores/swaps'
import { WALLET_CONFIGS, getWalletNetworkLabel } from 'src/utils/wallet-configs'
import { nativeSendChainIdentifier } from 'src/utils/native-transfer'
import { walletSupport } from 'src/utils/wallet-support'
import { openUtxoWallet } from 'src/accounts/utxo-wallets'

// One wallet's detail view in the main pane (#570): the Wallet rail tab's drawer shows the
// wallet list; picking a row lands here for that wallet's info and actions. Stealth payment
// initiation is deliberately absent until the stealth design (#71) lands -- no dead controls.
export default defineComponent({
  components: {
    QrcodeVue,
    AvuExplainerDialog,
    AvuParityChart,
    DAppSwapView,
  },
  emits: ['toggleMyDrawerOpen'],
  setup() {
    const myDrawerOpen = useMyDrawerOpen()
    const route = useRoute()
    const router = useRouter()
    // The global adapter is a plain object; subscribe to its owner instead of
    // expecting Vue to observe in-place network replacement.
    const network = shallowRef({ ...activeChain })
    onBeforeUnmount(
      onActiveChainChange(chain => {
        network.value = { ...chain }
      }),
    )
    const isTestnet = computed(() => network.value.isTestnet ?? false)
    const { getCustomName } = useWalletNames()
    const oracle = useSafeOracleStore()
    const showAvuDialog = ref(false)
    const activeTab = ref<'balance' | 'parity'>('balance')

    const selectedWallet = computed<string>(() => {
      const parts = (route?.path || '').toLowerCase().split('/').filter(Boolean)
      if (parts[0] === 'wallet' && parts[1]) {
        return parts[1]
      }
      const walletParam = (route?.params?.wallet as string)?.toLowerCase()
      if (walletParam) return walletParam
      const chainParam = (route?.params?.chain as string)?.toLowerCase()
      if (chainParam) return chainParam
      const query = (
        (route?.query?.chain || route?.query?.wallet) as string
      )?.toLowerCase()
      if (query) return query
      return 'monad'
    })

    const currentWalletConfig = computed(() =>
      WALLET_CONFIGS.find(w => w.id === selectedWallet.value),
    )
    const sendChainIdentifier = computed(() =>
      nativeSendChainIdentifier(selectedWallet.value, isTestnet.value),
    )

    // What this wallet can do, from the chain registry: send, receive only, or nothing.
    const support = computed(() =>
      walletSupport(selectedWallet.value, isTestnet.value),
    )
    const walletStatus = computed(() => support.value.status)
    const sendLabel = computed(() =>
      selectedWallet.value === 'monad'
        ? {
            key: isTestnet.value ? 'walletPanel.sendMont' : 'walletPanel.send',
          }
        : {
            key: 'walletPanel.sendAsset',
            params: { unit: support.value.entry?.unit ?? '' },
          },
    )

    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const {
      presentation: balancePresentation,
      tokens: activeTokens,
      tokenObservation,
      refreshCordoned,
    } = useChainBalance(selectedWallet)
    // The cordoned amount is otherwise read at a slow cadence; opening this page shows it fresh.
    onMounted(() => void refreshCordoned?.())
    const tokenStatusKey = computed(() => {
      const observation = tokenObservation.value
      if (!observation || observation.status === 'available') return ''
      if (observation.status === 'loading')
        return 'walletPanel.tokenBalancesLoading'
      return observation.lastKnown
        ? 'walletPanel.tokenBalancesStale'
        : 'walletPanel.tokenBalancesUnavailable'
    })
    const balanceObservation = computed(() => {
      const presentation = balancePresentation.value
      return presentation.status === 'available'
        ? presentation.observation
        : presentation.status === 'unavailable'
        ? presentation.lastKnown
        : undefined
    })
    // Every digit, on hover: the balance line itself is shortened for reading.
    const balanceTitle = computed(() => {
      const observation = balanceObservation.value
      return (
        (observation?.cordoned
          ? observation.cordoned.exactTotal
          : observation?.exactBalance) ?? undefined
      )
    })
    // No balance reader exists for this network: said once and quietly, not as a failed fetch.
    const balanceUnsupported = computed(() => {
      const presentation = balancePresentation.value
      return (
        presentation.status === 'unavailable' &&
        presentation.reason === 'unsupported' &&
        !presentation.lastKnown
      )
    })
    const currentWalletHasError = computed(
      () =>
        balancePresentation.value.status === 'unavailable' &&
        !balanceUnsupported.value,
    )

    const currentUnitRateAvu = computed(() => {
      const asset = selectedWallet.value as any
      return oracle.formatUnitRate ? oracle.formatUnitRate(asset) : ''
    })

    const currentWalletAvu = computed(() => {
      const observation = balanceObservation.value
      if (!observation?.balance) return ''
      return oracle.formatAvuAmount(
        selectedWallet.value as any,
        observation.balance,
      )
    })

    const swapHistory = useSwapHistory()
    const recentSwaps = computed(() => {
      return swapHistory.getSwapsForChain(selectedWallet.value).value
    })

    const formatSwapTime = (timestamp: number) => {
      try {
        const diff = Date.now() - timestamp
        if (diff < 60_000) return 'Just now'
        if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
        return new Date(timestamp).toLocaleDateString()
      } catch {
        return ''
      }
    }

    const getExplorerLink = (swap: SwapRecord) => {
      if (!swap.txHash) return undefined
      return getExplorerUrl(swap.txHash, swap.chain, {
        isTestnet: isTestnet.value,
      })
    }

    const nativeOperations = shallowRef<NativeOperationInspection>({
      status: 'unsupported',
    })
    const nativePresentation = shallowRef({
      unit: '',
      toDisplayAmount: (value: bigint) => value.toString(),
    })
    const displayAddress = ref(
      accountSession.getCachedChainAddress?.(selectedWallet.value) ?? '',
    )

    watch(
      () => [
        accountStatus.status,
        accountStatus.revision,
        selectedWallet.value,
        network.value.chainIdentifier,
      ],
      async ([status, , chain], _previous, onCleanup) => {
        nativeOperations.value = {
          status: chain === 'monad' ? 'unavailable' : 'unsupported',
        }
        const capturedChain = network.value
        if (status !== 'ready') {
          displayAddress.value = ''
          return
        }
        const capability = walletSupport(
          chain,
          capturedChain.isTestnet ?? false,
        )
        if (capability.status === 'unsupported') {
          displayAddress.value = ''
          return
        }
        const utxoChain =
          capability.entry.family === 'bitcoin'
            ? capability.entry.id
            : undefined
        // A Bitcoin-family address rotates, so a cached one may already have been paid.
        displayAddress.value = utxoChain
          ? ''
          : accountSession.getCachedChainAddress?.(chain) ?? ''
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          if (chain === 'monad') {
            const wallet = await useActiveWallet()
            if (!current) return
            nativePresentation.value = capturedChain
            nativeOperations.value = inspectNativeTransferOperations(
              wallet,
              capturedChain.chainIdentifier,
            )
            let address: unknown
            if (typeof wallet.getReceiveAddress === 'function') {
              address = await wallet.getReceiveAddress()
            } else if (wallet.identity?.displayAddress) {
              address = wallet.identity.displayAddress
            }
            if (current && address) {
              displayAddress.value =
                typeof address === 'string'
                  ? address
                  : capturedChain.addressToString(
                      address as Parameters<
                        typeof capturedChain.addressToString
                      >[0],
                    )
            }
          } else if (utxoChain) {
            // The wallet's next unused receive address, never one that was already paid.
            const { wallet } = await openUtxoWallet(utxoChain)
            const address = await wallet.getReceiveAddress()
            if (current) displayAddress.value = address.raw
          } else {
            const address = await accountSession.getChainAddress(chain)
            if (current) displayAddress.value = address
          }
        } catch (err) {
          if (current)
            errorNotify(err, { fallbackKey: 'walletPanel.failedLoadAddress' })
        }
      },
      { immediate: true, flush: 'sync' },
    )

    return {
      myDrawerOpen,
      nativeOperations,
      nativeUnit: computed(() => nativePresentation.value.unit),
      nativeAmount: (value: string) =>
        nativePresentation.value.toDisplayAmount(BigInt(value)),
      activeTab,
      selectedWallet,
      sendChainIdentifier,
      walletStatus,
      sendLabel,
      getWalletNetworkLabel,
      selectedChain: selectedWallet,
      currentWalletConfig,
      isTestnet,
      displayAddress,
      balancePresentation,
      balanceObservation,
      balanceTitle,
      balanceUnsupported,
      currentWalletHasError,
      currentWalletAvu,
      currentUnitRateAvu,
      getCustomName,
      showAvuDialog,
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
        if (sendChainIdentifier.value) {
          openPage(router, `/send?chainIdentifier=${sendChainIdentifier.value}`)
        }
      },
      openSendContact() {
        openPage(router, '/send-contact')
      },
      openReceive() {
        openPage(router, '/wallet')
      },
      activeTokens,
      tokenStatusKey,
      recentSwaps,
      formatSwapTime,
      getExplorerLink,
    }
  },
})
</script>

<style scoped>
.wallet-scroll-content {
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 20px 32px;
  box-sizing: border-box;
}

.wallet-content-card {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
}

/* The bracket wraps whole under the total instead of breaking in the middle. */
.wallet-balance-bracket {
  display: inline-block;
  white-space: nowrap;
}

@media (max-width: 600px) {
  .wallet-scroll-content {
    padding: 8px 10px 24px;
  }
}
</style>
