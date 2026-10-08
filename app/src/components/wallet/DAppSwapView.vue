<template>
  <div class="q-pa-md d-app-swap-view" data-testid="dapp-swap-view">
    <div class="column q-gutter-md">
      <!-- From Asset Card -->
      <q-card flat bordered class="q-pa-md bg-surface">
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-caption text-grey-7">{{
            $t('walletPanel.swapPay')
          }}</span>
          <span
            v-if="availableBalance"
            class="text-caption text-primary cursor-pointer"
            data-testid="swap-max-balance"
            @click="setMaxAmount"
          >
            {{ $t('walletPanel.swapAvailable') }}: {{ availableBalance }}
          </span>
        </div>
        <div class="row items-center q-gutter-sm no-wrap">
          <q-input
            v-model="fromAmount"
            type="number"
            dense
            borderless
            placeholder="0.00"
            class="col text-h6"
            input-class="text-weight-bold"
            data-testid="swap-from-amount"
            @update:model-value="calculateQuote"
          />
          <q-select
            v-model="fromAsset"
            :options="assetOptions"
            dense
            outlined
            emit-value
            map-options
            class="col-auto asset-select"
            data-testid="swap-from-asset"
            @update:model-value="onFromAssetChange"
          />
        </div>
      </q-card>

      <!-- Swap Invert Button -->
      <div class="row justify-center q-my-none">
        <q-btn
          round
          flat
          dense
          icon="swap_vert"
          color="primary"
          class="bg-grey-2 dark:bg-grey-9 shadow-1"
          data-testid="swap-flip-btn"
          @click="flipAssets"
        />
      </div>

      <!-- To Asset Card -->
      <q-card flat bordered class="q-pa-md bg-surface">
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-caption text-grey-7">{{
            $t('walletPanel.swapReceive')
          }}</span>
          <span v-if="unitRateDisplay" class="text-caption text-grey-6">
            {{ unitRateDisplay }}
          </span>
        </div>
        <div class="row items-center q-gutter-sm no-wrap">
          <q-input
            :model-value="estimatedToAmount"
            readonly
            dense
            borderless
            placeholder="0.00"
            class="col text-h6"
            input-class="text-weight-bold text-positive"
            data-testid="swap-to-amount"
          />
          <q-select
            v-model="toAsset"
            :options="assetOptions"
            dense
            outlined
            emit-value
            map-options
            class="col-auto asset-select"
            data-testid="swap-to-asset"
            @update:model-value="calculateQuote"
          />
        </div>
      </q-card>

      <!-- Protocol Fee & Privacy Notice -->
      <q-card
        flat
        bordered
        class="q-pa-sm bg-grey-1 dark:bg-grey-9 text-caption"
      >
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-grey-7">{{ $t('walletPanel.swapFeeLabel') }}</span>
          <div class="row items-center q-gutter-xs">
            <span class="text-weight-bold" data-testid="swap-protocol-fee">
              {{ protocolFeeDisplay }}
            </span>
            <q-badge color="positive" outline class="q-ml-xs text-bold">
              {{ $t('walletPanel.swapFeeSavingsBadge') }}
            </q-badge>
          </div>
        </div>
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-grey-7">{{ $t('walletPanel.swapRouting') }}</span>
          <span class="text-weight-medium" data-testid="swap-router-name">
            {{ activeRouterName }}
          </span>
        </div>
        <q-separator class="q-my-xs" />
        <div class="row items-center q-gutter-xs text-grey-8 dark:text-grey-4">
          <q-icon name="shield" color="positive" size="14px" />
          <span class="col ellipsis" data-testid="swap-destination-address">
            {{ $t('walletPanel.swapDestinationChange') }}
          </span>
        </div>
      </q-card>

      <!-- Action Button -->
      <q-btn
        unelevated
        color="primary"
        size="lg"
        class="full-width text-weight-bold"
        :label="
          swapStatusKey === 'walletPanel.swapExecute'
            ? `${$t(swapStatusKey)} (${fromAsset} → ${toAsset})`
            : $t(swapStatusKey)
        "
        :disable="!canSwap"
        :loading="isExecuting"
        data-testid="swap-execute-btn"
        @click="executeSwap"
      />

      <div
        v-if="lastTxHash"
        class="text-center text-caption text-positive q-mt-xs"
        data-testid="swap-success-banner"
      >
        <q-icon name="check_circle" size="14px" />
        {{ $t('walletPanel.swapSuccess') }}
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { defaultPluginRegistry } from '@frank/wallet/plugins'

export const SWAP_FEE_BPS = 8.75 // 0.0875% = 1/10th of MetaMask's 0.875%

export const SUPPORTED_SWAP_ASSETS = [
  { label: 'USDC', value: 'USDC' },
  { label: 'AVU (1 kWh)', value: 'AVU' },
  { label: 'MON (Monad)', value: 'MON' },
  { label: 'SOL (Solana)', value: 'SOL' },
  { label: 'ETH (Ethereum)', value: 'ETH' },
  { label: 'XEC (eCash)', value: 'XEC' },
]

