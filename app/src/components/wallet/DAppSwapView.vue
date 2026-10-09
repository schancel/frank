<template>
  <div class="q-py-sm" data-testid="dapp-swap-view">
    <q-card flat bordered>
      <q-card-section>
        <div role="status" data-testid="swap-unavailable">
          <div class="text-subtitle1 text-weight-medium">
            {{ $t('walletPanel.swapUnavailable') }}
          </div>
          <p class="text-body2 text-grey-7 q-mt-sm q-mb-md">
            {{ $t('walletPanel.swapUnavailableDescription') }}
          </p>
        </div>
        <q-btn
          disable
          no-caps
          color="primary"
          class="full-width"
          data-testid="swap-execute-btn"
          :label="$t('walletPanel.swapExecute')"
        />
      </q-card-section>
    </q-card>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'DAppSwapView',
  props: {
    selectedWallet: {
      type: String,
      default: 'monad',
    },
  },
})
</script>
