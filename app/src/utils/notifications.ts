import { Notify, openURL } from 'quasar'
import { transactionExplorerUrl } from './explorer'

// Error notifications

function negativeNotify(text: string) {
  Notify.create({
    message: '<div class="text-center"> ' + text + ' </div>',
    html: true,
    color: 'negative',
  })
}

export function errorNotify(
  err: { response?: unknown; message: string } & { shortMessage?: unknown },
) {
  console.error(err)
  if (err.response) {
    console.error(err.response)
  }
  // Found live testing a real failed send (ticket #53 GUI verification): a real ethers v6
  // CALL_EXCEPTION's `.message` is a full technical dump (the exact failing tx's calldata, `to`,
  // `code`, library version, ...) -- correctly surfaced (the notification mechanism itself
  // works), just unreadable for an end user trying to figure out why their message didn't send.
  // ethers v6 errors carry a separate `.shortMessage` specifically for this (a terse,
  // human-readable summary) -- e.g. "missing revert data" here, not the whole dump. Falls back to
  // the full `.message` for plain `Error`s (no `.shortMessage`), unchanged from before.
  const message =
    typeof err.shortMessage === 'string' ? err.shortMessage : err.message
  negativeNotify(message)
}

// Info notifications

export function infoNotify(text: string) {
  Notify.create({
    message: '<div class="text-center"> ' + text + ' </div>',
    html: true,
    color: 'accent',
  })
}

export function addressCopiedNotify() {
  infoNotify('Address copied to clipboard.')
}

export function insufficientStampNotify() {
  infoNotify('Stamp is too small, receiver will not be notified.')
}

export function seedCopiedNotify() {
  infoNotify('Your recovery phrase has been copied to your clipboard.')
}

export function sentTransactionNotify(txId?: string) {
  const action = {
    label: 'View',
    color: 'secondary',
    handler: () => {
      if (txId) {
        openURL(transactionExplorerUrl(txId))
      }
    },
  }
  const actions = txId ? [action] : []

  Notify.create({
    message: '<div class="text-center"> Sent transaction </div>',
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
