<template>
  <q-card class="q-px-sm q-pb-md dialog-medium">
    <q-card-section>
      <div class="text-h6">
        {{ title }}
      </div>
    </q-card-section>
    <q-card-section>
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
              <a :href="`https://explorer.givelotus.org/tx/${outpoint.txId}`">{{
                outpoint.txId
              }}</a>
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
import { Utxo } from 'src/cashweb/types/utxo'

// `toDisplayAddress` (Lotus-only) is left as-is here rather than swapped for `activeChain`
// (ticket #44): this dialog's `outpoints` prop is always `[]` for Monad-sourced messages
// (`stores/chats.ts`'s own doc comment, ticket #42 -- "outpoints ... defaulted to [] for
// Monad-sourced messages"), so its per-outpoint tabs, and this address formatting, never actually
// render under the current Monad-only build. It's genuinely Lotus-only dead code today, not a live
// caller to rewire -- converting it now would be an untestable, false-confidence change. Revisit
// once/if `ChatMessage.vue`'s outpoints-vs-burnValueWei display is redesigned (out of this
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
  },
  data() {
    return {
      tab: 1,
    }
  },
  setup() {
    return {
      extractAddress(outpointAddress: string) {
        return toDisplayAddress(outpointAddress)
      },
    }
  },
})
</script>
