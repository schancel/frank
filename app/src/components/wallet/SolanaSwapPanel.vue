<template>
  <!-- Placeholder: the Solana swap panel is written separately and replaces this file. -->
  <q-card flat bordered data-testid="solana-swap-panel">
    <q-card-section role="status" data-testid="swap-unavailable">
      <div class="text-subtitle1 text-weight-medium">
        {{ $t('walletPanel.swapUnavailable') }}
      </div>
      <p class="text-body2 text-grey-7 q-mt-sm q-mb-none">
        {{ $t('swap.unavailableSolana') }}
      </p>
    </q-card-section>
  </q-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'SolanaSwapPanel',
  props: {
    selectedWallet: { type: String, required: true },
    isTestnet: { type: Boolean, default: true },
  },
})
</script>
