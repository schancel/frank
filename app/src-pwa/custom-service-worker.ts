/*
 * This file (which will be your service worker)
 * is picked up by the build system ONLY if
 * quasar.conf > pwa > workboxPluginMode is set to "InjectManifest"
 */

export const BLIND_WAKEUP_MESSAGE_TYPE = 'FRANK_BLIND_WAKEUP_SYNC'
export const BLIND_WAKEUP_HANDLED_TYPE = 'FRANK_BLIND_WAKEUP_HANDLED'
export const BLIND_WAKEUP_NOTIFICATION_TITLE = 'Frank'
export const BLIND_WAKEUP_NOTIFICATION_BODY =
  'New encrypted activity — open Frank to sync your inbox.'
export const BLIND_WAKEUP_NOTIFICATION_TAG = 'frank-blind-wakeup-sync'
export const DEFAULT_BACKGROUND_DEDUP_GRACE_MS = 650

export interface BlindPushPayload {
  type: 'sync'
}

export interface SwClientLike {
  focused?: boolean
  visibilityState?: string
  postMessage: (message: unknown) => void
  focus?: () => Promise<unknown>
}

export interface SwScopeLike {
  clients?: {
    matchAll: (options?: {
      type?: 'window' | 'worker' | 'sharedworker' | 'all'
      includeUncontrolled?: boolean
    }) => Promise<ReadonlyArray<SwClientLike>>
    openWindow?: (url: string) => Promise<unknown>
  }
  registration?: {
    showNotification: (
      title: string,
      options?: {
        body?: string
        tag?: string
        renotify?: boolean
        data?: Record<string, unknown>
      },
    ) => Promise<void>
  }
  addEventListener?: (type: string, listener: (event: any) => void) => void
}

export interface BlindWakeupHandleOptions {
  /** Optional grace period (in ms) to wait when backgrounded clients exist so they can display a rich decrypted notification first. */
  dedupGraceMs?: number
  /** Predicate returning true if a woken client already handled and displayed a decrypted notification. */
  wasHandledByClient?: () => boolean | Promise<boolean>
}

/**
 * Parse a raw push payload while strictly enforcing the #384 content-free invariant:
 * only `{ "type": "sync" }` (or empty payload, which defaults to `{ "type": "sync" }`)
 * is recognized, and no sender/subject/amount fields are ever propagated.
 */
export function parseBlindPushPayload(
  rawText?: string | null,
): BlindPushPayload | null {
  if (!rawText || !rawText.trim()) {
    return { type: 'sync' }
  }
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>
    if (parsed && parsed.type === 'sync') {
      return { type: 'sync' }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Handle an incoming content-free blind WebPush wakeup (`{ "type": "sync" }`).
 *
 * - Wakes all open client windows with `postMessage({ type: 'FRANK_BLIND_WAKEUP_SYNC' })`
 *   so active sessions immediately pull and decrypt new inbox items from the relay.
 * - If any client is focused/visible, or if a backgrounded client handles the wakeup within
 *   `dedupGraceMs` and acknowledges with `FRANK_BLIND_WAKEUP_HANDLED`, suppresses the
 *   generic fallback notification.
 * - Otherwise displays a generic privacy-preserving notification without leaking metadata.
 */
export async function handleBlindPushWakeup(
  sw: SwScopeLike,
  rawPayloadText?: string | null,
  nowMs: number = Date.now(),
  options?: BlindWakeupHandleOptions,
): Promise<{ syncedClients: number; showedNotification: boolean }> {
  const payload = parseBlindPushPayload(rawPayloadText)
  if (!payload) {
    return { syncedClients: 0, showedNotification: false }
  }

  const clients =
    (await sw.clients?.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })) ?? []

  let anyVisibleOrFocused = false
  for (const client of clients) {
    if (client.focused || client.visibilityState === 'visible') {
      anyVisibleOrFocused = true
    }
    client.postMessage({
      type: BLIND_WAKEUP_MESSAGE_TYPE,
      payload: { type: 'sync' },
      timestampMs: nowMs,
    })
  }

  if (anyVisibleOrFocused) {
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

  if (sw.registration?.showNotification) {
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

/**
 * Install `push`, `message`, and `notificationclick` listeners on a ServiceWorkerGlobalScope.
 */
export function registerBlindWakeupServiceWorkerListeners(
  sw: SwScopeLike = globalThis as unknown as SwScopeLike,
): void {
  if (typeof sw?.addEventListener !== 'function') {
    return
  }

  let lastClientHandledAtMs = 0

  sw.addEventListener('message', (event: any) => {
    const data = event?.data
    if (data && data.type === BLIND_WAKEUP_HANDLED_TYPE) {
      lastClientHandledAtMs = Date.now()
    }
  })

  sw.addEventListener('push', (event: any) => {
    let rawText: string | null = null
    try {
      rawText = event?.data ? event.data.text() : null
    } catch {
      rawText = null
    }
    const pushStartedAtMs = Date.now()
    const task = handleBlindPushWakeup(sw, rawText, pushStartedAtMs, {
      dedupGraceMs: DEFAULT_BACKGROUND_DEDUP_GRACE_MS,
      wasHandledByClient: () => lastClientHandledAtMs >= pushStartedAtMs,
    })
    if (typeof event?.waitUntil === 'function') {
      event.waitUntil(task)
    }
  })

  sw.addEventListener('notificationclick', (event: any) => {
    if (event?.notification && typeof event.notification.close === 'function') {
      event.notification.close()
    }
    const focusOrOpen = (async () => {
      const clients =
        (await sw.clients?.matchAll({
          type: 'window',
          includeUncontrolled: true,
        })) ?? []
      for (const client of clients) {
        client.postMessage({
          type: BLIND_WAKEUP_MESSAGE_TYPE,
          payload: { type: 'sync' },
          timestampMs: Date.now(),
        })
        if (typeof client.focus === 'function') {
          await client.focus()
          return
        }
      }
      if (typeof sw.clients?.openWindow === 'function') {
        await sw.clients.openWindow('/')
      }
    })()

    if (typeof event?.waitUntil === 'function') {
      event.waitUntil(focusOrOpen)
    }
  })
}

registerBlindWakeupServiceWorkerListeners()

