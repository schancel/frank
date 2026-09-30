<template>
  <section
    v-if="visible"
    class="q-pa-sm"
    :aria-label="$t('backupReminder.regionLabel')"
    data-test="backup-reminder"
  >
    <q-banner dense rounded class="bg-orange-2 text-black">
      {{ $t('backupReminder.message') }}
      <template #action>
        <q-btn
          flat
          dense
          color="primary"
          data-test="backup-reminder-confirm"
          :label="$t('backupReminder.confirm')"
          @click="$emit('confirm')"
        />
        <q-btn
          flat
          dense
          data-test="backup-reminder-dismiss"
          :label="$t('backupReminder.dismiss')"
          @click="dismiss"
        />
      </template>
    </q-banner>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { useProfileStore } from 'src/stores/my-profile'
import { useWalletStore } from 'src/stores/wallet'
import { needsBackupConfirmation } from '../../utils/account-state'

// Dismissal lasts for this app session only: the reminder is gentle, never blocks anything, and
// comes back on the next launch until the phrase is confirmed. The Settings item stays available.
const dismissed = ref(false)

export function resetBackupReminderDismissal() {
  dismissed.value = false
}

export default defineComponent({
  emits: ['confirm'],
  setup() {
    const wallet = useWalletStore()
    const profile = useProfileStore()
    const visible = computed(
      () =>
        !dismissed.value &&
        needsBackupConfirmation({
          seedPhrase: wallet.seedPhrase,
          name: profile.profile?.name,
          seedConfirmedAt: wallet.seedConfirmedAt,
        }),
    )
    return {
      visible,
      dismiss() {
        dismissed.value = true
      },
    }
  },
})
</script>
