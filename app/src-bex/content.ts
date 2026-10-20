import {
  getExtensionResourceUrl,
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  onRuntimeMessage,
  sendRuntimeMessage,
} from './runtime-adapter'
import { FRANK_DAPP_BRIDGE_CHANNEL } from './inpage'

export const FRANK_PWA_EXTENSION_SYNC_CHANNEL = 'frank-pwa-extension-sync-v1'

const ALLOWED_SYNC_HOSTS = new Set(['signet.mx', 'localhost', '127.0.0.1'])

export function isAllowedSyncOrigin(locationObj: {
  protocol?: string
  hostname?: string
}): boolean {
  const hostname = locationObj?.hostname ?? ''
  const protocol = locationObj?.protocol ?? ''
  if (hostname === 'signet.mx' && protocol === 'https:') {
    return true
  }
  if (
    (hostname === 'localhost' || hostname === '127.0.0.1') &&
    (protocol === 'http:' || protocol === 'https:')
  ) {
    return true
  }
  return false
}

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
  const existing = win.document.querySelector(
    'script[data-frank-safari-inpage="true"]',
  )
  if (existing) {
    return existing as HTMLScriptElement
  }
  const script = win.document.createElement('script')
  script.src = scriptUrl
  script.async = false
  script.setAttribute('data-frank-safari-inpage', 'true')
  const container = win.document.head || win.document.documentElement
  if (container) {
    container.appendChild(script)
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

  const handleWindowMessage = async (event: MessageEvent) => {
    if (event.source !== null && event.source !== win) return
    const data = event.data
    if (!data || typeof data !== 'object') return

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
        win.postMessage(
          {
            channel: FRANK_DAPP_BRIDGE_CHANNEL,
            direction: 'to-inpage',
            type: 'rpc-response',
            id: data.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          },
          '*',
        )
      }
      return
    }

    // 2. Standalone PWA <-> Browser Extension 1-click DeviceSyncBundle bridge (#1710)
    if (
      data.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      data.direction === 'to-extension'
    ) {
      if (!isAllowedSyncOrigin(win.location)) {
        win.postMessage(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            direction: 'to-pwa',
            type: 'sync-error',
            id: data.id,
            error: {
              code: 4100,
              message: `Origin ${win.location.origin} is not authorized for Frank PWA-Extension sync`,
            },
          },
          '*',
        )
        return
      }

      try {
        const response = await sendRuntimeMessage<Record<string, any>, any>(
          {
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            type: data.type || 'pwa-sync-handshake',
            id: data.id,
            origin: win.location.origin,
            href: win.location.href,
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
            result: response?.result ?? response,
            error: response?.error,
          },
          '*',
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
          '*',
        )
      }
    }
  }

  win.addEventListener('message', handleWindowMessage)

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
      message.channel === FRANK_PWA_EXTENSION_SYNC_CHANNEL &&
      message.type === 'extension-sync-push' &&
      win.location &&
      isAllowedSyncOrigin(win.location)
    ) {
      win.postMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'extension-sync-push',
          payload: message.payload,
        },
        '*',
      )
      return { ok: true }
    }
    return undefined
  }, runtimeScope)

  const api = getRawExtensionApi(runtimeScope)
  const storageListener = (changes: Record<string, any>, areaName?: string) => {
    if (areaName && areaName !== 'local') return
    const nextSynced = changes?.frankSyncedState?.newValue
    if (
      nextSynced &&
      nextSynced.syncedFromOrigin === 'frank-extension' &&
      win.location &&
      isAllowedSyncOrigin(win.location)
    ) {
      win.postMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          direction: 'to-pwa',
          type: 'extension-sync-push',
          payload: nextSynced,
        },
        '*',
      )
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

