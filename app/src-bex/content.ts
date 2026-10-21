import {
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  FRANK_SYNC_PAGE_MESSAGE_TYPES,
  FRANK_SYNC_NAVIGATION_TIMEOUT_MS,
  type SyncSenderNavigationResult,
  getExtensionResourceUrl,
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  isFrankWebAppOrigin,
  onRuntimeMessage,
  sendRuntimeMessage,
} from './runtime-adapter'

export { FRANK_DAPP_BRIDGE_CHANNEL, FRANK_PWA_EXTENSION_SYNC_CHANNEL }

/** Account sync runs only in the Frank web app's own origin (exact match). */
export function isAllowedSyncOrigin(locationObj: { origin?: string }): boolean {
  return isFrankWebAppOrigin(locationObj?.origin)
}

/** How long a relayed pairing message waits for the Frank page's reply. */
export const SYNC_PAGE_REPLY_TIMEOUT_MS = 5_000

export function ensureSafariFallbackInpageScript(
  win: Window & Record<string, any>,
  runtimeScope?: Record<string, any>,
): HTMLScriptElement | null {
  if (!win?.document || win.__FRANK_INPAGE_PROVIDER_INSTALLED__) {
    return null
  }
  const scriptUrl = getExtensionResourceUrl('inpage.js', runtimeScope)
  if (!scriptUrl || !scriptUrl.startsWith('safari-web-extension://')) {
    return null
  }
  const existing = win.document.querySelector?.(
    'script[data-frank-safari-inpage="true"]',
  )
  if (existing) {
    return existing as HTMLScriptElement
  }
  const script = win.document.createElement('script')
  script.src = scriptUrl
  script.async = false
  script.setAttribute('data-frank-safari-inpage', 'true')
  const mountScript = (): boolean => {
    const container = win.document.head || win.document.documentElement
    if (!container) return false
    if (!script.parentNode) {
      container.appendChild(script)
    }
    return true
  }
  if (!mountScript() && typeof win.document.addEventListener === 'function') {
    const onReady = () => {
      if (mountScript()) {
        win.document.removeEventListener?.('readystatechange', onReady)
        win.removeEventListener?.('DOMContentLoaded', onReady)
      }
    }
    win.document.addEventListener('readystatechange', onReady)
    win.addEventListener?.('DOMContentLoaded', onReady, { once: true })
  }
  return script
}

