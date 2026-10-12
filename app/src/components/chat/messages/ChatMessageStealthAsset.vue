<template>
  <q-card
    flat
    bordered
    class="q-pa-sm"
    :class="isDark ? 'bg-grey-10 text-white' : 'bg-grey-1 text-dark'"
    data-testid="chat-message-stealth-asset"
  >
    <div class="text-weight-bold q-mb-sm">
      {{ tr(outbound ? 'title' : 'incomingTitle') }}
    </div>
    <div v-if="claimError" data-testid="asset-claim-error">
      {{ tr('claimError') }}
    </div>
    <div
      v-for="row in rows"
      :key="row.key"
      class="q-mb-sm"
      data-testid="asset-payment-row"
    >
      <div class="row items-center justify-between">
        <span data-testid="asset-chain">{{ row.chainName }}</span>
        <q-badge :color="statusColor(row.status)" data-testid="asset-status">{{
          statusLabel(row.status)
        }}</q-badge>
      </div>
      <div data-testid="asset-intended">
        {{
          tr('intended', {
            amount: displayAmount(row, row.intendedAmount),
            unit: row.unit,
          })
        }}
      </div>
      <div v-if="row.verifiedAmount !== undefined" data-testid="asset-verified">
        {{
          tr('verified', {
            amount: displayAmount(row, row.verifiedAmount),
            unit: row.unit,
          })
        }}
      </div>
      <div
        v-if="row.status === 'needs-native-gas'"
        data-testid="asset-gas-hint"
      >
        {{ tr('gasHint') }}
      </div>
      <div v-else-if="row.spendability === 'reserved'" class="text-caption">
        {{ tr('reservedHint') }}
      </div>
      <div v-else-if="row.spendability === 'empty'" class="text-caption">
        {{ tr('emptyHint') }}
      </div>
      <div v-for="tx in row.transactions" :key="tx.txId" class="text-caption">
        <a
          v-if="tx.url"
          :href="tx.url"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="asset-explorer"
          >{{ tx.txId }}</a
        >
        <span v-else>{{ tx.txId }}</span>
      </div>
      <details
        v-if="row.status === 'unsupported'"
        data-testid="asset-unsupported-details"
      >
        <summary>{{ tr('details') }}</summary>
        <pre>{{ unsupportedDetails(row.indices) }}</pre>
      </details>
    </div>
    <div
      v-if="item.memo"
      class="text-caption text-italic"
      data-testid="asset-memo"
    >
      {{ item.memo }}
    </div>
    <details v-if="claimError">
      <summary>{{ tr('details') }}</summary>
      <pre>{{ JSON.stringify(item.transfers, null, 2) }}</pre>
    </details>
    <q-btn
      v-if="!outbound && rows.some(row => row.claim)"
      flat
      dense
      :label="tr('check')"
      @click="refresh"
    />
  </q-card>
</template>
<script lang="ts">
import {
  defineComponent,
  computed,
  onBeforeUnmount,
  ref,
  watch,
  type PropType,
} from 'vue'
import { useQuasar } from 'quasar'
import { useTranslate } from '../../../composables/useTranslate'
import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import type { StealthAssetOption } from '../../../stealth-payments/options'
import {
  recipientAssetRows,
  observeRecipientAssetRow,
  type RecipientAssetObservationContext,
  type RecipientAssetRow,
  type RecipientAssetRowStatus,
} from '../../../stealth-payments/presentation'

export default defineComponent({
  name: 'ChatMessageStealthAsset',
  props: {
    item: {
      type: Object as PropType<RecipientAssetPaymentItem>,
      required: true,
    },
    assetOptions: {
      type: Array as PropType<readonly StealthAssetOption[]>,
      default: () => [],
    },
    transactionUrl: {
      type: Function as PropType<
        (chainIdentifier: string, txId: string) => string | undefined
      >,
      default: undefined,
    },
    observationContext: {
      type: Object as PropType<RecipientAssetObservationContext>,
      default: undefined,
    },
    outbound: { type: Boolean, default: false },
    outboundState: { type: String, default: 'unknown' },
  },
  setup(props) {
    const translate = useTranslate()
    const tr = (key: string, params?: Record<string, unknown>) =>
      translate(`chatMessageStealthAsset.${key}`, params)
    const displayAmount = (row: RecipientAssetRow, value: string) =>
      row.decimals === undefined ? `${value} ${tr('atomicUnits')}` : value
    const quasar = useQuasar()
    const isDark = computed(() => quasar?.dark?.isActive ?? false)
    const rows = ref<readonly RecipientAssetRow[]>([])
    const claimError = ref(false)
    let generation = 0
    async function refresh() {
      const captured = ++generation
      claimError.value = false
      try {
        const initial = recipientAssetRows(
          props.item,
          props.assetOptions,
          props.observationContext,
          props.outbound,
          props.transactionUrl,
        )
        rows.value = initial
        if (props.outbound) return
        const observed = await Promise.all(
          initial.map(row =>
            observeRecipientAssetRow(row, props.observationContext),
          ),
        )
        if (captured === generation) rows.value = observed
      } catch {
        if (captured === generation) {
          rows.value = []
          claimError.value = true
        }
      }
    }
    watch(
      () => [
        props.item,
        props.assetOptions,
        props.observationContext,
        props.outbound,
        props.transactionUrl,
      ],
      refresh,
      { immediate: true },
    )
    onBeforeUnmount(() => {
      generation++
    })
    const statusLabel = (status: RecipientAssetRowStatus) => {
      if (status !== 'outgoing') return tr(status)
      return tr(
        props.outboundState === 'delivered'
          ? 'delivered'
          : props.outboundState === 'failed'
          ? 'deliveryFailed'
          : ['pending', 'sending'].includes(props.outboundState)
          ? 'sending'
          : 'deliveryUnknown',
      )
    }
    const statusColor = (status: RecipientAssetRowStatus) =>
      status === 'received'
        ? 'positive'
        : status === 'failed'
        ? 'negative'
        : ['pending', 'partial', 'needs-native-gas'].includes(status)
        ? 'warning'
        : 'grey'
    return {
      rows,
      tr,
      displayAmount,
      isDark,
      claimError,
      refresh,
      statusLabel,
      statusColor,
      unsupportedDetails: (indices: readonly number[]) =>
        JSON.stringify(
          indices.map(index => props.item.transfers[index]),
          null,
          2,
        ),
    }
  },
})
</script>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
a {
  overflow-wrap: anywhere;
}
</style>
