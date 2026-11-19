<template>
  <q-banner
    v-if="visible"
    dense
    inline-actions
    rounded
    class="notification-offer q-mx-sm q-mt-sm"
    data-testid="notification-permission-offer"
  >
    <template #avatar>
      <q-icon name="notifications" color="primary" size="sm" />
    </template>
    <div class="text-body2 text-weight-medium">
      {{ $t('notificationPermission.offer') }}
    </div>
    <div class="text-caption text-grey-7">
      {{ $t('notificationPermission.offerHint') }}
    </div>
    <div v-if="failed" role="alert" class="text-caption text-negative">
      {{ $t('notificationPermission.failed') }}
    </div>
    <template #action>
      <q-btn
        unelevated
        dense
        no-caps
        color="primary"
        class="q-px-sm"
        :label="$t('notificationPermission.enable')"
        :loading="requesting"
        :disable="requesting"
        data-testid="notification-permission-enable"
        @click="enableNotifications"
      />
      <q-btn
        flat
        dense
        no-caps
        class="q-px-sm"
        :label="$t('notificationPermission.notNow')"
        :disable="requesting"
        data-testid="notification-permission-dismiss"
        @click="dismiss"
      />
    </template>
  </q-banner>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useNotificationPermissionOffer } from '../../composables/useNotificationPermissionOffer'

const props = defineProps<{ ready: boolean }>()
const { visible, requesting, failed, enableNotifications, dismiss } =
  useNotificationPermissionOffer(toRef(props, 'ready'))
</script>

<style scoped>
.notification-offer {
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.02);
}

.body--dark .notification-offer {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
}
</style>
