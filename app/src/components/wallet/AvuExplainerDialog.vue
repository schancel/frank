<template>
  <q-dialog
    :model-value="modelValue"
    data-test="avu-explainer-dialog"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      style="max-width: 540px; width: 100%"
      data-test="avu-explainer-card"
    >
      <q-card-section class="row items-center q-pb-none">
        <q-avatar
          icon="bolt"
          color="primary"
          text-color="white"
          size="36px"
          class="q-mr-sm"
        />
        <div>
          <div class="text-h6 text-weight-bold">
            {{ $t('walletPanel.avuDialogTitle') }}
          </div>
          <div class="text-caption text-grey-7">
            {{ $t('walletPanel.avuDialogSubtitle') }}
            <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
          </div>
        </div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          @click="$emit('update:modelValue', false)"
        />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <p class="text-body2 text-grey-9 q-mb-md">
          {{ $t('walletPanel.avuDialogDesc') }}
        </p>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="psychology" size="18px" />
            <span>{{ $t('walletPanel.avuMemeHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuMemeDesc') }}
          </p>
        </div>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="precision_manufacturing" size="18px" />
            <span>{{ $t('walletPanel.avuSupplyChainHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuSupplyChainDesc') }}
          </p>
        </div>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="trending_down" size="18px" />
            <span>{{ $t('walletPanel.avuCpiHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuCpiDesc') }}
          </p>
        </div>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="verified" size="18px" />
            <span>{{ $t('walletPanel.avuOracleLessHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuOracleLessDesc') }}
          </p>
        </div>

        <div class="q-mt-md" data-test="avu-rates-section">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs q-mb-xs"
          >
            <q-icon name="table_chart" size="18px" />
            <span>{{ $t('walletPanel.avuRatesTitle') }}</span>
          </div>
          <q-markup-table
            flat
            bordered
            dense
            separator="horizontal"
            class="full-width q-mt-xs"
            data-test="avu-rates-table"
          >
            <thead>
              <tr class="text-left text-grey-8">
                <th>{{ $t('walletPanel.avuRatesAsset') }}</th>
                <th>{{ $t('walletPanel.avuRatesRate') }}</th>
                <th class="text-right">
                  {{ $t('walletPanel.avuRatesRefUsd') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in equivalencyRows"
                :key="row.asset"
                :data-test="`avu-rate-row-${row.asset}`"
              >
                <td class="text-weight-medium">{{ row.label }}</td>
                <td class="text-primary text-weight-bold">
                  {{ row.rateFormatted }}
                  <q-tooltip>{{ $t('walletPanel.avuTooltip') }}</q-tooltip>
                </td>
                <td class="text-right text-grey-7">{{ row.usdFormatted }}</td>
              </tr>
            </tbody>
          </q-markup-table>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md q-pt-none">
        <q-btn
          flat
          no-caps
          color="primary"
          :label="$t('walletPanel.avuDialogClose')"
          data-test="avu-dialog-close-btn"
          @click="$emit('update:modelValue', false)"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSafeOracleStore } from '../../stores/oracle'
import {
  AVU_PER_DOLLAR,
  DEFAULT_ANCHOR_SPOT_PRICES,
  type SupportedAsset,
} from '@frank/wallet/oracle'

defineProps<{
  modelValue: boolean
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const oracle = useSafeOracleStore()

interface EquivalencyRow {
  asset: string
  label: string
  rateFormatted: string
  usdFormatted: string
}

const equivalencyRows = computed<EquivalencyRow[]>(() => {
  const currentRates = oracle.rates ?? {}
  const rows: EquivalencyRow[] = [
    {
      asset: 'monad',
      label: '1 MON',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('monad')
        : '1 MON ≈ 41.67 AVU',
      usdFormatted: `$${DEFAULT_ANCHOR_SPOT_PRICES.monad.toFixed(2)}`,
    },
    {
      asset: 'solana',
      label: '1 SOL',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('solana')
        : '1 SOL ≈ 1,785.71 AVU',
      usdFormatted: `$${DEFAULT_ANCHOR_SPOT_PRICES.solana.toFixed(2)}`,
    },
    {
      asset: 'ethereum',
      label: '1 ETH',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('ethereum')
        : '1 ETH ≈ 30,952.38 AVU',
      usdFormatted: `$${DEFAULT_ANCHOR_SPOT_PRICES.ethereum.toLocaleString(
        'en-US',
        { minimumFractionDigits: 2 },
      )}`,
    },
    {
      asset: 'hyperliquid',
      label: '1 HYPE',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('hyperliquid')
        : '1 HYPE ≈ 476.19 AVU',
      usdFormatted: `$${DEFAULT_ANCHOR_SPOT_PRICES.hyperliquid.toFixed(2)}`,
    },
    {
      asset: 'tempo',
      label: '1 TUSD',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('tempo')
        : '1 TUSD ≈ 11.90 AVU',
      usdFormatted: `$${DEFAULT_ANCHOR_SPOT_PRICES.tempo.toFixed(2)}`,
    },
    {
      asset: 'ecash',
      label: '1M XEC',
      rateFormatted: oracle.formatUnitRate
        ? oracle.formatUnitRate('ecash')
        : '1M XEC ≈ 416.67 AVU',
      usdFormatted: `$${(DEFAULT_ANCHOR_SPOT_PRICES.ecash * 1_000_000).toFixed(
        2,
      )}`,
    },
    {
      asset: 'usd',
      label: '1 USD',
      rateFormatted: `1 USD ≈ ${(
        currentRates.tempo ?? AVU_PER_DOLLAR
      ).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} AVU`,
      usdFormatted: '$1.00',
    },
  ]
  return rows
})
</script>
