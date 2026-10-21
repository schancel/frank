<template>
  <q-page-container class="col full-height overflow-hidden">
    <q-page
      class="account-sync-page q-pa-md"
      :style-fn="viewportPageStyle"
      data-test="account-sync-receive"
    >
      <main class="account-sync-content">
        <template v-if="complete">
          <q-icon name="check_circle" color="positive" size="48px" />
          <h1 class="text-h5">{{ $t('accountSync.received') }}</h1>
          <q-btn
            unelevated
            no-caps
            color="primary"
            :label="$t('accountSync.done')"
            :to="doneTarget"
            replace
            data-test="sync-done"
          />
        </template>
        <template v-else>
          <q-btn
            flat
            no-caps
            icon="arrow_back"
            :label="$t('accountSync.back')"
            :disable="restoring"
            :to="backTarget"
            replace
            data-test="sync-back"
          />
          <h1 class="text-h5">{{ $t('accountSync.receive') }}</h1>
          <p
            v-if="navigationNotice"
            role="status"
            data-test="sync-navigation-notice"
          >
            {{ navigationNotice }}
          </p>
          <SyncPinEntry
            v-if="canReceive"
            :busy="restoring"
            @received="restore"
          />
          <p v-else role="alert">{{ $t('accountSync.hasAccount') }}</p>
          <p
            v-if="restoreFailed"
            role="alert"
            class="text-negative"
            data-test="sync-restore-error"
          >
            {{ $t('accountSync.restoreFailed') }}
          </p>
          <q-btn
            flat
            no-caps
            :label="$t('accountSync.cancel')"
            :disable="restoring"
            :to="backTarget"
            replace
            data-test="sync-cancel"
          />
        </template>
      </main>
    </q-page>
  </q-page-container>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import SyncPinEntry from '../components/SyncPinEntry.vue'
import { accountStatus } from '../accounts/session'
import {
  canReceiveSyncedAccount,
  requestWebAccountSyncSender,
  restoreAccountFromExtensionBundle,
} from '../utils/extension-account-sync'
import { isBrowserExtensionRuntime } from '../../src-bex/runtime-adapter'
import { useTranslate } from '../composables/useTranslate'
import { viewportPageStyle } from '../utils/layout'
const t = useTranslate()
const route = useRoute()
// Only the existing onboarding screen may receive a continuation, never an arbitrary route.
const onboardingReturn = computed(() =>
  typeof route.query.returnTo === 'string' &&
  /^\/onboard(?:[?#]|$)/.test(route.query.returnTo)
    ? route.query.returnTo
    : null,
)
const backTarget = computed(() => onboardingReturn.value ?? '/welcome')
const doneTarget = computed(() => onboardingReturn.value ?? '/forum')
const canReceive = computed(() => {
  void accountStatus.status
  return canReceiveSyncedAccount()
})
const complete = ref(false)
const restoring = ref(false)
const restoreFailed = ref(false)
const navigationNotice = ref('')
let disposed = false
onMounted(async () => {
  if (!isBrowserExtensionRuntime() || !canReceive.value) return
  const opened = await requestWebAccountSyncSender()
  if (!disposed)
    navigationNotice.value = t(
      opened ? 'accountSync.senderOpened' : 'accountSync.openSource',
    )
})
onBeforeUnmount(() => {
  disposed = true
})
onBeforeRouteLeave(() => !restoring.value)
async function restore(bundle: Record<string, unknown>) {
  if (disposed || restoring.value || !canReceive.value) return
  restoring.value = true
  restoreFailed.value = false
  try {
    const preferredDisplayName =
      onboardingReturn.value && typeof route.query.displayName === 'string'
        ? route.query.displayName.trim().slice(0, 80)
        : undefined
    const restored = await restoreAccountFromExtensionBundle(
      bundle,
      preferredDisplayName ? { preferredDisplayName } : undefined,
    )
    if (disposed) return
    complete.value = restored
    restoreFailed.value = !restored
  } finally {
    restoring.value = false
  }
}
</script>

<style scoped>
.account-sync-page {
  overflow-y: auto;
  overflow-x: hidden;
}
.account-sync-content {
  width: 100%;
  max-width: 32rem;
  margin: 0 auto;
  padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0px));
}
</style>
