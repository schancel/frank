<template>
  <q-card
    class="q-px-sm q-pb-md dialog-medium"
    data-testid="send-stealth-dialog"
  >
    <q-card-section>
      <div class="text-h6">
        {{
          $t('sendStealthDialog.sendStealthTo') +
          ' ' +
          (contact?.name || address)
        }}
      </div>
      <div class="text-caption text-grey-7">
        Encrypted direct transfer (invisible to relay)
      </div>
    </q-card-section>

    <q-card-section>
      <q-select
        v-model="selectedChainId"
        :options="chainOptions"
        emit-value
        map-options
        filled
        dense
        :label="$t('sendStealthDialog.chainLabel')"
        data-testid="stealth-chain-select"
      />
    </q-card-section>

    <q-card-section>
      <q-input
        class="text-bold text-h6"
        v-model="amount"
        type="number"
        filled
        dense
        :suffix="currentUnit"
        :hint="$t('sendStealthDialog.amountHint')"
        :placeholder="$t('sendStealthDialog.amountPlaceholder')"
        data-testid="stealth-amount-input"
        ref="amountInput"
      />
    </q-card-section>

    <q-card-section>
      <q-input
        v-model="memo"
        filled
        dense
        :hint="$t('sendStealthDialog.memoHint')"
        :placeholder="$t('sendStealthDialog.memoPlaceholder')"
        data-testid="stealth-memo-input"
      />
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('sendStealthDialog.cancelBtnLabel')"
        color="primary"
        v-close-popup
      />
      <q-btn
        flat
        :disable="!canSend || busy"
        :label="$t('sendStealthDialog.sendBtnLabel')"
        color="primary"
        data-testid="stealth-send-confirm-btn"
        v-close-popup
        @click="sendStealth"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'

export default defineComponent({
  name: 'SendStealthDialog',
  props: {
    address: {
      type: String,
      default: '',
    },
    contact: {
      type: Object,
      default: () => ({ name: 'Unknown' }),
    },
    busy: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['send'],
  data() {
    return {
      selectedChainId: activeChain.networkName || 'monad-testnet',
      amount: '',
      memo: '',
    }
  },
  computed: {
    chainOptions() {
      return Object.values(PROTOCOL_CHAINS).map(c => ({
        label: `${c.name} (${c.unit})`,
        value: c.id,
        unit: c.unit,
      }))
    },
    currentUnit(): string {
      const found = this.chainOptions.find(
        o => o.value === this.selectedChainId,
      )
      return found ? found.unit : activeChain.unit
    },
    canSend(): boolean {
      const parsed = parseFloat(this.amount)
      return !isNaN(parsed) && parsed > 0
    },
  },
  methods: {
    sendStealth() {
      const numAmount = parseFloat(this.amount)
      this.$emit('send', {
        address: this.address,
        chainId: this.selectedChainId,
        amount: numAmount,
        memo: this.memo.trim(),
      })
    },
  },
  mounted() {
    const input = this.$refs.amountInput as { focus?: () => void } | undefined
    input?.focus?.()
  },
})
</script>
