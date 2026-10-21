import {
  FRANK_DAPP_BRIDGE_CHANNEL,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  FRANK_SYNC_PAGE_MESSAGE_TYPES,
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

/** How long a pushed sync bundle waits for the page to say whether it offered it. */
export const SYNC_OFFER_REPLY_TIMEOUT_MS = 3_000

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
    return () => {}
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
    if (typeof win.dispatchEvent === 'function' && typeof Event === 'function') {
      try {
        win.dispatchEvent(new Event('frank:extension-bridge-ready'))
      } catch {
        // Ignore event dispatch errors
      }
    }
  }

  // Pushed sync bundles waiting for the page's 'sync-offer-result', by id.
  const offerReplies = new Map<string, (offered: boolean) => void>()
  let offerReplySeq = 0

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

    // 1. Standard dApp EIP-1193 / Solana bridge
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

    // The Frank page says whether it offered a pushed bundle to its user.
    if (
      data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      data.direction === 'to-extension' &&
      data.type === 'sync-offer-result'
    ) {
      const reply = offerReplies.get(data.id)
      if (
        reply &&
        event.source === win &&
        event.origin === win.location?.origin &&
        isAllowedSyncOrigin(win.location)
      ) {
        reply(data.offered === true)
      }
      return
    }

    // 2. Frank web app <-> extension account sync. The bundle carries backup
    // shares: only the Frank origin's own window may use it, only for the listed
    // message types, and replies go to that exact origin.
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

    // 3. eCash Cashtab window.postMessage compatibility bridge
    if (data.type === 'FROM_PAGE' && data.text === 'Cashtab') {
      try {
        const response = await sendRuntimeMessage<Record<string, any>, any>(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            type: 'dapp-rpc-request',
            id: data.id || `cashtab-${Date.now()}`,
            origin: win.location?.origin ?? '',
            href: win.location?.href ?? '',
            payload: {
              method: 'xec_cashtabRequest',
              params: [
                {
                  addressRequest: Boolean(data.addressRequest),
                  txInfo: data.txInfo,
                },
              ],
            },
          },
          runtimeScope,
        )
        const resPayload = response?.result
        if (response?.error) {
          win.postMessage(
            {
              type: 'FROM_CASHTAB',
              address: data.addressRequest
                ? 'Address request denied by user'
                : undefined,
              error: response.error.message || 'User Rejected Request',
            },
            '*',
          )
        } else if (resPayload && typeof resPayload === 'object') {
          win.postMessage(
            {
              type: 'FROM_CASHTAB',
              ...(resPayload.address ? { address: resPayload.address } : {}),
              ...(resPayload.txid ? { txid: resPayload.txid } : {}),
            },
            '*',
          )
        } else if (typeof resPayload === 'string') {
          win.postMessage(
            {
              type: 'FROM_CASHTAB',
              ...(data.addressRequest
                ? { address: resPayload }
                : { txid: resPayload }),
            },
            '*',
          )
        }
      } catch (err) {
        win.postMessage(
          {
            type: 'FROM_CASHTAB',
            error: err instanceof Error ? err.message : String(err),
          },
          '*',
        )
      }
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

  const unsubscribeRuntime = onRuntimeMessage((message: any) => {
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
      message.type === 'extension-sync-push'
    ) {
      // Only the Frank web app gets the bundle. The ack says whether the page
      // offered it to its user (a page that has an account declines it).
      if (!win.location || !isAllowedSyncOrigin(win.location)) return undefined
      const id = `sync-push-${++offerReplySeq}`
      const offered = new Promise<boolean>(resolve => {
        const timer = setTimeout(
          () => settle(false),
          SYNC_OFFER_REPLY_TIMEOUT_MS,
        )
        const settle = (value: boolean) => {
          clearTimeout(timer)
          offerReplies.delete(id)
          resolve(value)
        }
        offerReplies.set(id, settle)
      })
      win.postMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'extension-sync-push',
          id,
          payload: message.payload,
        },
        win.location.origin,
      )
      return offered.then(value => ({ ok: true, offered: value }))
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

