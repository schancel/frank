/*
 * This file (which will be your service worker)
 * is picked up by the build system ONLY if
 * quasar.conf > pwa > workboxPluginMode is set to "InjectManifest"
 */

const BLIND_WAKEUP_MESSAGE_TYPE = 'FRANK_BLIND_WAKEUP_SYNC'
const BLIND_WAKEUP_HANDLED_TYPE = 'FRANK_BLIND_WAKEUP_HANDLED'
const BLIND_WAKEUP_NOTIFICATION_TITLE = 'Frank'
const BLIND_WAKEUP_NOTIFICATION_BODY =
  'New encrypted activity — open Frank to sync your inbox.'
const BLIND_WAKEUP_NOTIFICATION_TAG = 'frank-blind-wakeup-sync'
const DEFAULT_BACKGROUND_DEDUP_GRACE_MS = 650

function parseBlindPushPayload(rawText) {
  if (!rawText || !String(rawText).trim()) {
    return { type: 'sync' }
  }
  try {
    const parsed = JSON.parse(rawText)
    if (parsed && parsed.type === 'sync') {
      return { type: 'sync' }
    }
    return null
  } catch {
    return null
  }
}

async function handleBlindPushWakeup(
  sw,
  rawPayloadText,
  nowMs = Date.now(),
  options,
) {
  const payload = parseBlindPushPayload(rawPayloadText)
  if (!payload) {
    return { syncedClients: 0, showedNotification: false }
  }

  const clients =
    (sw &&
      sw.clients &&
      (await sw.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      }))) ||
    []

  let anyFocused = false
  for (const client of clients) {
    if (client.focused) {
      anyFocused = true
    }
    client.postMessage({
      type: BLIND_WAKEUP_MESSAGE_TYPE,
      payload: { type: 'sync' },
      timestampMs: nowMs,
    })
  }

  if (anyFocused) {
    return { syncedClients: clients.length, showedNotification: false }
  }

  if (clients.length > 0 && options) {
    const graceMs = Math.max(0, options.dedupGraceMs ?? 0)
    if (graceMs > 0) {
      await new Promise(resolve => setTimeout(resolve, graceMs))
    }
    if (options.wasHandledByClient && (await options.wasHandledByClient())) {
      return { syncedClients: clients.length, showedNotification: false }
    }
  }

  if (
    sw &&
    sw.registration &&
    typeof sw.registration.showNotification === 'function'
  ) {
    await sw.registration.showNotification(BLIND_WAKEUP_NOTIFICATION_TITLE, {
      body: BLIND_WAKEUP_NOTIFICATION_BODY,
      tag: BLIND_WAKEUP_NOTIFICATION_TAG,
      renotify: false,
      data: { type: 'sync', timestampMs: nowMs },
    })
    return { syncedClients: clients.length, showedNotification: true }
  }

  return { syncedClients: clients.length, showedNotification: false }
}

function registerBlindWakeupServiceWorkerListeners(
  sw = typeof self !== 'undefined' ? self : undefined,
) {
  if (!sw || typeof sw.addEventListener !== 'function') {
    return
  }

  let lastClientHandledAtMs = 0

  sw.addEventListener('message', event => {
    const data = event && event.data
    if (data && data.type === BLIND_WAKEUP_HANDLED_TYPE) {
      lastClientHandledAtMs = Date.now()
    }
  })

  sw.addEventListener('push', event => {
    let rawText = null
    try {
      rawText = event && event.data ? event.data.text() : null
    } catch {
      rawText = null
    }
    const pushStartedAtMs = Date.now()
    const task = handleBlindPushWakeup(sw, rawText, pushStartedAtMs, {
      dedupGraceMs: DEFAULT_BACKGROUND_DEDUP_GRACE_MS,
      wasHandledByClient: () => lastClientHandledAtMs >= pushStartedAtMs,
    })
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(task)
    }
  })

  sw.addEventListener('notificationclick', event => {
    if (
      event &&
      event.notification &&
      typeof event.notification.close === 'function'
    ) {
      event.notification.close()
    }
    const tag =
      event &&
      event.notification &&
      typeof event.notification.tag === 'string' &&
      event.notification.tag
        ? event.notification.tag
        : undefined
    const dataConversationId =
      event &&
      event.notification &&
      event.notification.data &&
      typeof event.notification.data.conversationId === 'string' &&
      event.notification.data.conversationId
        ? event.notification.data.conversationId
        : undefined
    const focusOrOpen = (async () => {
      const clients =
        (sw.clients &&
          (await sw.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
          }))) ||
        []
      for (const client of clients) {
        client.postMessage({
          type: BLIND_WAKEUP_MESSAGE_TYPE,
          payload: {
            type: 'sync',
            notificationClick: true,
            ...(tag ? { tag } : {}),
            ...(dataConversationId
              ? { conversationId: dataConversationId }
              : {}),
          },
          timestampMs: Date.now(),
        })
        if (typeof client.focus === 'function') {
          await client.focus()
          return
        }
      }
      if (sw.clients && typeof sw.clients.openWindow === 'function') {
        const targetUrl = dataConversationId
          ? `/#/chat/${encodeURIComponent(dataConversationId)}`
          : '/?notificationClick=1'
        await sw.clients.openWindow(targetUrl)
      }
    })()

    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(focusOrOpen)
    }
  })
}

registerBlindWakeupServiceWorkerListeners()

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BLIND_WAKEUP_MESSAGE_TYPE,
    BLIND_WAKEUP_HANDLED_TYPE,
    BLIND_WAKEUP_NOTIFICATION_TITLE,
    BLIND_WAKEUP_NOTIFICATION_BODY,
    BLIND_WAKEUP_NOTIFICATION_TAG,
    DEFAULT_BACKGROUND_DEDUP_GRACE_MS,
    parseBlindPushPayload,
    handleBlindPushWakeup,
    registerBlindWakeupServiceWorkerListeners,
  }
}
