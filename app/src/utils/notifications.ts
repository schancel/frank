import { Notify, openURL } from 'quasar'
import { transactionExplorerUrl } from './explorer'
import { markdownPlainText } from './markdown-plain-text'
import { translateMessage } from 'src/i18n'

const $t = (key: string) => translateMessage(key)

// Error notifications

function negativeNotify(text: string) {
  Notify.create({
    message: text,
    html: false,
    classes: 'text-center',
    color: 'negative',
  })
}

export type ErrorNotifyOptions = {
  /** A stable i18n key for a more specific user-facing recovery message. */
  fallbackKey?: string
  /** An already-localized, app-authored message. Never pass provider or relay text here. */
  safeMessage?: string
}

const genericErrorKey = 'notifications.unexpectedError'

function errorMessageFor(options: ErrorNotifyOptions): string {
  if (options.fallbackKey) {
    const translatedFallback = $t(options.fallbackKey)
    if (translatedFallback !== options.fallbackKey) {
      return translatedFallback
    }
  }
  if (options.safeMessage) {
    return options.safeMessage
  }
  return $t(genericErrorKey)
}

export function errorNotify(err: unknown, options: ErrorNotifyOptions = {}) {
  console.error(err)
  if (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    err.response
  ) {
    console.error(err.response)
  }
  // Provider and relay errors can contain transaction dumps, English-only text, or markup. Keep
  // those details in diagnostics and make the user-facing recovery message an explicit app-owned
  // translation. A missing caller key fails closed to the generic message.
  negativeNotify(errorMessageFor(options))
}

// Info notifications

export function infoNotify(text: string) {
  Notify.create({
    // Some callers include relay-authored values (for example a forum topic). Keep Quasar on its
    // textContent path so those values can never become notification markup or event handlers.
    message: text,
    html: false,
    classes: 'text-center',
    color: 'accent',
  })
}

export function addressCopiedNotify(customMessage?: string) {
  infoNotify(customMessage ?? $t('notifications.addressCopied'))
}

export function insufficientStampNotify(customMessage?: string) {
  infoNotify(customMessage ?? $t('notifications.insufficientStamp'))
}

export function seedCopiedNotify(customMessage?: string) {
  infoNotify(customMessage ?? $t('notifications.seedCopied'))
}

export function sentTransactionNotify(txId?: string, customMessage?: string) {
  const action = {
    label: $t('notifications.viewAction'),
    color: 'secondary',
    handler: () => {
      if (txId) {
        const url = transactionExplorerUrl(txId)
        if (url) {
          openURL(url)
        }
      }
    },
  }
  const actions = txId ? [action] : []
  const messageText = customMessage ?? $t('notifications.sentTransaction')

  Notify.create({
    message: `<div class="text-center"> ${messageText} </div>`,
    html: true,
    color: 'accent',
    actions,
  })
}
const activeNotifications = new Map<string, Notification>()
const notificationCallbacksByTag = new Map<string, () => void>()
let lastNotificationCallback: (() => void) | null = null
let untaggedNotificationCounter = 0

export function invokeNotificationClickCallback(tag?: string): boolean {
  if (tag && notificationCallbacksByTag.has(tag)) {
    const cb = notificationCallbacksByTag.get(tag)
    notificationCallbacksByTag.delete(tag)
    if (cb) {
      cb()
      return true
    }
  }
  if (lastNotificationCallback) {
    const cb = lastNotificationCallback
    lastNotificationCallback = null
    cb()
    return true
  }
  return false
}

export function desktopNotify(
  title: string,
  body: string,
  icon: string,
  callback: () => void,
  // One per message (its index): the browser replaces a notification that has the same tag, so the
  // same message never shows twice on a device even when two tabs or windows each notify for it.
  tag?: string,
) {
  const plainBody = markdownPlainText(body)
  lastNotificationCallback = callback
  if (tag) {
    if (notificationCallbacksByTag.size >= 100) {
      const oldestKey = notificationCallbacksByTag.keys().next().value
      if (oldestKey !== undefined) notificationCallbacksByTag.delete(oldestKey)
    }
    notificationCallbacksByTag.set(tag, callback)
  }

  // A notification shows text as it is: the message's words, without its Markdown syntax.
  try {
    if (typeof Notification === 'function') {
      const notify = new Notification(title, {
        body: plainBody,
        icon,
        ...(tag === undefined ? {} : { tag }),
      })
      const retentionKey = tag ?? `__untagged_${++untaggedNotificationCounter}`
      if (activeNotifications.size >= 50) {
        const oldestKey = activeNotifications.keys().next().value
        if (oldestKey !== undefined) activeNotifications.delete(oldestKey)
      }
      activeNotifications.set(retentionKey, notify)

      notify.onclose = () => {
        activeNotifications.delete(retentionKey)
      }

      notify.onclick = () => {
        activeNotifications.delete(retentionKey)
        if (tag) {
          notificationCallbacksByTag.delete(tag)
        }
        try {
          notify.close?.()
        } catch {
          // Ignored
        }
        try {
          window.focus()
        } catch {
          // Ignored: window.focus may be restricted in some browser contexts
        }
        callback()
      }
      return
    }
  } catch {
    // Mobile browsers (e.g. Android Chrome) throw TypeError: Illegal constructor on
    // `new Notification(...)` and require ServiceWorkerRegistration.showNotification().
  }

  if (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof navigator.serviceWorker?.getRegistration === 'function'
  ) {
    void navigator.serviceWorker
      .getRegistration()
      .then(reg => {
        if (reg && typeof reg.showNotification === 'function') {
          return reg.showNotification(title, {
            body: plainBody,
            icon,
            ...(tag === undefined ? {} : { tag, data: { tag } }),
          })
        }
        return undefined
      })
      .catch(() => undefined)
  }
}

