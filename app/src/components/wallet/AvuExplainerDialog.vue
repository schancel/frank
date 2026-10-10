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
import { SUPPORTED_ASSETS } from '@frank/wallet/oracle'

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
}

/**
 * One row per coin: what one unit of it is worth in AVU, by the rate the oracle store
 * computed. A coin with no rate says so; nothing stands in for it. No dollar figure is
 * shown: prices are an input of the rate, not something this app displays.
 */
const equivalencyRows = computed<EquivalencyRow[]>(() =>
  SUPPORTED_ASSETS.map(asset => ({
    asset,
    label: UNIT_RATE_ASSET_METRICS[asset].symbol,
    rateFormatted:
      oracle.formatUnitRate?.(asset) || t('walletPanel.avuUnavailable'),
  })),
)
</script>
