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
        <q-toolbar-title class="h6">
          {{ $t('walletPanel.title') }}
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-ma-none q-pa-none">
        <q-scroll-area class="absolute full-width full-height">
          <div class="q-pa-md">
            <q-card
              flat
              class="col column full-width bg-transparent"
              style="max-width: 720px; width: 100%; margin: 0 auto"
            >
              <q-card-section>
                <div class="text-h6 row items-center" data-testid="wallet-name">
                  <span data-testid="wallet-name-text">
                    {{
                      getCustomName(selectedWallet) ||
                      (selectedWallet === 'ecash'
                        ? $t('walletPanel.ecash')
                        : selectedWallet === 'solana'
                        ? $t('walletPanel.solana')
                        : selectedWallet === 'tempo'
                        ? $t('walletPanel.tempo')
                        : selectedWallet === 'ethereum'
                        ? $t('walletPanel.ethereum')
                        : selectedWallet === 'hyperliquid'
                        ? $t('walletPanel.hyperliquid')
                        : $t('walletPanel.mainWallet'))
                    }}
                  </span>
                  <q-badge
                    v-if="isTestnet"
                    color="orange"
                    text-color="black"
                    :label="$t('walletPanel.testnet')"
                    class="q-ml-sm text-bold"
                    data-testid="wallet-testnet-badge"
                  />
                </div>
                <div class="text-caption" data-testid="wallet-chain">
                  {{
                    selectedWallet === 'ecash'
                      ? isTestnet
                        ? $t('walletPanel.ecashTestnet')
                        : $t('walletPanel.ecash')
                      : selectedWallet === 'solana'
                      ? isTestnet
                        ? $t('walletPanel.solanaTestnet')
                        : $t('walletPanel.solana')
                      : selectedWallet === 'tempo'
                      ? isTestnet
                        ? $t('walletPanel.tempoTestnet')
                        : $t('walletPanel.tempo')
                      : selectedWallet === 'ethereum'
                      ? isTestnet
                        ? $t('walletPanel.ethereumTestnet')
                        : $t('walletPanel.ethereum')
                      : selectedWallet === 'hyperliquid'
                      ? isTestnet
                        ? $t('walletPanel.hyperliquidTestnet')
                        : $t('walletPanel.hyperliquid')
                      : isTestnet
                      ? $t('walletPanel.monadTestnet')
                      : $t('walletPanel.monad')
                  }}
                </div>
              </q-card-section>
              <q-separator />
              <q-tabs
                v-model="activeTab"
                dense
                no-caps
                class="text-grey-7"
                active-color="primary"
                indicator-color="primary"
                align="justify"
                narrow-indicator
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
                      class="text-bold text-subtitle1 text-center"
                      role="status"
                      aria-live="polite"
                      data-testid="wallet-balance"
                    >
                      {{
                        selectedWallet === 'monad'
                          ? balanceText
                          : chainLoaded && chainFormattedBalance
                          ? chainFormattedBalance
                          : selectedWallet === 'ecash'
                          ? isTestnet
                            ? $t('walletPanel.zeroTxec')
                            : $t('walletPanel.zeroXec')
                          : selectedWallet === 'solana'
                          ? isTestnet
                            ? $t('walletPanel.zeroTsol')
                            : $t('walletPanel.zeroSol')
                          : selectedWallet === 'tempo'
                          ? isTestnet
                            ? $t('walletPanel.zeroTusd')
                            : $t('walletPanel.zeroUsd')
                          : selectedWallet === 'ethereum'
                          ? isTestnet
                            ? $t('walletPanel.zeroSep')
                            : $t('walletPanel.zeroEth')
                          : selectedWallet === 'hyperliquid'
                          ? isTestnet
                            ? $t('walletPanel.zeroThype')
                            : $t('walletPanel.zeroHype')
                          : balanceText
                      }}
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
                  <q-card-section>
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
                        no-caps
                        :label="
                          selectedWallet === 'ecash'
                            ? isTestnet
                              ? $t('walletPanel.sendTxec')
                              : $t('walletPanel.sendXec')
                            : selectedWallet === 'solana'
                            ? isTestnet
                              ? $t('walletPanel.sendTsol')
                              : $t('walletPanel.sendSol')
                            : selectedWallet === 'tempo'
                            ? isTestnet
                              ? 'Send tUSD'
                              : 'Send USD'
                            : selectedWallet === 'ethereum'
                            ? isTestnet
                              ? 'Send SEP'
                              : 'Send ETH'
                            : selectedWallet === 'hyperliquid'
                            ? isTestnet
                              ? 'Send tHYPE'
                              : 'Send HYPE'
                            : isTestnet
                            ? $t('walletPanel.sendMont')
                            : $t('walletPanel.send')
                        "
                        color="primary"
                        :disable="selectedWallet !== 'monad'"
                        data-testid="wallet-send-action"
                        data-test="wallet-legacy-send-action"
                        @click="openSend"
                      />
                    </q-card-actions>
                  </q-card-section>
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
import { computed, defineComponent, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import QrcodeVue from 'qrcode.vue'
import AvuExplainerDialog from 'src/components/wallet/AvuExplainerDialog.vue'
import AvuParityChart from 'src/components/wallet/AvuParityChart.vue'
import DAppSwapView from 'src/components/wallet/DAppSwapView.vue'
import { copyToClipboard } from 'quasar'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { useChainBalance } from 'src/composables/useChainBalance'
import { useMyDrawerOpen } from 'src/composables/useMyDrawerOpen'
import { useWalletNames } from 'src/composables/useWalletNames'
import { openPage } from 'src/utils/routes'
import { addressCopiedNotify, errorNotify } from 'src/utils/notifications'
import { accountSession, accountStatus } from '../accounts/session'
import { activeChain } from '@frank/wallet/chain'
import { useSafeOracleStore } from 'src/stores/oracle'

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
    const isTestnet = computed(() => activeChain.isTestnet ?? false)
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

    // Shared with the drawer: one polling loop, so this page refreshes without a reload.
    const {
      formattedBalance,
      balance: monadBalance,
      loaded,
      hasError,
    } = useBalance()
    const {
      formattedBalance: chainFormattedBalance,
      balance: chainBalance,
      loaded: chainLoaded,
      hasError: chainHasError,
    } = useChainBalance(selectedWallet)

    const currentWalletHasError = computed(() => {
      return selectedWallet.value === 'monad'
        ? hasError.value
        : chainHasError.value
    })

    const currentUnitRateAvu = computed(() => {
      const asset = selectedWallet.value as any
      return oracle.formatUnitRate ? oracle.formatUnitRate(asset) : ''
    })

    const currentWalletAvu = computed(() => {
      if (selectedWallet.value === 'monad') {
        if (!loaded.value || !monadBalance?.value) return ''
        return oracle.formatAvuAmount('monad', monadBalance.value)
      }
      if (!chainLoaded.value || !chainBalance?.value) return ''
      return oracle.formatAvuAmount(
        selectedWallet.value as any,
        chainBalance.value,
      )
    })

    // An em dash (not "0") until the first successful fetch: an unloaded or failed balance must
    // not look like a real zero.
    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '\u2014',
    )
    const displayAddress = ref(
      accountSession.getCachedChainAddress?.(selectedWallet.value) ?? '',
    )

    const prewarmChains = (active: string) => {
      if (accountStatus.status === 'ready') {
        for (const chain of [
          'ecash',
          'solana',
          'tempo',
          'ethereum',
          'hyperliquid',
        ]) {
          if (active !== chain) {
            accountSession?.getChainAddress?.(chain)?.catch(() => undefined)
          }
        }
      }
    }

    watch(
      () => [
        accountStatus.status,
        accountStatus.revision,
        selectedWallet.value,
      ],
      async ([status, , chain], _previous, onCleanup) => {
        if (status !== 'ready') {
          displayAddress.value = ''
          return
        }
        prewarmChains(chain)
        const cached = accountSession.getCachedChainAddress?.(chain)
        if (cached) {
          displayAddress.value = cached
        } else {
          displayAddress.value = ''
        }
        let current = true
        onCleanup(() => {
          current = false
        })
        try {
          if (chain === 'monad') {
            const wallet = await useActiveWallet()
            if (!current) return
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
                  : activeChain.addressToString(
                      address as Parameters<
                        typeof activeChain.addressToString
                      >[0],
                    )
            }
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
      activeTab,
      selectedWallet,
      selectedChain: selectedWallet,
      isTestnet,
      displayAddress,
      balanceText,
      chainFormattedBalance,
      chainLoaded,
      currentWalletHasError,
      currentWalletAvu,
      currentUnitRateAvu,
      hasError,
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
        openPage(router, '/send')
      },
      openSendContact() {
        openPage(router, '/send-contact')
      },
      openReceive() {
        openPage(router, '/wallet')
      },
    }
  },
})
</script>
