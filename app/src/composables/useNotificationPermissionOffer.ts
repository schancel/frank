import { computed, readonly, ref, watch, type Ref } from 'vue'
import {
  NOTIFICATION_PROMPT_DISMISSED_KEY,
  NOTIFICATIONS_ENABLED_KEY,
  useNotificationPermission,
} from './useNotificationPermission'

// This is a device UI preference, not a stored permission or an account record.
// Read-only mounting never writes it; only an explicit user action on the offer does.
const DISMISSED_KEY = 'frank.notification-offer-dismissed.v1'
function isDismissed(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(DISMISSED_KEY) === '1' ||
      globalThis.localStorage?.getItem(NOTIFICATION_PROMPT_DISMISSED_KEY) ===
        '1' ||
      globalThis.localStorage?.getItem(NOTIFICATIONS_ENABLED_KEY) === '1'
    )
  } catch {
    return false
  }
}
function rememberDismissal() {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, '1')
    globalThis.localStorage?.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, '1')
  } catch {
    // Storage may be blocked; the in-memory offer guard still prevents remount spam.
  }
}
function clearDismissal() {
  try {
    globalThis.localStorage?.removeItem(DISMISSED_KEY)
    globalThis.localStorage?.removeItem(NOTIFICATION_PROMPT_DISMISSED_KEY)
  } catch {
    // Ignore storage removal errors.
  }
}

// The live-runtime guard also covers remounts while storage is unavailable.
let offered = false

export function useNotificationPermissionOffer(ready: Readonly<Ref<boolean>>) {
  const { permission, requesting, enable } = useNotificationPermission()
  const showing = ref(false)
  const failed = ref(false)
  watch(
    [ready, permission],
    ([isReady, state]) => {
      if (!isReady || state !== 'default') {
        showing.value = false
        return
      }
      if (offered || isDismissed()) return
      offered = true
      showing.value = true
    },
    { immediate: true },
  )

  function dismiss() {
    rememberDismissal()
    showing.value = false
  }

  // Do not defer this call: the permission helper must retain the click's activation.
  async function enableNotifications() {
    if (!ready.value || permission.value !== 'default' || requesting.value)
      return
    failed.value = false
    rememberDismissal()
    try {
      await enable()
      showing.value = false
    } catch {
      clearDismissal()
      failed.value = true
    }
  }

  return {
    visible: computed(
      () => showing.value && ready.value && permission.value === 'default',
    ),
    requesting,
    failed: readonly(failed),
    enableNotifications,
    dismiss,
  }
}
