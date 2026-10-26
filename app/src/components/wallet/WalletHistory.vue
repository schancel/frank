<template>
  <q-card-section class="wallet-history" data-testid="wallet-native-operations">
    <p
      v-if="inspectionStatus !== 'available'"
      role="status"
      class="text-caption text-grey-7"
    >
      {{ $t(`nativeOperation.${inspectionStatus}`) }}
    </p>
    <p v-if="!groups.length" data-testid="wallet-activity-empty">
      {{ $t('walletPanel.historyEmpty') }}
    </p>
    <q-list v-else separator data-testid="wallet-activity-list">
      <template v-for="group in groups" :key="group.id">
        <q-item-label header>{{ $t(group.label) }}</q-item-label>
        <q-item
          v-for="entry in group.rows"
          :key="entry.id"
          class="wallet-history-row q-px-none q-py-md"
          data-testid="wallet-activity-item"
          :data-activity-id="entry.id"
        >
          <q-item-section avatar top class="wallet-history-icon">
            <q-icon
              :name="
                entry.kind === 'swap'
                  ? 'swap_horiz'
                  : entry.kind === 'received'
                  ? 'south_west'
                  : 'north_east'
              "
              color="primary"
              size="24px"
              aria-hidden="true"
            />
          </q-item-section>
          <q-item-section class="wallet-history-content">
            <div class="wallet-history-heading">
              <q-item-label class="text-weight-bold wallet-history-amount">
                <template v-if="entry.kind === 'swap'">
                  {{ entry.swap.fromAmount }} {{ entry.swap.fromAsset }} →
                  {{ entry.swap.status === 'pending' ? '≥' : ''
                  }}{{ entry.swap.toAmount }} {{ entry.swap.toAsset }}
                </template>
                <template v-else-if="entry.kind === 'received'"
                  >+{{ nativeAmount(receivedAmount(entry.payment)) }}
                  {{ nativeUnit }}</template
                >
                <template v-else
                  >{{ nativeAmount(entry.operation.intendedValueWei) }}
                  {{ nativeUnit }}</template
                >
              </q-item-label>
              <q-badge
                :color="statusColor(entry)"
                outline
                class="wallet-history-status"
                data-testid="wallet-activity-status"
              >
                {{ $t(statusLabel(entry)) }}
              </q-badge>
            </div>
            <q-item-label v-if="entry.kind === 'swap'" caption class="q-mt-xs">
              {{ entry.swap.route }} ·
              {{ formatSwapTime(entry.swap.timestamp) }}
            </q-item-label>
            <template v-else-if="entry.kind === 'received'">
              <q-item-label caption class="q-mt-xs">
                {{
                  $t(
                    entry.payment.origin === 'stamp'
                      ? 'walletHistory.receivedStamp'
                      : 'walletHistory.receivedPayment',
                  )
                }}
                ·
                <time
                  :datetime="new Date(entry.timeMs).toISOString()"
                  data-testid="wallet-activity-date"
                  >{{ formatSwapTime(entry.timeMs) }}</time
                >
              </q-item-label>
              <p
                v-if="entry.payment.partial"
                class="text-caption q-mt-xs q-mb-none"
                data-testid="wallet-received-partial"
              >
                {{
                  $t('walletHistory.receivedPartial', {
                    amount: nativeAmount(
                      String(entry.payment.receivedAmountWei ?? 0n),
                    ),
                    claimed: nativeAmount(
                      String(entry.payment.claimedAmountWei),
                    ),
                    unit: nativeUnit,
                  })
                }}
              </p>
              <p
                v-else-if="entry.payment.status !== 'received'"
                class="text-caption q-mt-xs q-mb-none"
              >
                {{ $t('walletHistory.receivedClaimed') }}
              </p>
            </template>
            <template v-else>
              <q-item-label caption class="q-mt-xs">
                {{
                  $t(
                    entry.operation.kind === 'contract'
                      ? 'walletHistory.contract'
                      : 'walletHistory.to',
                  )
                }}
                <template v-if="entry.timeMs !== undefined">
                  ·
                  <time
                    :datetime="new Date(entry.timeMs).toISOString()"
                    data-testid="wallet-activity-date"
                    >{{ formatSwapTime(entry.timeMs) }}</time
                  >
                </template>
              </q-item-label>
              <div class="wallet-history-address">
                <address-text :address="entry.operation.recipient" copyable />
              </div>
            </template>
            <details
              v-if="entry.kind !== 'received' && entry.operation"
              data-testid="wallet-native-operation"
              class="wallet-history-details q-mt-sm"
            >
              <summary class="wallet-history-action">
                {{ $t('walletHistory.details') }}
              </summary>
              <div class="wallet-history-detail-body">
                <p class="wallet-history-outcome">
                  {{
                    $t(`nativeOperation.${entry.operation.payment}`, {
                      network:
                        networkName(entry.operation.chainIdentifier) ||
                        entry.operation.chainIdentifier,
                    })
                  }}
                </p>
                <p
                  v-if="
                    entry.kind === 'native' &&
                    entry.operation.payment !== 'included' &&
                    entry.operation.payment !== 'cancelled'
                  "
                  class="text-caption"
                >
                  {{ $t('walletHistory.intended') }}
                </p>
                <p
                  class="text-caption text-grey-7"
                  data-testid="wallet-native-operation-date"
                >
                  {{
                    entry.timeMs !== undefined
                      ? $t('walletHistory.includedAt', {
                          date: formatDate(entry.timeMs),
                        })
                      : $t('walletHistory.notYetInBlock')
                  }}
                </p>
                <p>
                  {{
                    $t(
                      `nativeOperation.fee${
                        observedFees(paymentMembers(entry.operation)).coverage
                      }`,
                      {
                        amount: nativeAmount(
                          observedFees(paymentMembers(entry.operation)).feeWei,
                        ),
                        unit: nativeUnit,
                      },
                    )
                  }}
                </p>
                <div
                  v-for="(member, index) in paymentMembers(entry.operation)"
                  :key="`payment-${index}`"
                  class="wallet-history-transaction"
                >
                  <div class="wallet-history-heading">
                    <span class="text-weight-medium">{{
                      $t('walletHistory.transaction', { number: index + 1 })
                    }}</span>
                    <span class="text-caption">{{
                      $t(`walletHistory.memberStatus.${member.state}`)
                    }}</span>
                  </div>
                  <div
                    v-if="member.transactionHash"
                    class="wallet-history-address"
                  >
                    <address-text :address="member.transactionHash" copyable />
                  </div>
                  <a
                    v-if="
                      member.transactionHash &&
                      transactionExplorerLink(
                        member.transactionHash,
                        entry.operation.chainIdentifier,
                      )
                    "
                    :href="
                      transactionExplorerLink(
                        member.transactionHash,
                        entry.operation.chainIdentifier,
                      )
                    "
                    target="_blank"
                    rel="noopener noreferrer"
                    class="wallet-history-action"
                    >{{ $t('walletPanel.viewInExplorer') }}</a
                  >
                  <p
                    v-if="member.blockNumber !== undefined"
                    class="text-caption q-mb-none"
                  >
                    {{
                      $t('nativeOperation.block', { block: member.blockNumber })
                    }}
                  </p>
                </div>
                <details
                  v-if="changeMembers(entry.operation).length"
                  class="wallet-history-change"
                  data-testid="wallet-native-operation-change"
                >
                  <summary class="wallet-history-action">
                    {{
                      $t('walletHistory.change', {
                        count: changeMembers(entry.operation).length,
                      })
                    }}
                  </summary>
                  <p class="text-caption q-mt-sm">
                    {{ $t('walletHistory.changeNote') }}
                  </p>
                  <p class="text-caption">
                    {{
                      $t(
                        `nativeOperation.fee${
                          observedFees(changeMembers(entry.operation)).coverage
                        }`,
                        {
                          amount: nativeAmount(
                            observedFees(changeMembers(entry.operation)).feeWei,
                          ),
                          unit: nativeUnit,
                        },
                      )
                    }}
                  </p>
                  <div
                    v-for="(member, index) in changeMembers(entry.operation)"
                    :key="`change-${index}`"
                    class="wallet-history-transaction"
                  >
                    <div class="wallet-history-heading">
                      <span class="text-weight-medium">{{
                        $t('walletHistory.changeTransaction', {
                          number: index + 1,
                        })
                      }}</span>
                      <span class="text-caption">{{
                        $t(`walletHistory.memberStatus.${member.state}`)
                      }}</span>
                    </div>
                    <div
                      v-if="member.transactionHash"
                      class="wallet-history-address"
                    >
                      <address-text
                        :address="member.transactionHash"
                        copyable
                      />
                    </div>
                    <a
                      v-if="
                        member.transactionHash &&
                        transactionExplorerLink(
                          member.transactionHash,
                          entry.operation.chainIdentifier,
                        )
                      "
                      :href="
                        transactionExplorerLink(
                          member.transactionHash,
                          entry.operation.chainIdentifier,
                        )
                      "
                      target="_blank"
                      rel="noopener noreferrer"
                      class="wallet-history-action"
                      >{{ $t('walletPanel.viewInExplorer') }}</a
                    >
                  </div>
                </details>
                <p
                  v-if="entry.operation.sharing !== 'none'"
                  class="text-caption text-grey-7"
                  data-testid="wallet-native-operation-sync"
                >
                  {{
                    $t(
                      entry.operation.sharing === 'shared'
                        ? 'nativeOperation.syncShared'
                        : entry.operation.sharing === 'failed'
                        ? 'nativeOperation.syncFailed'
                        : 'nativeOperation.syncNotShared',
                    )
                  }}
                </p>
                <p
                  v-if="
                    entry.operation.payment === 'unknown' ||
                    entry.operation.payment === 'partial'
                  "
                  data-testid="wallet-native-operation-recovery"
                >
                  {{ $t('nativeOperation.recoveryUnavailable') }}
                </p>
              </div>
            </details>
            <a
              v-else-if="
                entry.kind === 'swap' &&
                entry.swap.txHash &&
                transactionExplorerLink(
                  entry.swap.txHash,
                  entry.swap.chainIdentifier,
                )
              "
              :href="
                transactionExplorerLink(
                  entry.swap.txHash,
                  entry.swap.chainIdentifier,
                )
              "
              target="_blank"
              rel="noopener noreferrer"
              class="wallet-history-action q-mt-sm"
              >{{ $t('walletPanel.viewInExplorer') }}</a
            >
          </q-item-section>
        </q-item>
      </template>
    </q-list>
  </q-card-section>
