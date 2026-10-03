import { Notify, openURL } from 'quasar'
import { transactionExplorerUrl } from './explorer'
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
        openURL(transactionExplorerUrl(txId))
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
export function desktopNotify(
  title: string,
  body: string,
  icon: string,
  callback: () => void,
  // One per message (its index): the browser replaces a notification that has the same tag, so the
  // same message never shows twice on a device even when two tabs or windows each notify for it.
  tag?: string,
) {
  const notify = new Notification(title, {
    body,
    icon,
    ...(tag === undefined ? {} : { tag }),
  })

  notify.onclick = () => {
    callback()
  }
}
