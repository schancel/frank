import { onMounted, onUnmounted, readonly, ref } from 'vue'

export type BrowserNotificationPermission =
  | NotificationPermission
  | 'unsupported'

export const NOTIFICATIONS_ENABLED_KEY = 'frank:notifications-enabled'
export const NOTIFICATION_PROMPT_DISMISSED_KEY =
  'frank:notification-prompt-dismissed'

const EXTENSION_PROTOCOLS = new Set([
  'chrome-extension:',
  'safari-web-extension:',
  'moz-extension:',
])

export function isExtensionNotificationContext(): boolean {
  if (typeof window !== 'undefined' && window.location) {
    if (
      window.location.protocol &&
      EXTENSION_PROTOCOLS.has(window.location.protocol)
    ) {
      return true
    }
    if (
      typeof window.location.search === 'string' &&
      window.location.search.includes('extMode=')
    ) {
      return true
    }
  }
  const g = globalThis as Record<string, any>
  if (g?.chrome?.runtime?.id || g?.browser?.runtime?.id) {
    return true
  }
  return false
}

function readPersistedEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(NOTIFICATIONS_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function writeExtensionPreference(enabled: boolean) {
  try {
    globalThis.localStorage?.setItem(NOTIFICATION_PROMPT_DISMISSED_KEY, '1')
    if (enabled) {
      globalThis.localStorage?.setItem(NOTIFICATIONS_ENABLED_KEY, '1')
    } else {
      globalThis.localStorage?.removeItem(NOTIFICATIONS_ENABLED_KEY)
    }
  } catch {
    // Ignore blocked storage
  }
}

function readPermission(): BrowserNotificationPermission {
  const raw =
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission
  if (raw === 'granted' || raw === 'denied') {
    return raw
  }
  if (isExtensionNotificationContext() && readPersistedEnabled()) {
    return 'granted'
  }
  return raw
}

// A view of browser state, falling back to persisted preference in transient extension popups.
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
    const inExtension = isExtensionNotificationContext()
    if (inExtension) {
      // Persist immediately before invoking requestPermission because browser extension
      // popups can lose focus and close as soon as a native permission bubble opens,
      // or resolve to 'default' without displaying a prompt.
      writeExtensionPreference(true)
    }
    try {
      if (
        typeof Notification !== 'undefined' &&
        typeof Notification.requestPermission === 'function'
      ) {
        const outcome = await new Promise<NotificationPermission>(
          (resolve, reject) => {
            const result = Notification.requestPermission(resolve)
            result?.then(resolve, reject)
          },
        )
        if (inExtension && outcome === 'denied') {
          writeExtensionPreference(false)
        }
      }
    } catch (err) {
      if (!inExtension) {
        throw err
      }
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
