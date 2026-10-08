<template>
  <div class="d-app-swap-view q-py-sm" data-testid="dapp-swap-view">
    <div class="column q-gutter-y-sm">
      <!-- From Asset Card -->
      <q-card flat bordered class="q-pa-md swap-card">
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-caption text-grey-7">{{
            $t('walletPanel.swapPay')
          }}</span>
          <span
            v-if="availableBalance"
            class="text-caption text-primary cursor-pointer text-weight-medium"
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
            class="col text-h5"
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
        <div
          v-if="fromEnergyAvu"
          class="row items-center q-mt-xs text-caption text-grey-6"
          data-testid="swap-from-avu"
        >
          <q-icon name="bolt" size="13px" color="amber-8" class="q-mr-xs" />
          <span>{{ fromEnergyAvu }}</span>
        </div>
      </q-card>

      <!-- Swap Invert Button: Floating centered pill on seam -->
      <div class="swap-flip-container">
        <q-btn
          round
          dense
          icon="swap_vert"
          color="primary"
          class="swap-flip-btn shadow-2"
          data-testid="swap-flip-btn"
          :aria-label="$t('a11y.switchAssets')"
          @click="flipAssets"
        />
      </div>

      <!-- To Asset Card -->
      <q-card flat bordered class="q-pa-md swap-card">
        <div class="row items-center justify-between q-mb-xs">
          <span class="text-caption text-grey-7">{{
            $t('walletPanel.swapReceive')
          }}</span>
          <span
            v-if="unitRateDisplay"
            class="text-caption text-grey-6 text-weight-medium"
          >
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
            class="col text-h5"
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
        <div
          v-if="toEnergyAvu"
          class="row items-center q-mt-xs text-caption text-grey-6"
          data-testid="swap-to-avu"
        >
          <q-icon name="bolt" size="13px" color="amber-8" class="q-mr-xs" />
          <span>{{ toEnergyAvu }}</span>
        </div>
      </q-card>

      <!-- Protocol Fee & Privacy Notice -->
      <q-card
        flat
        bordered
        class="q-pa-sm bg-grey-1 dark:bg-grey-9 text-caption swap-card q-mt-xs"
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
      <div class="full-width q-mt-xs">
        <q-btn
          unelevated
          color="primary"
          class="full-width swap-action-btn text-weight-bold"
          icon="swap_horiz"
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
      </div>

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
import { computed, defineComponent, ref, watch } from 'vue'
import { defaultPluginRegistry } from '@frank/wallet/plugins'

export const SWAP_FEE_BPS = 8.75 // 0.0875% = 1/10th of MetaMask's 0.875%

