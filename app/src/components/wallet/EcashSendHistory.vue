<template>
  <q-card-section class="ecash-send-history" data-testid="ecash-send-history">
    <p v-if="!sends.length && showEmpty" data-testid="ecash-send-empty">
      {{ $t('walletPanel.historyEmpty') }}
    </p>
    <q-list v-else-if="sends.length" separator>
      <q-item-label header>{{ $t('walletHistory.transfers') }}</q-item-label>
      <q-item
        v-for="send in [...sends].reverse()"
        :key="send.operationId"
        class="q-px-none q-py-md"
        data-testid="ecash-send-row"
        :data-operation-id="send.operationId"
      >
        <q-item-section avatar top class="ecash-send-icon">
          <q-icon
            name="north_east"
            color="primary"
            size="24px"
            aria-hidden="true"
          />
        </q-item-section>
        <q-item-section class="ecash-send-content">
          <div class="ecash-send-heading">
            <q-item-label
              class="text-weight-bold ecash-send-amount"
              :title="`${nativeAmount(send.valueSats)} ${nativeUnit}`"
              >{{ shortenDisplayAmount(nativeAmount(send.valueSats)) }}
              {{ nativeUnit }}</q-item-label
            >
            <q-badge
              :color="statusColor(send.state)"
              outline
              data-testid="ecash-send-status"
            >
              {{ $t(`walletHistory.ecashSend.status.${send.state}`) }}
            </q-badge>
          </div>
          <q-item-label caption class="q-mt-xs">
            {{ $t('walletHistory.ecashSend.to') }}
          </q-item-label>
          <div class="ecash-send-address">
            <address-text :address="send.recipient" copyable />
          </div>
          <p
            v-if="send.state !== 'conflicted'"
            class="text-caption q-mt-xs q-mb-none"
          >
            {{
              $t('walletHistory.fee', {
                amount: nativeAmount(send.feeSats),
                unit: nativeUnit,
              })
            }}
          </p>
          <template v-else>
            <p
              class="text-caption q-mt-xs q-mb-none"
              data-testid="ecash-send-conflicted"
            >
              {{ $t('walletHistory.ecashSend.conflicted') }}
            </p>
            <div class="q-mt-sm">
              <q-btn
                outline
                no-caps
                color="primary"
                :label="$t('walletHistory.ecashSend.retry')"
                :loading="retrying.has(send.operationId)"
                :disable="retrying.has(send.operationId)"
                data-testid="ecash-send-retry"
                @click="onRetry(send.operationId)"
              />
              <p class="text-caption text-grey-7 q-mt-xs q-mb-none">
                {{ $t('walletHistory.ecashSend.retryNote') }}
              </p>
            </div>
          </template>
          <a
            v-if="
              send.state !== 'conflicted' &&
              transactionExplorerLink(send.txid, chainIdentifier)
            "
            :href="transactionExplorerLink(send.txid, chainIdentifier)"
            target="_blank"
            rel="noopener noreferrer"
            class="ecash-send-action text-caption"
            >{{ $t('walletHistory.details') }}</a
          >
        </q-item-section>
      </q-item>
    </q-list>
  </q-card-section>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import type { EcashSend } from '@frank/wallet/ecash-wallet'
import AddressText from '../AddressText.vue'
import { shortenDisplayAmount } from 'src/utils/chain-amount'

/**
 * This device's plain eCash sends, from the eCash wallet's operation journal (`ecashSendsOf`):
 * a derived view. A send another device's spend made impossible reads "Didn't go through" and
 * offers Retry, which sends the same payment again only when the user clicks it.
 */
const props = defineProps<{
  chainIdentifier: string
  /** Oldest first, as the journal records them; shown newest first. */
  sends: readonly EcashSend[]
  /** Say there is nothing yet (no other History rows either). */
  showEmpty: boolean
  nativeUnit: string
  nativeAmount: (value: string) => string
  transactionExplorerLink: (
    hash: string,
    chainIdentifier: string,
  ) => string | undefined
  /** Retries one conflicted send; resolves when the wallet has handed it to the network. */
  retry: (operationId: string) => Promise<void>
}>()

/** Sends whose retry is under way: one click, one retry. */
const retrying = reactive(new Set<string>())

async function onRetry(operationId: string) {
  if (retrying.has(operationId)) return
  retrying.add(operationId)
  try {
    await props.retry(operationId)
  } finally {
    retrying.delete(operationId)
  }
}

function statusColor(state: EcashSend['state']) {
  if (state === 'confirmed') return 'positive'
  if (state === 'conflicted') return 'negative'
  return 'warning'
}
</script>

<style scoped>
.ecash-send-content {
  min-width: 0;
}
.ecash-send-icon {
  min-width: 40px;
  padding-right: 12px;
}
.ecash-send-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.ecash-send-amount {
  overflow-wrap: anywhere;
}
.ecash-send-address {
  width: fit-content;
  max-width: 100%;
  margin-top: 4px;
}
.ecash-send-action {
  color: var(--q-primary);
  text-decoration: underline;
}
</style>