export default defineComponent({
  name: 'DAppSwapView',
  props: {
    selectedWallet: {
      type: String,
      default: 'monad',
    },
  },
  setup(props) {
    const fromAsset = ref<string>('USDC')
    const toAsset = ref<string>('AVU')
    const fromAmount = ref<string>('100')
    const estimatedToAmount = ref<string>('813.01')
    const isExecuting = ref<boolean>(false)
    const lastTxHash = ref<string | null>(null)

    const assetOptions = SUPPORTED_SWAP_ASSETS

    // Approximate baseline rates for instantaneous quote estimation
    // In production, these derive from @frank/price-feeds and the DAppPlugin.getQuote()
    const RATES_IN_USD: Record<string, number> = {
      USDC: 1.0,
      AVU: 0.123, // ~12.3 cents per kWh
      MON: 0.024,
      SOL: 145.0,
      ETH: 2550.0,
      XEC: 0.000041,
    }

    const availableBalance = computed(() => {
      if (fromAsset.value === 'USDC') return '1,000.00 USDC'
      if (fromAsset.value === 'MON') return '250.00 MON'
      if (fromAsset.value === 'SOL') return '5.20 SOL'
      return '100.00'
    })

    const setMaxAmount = () => {
      fromAmount.value = '1000'
      calculateQuote()
    }

    const onFromAssetChange = () => {
      if (fromAsset.value === toAsset.value) {
        toAsset.value = fromAsset.value === 'USDC' ? 'AVU' : 'USDC'
      }
      calculateQuote()
    }

    const flipAssets = () => {
      const prevFrom = fromAsset.value
      fromAsset.value = toAsset.value
      toAsset.value = prevFrom
      calculateQuote()
    }

    const calculateQuote = () => {
      const val = parseFloat(fromAmount.value)
      if (isNaN(val) || val <= 0) {
        estimatedToAmount.value = '0.00'
        return
      }

      const fromPrice = RATES_IN_USD[fromAsset.value] || 1.0
      const toPrice = RATES_IN_USD[toAsset.value] || 1.0

      const grossValueUsd = val * fromPrice
      // Deduct 0.0875% fee
      const netValueUsd = grossValueUsd * (1 - SWAP_FEE_BPS / 10000)
      const toUnits = netValueUsd / toPrice

      estimatedToAmount.value = toUnits.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      })
    }

    const protocolFeeDisplay = computed(() => {
      const val = parseFloat(fromAmount.value)
      if (isNaN(val) || val <= 0) return '0.0875% ($0.00)'
      const fromPrice = RATES_IN_USD[fromAsset.value] || 1.0
      const feeUsd = val * fromPrice * (SWAP_FEE_BPS / 10000)
      return `0.0875% (~$${feeUsd.toFixed(2)})`
    })

    const activeRouterName = computed(() => {
      if (fromAsset.value === 'SOL' || toAsset.value === 'SOL') {
        const jup =
          defaultPluginRegistry.get('jupiter-aggregator') ??
          defaultPluginRegistry.get('jupiter')
        return jup ? jup.name : 'Jupiter Aggregator (Solana)'
      }
      const uni = defaultPluginRegistry.get('uniswap-universal-router')
      return uni ? uni.name : 'Uniswap Universal Router'
    })

    const unitRateDisplay = computed(() => {
      const fromPrice = RATES_IN_USD[fromAsset.value] || 1.0
      const toPrice = RATES_IN_USD[toAsset.value] || 1.0
      const rate = fromPrice / toPrice
      return `1 ${fromAsset.value} ≈ ${rate.toFixed(4)} ${toAsset.value}`
    })

    const canSwap = computed(() => {
      const val = parseFloat(fromAmount.value)
      return !isNaN(val) && val > 0 && fromAsset.value !== toAsset.value
    })

    const swapStatusKey = computed(() => {
      if (fromAsset.value === toAsset.value)
        return 'walletPanel.swapSelectDifferent'
      const val = parseFloat(fromAmount.value)
      if (isNaN(val) || val <= 0) return 'walletPanel.swapEnterAmount'
      return 'walletPanel.swapExecute'
    })

    const executeSwap = async () => {
      if (!canSwap.value) return
      isExecuting.value = true
      lastTxHash.value = null

      try {
        // Simulate plugin dispatch
        await new Promise(resolve => setTimeout(resolve, 800))
        lastTxHash.value =
          '0x' +
          Array.from({ length: 64 }, () =>
            Math.floor(Math.random() * 16).toString(16),
          ).join('')
      } finally {
        isExecuting.value = false
      }
    }

    return {
      fromAsset,
      toAsset,
      fromAmount,
      estimatedToAmount,
      assetOptions,
      availableBalance,
      protocolFeeDisplay,
      activeRouterName,
      unitRateDisplay,
      canSwap,
      swapStatusKey,
      isExecuting,
      lastTxHash,
      setMaxAmount,
      onFromAssetChange,
      flipAssets,
      calculateQuote,
      executeSwap,
    }
  },
})
</script>

<style scoped>
.d-app-swap-view {
  max-width: 520px;
  margin: 0 auto;
}
.asset-select {
  min-width: 140px;
}
</style>
