<template>
  <q-banner
    v-if="unchecked"
    dense
    rounded
    role="status"
    class="bg-amber-1 text-brown-10 q-ma-sm"
    data-test="own-profile-unchecked"
  >
    <template #avatar>
      <q-icon name="cloud_off" color="warning" />
    </template>
    <div class="text-caption">
      {{ $t('accountRecovery.profile_relay_unchecked') }}
    </div>
    <div v-if="saveWaits" class="text-caption q-mt-xs">
      {{ $t('accountRecovery.profile_relay_unchecked_save_waits') }}
    </div>
  </q-banner>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useProfileStore } from 'src/stores/my-profile'
import { ownProfileCheck } from 'src/utils/own-profile'

/**
 * Says, without blocking anything, that the relay has not answered for the active account's
 * published profile yet (see `ownProfileCheck`).
 */
defineProps<{ saveWaits?: boolean }>()

const store = useProfileStore()
const unchecked = computed(
  () =>
    ownProfileCheck.unchecked !== null &&
    ownProfileCheck.unchecked === store.owner?.toLowerCase(),
)
</script>
