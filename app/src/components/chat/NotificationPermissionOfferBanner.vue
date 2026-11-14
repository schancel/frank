<template>
  <q-banner
    v-if="visible"
    class="q-pa-sm"
    data-testid="notification-permission-offer"
  >
    {{ $t('notificationPermission.offer') }}
    <div class="text-caption">{{ $t('notificationPermission.offerHint') }}</div>
    <div v-if="failed" role="alert" class="text-negative">
      {{ $t('notificationPermission.failed') }}
    </div>
    <template #action>
      <q-btn
        flat
        no-caps
        color="primary"
        :label="$t('notificationPermission.enable')"
        :loading="requesting"
        :disable="requesting"
        data-testid="notification-permission-enable"
        @click="enableNotifications"
      />
      <q-btn
        flat
        no-caps
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
