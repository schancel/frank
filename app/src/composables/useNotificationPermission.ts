import { onMounted, onUnmounted, readonly, ref } from 'vue'

export type BrowserNotificationPermission =
  | NotificationPermission
  | 'unsupported'

function readPermission(): BrowserNotificationPermission {
  return typeof Notification === 'undefined'
    ? 'unsupported'
    : Notification.permission
}

// A view of browser state, never an application preference or persisted grant.
const permission = ref<BrowserNotificationPermission>(readPermission())
const requesting = ref(false)

export function useNotificationPermission() {
  const refresh = () => {
    permission.value = readPermission()
  }
  refresh()
  onMounted(() => {
    refresh()
    if (typeof window !== 'undefined') window.addEventListener('focus', refresh)
  })
  onUnmounted(() => {
    if (typeof window !== 'undefined')
      window.removeEventListener('focus', refresh)
  })

  // Call only from a user action. Invoke the browser synchronously to retain activation.
  async function enable() {
    refresh()
    if (permission.value !== 'default' || requesting.value) return
    requesting.value = true
    try {
      await new Promise<NotificationPermission>((resolve, reject) => {
        const result = Notification.requestPermission(resolve)
        result?.then(resolve, reject)
      })
    } finally {
      requesting.value = false
      refresh()
    }
  }
  return {
    permission: readonly(permission),
    requesting: readonly(requesting),
    refresh,
    enable,
  }
}
