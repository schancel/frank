<template>
  <q-card class="q-px-sm q-pb-md dialog-medium" data-testid="offer-swap-dialog">
    <q-card-section>
      <div class="text-h6">
        {{ $t('offerSwapDialog.title') + ' ' + (contact?.name || address) }}
      </div>
      <div class="text-caption text-grey-7">
        {{ $t('offerSwapDialog.subtitle') }}
      </div>
    </q-card-section>

    <!-- Offered Leg (What you pay) -->
    <q-card-section class="q-py-xs">
      <div class="text-subtitle2 text-primary q-mb-xs">
        {{ $t('offerSwapDialog.youPay') }}
      </div>
      <div class="row q-col-gutter-sm">
        <div class="col-6">
          <q-select
            v-model="offeredChain"
            :options="chainOptions"
            emit-value
            map-options
            filled
            dense
            :label="$t('offerSwapDialog.offeredChain')"
            data-testid="swap-offered-chain-select"
          />
        </div>
        <div class="col-6">
          <q-input
            v-model="offeredAmount"
            type="number"
            filled
            dense
            :suffix="offeredUnit"
            :placeholder="'0.0'"
            data-testid="swap-offered-amount-input"
          />
        </div>
      </div>
    </q-card-section>

    <!-- Requested Leg (What you receive) -->
    <q-card-section class="q-py-xs">
      <div class="text-subtitle2 text-secondary q-mb-xs">
        {{ $t('offerSwapDialog.youReceive') }}
      </div>
      <div class="row q-col-gutter-sm">
        <div class="col-6">
          <q-select
            v-model="requestedChain"
            :options="chainOptions"
            emit-value
            map-options
            filled
            dense
            :label="$t('offerSwapDialog.requestedChain')"
            data-testid="swap-requested-chain-select"
          />
        </div>
        <div class="col-6">
          <q-input
            v-model="requestedAmount"
            type="number"
            filled
            dense
            :suffix="requestedUnit"
            :placeholder="'0.0'"
            data-testid="swap-requested-amount-input"
          />
        </div>
      </div>
    </q-card-section>

    <q-card-actions align="right" class="q-mt-sm">
      <q-btn
        flat
        :label="$t('offerSwapDialog.cancelBtnLabel')"
        color="grey-7"
        v-close-popup
      />
      <q-btn
        flat
        :disable="!canOffer || busy"
        :label="$t('offerSwapDialog.offerBtnLabel')"
        color="primary"
        data-testid="swap-offer-confirm-btn"
        v-close-popup
        @click="offerSwap"
      />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'

export default defineComponent({
  name: 'OfferSwapDialog',
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
  emits: ['offer'],
  data() {
    return {
      offeredChain: 'monad-testnet',
      offeredAmount: '',
      requestedChain: 'solana-testnet',
      requestedAmount: '',
    }
  },
  computed: {
    chainOptions() {
      return Object.values(PROTOCOL_CHAINS).map(chain => ({
        label: `${chain.name} (${chain.symbol})`,
        value: chain.id,
      }))
    },
    offeredUnit(): string {
      return PROTOCOL_CHAINS[this.offeredChain]?.symbol || 'MON'
    },
    requestedUnit(): string {
      return PROTOCOL_CHAINS[this.requestedChain]?.symbol || 'SOL'
    },
    canOffer(): boolean {
      const offeredNum = parseFloat(this.offeredAmount)
      const requestedNum = parseFloat(this.requestedAmount)
      return (
        !isNaN(offeredNum) &&
        offeredNum > 0 &&
        !isNaN(requestedNum) &&
        requestedNum > 0 &&
        this.offeredChain !== this.requestedChain
      )
    },
  },
  methods: {
    offerSwap() {
      if (!this.canOffer) return
      const swapId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

      this.$emit('offer', {
        type: 'swap-offer',
        swapId,
        offeredChain: this.offeredChain,
        offeredAsset: this.offeredUnit,
        offeredAmount: this.offeredAmount,
        requestedChain: this.requestedChain,
        requestedAsset: this.requestedUnit,
        requestedAmount: this.requestedAmount,
        status: 'pending',
        recipientAddress: this.address,
        createdAt: Date.now(),
      })
    },
  },
})
</script>
