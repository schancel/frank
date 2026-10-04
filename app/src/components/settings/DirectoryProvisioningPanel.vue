<template>
  <section
    data-test="directory-provisioning"
    class="q-gutter-y-sm"
    aria-labelledby="directory-provisioning-title"
  >
    <h2 id="directory-provisioning-title" class="text-subtitle1">
      {{ $t('directoryProvisioning.title') }}
    </h2>
    <p
      role="status"
      aria-live="polite"
      data-test="directory-provisioning-status"
    >
      {{ $t(`directoryProvisioning.${statusKey}`) }}
    </p>
    <p>{{ $t('directoryProvisioning.explanation') }}</p>
    <p
      v-if="messaging.reason"
      id="directory-provisioning-reason"
      data-test="directory-provisioning-reason"
    >
      {{ $t(`directoryProvisioning.reasons.${messaging.reason}`) }}
    </p>
    <ul data-test="directory-participants" class="q-pl-md">
      <li
        v-for="id in participantIds"
        :key="id"
        :data-test="`directory-participant-${id}`"
      >
        {{ $t(`directoryProvisioning.participants.${id}`) }}:
        {{
          $t(`directoryProvisioning.participant.${messaging.participants[id]}`)
        }}
      </li>
    </ul>
    <p v-if="messaging.peerAddress" data-test="directory-peer-address">
      {{ $t('directoryProvisioning.peerAddress') }}
      <code>{{ messaging.peerAddress }}</code>
    </p>
    <ol id="directory-provisioning-steps" class="q-pl-md">
      <li>{{ $t('directoryProvisioning.stepExport') }}</li>
      <li>{{ $t('directoryProvisioning.stepInstall') }}</li>
      <li>{{ $t('directoryProvisioning.stepCheck') }}</li>
    </ol>
    <div class="q-gutter-sm">
      <q-btn
        :disable="busy"
        :label="$t('directoryProvisioning.exportPublic')"
        aria-describedby="directory-provisioning-steps"
        data-test="directory-export"
        @click="exportPublic"
      />
      <q-btn
        :disable="busy || messaging.status === 'checking'"
        :label="$t('directoryProvisioning.check')"
        aria-describedby="directory-provisioning-steps"
        data-test="directory-check"
        @click="check"
      />
    </div>
    <p v-if="exportError" role="alert" data-test="directory-export-error">
      {{ $t(`directoryProvisioning.reasons.${exportError}`) }}
    </p>
    <div v-if="exported">
      <label for="directory-export-text">
        {{ $t('directoryProvisioning.exportLabel') }}
      </label>
      <textarea
        id="directory-export-text"
        readonly
        rows="6"
        class="full-width"
        data-test="directory-export-text"
        :value="exported"
      />
      <a
        :href="downloadHref"
        download="frank-ui-public-export.json"
        data-test="directory-export-download"
      >
        {{ $t('directoryProvisioning.download') }}
      </a>
    </div>
    <p>{{ $t('directoryProvisioning.publicOnly') }}</p>
  </section>
</template>
<script setup lang="ts">
// Mounting reads nothing from the network and signs nothing. Export and Check are separate
// explicit actions. Export produces public bytes only. Check is the only action that may publish
// this account's own signed revision-zero evidence to its installed home relay.
import { computed, ref } from 'vue'
import {
  exportPublicIdentity,
  messagingState,
  refreshMessaging,
} from '../../utils/monad-identity-session'
import type { ReadinessReason } from '../../utils/directory-readiness'

const participantIds = ['relay-a', 'relay-b', 'bot'] as const
const messaging = messagingState
const busy = ref(false)
const exported = ref('')
const exportError = ref<ReadinessReason | null>(null)
const statusKey = computed(() =>
  messaging.status === 'ready'
    ? 'ready'
    : messaging.status === 'checking'
    ? 'checking'
    : 'pending',
)
const downloadHref = computed(
  () =>
    `data:application/json;charset=utf-8,${encodeURIComponent(exported.value)}`,
)
async function exportPublic() {
  busy.value = true
  exportError.value = null
  try {
    const result = await exportPublicIdentity()
    if (result.ok) exported.value = JSON.stringify(result.file, null, 2)
    else {
      exported.value = ''
      exportError.value = result.reason
    }
  } finally {
    busy.value = false
  }
}
async function check() {
  busy.value = true
  try {
    await refreshMessaging(true)
  } finally {
    busy.value = false
  }
}
</script>
