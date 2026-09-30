<template>
  <div class="persistent-storage q-gutter-y-sm" data-test="persistent-storage">
    <h2 class="text-subtitle1 q-ma-none">
      {{ $t('persistentStorage.heading') }}
    </h2>
    <p
      class="q-ma-none text-weight-bold"
      role="status"
      aria-live="polite"
      data-test="persistent-storage-status"
    >
      {{ statusText }}
    </p>
    <p class="q-ma-none" data-test="persistent-storage-explanation">
      {{ explanation }}
    </p>

    <q-btn
      v-if="status === 'not-granted'"
      outline
      color="primary"
      no-caps
      data-test="persistent-storage-request"
      :label="$t('persistentStorage.request')"
      @click="request"
    />

    <p
      v-if="seedConfirmed"
      class="q-ma-none text-positive"
      data-test="persistent-storage-seed-confirmed"
    >
      {{ $t('persistentStorage.seedConfirmed') }}
    </p>
    <q-btn
      v-else-if="hasSeed"
      color="primary"
      no-caps
      data-test="persistent-storage-confirm-seed"
      :label="$t('persistentStorage.confirmSeed')"
      @click="seedConfirmOpen = true"
    />

    <q-dialog v-model="seedConfirmOpen">
      <seed-confirm-dialog @confirmed="seedConfirmOpen = false" />
    </q-dialog>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { usePersistentStorageStore } from 'src/stores/persistent-storage'
import { useWalletStore } from 'src/stores/wallet'
import SeedConfirmDialog from '../dialogs/SeedConfirmDialog.vue'

/**
 * Settings > Storage (ticket #370): whether the browser will keep the stored seed, what it means
 * when it will not, and a shortcut to confirm the recovery phrase (the only real backup).
 */
export default defineComponent({
  components: { SeedConfirmDialog },
  setup() {
    const storage = usePersistentStorageStore()
    const wallet = useWalletStore()
    const { status } = storeToRefs(storage)
    const seedConfirmOpen = ref(false)
    onMounted(() => {
      void storage.refresh()
    })
    return {
      status,
      seedConfirmOpen,
      hasSeed: computed(() => !!wallet.seedPhrase),
      seedConfirmed: computed(
        () => !!wallet.seedPhrase && wallet.seedConfirmedAt != null,
      ),
      request: () => storage.request(),
    }
  },
  computed: {
    statusText(): string {
      switch (this.status) {
        case 'granted':
          return this.$t('persistentStorage.granted')
        case 'not-granted':
          return this.$t('persistentStorage.notGranted')
        case 'unsupported':
          return this.$t('persistentStorage.unsupported')
        default:
          return this.$t('persistentStorage.unknown')
      }
    },
    explanation(): string {
      switch (this.status) {
        case 'granted':
          return this.$t('persistentStorage.explainGranted')
        case 'unsupported':
          return this.$t('persistentStorage.explainUnsupported')
        case 'not-granted':
          return this.$t('persistentStorage.explainNotGranted')
        default:
          return ''
      }
    },
  },
})
</script>
