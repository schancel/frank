/*
 * Frank PWA Blind WebPush Wakeup & Smart Notification Deduplication Worker (#384, #1574).
 *
 * Imported by the generated Workbox Service Worker (`sw.js`) via `importScripts('push-sw.js')`.
 *
 * Security & Privacy Invariants:
 * 1. Content-free wakeup: Only `{ "type": "sync" }` (or empty payload) is processed; no sender,
 *    subject, or payment metadata ever travels over OS push infrastructure.
 * 2. Smart foreground/background deduplication:
 *    - If any Frank client window is focused or visible, it is woken via `postMessage` to pull
 *      and decrypt new inbox messages over E2EE HTTP/WS, and the generic OS push notification
 *      is suppressed.
 *    - If client windows exist only in the background, `postMessage` wakes them and waits a short
 *      grace window (650ms) so the client can decrypt the message and either display a rich local
 *      notification (using the same tag `'frank-blind-wakeup-sync'`) or acknowledge via
 *      `FRANK_BLIND_WAKEUP_HANDLED`, preventing duplicate notifications.
 *    - If no client window is open (or backgrounded tabs are frozen by the mobile OS), displays
 *      the privacy-preserving notification: "New encrypted activity — open Frank to sync your inbox."
 */
;(function (sw) {
  if (!sw || typeof sw.addEventListener !== 'function') {
    return
  }

  var BLIND_WAKEUP_MESSAGE_TYPE = 'FRANK_BLIND_WAKEUP_SYNC'
  var BLIND_WAKEUP_HANDLED_TYPE = 'FRANK_BLIND_WAKEUP_HANDLED'
  var BLIND_WAKEUP_NOTIFICATION_TITLE = 'Frank'
  var BLIND_WAKEUP_NOTIFICATION_BODY =
    'New encrypted activity — open Frank to sync your inbox.'
  var BLIND_WAKEUP_NOTIFICATION_TAG = 'frank-blind-wakeup-sync'
  var BACKGROUND_DEDUP_GRACE_MS = 650

  var lastClientHandledAtMs = 0

  sw.addEventListener('message', function (event) {
    var data = event && event.data
    if (data && data.type === BLIND_WAKEUP_HANDLED_TYPE) {
      lastClientHandledAtMs = Date.now()
    }
  })

  function parseBlindPushPayload(rawText) {
    if (!rawText || !String(rawText).trim()) {
      return { type: 'sync' }
    }
    try {
      var parsed = JSON.parse(String(rawText))
      if (parsed && parsed.type === 'sync') {
        return { type: 'sync' }
      }
      return null
    } catch (_err) {
      return null
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }

  async function handlePushWakeup(rawPayloadText) {
    var payload = parseBlindPushPayload(rawPayloadText)
    if (!payload) {
      return
    }
    var nowMs = Date.now()
    var clients =
      sw.clients && typeof sw.clients.matchAll === 'function'
        ? await sw.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
          })
        : []

    var anyFocused = false
    for (var i = 0; i < clients.length; i++) {
      var client = clients[i]
      if (client.focused) {
        anyFocused = true
      }
      try {
        client.postMessage({
          type: BLIND_WAKEUP_MESSAGE_TYPE,
          payload: { type: 'sync' },
          timestampMs: nowMs,
        })
      } catch (_err) {
        // Ignore postMessage errors on closing tabs
      }
    }

    if (anyFocused) {
      return
    }

    if (clients.length > 0) {
      await delay(BACKGROUND_DEDUP_GRACE_MS)
      if (lastClientHandledAtMs >= nowMs) {
        return
      }
    }

    if (
      sw.registration &&
      typeof sw.registration.showNotification === 'function'
    ) {
      await sw.registration.showNotification(BLIND_WAKEUP_NOTIFICATION_TITLE, {
        body: BLIND_WAKEUP_NOTIFICATION_BODY,
        tag: BLIND_WAKEUP_NOTIFICATION_TAG,
        renotify: false,
        data: { type: 'sync', timestampMs: nowMs },
      })
    }
  }

  sw.addEventListener('push', function (event) {
    var rawText = null
    try {
      rawText = event && event.data ? event.data.text() : null
    } catch (_err) {
      rawText = null
    }
    var task = handlePushWakeup(rawText)
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(task)
    }
  })

  sw.addEventListener('notificationclick', function (event) {
    if (
      event &&
      event.notification &&
      typeof event.notification.close === 'function'
    ) {
      event.notification.close()
    }
    var tag =
      event &&
      event.notification &&
      typeof event.notification.tag === 'string' &&
      event.notification.tag
        ? event.notification.tag
        : undefined
    var dataConversationId =
      event &&
      event.notification &&
      event.notification.data &&
      typeof event.notification.data.conversationId === 'string' &&
      event.notification.data.conversationId
        ? event.notification.data.conversationId
        : undefined
    var focusOrOpen = (async function () {
      var clients =
        sw.clients && typeof sw.clients.matchAll === 'function'
          ? await sw.clients.matchAll({
              type: 'window',
              includeUncontrolled: true,
            })
          : []
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i]
        try {
          client.postMessage({
            type: BLIND_WAKEUP_MESSAGE_TYPE,
            payload: {
              type: 'sync',
              notificationClick: true,
              ...(tag ? { tag: tag } : {}),
              ...(dataConversationId
                ? { conversationId: dataConversationId }
                : {}),
            },
            timestampMs: Date.now(),
          })
        } catch (_err) {
          // Ignore
        }
        if (typeof client.focus === 'function') {
          await client.focus()
          return
        }
      }
      if (sw.clients && typeof sw.clients.openWindow === 'function') {
        var targetUrl = dataConversationId
          ? '/#/chat/' + encodeURIComponent(dataConversationId)
          : '/?notificationClick=1'
        await sw.clients.openWindow(targetUrl)
      }
    })()

    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(focusOrOpen)
    }
  })
})(typeof self !== 'undefined' ? self : globalThis)
