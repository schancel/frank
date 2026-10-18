<template>
  <span
    v-if="
      status.snapshot &&
      status.snapshot.state !== 'ready' &&
      status.snapshot.state !== 'unsupported' &&
      status.snapshot.state !== 'restoring' &&
      status.snapshot.state !== 'scanning'
    "
    class="negotiation-recovery-indicator"
  >
    <q-btn
      flat
      dense
      round
      size="sm"
      icon="sync_problem"
      color="warning"
      :aria-label="$t(`negotiationRecovery.${status.snapshot.state}`)"
    >
      <q-tooltip>{{
        $t(`negotiationRecovery.${status.snapshot.state}`)
      }}</q-tooltip>
    </q-btn>
    <span
      data-testid="negotiation-recovery-status"
      class="q-sr-only"
      role="status"
      aria-live="polite"
      >{{ $t(`negotiationRecovery.${status.snapshot.state}`) }}</span
    >
  </span>
</template>
<script lang="ts">
import { defineComponent } from 'vue'
import { negotiationRecoveryStatus as status } from '../../utils/negotiation-recovery'
export default defineComponent({
  name: 'NegotiationRecoveryIndicator',
  setup: () => ({ status }),
})
</script>
<style scoped>
.negotiation-recovery-indicator {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
