<template>
  <span
    v-if="status.snapshot"
    data-testid="negotiation-recovery-status"
    role="status"
    aria-live="polite"
    class="text-caption q-mx-xs"
    >{{ $t(`negotiationRecovery.${status.snapshot.state}`) }}</span
  >
</template>
<script lang="ts">
import { defineComponent } from 'vue'
import { negotiationRecoveryStatus as status } from '../../utils/negotiation-recovery'
export default defineComponent({
  name: 'NegotiationRecoveryIndicator',
  setup: () => ({ status }),
})
</script>
