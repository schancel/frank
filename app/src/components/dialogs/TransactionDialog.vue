<template>
  <q-card class="q-px-sm q-pb-md dialog-medium">
    <q-card-section>
      <div class="text-h6">
        {{ title }}
      </div>
    </q-card-section>
    <q-card-section>
      <div v-if="stampPayments.length" class="q-px-md q-pb-md">
        <div class="text-caption text-grey-7">
          {{ $t('transactionDialog.totalStampPayment') }}
        </div>
        <div class="text-h6">{{ formattedTotal }}</div>
      </div>
      <q-list v-if="stampPayments.length" separator>
        <q-item v-for="(payment, idx) in stampPayments" :key="payment.txHash">
          <q-item-section>
            <q-item-label overline>{{
              $t('transactionDialog.stampPaymentN', { n: idx + 1 })
            }}</q-item-label>
            <q-item-label>{{ formatValue(payment.valueWei) }}</q-item-label>
            <q-item-label caption lines="1">
              {{
                $t('transactionDialog.sentTo', {
                  address: payment.destinationAddress,
                })
              }}
            </q-item-label>
            <q-item-label lines="1">
              <a
                :href="transactionExplorerUrl(payment.txHash)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ payment.txHash }}</a
              >
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-btn
              flat
              round
              icon="open_in_new"
              :aria-label="$t('a11y.openInExplorer')"
              :href="transactionExplorerUrl(payment.txHash)"
              target="_blank"
            />
          </q-item-section>
        </q-item>
      </q-list>
      <q-tabs v-model="tab" class="text-primary">
        <q-tab v-for="n in outpoints.length" :key="n" :name="n" :label="n" />
      </q-tabs>
      <q-tab-panels v-model="tab" animated>
        <q-tab-panel
          v-for="(outpoint, idx) in outpoints"
          :key="outpoint.txId"
          :name="idx + 1"
        >
          <q-item-section class="q-py-lg">
            <span class="text-bold">
              {{ $t('transactionDialog.txId') }}
            </span>
            <q-item-label>
              <a
                :href="transactionExplorerUrl(outpoint.txId)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ outpoint.txId }}</a
              >
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

    <q-card-actions align="right">
      <q-btn flat :label="$t('close')" color="primary" v-close-popup />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'
import { toDisplayAddress } from 'src/utils/address'
import { Utxo } from '@frank/cashweb/types/utxo'
import { transactionExplorerUrl } from 'src/utils/explorer'
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
    return {
      transactionExplorerUrl,
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
