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
import { UNIT_RATE_ASSET_METRICS } from '../../utils/avu-units'
import { useTranslate } from '../../composables/useTranslate'
import { ASSET_FEED_SYMBOLS, type SupportedAsset } from '@frank/wallet/oracle'

defineProps<{
  modelValue: boolean
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const oracle = useSafeOracleStore()
const t = useTranslate()

interface EquivalencyRow {
  asset: string
  label: string
  rateFormatted: string
  usdFormatted: string
}

/**
 * One row per coin that has a price source, showing the price that was fetched. A coin
 * whose price has not been fetched says so; nothing stands in for it. The last row is
 * AVU_hash itself: the kWh one dollar is worth as mining prices it, or "Unavailable".
 */
const equivalencyRows = computed<EquivalencyRow[]>(() => {
  const rows = (Object.keys(ASSET_FEED_SYMBOLS) as SupportedAsset[]).map(
    asset => {
      const metric = UNIT_RATE_ASSET_METRICS[asset]
      const price = oracle.snapshot?.prices?.[asset]
      const rate = oracle.formatUnitRate?.(asset) ?? ''
      return {
        asset,
        label: metric.symbol,
        rateFormatted: rate || t('walletPanel.avuUnavailable'),
        usdFormatted:
          rate && price !== undefined
            ? `$${(price * metric.multiplier).toPrecision(6)}`
            : '\u2014',
      }
    },
  )
  rows.push({
    asset: 'usd' as SupportedAsset,
    label: '1 USD',
    rateFormatted: oracle.snapshot?.avuHash
      ? `1 USD = ${oracle.snapshot.avuHash.kwhPerDollar.toLocaleString(
          'en-US',
          { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        )} AVU`
      : t('walletPanel.avuUnavailable'),
    usdFormatted: '$1.00',
  })
  return rows
})
</script>
