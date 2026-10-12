<template>
  <q-card class="dialog-medium">
    <q-card-section class="row items-center q-pb-none">
      <div class="text-h6 text-weight-medium">
        {{ title }}
      </div>
      <div class="col" />
      <q-btn
        icon="close"
        flat
        round
        dense
        v-close-popup
        :aria-label="$t('close')"
      />
    </q-card-section>

    <q-card-section
      v-for="(group, index) in stealthGroups"
      :key="group.ephemeralPubKey || index"
      data-testid="stealth-transaction-group"
    >
      <div class="text-subtitle2">
        {{ $t('transactionDialog.stealthPayment') }}
      </div>
      <div class="text-caption" data-testid="stealth-transaction-status">
        {{ $t(`chatMessageStealth.outboundState.${group.state}`) }}
      </div>
      <div class="text-weight-bold" data-testid="stealth-transaction-total">
        {{ groupTotal(group) }}
      </div>
      <q-list separator>
        <q-item
          v-for="(tx, txIndex) in group.transactions"
          :key="tx.txHash || txIndex"
        >
          <q-item-section>
            <q-item-label>{{
              tx.valueWei !== undefined
                ? groupValue(tx.valueWei, group)
                : $t('transactionDialog.valueUnavailable')
            }}</q-item-label>
            <q-item-label v-if="tx.state" caption>{{
              $t(`chatMessageStealth.outboundState.${tx.state}`)
            }}</q-item-label>
            <q-item-label v-if="tx.destinationAddress" caption>{{
              $t('transactionDialog.sentTo', { address: tx.destinationAddress })
            }}</q-item-label>
            <q-item-label>
              <a
                v-if="
                  tx.txHash &&
                  group.chainIdentifier &&
                  multiChainExplorerUrl(tx.txHash, group.chainIdentifier)
                "
                :href="
                  multiChainExplorerUrl(tx.txHash, group.chainIdentifier || '')
                "
                target="_blank"
                rel="noopener noreferrer"
                >{{ tx.txHash }}</a
              >
              <span v-else>{{
                tx.txHash || $t('transactionDialog.transactionUnavailable')
              }}</span>
            </q-item-label>
          </q-item-section>
          <q-item-section v-if="tx.txHash" side>
            <q-btn
              flat
              round
              dense
              icon="content_copy"
              :aria-label="$t('a11y.copyTxHash')"
              @click="copyTxHash(tx.txHash)"
            />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card-section>

    <q-card-section v-if="stampPayments.length" class="q-pt-sm q-pb-xs">
      <div class="q-pa-md bg-grey-1 rounded-borders">
        <div class="text-caption text-grey-7">
          {{ $t('transactionDialog.totalStampPayment') }}
          <span v-if="stampStatus" data-testid="stamp-transaction-status">
            — {{ $t(`transactionDialog.stampState.${stampStatus}`) }}</span
          >
        </div>
        <div class="text-h6 text-weight-bold text-primary">
          {{ formattedTotal }}
        </div>
      </div>
    </q-card-section>

    <q-card-section v-if="stampPayments.length" class="q-pt-none q-pb-none">
      <q-list separator class="rounded-borders">
        <q-item
          v-for="(payment, idx) in stampPayments"
          :key="payment.txHash"
          class="q-px-none q-py-sm"
        >
          <q-item-section>
            <div class="row items-center justify-between no-wrap">
              <q-item-label overline class="text-weight-bold text-uppercase">
                {{ $t('transactionDialog.stampPaymentN', { n: idx + 1 }) }}
              </q-item-label>
              <span class="text-weight-bold text-body2">{{
                formatValue(payment.valueWei)
              }}</span>
            </div>
            <q-item-label caption lines="1" class="q-mt-xs">
              {{
                $t('transactionDialog.sentTo', {
                  address: payment.destinationAddress,
                })
              }}
            </q-item-label>
            <q-item-label lines="1" class="q-mt-xs">
              <a
                v-if="transactionExplorerUrl(payment.txHash)"
                :href="transactionExplorerUrl(payment.txHash)"
                target="_blank"
                rel="noopener noreferrer"
                class="ellipsis block text-primary"
                >{{ payment.txHash }}</a
              >
              <span
                v-else
                class="text-caption text-grey-7 ellipsis block"
                data-testid="local-chain-notice"
              >
                {{ payment.txHash }} ({{
                  $t('transactionDialog.localChainNotice')
                }})
              </span>
            </q-item-label>
          </q-item-section>
          <q-item-section side class="q-pl-sm">
            <div class="row items-center no-wrap q-gutter-xs">
              <q-btn
                flat
                round
                dense
                icon="content_copy"
                :aria-label="$t('a11y.copyTxHash')"
                @click="copyTxHash(payment.txHash)"
              >
                <q-tooltip>{{ $t('transactionDialog.copyTxHash') }}</q-tooltip>
              </q-btn>
              <q-btn
                v-if="transactionExplorerUrl(payment.txHash)"
                flat
                round
                dense
                icon="open_in_new"
                :aria-label="$t('a11y.openInExplorer')"
                :href="transactionExplorerUrl(payment.txHash)"
                target="_blank"
              />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card-section>

    <!-- Legacy / UTXO outpoints if present -->
    <template v-if="outpoints.length">
      <q-card-section class="q-pt-sm">
        <q-tabs v-model="tab" class="text-primary">
          <q-tab v-for="n in outpoints.length" :key="n" :name="n" :label="n" />
        </q-tabs>
        <q-tab-panels v-model="tab" animated>
          <q-tab-panel
            v-for="(outpoint, idx) in outpoints"
            :key="outpoint.txId"
            :name="idx + 1"
          >
            <q-item-section class="q-py-md">
              <span class="text-bold">
                {{ $t('transactionDialog.txId') }}
              </span>
              <q-item-label>
                <a
                  v-if="transactionExplorerUrl(outpoint.txId)"
                  :href="transactionExplorerUrl(outpoint.txId)"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ outpoint.txId }}</a
                >
                <span
                  v-else
                  class="text-caption text-grey-7"
                  data-testid="local-chain-notice-outpoint"
                >
                  {{ outpoint.txId }} ({{
                    $t('transactionDialog.localChainNotice')
                  }})
                </span>
              </q-item-label>
              <span class="text-bold">
                {{ $t('transactionDialog.txType') }}
              </span>
              <q-item-label>{{ outpoint.type }}</q-item-label>
              <span class="text-bold">
                {{ $t('transactionDialog.txAddress') }}
              </span>
              {{ extractAddress(outpoint.address) }}
              <span class="text-bold">
                {{ $t('transactionDialog.txAmount') }}
              </span>
              {{ outpoint.satoshis }}
            </q-item-section>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>
    </template>

    <q-card-actions align="right" class="q-pa-md">
      <q-btn flat :label="$t('close')" color="primary" v-close-popup no-caps />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import { copyToClipboard } from 'quasar'
