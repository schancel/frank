<template>
  <q-card-section
    class="native-transfer-history"
    data-testid="native-transfer-history"
  >
    <p
      v-if="load.status === 'loading' && !load.rows.length"
      data-testid="native-transfer-loading"
    >
      {{ $t('walletHistory.nativeTransfer.loading') }}
    </p>
    <p
      v-if="load.status === 'unavailable'"
      role="status"
      data-testid="native-transfer-unavailable"
    >
      {{ $t('walletHistory.nativeTransfer.unavailable') }}
    </p>
    <p
      v-if="load.status === 'available' && !rows.length && showEmpty"
      data-testid="native-transfer-empty"
    >
      {{ $t('walletPanel.historyEmpty') }}
    </p>
    <q-list v-if="rows.length" separator>
      <q-item-label header>{{ $t('walletHistory.transfers') }}</q-item-label>
      <q-item
        v-for="row in rows"
        :key="`${row.direction}:${row.txid}`"
        class="q-px-none q-py-md"
        data-testid="native-transfer-row"
        :data-direction="row.direction"
        :data-txid="row.txid"
      >
        <q-item-section avatar top class="native-transfer-icon">
          <q-icon
            :name="row.direction === 'sent' ? 'north_east' : 'south_west'"
            :color="row.direction === 'sent' ? 'primary' : 'positive'"
            size="24px"
            aria-hidden="true"
          />
        </q-item-section>
        <q-item-section class="native-transfer-content">
          <div class="native-transfer-heading">
            <q-item-label
              class="text-weight-bold native-transfer-amount"
              data-testid="native-transfer-amount"
              :title="`${nativeAmount(row.value)} ${nativeUnit}`"
              >{{ row.direction === 'sent' ? '-' : '+'
              }}{{ shortenDisplayAmount(nativeAmount(row.value)) }}
              {{ nativeUnit }}</q-item-label
            >
            <q-badge
              :color="row.state === 'confirmed' ? 'positive' : 'warning'"
              outline
              data-testid="native-transfer-status"
            >
              {{ $t(`walletHistory.nativeTransfer.status.${row.state}`) }}
            </q-badge>
          </div>
          <template v-if="row.direction === 'sent' && row.recipient">
            <q-item-label caption class="q-mt-xs">
              {{ $t('walletHistory.ecashSend.to') }}
            </q-item-label>
            <div class="native-transfer-address">
              <address-text :address="row.recipient" copyable />
            </div>
          </template>
          <q-item-label v-else caption class="q-mt-xs">
            {{ $t('walletHistory.nativeTransfer.received') }}
          </q-item-label>
          <p
            v-if="row.fee !== undefined"
            class="text-caption q-mt-xs q-mb-none"
          >
            {{
              $t('walletHistory.fee', {
                amount: nativeAmount(row.fee),
                unit: nativeUnit,
              })
            }}
          </p>
          <p
            class="text-caption text-grey-7 q-mt-xs q-mb-none"
            data-testid="native-transfer-block"
          >
            {{
              row.height !== undefined
                ? $t('walletHistory.nativeTransfer.inBlock', {
                    height: row.height,
                  })
                : row.state === 'pending'
                ? $t('walletHistory.notYetInBlock')
                : ''
            }}
          </p>
          <a
            v-if="transactionExplorerLink(row.txid, chainIdentifier)"
            :href="transactionExplorerLink(row.txid, chainIdentifier)"
            target="_blank"
            rel="noopener noreferrer"
            class="native-transfer-action text-caption"
            >{{ $t('walletHistory.details') }}</a
          >
        </q-item-section>
      </q-item>
    </q-list>
  </q-card-section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AddressText from '../AddressText.vue'
import { shortenDisplayAmount } from 'src/utils/chain-amount'
import type { NativeTransferLoad } from './wallet-history'

/**
 * A wallet's plain native sends and receipts (`getNativeTransfers`): a derived view, read again
 * whenever History is. Pending sends first, then newest block first.
 */
const props = defineProps<{
  chainIdentifier: string
  load: NativeTransferLoad
  /** Say there is nothing yet (no other History rows either). */
  showEmpty: boolean
  nativeUnit: string
  nativeAmount: (value: bigint) => string
  transactionExplorerLink: (
    hash: string,
    chainIdentifier: string,
  ) => string | undefined
}>()

const rows = computed(() =>
  [...props.load.rows].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'pending' ? -1 : 1
    const ha = a.height ?? Number.MAX_SAFE_INTEGER
    const hb = b.height ?? Number.MAX_SAFE_INTEGER
    if (ha !== hb) return hb - ha
    return (b.recordedAt ?? 0) - (a.recordedAt ?? 0)
  }),
)
</script>

<style scoped>
.native-transfer-content {
  min-width: 0;
}
.native-transfer-icon {
  min-width: 40px;
  padding-right: 12px;
}
.native-transfer-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.native-transfer-amount {
  overflow-wrap: anywhere;
}
.native-transfer-address {
  width: fit-content;
  max-width: 100%;
  margin-top: 4px;
}
.native-transfer-action {
  color: var(--q-primary);
  text-decoration: underline;
}
</style>