export const ALL_SWAP_ASSETS = [
  { label: 'MON (Monad)', value: 'MON' },
  { label: 'USDC', value: 'USDC' },
  { label: 'USDT', value: 'USDT' },
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
    const fromAsset = ref<string>('MON')
    const toAsset = ref<string>('USDC')
    const fromAmount = ref<string>('100')
    const estimatedToAmount = ref<string>('349.69')
    const isExecuting = ref<boolean>(false)
    const lastTxHash = ref<string | null>(null)

    // Contextualize token selection to the active wallet chain
    const assetOptions = computed(() => {
      if (props.selectedWallet === 'solana') {
        return [
          { label: 'SOL (Solana)', value: 'SOL' },
          { label: 'USDC', value: 'USDC' },
          { label: 'USDT', value: 'USDT' },
        ]
      }
      if (
        props.selectedWallet === 'ethereum' ||
        props.selectedWallet === 'sepolia'
      ) {
        return [
          { label: 'ETH (Ethereum)', value: 'ETH' },
          { label: 'USDC', value: 'USDC' },
          { label: 'USDT', value: 'USDT' },
        ]
      }
      return [
        { label: 'MON (Monad)', value: 'MON' },
        { label: 'USDC', value: 'USDC' },
        { label: 'USDT', value: 'USDT' },
        { label: 'SOL (Solana)', value: 'SOL' },
        { label: 'ETH (Ethereum)', value: 'ETH' },
      ]
    })

    // Approximate baseline rates for instantaneous quote estimation
    // In production, these derive from @frank/price-feeds and the DAppPlugin.getQuote()
    const RATES_IN_USD: Record<string, number> = {
      USDC: 1.0,
      USDT: 1.0,
      MON: 3.5,
      SOL: 145.0,
      ETH: 2550.0,
      XEC: 0.000041,
    }

    // 11.90 AVU per USD ($0.084 / kWh industrial energy benchmark)
    const AVU_PER_USD = 11.9

    const fromEnergyAvu = computed(() => {
      const val = parseFloat(fromAmount.value)
      if (isNaN(val) || val <= 0) return ''
      const priceUsd = RATES_IN_USD[fromAsset.value] || 1.0
      const avu = val * priceUsd * AVU_PER_USD
      return `≈ ${avu.toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} AVU (kWh)`
    })

    const toEnergyAvu = computed(() => {
      const val = parseFloat(
        (estimatedToAmount.value || '').toString().replace(/,/g, ''),
      )
      if (isNaN(val) || val <= 0) return ''
      const priceUsd = RATES_IN_USD[toAsset.value] || 1.0
      const avu = val * priceUsd * AVU_PER_USD
      return `≈ ${avu.toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} AVU (kWh)`
    })

    const availableBalance = computed(() => {
      if (fromAsset.value === 'USDC') return '1,000.00 USDC'
      if (fromAsset.value === 'USDT') return '500.00 USDT'
      if (fromAsset.value === 'MON') return '250.00 MON'
      if (fromAsset.value === 'SOL') return '5.20 SOL'
      if (fromAsset.value === 'ETH') return '1.25 ETH'
      return '100.00'
    })

    const setMaxAmount = () => {
      if (fromAsset.value === 'USDC') fromAmount.value = '1000'
      else if (fromAsset.value === 'USDT') fromAmount.value = '500'
      else if (fromAsset.value === 'MON') fromAmount.value = '250'
      else if (fromAsset.value === 'SOL') fromAmount.value = '5.2'
      else if (fromAsset.value === 'ETH') fromAmount.value = '1.25'
      else fromAmount.value = '100'
      calculateQuote()
    }

    const onFromAssetChange = () => {
      if (fromAsset.value === toAsset.value) {
        const fallback =
          props.selectedWallet === 'solana'
            ? 'SOL'
            : props.selectedWallet === 'ethereum' ||
              props.selectedWallet === 'sepolia'
            ? 'ETH'
            : 'MON'
        toAsset.value = fromAsset.value === 'USDC' ? fallback : 'USDC'
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

    const setDefaultsForWallet = (walletId: string) => {
      if (walletId === 'solana') {
        fromAsset.value = 'SOL'
        toAsset.value = 'USDC'
        fromAmount.value = '1'
      } else if (walletId === 'ethereum' || walletId === 'sepolia') {
        fromAsset.value = 'ETH'
        toAsset.value = 'USDC'
        fromAmount.value = '0.1'
      } else {
        fromAsset.value = 'MON'
        toAsset.value = 'USDC'
        fromAmount.value = '100'
      }
      calculateQuote()
    }

    watch(() => props.selectedWallet, setDefaultsForWallet, { immediate: true })

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
      fromEnergyAvu,
      toEnergyAvu,
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
  width: 100%;
  margin: 0 auto;
}
.swap-card {
  border-radius: 12px;
}
.swap-flip-container {
  display: flex;
  justify-content: center;
  align-items: center;
  margin: -14px auto;
  height: 28px;
  z-index: 3;
  position: relative;
}
.swap-flip-btn {
  background-color: #ffffff;
  border: 2px solid var(--q-primary);
  color: var(--q-primary);
  width: 36px;
  height: 36px;
  transition: transform 0.25s ease, box-shadow 0.2s ease;
}
.body--dark .swap-flip-btn {
  background-color: #1d1d1d;
}
.swap-flip-btn:hover {
  transform: rotate(180deg) scale(1.08);
}
.swap-action-btn {
  height: 50px;
  border-radius: 10px;
  font-size: 15px;
  letter-spacing: 0.5px;
  box-shadow: 0 4px 12px rgba(224, 76, 36, 0.25);
}
.asset-select {
  min-width: 150px;
}
</style>
