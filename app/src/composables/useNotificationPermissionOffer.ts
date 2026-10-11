import { onUnmounted, watch, type Ref } from 'vue'
import { Notify } from 'quasar'
import { translateMessage as t } from 'src/i18n'
import { useNotificationPermission } from './useNotificationPermission'

// Dismissing the offer lasts for this app runtime, including component remounts.
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
      if (offered) return
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
              void enable().catch(() =>
                Notify.create({
                  type: 'negative',
                  message: t('notificationPermission.failed'),
                  html: false,
                }),
              )
            },
          },
          { label: t('notificationPermission.notNow') },
        ],
      })
    },
    { immediate: true },
  )
  onUnmounted(() => dismiss?.())
}
