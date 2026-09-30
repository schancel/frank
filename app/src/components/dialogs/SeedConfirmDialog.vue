<template>
  <q-card class="q-px-sm q-pb-md dialog-medium">
    <q-card-section>
      <seed-confirm-step
        v-if="challenge"
        :seed="challenge.seed"
        :positions="challenge.positions"
        :confirmed="confirmed"
        @confirmed="onConfirmed"
      />
    </q-card-section>
    <q-card-actions align="right">
      <q-btn flat :label="$t('close')" color="primary" v-close-popup />
    </q-card-actions>
  </q-card>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { useWalletStore } from 'src/stores/wallet'
import {
  ensureConfirmationChallenge,
  normalizeSetupMnemonic,
} from '../../utils/setup-account'
import SeedConfirmStep from '../setup/SeedConfirmStep.vue'

/**
 * Confirm the recovery phrase ALREADY stored on this device (#284). It reads the stored seed and
 * only ever writes the confirmation marker: the seed is re-stored with the identical value and
 * is never generated, replaced, logged or sent anywhere.
 */
export default defineComponent({
  components: { SeedConfirmStep },
  emits: ['confirmed'],
  setup(_props, { emit }) {
    const wallet = useWalletStore()
    const challenge = computed(() =>
      wallet.seedPhrase
        ? ensureConfirmationChallenge(null, wallet.seedPhrase)
        : null,
    )
    // computed() caches the draw for as long as the stored seed is unchanged.
    const confirmed = computed(
      () => !!wallet.seedPhrase && wallet.seedConfirmedAt != null,
    )
    return {
      challenge,
      confirmed,
      onConfirmed() {
        const seed = wallet.seedPhrase
        if (!seed || !challenge.value) return
        if (challenge.value.seed !== normalizeSetupMnemonic(seed)) return
        wallet.setSeedPhrase(seed, Date.now())
        emit('confirmed')
      },
    }
  },
})
</script>
