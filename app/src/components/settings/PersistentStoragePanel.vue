<template>
  <section class="q-gutter-y-md" data-test="persistent-storage">
    <h2 class="text-subtitle1 q-mb-xs">
      {{ $t('accountRecovery.browser_storage') }}
    </h2>

    <div class="row items-center q-gutter-x-sm">
      <span class="text-weight-medium"
        >{{ $t('persistentStorage.heading') }}:</span
      >
      <q-chip
        dense
        :color="statusChipColor"
        :text-color="statusChipTextColor"
        :icon="statusChipIcon"
        role="status"
        aria-live="polite"
        data-test="persistent-storage-chip"
      >
        {{ $t(statusLabel) }}
      </q-chip>
    </div>

    <p class="text-body2 text-grey-8">
      {{
        status === 'granted'
          ? $t('persistentStorage.explainGranted')
          : status === 'unsupported'
          ? $t('persistentStorage.explainUnsupported')
          : status === 'not-granted'
          ? $t('persistentStorage.explainNotGranted')
          : $t(
              'accountRecovery.browser_persistence_reduces_automatic_eviction_it_is',
            )
      }}
    </p>

    <div v-if="status === 'not-granted'" class="q-gutter-y-sm">
      <q-btn
        color="primary"
        no-caps
        unelevated
        :loading="isRequesting"
        :disable="isRequesting"
        :label="$t('accountRecovery.request_persistent_storage')"
        data-test="request-persistent-storage-btn"
        @click="requestStorage"
      />

      <q-banner
        v-if="hasRequested && status === 'not-granted'"
        rounded
        dense
        class="bg-blue-1 text-blue-10 q-mt-sm"
        data-test="safari-tip-banner"
      >
        <template #avatar>
          <q-icon name="info" color="primary" />
        </template>
        <div class="text-caption">
          {{ $t('persistentStorage.safariTip') }}
        </div>
      </q-banner>
    </div>

    <p v-if="account.account" class="text-caption text-grey-7">
      {{ $t('accountRecovery.keep_independent_account_backup') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useQuasar } from 'quasar'
import { usePersistentStorageStore } from '../../stores/persistent-storage'
import { translateMessage } from '../../i18n'
import { accountStatus as account } from '../../accounts/session'

const $q = useQuasar()
const storage = usePersistentStorageStore()
const { status } = storeToRefs(storage)

const isRequesting = ref(false)
const hasRequested = ref(false)

const statusChipColor = computed(() => {
  switch (status.value) {
    case 'granted':
      return 'positive'
    case 'not-granted':
      return 'warning'
    case 'unsupported':
      return 'grey-6'
    default:
      return 'grey-5'
  }
})

const statusChipTextColor = computed(() => {
  return status.value === 'not-granted' ? 'dark' : 'white'
})

const statusChipIcon = computed(() => {
  switch (status.value) {
    case 'granted':
      return 'check_circle'
    case 'not-granted':
      return 'info'
    case 'unsupported':
      return 'block'
    default:
      return 'help_outline'
  }
})

const statusLabel = computed(() => {
  const keys = {
    'granted': 'persistentStorage.granted',
    'not-granted': 'persistentStorage.notGranted',
    'unsupported': 'persistentStorage.unsupported',
    'unknown': 'persistentStorage.unknown',
  }
  return keys[status.value]
})

async function requestStorage() {
  isRequesting.value = true
  hasRequested.value = true
  try {
    await storage.request()
    if (status.value === 'granted') {
      $q?.notify?.({
        type: 'positive',
        message: translateMessage('persistentStorage.grantedToast'),
      })
    } else if (status.value === 'not-granted') {
      $q?.notify?.({
        type: 'warning',
        message: translateMessage('persistentStorage.declinedToast'),
      })
    }
  } finally {
    isRequesting.value = false
  }
}

onMounted(() => {
  void storage.refresh()
})
</script>
