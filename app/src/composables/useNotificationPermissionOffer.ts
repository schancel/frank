import { onUnmounted, watch, type Ref } from 'vue'
import { Notify } from 'quasar'
import { translateMessage as t } from 'src/i18n'
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
  const { permission, enable } = useNotificationPermission()
  let dismiss: (() => void) | undefined
  watch(
    [ready, permission],
    ([isReady, state]) => {
      if (!isReady || state !== 'default') {
        dismiss?.()
        dismiss = undefined
        return
      }
      if (offered || isDismissed()) return
      offered = true
      dismiss = Notify.create({
        message: t('notificationPermission.offer'),
        caption: t('notificationPermission.offerHint'),
        html: false,
        timeout: 0,
        position: 'bottom-right',
        actions: [
          {
            label: t('notificationPermission.enable'),
            handler: () => {
              rememberDismissal()
              void enable().catch(() => {
                clearDismissal()
                Notify.create({
                  type: 'negative',
                  message: t('notificationPermission.failed'),
                  html: false,
                })
              })
            },
          },
          {
            label: t('notificationPermission.notNow'),
            handler: rememberDismissal,
          },
        ],
      })
    },
    { immediate: true },
  )
  onUnmounted(() => dismiss?.())
}
