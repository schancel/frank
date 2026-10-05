<template>
  <div class="q-mb-sm">
    <q-banner rounded :class="[banner, 'text-center']">
      <q-icon name="visibility_off" size="sm" class="q-mr-xs" />
      <span>{{ formatSats(amount) }}</span>
      <q-badge
        v-if="chainId"
        color="primary"
        class="q-ml-sm"
        data-testid="stealth-chain-badge"
      >
        {{ chainId }}
      </q-badge>
    </q-banner>
  </div>
</template>

<script lang="ts">
import { useQuasar } from 'quasar'
import { defineComponent } from 'vue'

import { formatBalance } from '../../../utils/formatting'

export default defineComponent({
  props: {
    amount: {
      type: Number,
      required: true,
    },
    chainId: {
      type: String,
      default: undefined,
    },
  },
  setup() {
    const $q = useQuasar()
    return {
      banner: $q.dark.isActive ? 'bg-pink-10' : 'bg-pink-2',
      formatSats(value: number) {
        return formatBalance(value)
      },
    }
  },
})
</script>