import { toDisplayAddress } from 'src/utils/address'
import { Utxo } from '@frank/cashweb/types/utxo'
import {
  transactionExplorerUrl,
  multiChainExplorerUrl,
} from 'src/utils/explorer'
import type { StealthTransactionGroup } from 'src/utils/stealth-transaction-details'
import { infoNotify } from 'src/utils/notifications'
import { translateMessage } from 'src/i18n'
import { activeChain } from '@frank/wallet/chain'

// `toDisplayAddress` (Lotus-only) is left as-is here rather than swapped for `activeChain`
// (ticket #44): this dialog's `outpoints` prop is always `[]` for Monad-sourced messages
// (`stores/chats.ts`'s own doc comment, ticket #42 -- "outpoints ... defaulted to [] for
// Monad-sourced messages"), so its per-outpoint tabs, and this address formatting, never actually
// render under the current Monad-only build. It's genuinely Lotus-only dead code today, not a live
// caller to rewire -- converting it now would be an untestable, false-confidence change. Revisit
// once/if `ChatMessage.vue`'s outpoints-vs-stampValueWei display is redesigned (out of this
// ticket's scope; see `stores/chats.ts`'s "Decision (#42)" note).

export default defineComponent({
  props: {
    title: {
      type: String,
      default: () => '',
    },
    outpoints: {
      type: Object as PropType<Array<Utxo>>,
      default: () => [] as Utxo[],
    },
    stampStatus: { type: String, default: '' },
    stealthGroups: {
      type: Array as PropType<StealthTransactionGroup[]>,
      default: () => [],
    },
    stampPayments: {
      type: Array as PropType<
        Array<{
          txHash: string
          destinationAddress: string
          valueWei: bigint
        }>
      >,
      default: () => [],
    },
  },
  data() {
    return {
      tab: 1,
    }
  },
  setup() {
    const copyTxHash = async (txHash: string) => {
      try {
        await copyToClipboard(txHash)
        infoNotify(translateMessage('transactionDialog.txHashCopied'))
      } catch (err) {
        console.error('Failed to copy tx hash', err)
      }
    }

    return {
      copyTxHash,
      transactionExplorerUrl,
      multiChainExplorerUrl,
      groupValue(value: bigint, group: StealthTransactionGroup) {
        return group.chainIdentifier === activeChain.chainIdentifier
          ? `${activeChain.toDisplayAmount(value)} ${activeChain.unit}`
          : `${value} ${translateMessage('transactionDialog.baseUnits')} (${
              group.chainIdentifier ?? '?'
            })`
      },
      groupTotal(group: StealthTransactionGroup) {
        if (
          !group.transactions.length ||
          group.transactions.some(tx => tx.valueWei === undefined)
        )
          return translateMessage('transactionDialog.valueUnavailable')
        const total = group.transactions.reduce(
          (sum, tx) => sum + (tx.valueWei ?? 0n),
          0n,
        )
        return group.chainIdentifier === activeChain.chainIdentifier
          ? `${activeChain.toDisplayAmount(total)} ${activeChain.unit}`
          : `${total} ${translateMessage('transactionDialog.baseUnits')} (${
              group.chainIdentifier ?? '?'
            })`
      },
      formatValue(valueWei: bigint) {
        return `${activeChain.toDisplayAmount(valueWei)} ${activeChain.unit}`
      },
      extractAddress(outpointAddress: string) {
        return toDisplayAddress(outpointAddress)
      },
    }
  },
  computed: {
    formattedTotal(): string {
      const total = this.stampPayments.reduce(
        (sum, payment) => sum + payment.valueWei,
        0n,
      )
      return `${activeChain.toDisplayAmount(total)} ${activeChain.unit}`
    },
  },
})
</script>