export function installContentScriptBridge(
  win: Window & Record<string, any> = typeof window !== 'undefined'
    ? (window as Window & Record<string, any>)
    : ({} as any),
  runtimeScope?: Record<string, any>,
): () => void {
  if (!win || typeof win.addEventListener !== 'function') {
    return () => {
      // No bridge was installed in this context.
    }
  }

  if (typeof win.__FRANK_CONTENT_BRIDGE_CLEANUP__ === 'function') {
    try {
      win.__FRANK_CONTENT_BRIDGE_CLEANUP__()
    } catch {
      // Ignore cleanup errors from prior injection
    }
  }

  ensureSafariFallbackInpageScript(win, runtimeScope)

  if (win.location && isAllowedSyncOrigin(win.location)) {
    win.__FRANK_EXTENSION_BRIDGE_READY__ = true
    if (
      typeof win.dispatchEvent === 'function' &&
      typeof Event === 'function'
    ) {
      try {
        win.dispatchEvent(new Event('frank:extension-bridge-ready'))
      } catch {
        // Ignore event dispatch errors
      }
    }
  }

  // Pairing messages relayed to the page, waiting for its 'pair-reply', by id.
  const pageReplies = new Map<string, (result: unknown) => void>()
  const navigationReplies = new Map<
    string,
    (result: SyncSenderNavigationResult) => void
  >()
  const navigationRequests = new Map<
    string,
    Promise<SyncSenderNavigationResult>
  >()
  let pageReplySeq = 0

  const handleWindowMessage = async (event: MessageEvent) => {
    if (event.source !== null && event.source !== win) return
    const data = event.data
    if (!data || typeof data !== 'object') return

    // If this content script belongs to a reloaded/invalidated extension context,
    // detach immediately so the newly injected content script handles the request.
    const activeApi = getRawExtensionApi(runtimeScope)
    if (!activeApi?.runtime?.id) {
      win.removeEventListener('message', handleWindowMessage)
      return
    }

    // 1. Standard dApp EIP-1193 bridge
    if (
      data.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      data.direction === 'to-content' &&
      data.type === 'rpc-request'
    ) {
      try {
        const response = await sendRuntimeMessage<Record<string, any>, any>(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            type: 'dapp-rpc-request',
            id: data.id,
            origin: win.location.origin,
            href: win.location.href,
            payload: data.payload,
          },
          runtimeScope,
        )

        win.postMessage(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            direction: 'to-inpage',
            type: 'rpc-response',
            id: data.id,
            result: response?.result,
            error: response?.error,
          },
          '*',
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          msg.includes('Extension context invalidated') ||
          !getRawExtensionApi(runtimeScope)?.runtime?.id
        ) {
          win.removeEventListener('message', handleWindowMessage)
          return
        }
        win.postMessage(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            direction: 'to-inpage',
            type: 'rpc-response',
            id: data.id,
            error: {
              code: -32603,
              message: msg,
            },
          },
          '*',
        )
      }
      return
    }

    if (
      data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      data.direction === 'to-extension' &&
      data.type === 'sync-navigation-reply'
    ) {
      if (
        event.source === win &&
        event.origin === win.location?.origin &&
        isAllowedSyncOrigin(win.location) &&
        typeof data.result?.ok === 'boolean'
      ) {
        // Navigation returns one boolean. Never relay account, PIN or export fields supplied
        // by a page response, and never accept a pairing reply as a navigation reply.
        navigationReplies.get(data.id)?.(
          data.result.ok ? { ok: true } : { ok: false, reason: 'not-ready' },
        )
      }
      return
    }

    // The Frank page answers a pairing message the extension relayed to it.
    if (
      data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      data.direction === 'to-extension' &&
      data.type === 'pair-reply'
    ) {
      const reply = pageReplies.get(data.id)
      if (
        reply &&
        event.source === win &&
        event.origin === win.location?.origin &&
        isAllowedSyncOrigin(win.location)
      ) {
        reply(data.result)
      }
      return
    }

    // 2. Frank web app <-> extension account sync (PIN pairing). Only the Frank
    // origin's own window may use it, only for the listed message types, and
    // replies go to that exact origin.
    if (
      data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      data.direction === 'to-extension'
    ) {
      const pageOrigin = win.location?.origin
      if (
        event.source !== win ||
        event.origin !== pageOrigin ||
        !isAllowedSyncOrigin(win.location) ||
        !FRANK_SYNC_PAGE_MESSAGE_TYPES.has(data.type)
      ) {
        return
      }

      try {
        const response = await sendRuntimeMessage<Record<string, any>, any>(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            type: data.type,
            id: data.id,
            payload: data.payload,
          },
          runtimeScope,
        )
        win.postMessage(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-pwa',
            type: 'sync-response',
            id: data.id,
            result: response?.result,
            error: response?.error,
          },
          pageOrigin,
        )
      } catch (err) {
        win.postMessage(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-pwa',
            type: 'sync-error',
            id: data.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          },
          pageOrigin,
        )
      }
      return
    }
  }

  win.addEventListener('message', handleWindowMessage)

  const syncProviderPrivacyFromBackground = async (triggerAnnounce = false) => {
    try {
      const origin = win.location?.origin ?? ''
      const res = await sendRuntimeMessage<Record<string, any>, any>(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'get-provider-privacy',
          origin,
        },
        runtimeScope,
      )
      const info = res?.result ?? res
      if (info && typeof info === 'object' && info.announceMode) {
        win.postMessage(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            direction: 'to-inpage',
            type: 'provider-privacy-config',
            announceMode: info.announceMode,
            isOriginApproved: Boolean(info.isOriginApproved),
            triggerAnnounce,
          },
          '*',
        )
      }
    } catch {
      // Ignore privacy query errors in non-extension contexts
    }
  }

  void syncProviderPrivacyFromBackground(false)

  const unsubscribeRuntime = onRuntimeMessage((message: any, sender: any) => {
    if (
      message?.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      message.type === 'open-sync-sender'
    ) {
      if (
        sender?.id !== getRawExtensionApi(runtimeScope)?.runtime?.id ||
        sender?.tab ||
        win.top !== win ||
        !isAllowedSyncOrigin(win.location) ||
        typeof message.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(message.id) ||
        Object.keys(message).some(
          key => !['channel', 'type', 'id'].includes(key),
        )
      ) {
        return { ok: false, reason: 'unavailable' }
      }
      const prior = navigationRequests.get(message.id)
      if (prior) return prior
      if (navigationReplies.size >= 8)
        return { ok: false, reason: 'unavailable' }
      const id = message.id
      const replied = new Promise<SyncSenderNavigationResult>(resolve => {
        const timer = setTimeout(
          () => settle({ ok: false, reason: 'timeout' }),
          FRANK_SYNC_NAVIGATION_TIMEOUT_MS,
        )
        const settle = (result: SyncSenderNavigationResult) => {
          clearTimeout(timer)
          navigationReplies.delete(id)
          resolve(result)
        }
        navigationReplies.set(id, settle)
      })
      if (navigationRequests.size >= 32)
        navigationRequests.delete(navigationRequests.keys().next().value!)
      navigationRequests.set(id, replied)
      win.postMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'open-sync-sender',
          id,
        },
        win.location.origin,
      )
      return replied
    }
    if (
      message &&
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'provider-event'
    ) {
      win.postMessage(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          direction: 'to-inpage',
          type: 'provider-event',
          event: message.event,
          payload: message.payload,
        },
        '*',
      )
      return { ok: true }
    }

    if (
      message &&
      message.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
      message.type === 'provider-privacy-config'
    ) {
      const pageOrigin = (win.location?.origin ?? '').toLowerCase()
      const approvedList = Array.isArray(message.connectedOrigins)
        ? message.connectedOrigins.map((o: unknown) => String(o).toLowerCase())
        : []
      const isOriginApproved =
        typeof message.isOriginApproved === 'boolean'
          ? message.isOriginApproved
          : Boolean(pageOrigin && approvedList.includes(pageOrigin))
      win.postMessage(
        {
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          direction: 'to-inpage',
          type: 'provider-privacy-config',
          announceMode: message.announceMode,
          isOriginApproved,
          triggerAnnounce: Boolean(message.triggerAnnounce),
        },
        '*',
      )
      return { ok: true }
    }

    if (
      message &&
      message.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      (message.type === 'pair-hello' || message.type === 'pair-confirm')
    ) {
      // An extension page pairs with the account this Frank page offers. The
      // page answers; no answer in time means it offers nothing.
      if (!win.location || !isAllowedSyncOrigin(win.location)) return undefined
      const id = `sync-pair-${++pageReplySeq}`
      const replied = new Promise<unknown>(resolve => {
        const timer = setTimeout(
          () => settle({ ok: false, reason: 'no-sender' }),
          SYNC_PAGE_REPLY_TIMEOUT_MS,
        )
        const settle = (value: unknown) => {
          clearTimeout(timer)
          pageReplies.delete(id)
          resolve(value)
        }
        pageReplies.set(id, settle)
      })
      win.postMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: message.type,
          id,
          payload: message.payload,
        },
        win.location.origin,
      )
      return replied
    }
    return undefined
  }, runtimeScope)

  const api = getRawExtensionApi(runtimeScope)
  const storageListener = (changes: Record<string, any>, areaName?: string) => {
    if (areaName && areaName !== 'local') return
    const nextAnnounceMode = changes?.frankAnnounceMode?.newValue
    if (
      nextAnnounceMode === 'always' ||
      nextAnnounceMode === 'connected-only' ||
      nextAnnounceMode === 'stealth'
    ) {
      void syncProviderPrivacyFromBackground(nextAnnounceMode === 'always')
    }
  }
  if (typeof api?.storage?.onChanged?.addListener === 'function') {
    api.storage.onChanged.addListener(storageListener)
  }

  const cleanup = () => {
    for (const reply of navigationReplies.values())
      reply({ ok: false, reason: 'unavailable' })
    navigationRequests.clear()
    win.removeEventListener('message', handleWindowMessage)
    unsubscribeRuntime()
    if (typeof api?.storage?.onChanged?.removeListener === 'function') {
      api.storage.onChanged.removeListener(storageListener)
    }
    if (win.__FRANK_CONTENT_BRIDGE_CLEANUP__ === cleanup) {
      delete win.__FRANK_CONTENT_BRIDGE_CLEANUP__
    }
  }
  win.__FRANK_CONTENT_BRIDGE_CLEANUP__ = cleanup
  return cleanup
}

if (typeof window !== 'undefined' && isBrowserExtensionRuntime()) {
  installContentScriptBridge(window as Window & Record<string, any>)
}
