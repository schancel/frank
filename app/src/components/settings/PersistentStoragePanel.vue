<template>
  <section class="q-gutter-y-sm" data-test="persistent-storage">
    <h2 class="text-subtitle1">{{ $t('accountRecovery.browser_storage') }}</h2>
    <p role="status" aria-live="polite">{{ status }}</p>
    <p>
      {{
        $t(
          'accountRecovery.browser_persistence_reduces_automatic_eviction_it_is',
        )
      }}
    </p>
    <q-btn
      v-if="status === 'not-granted'"
      :label="$t('accountRecovery.request_persistent_storage')"
      @click="storage.request()"
    />
    <p v-if="account.account">
      {{
        $t('accountRecovery.frank_account_backup_shares_were_verified_before')
      }}
    </p>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { usePersistentStorageStore } from '../../stores/persistent-storage'
import { accountStatus as account } from '../../accounts/session'
const storage = usePersistentStorageStore()
const { status } = storeToRefs(storage)
onMounted(() => {
  void storage.refresh()
})
</script>
