<template>
  <section aria-labelledby="notification-permission-title">
    <h2 id="notification-permission-title" class="text-subtitle1 q-mt-none">
      {{ $t('notificationPermission.title') }}
    </h2>
    <p role="status" aria-live="polite" data-test="notification-status">
      {{ $t(`notificationPermission.${permission}`) }}
    </p>
    <p class="text-body2">{{ $t('notificationPermission.contactHint') }}</p>
    <q-btn
      v-if="permission === 'default'"
      color="primary"
      no-caps
      :label="$t('notificationPermission.enable')"
      :loading="requesting"
      :disable="requesting"
      data-test="enable-notifications"
      @click="enableNotifications"
    />
    <p v-if="failed" role="alert" class="text-negative q-mt-md">
      {{ $t('notificationPermission.failed') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useNotificationPermission } from 'src/composables/useNotificationPermission'
import { syncRelayNotificationPolicy } from 'src/utils/webpush-sync'

const { permission, requesting, enable } = useNotificationPermission()
const failed = ref(false)
async function enableNotifications() {
  failed.value = false
  try {
    await enable()
    if (permission.value === 'granted') {
      void syncRelayNotificationPolicy({ subscribeIfGranted: true })
    }
  } catch {
    failed.value = true
  }
}
</script>