</template>

<script setup lang="ts">
import type { ReceivedPayment } from '@frank/wallet/chain'
import AddressText from '../AddressText.vue'
import {
  changeMembers,
  observedFees,
  paymentMembers,
  type WalletHistoryGroup,
  type WalletHistoryLoad,
  type WalletHistoryRow,
} from './wallet-history'

defineProps<{
  groups: WalletHistoryGroup[]
  inspectionStatus: WalletHistoryLoad['status']
  nativeUnit: string
  nativeAmount: (value: string) => string
  networkName: (chainIdentifier: string) => string
  transactionExplorerLink: (
    hash: string,
    chainIdentifier: string,
  ) => string | undefined
  formatSwapTime: (timestamp: number) => string
}>()

function formatDate(timeMs: number): string {
  return new Date(timeMs).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** What arrived, once the chain showed it; until then what the sender's message claimed. */
function receivedAmount(payment: ReceivedPayment): string {
  return String(payment.receivedAmountWei ?? payment.claimedAmountWei)
}

function statusLabel(entry: WalletHistoryRow) {
  if (entry.kind === 'swap') return `swap.status.${entry.swap.status}`
  if (entry.kind === 'received')
    return `walletHistory.receivedStatus.${entry.payment.status}`
  if (
    entry.operation.kind === 'contract' &&
    entry.operation.payment === 'included'
  )
    return 'walletHistory.status.confirmed'
  return `walletHistory.status.${entry.operation.payment}`
}

function statusColor(entry: WalletHistoryRow) {
  const status =
    entry.kind === 'swap'
      ? entry.swap.status
      : entry.kind === 'received'
      ? entry.payment.status
      : entry.operation.payment
  if (status === 'confirmed' || status === 'included' || status === 'received')
    return 'positive'
  if (status === 'failed' || status === 'reverted') return 'negative'
  if (
    status === 'cancelled' ||
    status === 'not-received' ||
    status === 'superseded'
  )
    return 'grey-7'
  return 'warning'
}
</script>

<style scoped>
.wallet-history-content {
  min-width: 0;
}
.wallet-history-icon {
  min-width: 40px;
  padding-right: 12px;
}
.wallet-history-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.wallet-history-amount {
  overflow-wrap: anywhere;
}
.wallet-history-status {
  flex-shrink: 0;
  line-height: 1.4;
}
.wallet-history-address {
  width: fit-content;
  max-width: 100%;
  margin-top: 4px;
}
.wallet-history-address :deep(.address-text) {
  width: auto;
  max-width: 100%;
}
.wallet-history-address :deep(.address-value) {
  flex: 0 1 auto;
}
.wallet-history-details {
  max-width: 100%;
}
.wallet-history-action {
  color: var(--q-primary);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
summary.wallet-history-action {
  width: fit-content;
  padding: 4px 0;
}
.wallet-history-action:focus-visible {
  outline: 2px solid var(--q-primary);
  outline-offset: 3px;
}
.wallet-history-detail-body {
  margin-top: 12px;
  padding: 12px;
  background: rgba(128, 128, 128, 0.06);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.wallet-history-change {
  margin-top: 8px;
}
.wallet-history-transaction {
  padding: 12px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.2);
}
.wallet-history-detail-body > :last-child {
  margin-bottom: 0;
}
@media (max-width: 400px) {
  .wallet-history {
    padding: 12px;
  }
  .wallet-history-icon {
    min-width: 28px;
    padding-right: 8px;
  }
}
</style>
