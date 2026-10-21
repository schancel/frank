export const FRANK_DAPP_BRIDGE_CHANNEL = 'frank-dapp-bridge-v1'
export const FRANK_PWA_EXTENSION_SYNC_CHANNEL = 'frank-pwa-extension-sync-v1'
/**
 * The one web origin that may take part in extension <-> web app account sync.
 * The extension relays pairing messages only to and from pages whose origin
 * equals this exactly. The extension build has no dev mode, so localhost pages
 * are never a sync peer.
 */
export const FRANK_WEB_APP_ORIGIN = 'https://signet.mx'
/**
 * Sync message types a Frank web page may send through the content script:
 * offer its account to the extension (no secret is sent) or withdraw that
 * offer, or run the PIN pairing with the extension's sending session.
 * Everything else on the sync channel is dropped.
 */
export const FRANK_SYNC_PAGE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'pwa-sync-offer',
  'pwa-sync-cancel',
  'pair-hello',
  'pair-confirm',
])

export function isFrankWebAppOrigin(origin: unknown): boolean {
  return origin === FRANK_WEB_APP_ORIGIN
}
/**
 * Sent by the background to open extension pages (popup, side panel, window)
 * on FRANK_DAPP_BRIDGE_CHANNEL whenever the pending dApp approval queue
 * changes. It carries no approval data; views re-read `get-bridge-state`.
 */
export const FRANK_DAPP_APPROVALS_CHANGED = 'approvals-changed'
/**
 * Sent by a Frank view to the background on FRANK_DAPP_BRIDGE_CHANNEL with
 * `sitePersonas: { [origin]: address }`: custody-derived per-site persona
 * addresses (never keys) for origins waiting on a decision.
 */
export const FRANK_DAPP_PROVISION_SITE_PERSONAS = 'provision-site-personas'

export type RuntimeEnvironmentKind =
  | 'pwa'
  | 'chrome-extension'
  | 'firefox-extension'
  | 'safari-extension'

export interface ExtensionRuntimeInfo {
  isExtension: boolean
  kind: RuntimeEnvironmentKind
  id?: string
  hasSidePanel: boolean
  hasSidebarAction: boolean
}

export function getRawExtensionApi(
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Record<string, any> | null {
  const browserApi = globalScope.browser
  if (browserApi && browserApi.runtime && browserApi.runtime.id) {
    return browserApi
  }
  const chromeApi = globalScope.chrome
  if (chromeApi && chromeApi.runtime && chromeApi.runtime.id) {
    return chromeApi
  }
  return null
}

export function getExtensionRuntime(
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): ExtensionRuntimeInfo {
  const api = getRawExtensionApi(globalScope)
  if (!api) {
    return {
      isExtension: false,
      kind: 'pwa',
      hasSidePanel: false,
      hasSidebarAction: false,
    }
  }

  const hasSidePanel = Boolean(api.sidePanel && typeof api.sidePanel.open === 'function')
  const hasSidebarAction = Boolean(
    api.sidebarAction && typeof api.sidebarAction.open === 'function',
  )
  const runtimeUrl =
    typeof api.runtime?.getURL === 'function' ? String(api.runtime.getURL('')) : ''
  const userAgent =
    typeof globalScope.navigator?.userAgent === 'string'
      ? globalScope.navigator.userAgent
      : ''

  let kind: RuntimeEnvironmentKind = 'chrome-extension'
  if (
    runtimeUrl.startsWith('safari-web-extension://') ||
    (/Safari/i.test(userAgent) && !/Chrome|Chromium|Firefox/i.test(userAgent))
  ) {
    kind = 'safari-extension'
  } else if (
    hasSidebarAction ||
    runtimeUrl.startsWith('moz-extension://') ||
    /Firefox/i.test(userAgent)
  ) {
    kind = 'firefox-extension'
  }

  return {
    isExtension: true,
    kind,
    id: String(api.runtime.id),
    hasSidePanel,
    hasSidebarAction,
  }
}

export function isBrowserExtensionRuntime(
  globalScope?: Record<string, any>,
): boolean {
  return getExtensionRuntime(globalScope).isExtension
}

/** What a click on the toolbar icon opens. */
export type ExtensionLaunchMode = 'popup' | 'sidepanel' | 'window'

/**
 * The user's toolbar click choice, in `storage.local`. Only the background's
 * `set-launch-mode` handler writes it (from the user's choice); opening a
 * view never changes it. The background re-applies it at every start.
 */
export const FRANK_EXT_LAUNCH_MODE_KEY = 'frank_ext_launch_mode'

export function parseExtensionLaunchMode(
  raw: unknown,
): ExtensionLaunchMode | null {
  return raw === 'popup' || raw === 'sidepanel' || raw === 'window' ? raw : null
}

export async function openCompanionPanel(
  options: {
    windowId?: number
    tabId?: number
  } = {},
  globalScope?: Record<string, any>,
): Promise<{
  opened: boolean
  mode: 'sidePanel' | 'sidebarAction' | 'popup' | 'noop'
}> {
  const api = getRawExtensionApi(globalScope)
  if (!api) {
    return { opened: false, mode: 'noop' }
  }

  if (api.sidePanel && typeof api.sidePanel.open === 'function') {
    let resolvedWindowId = options.windowId
    if (
      resolvedWindowId === undefined &&
      options.tabId === undefined &&
      typeof api.windows?.getCurrent === 'function'
    ) {
      try {
        const currentWin = await api.windows.getCurrent()
        if (currentWin && typeof currentWin.id === 'number') {
          resolvedWindowId = currentWin.id
        }
      } catch {
        // Ignore window lookup errors
      }
    }

    await api.sidePanel.open({
      ...(resolvedWindowId !== undefined ? { windowId: resolvedWindowId } : {}),
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
    })
    return { opened: true, mode: 'sidePanel' }
  }

  if (api.sidebarAction && typeof api.sidebarAction.open === 'function') {
    await api.sidebarAction.open()
    return { opened: true, mode: 'sidebarAction' }
  }

  if (api.action && typeof api.action.openPopup === 'function') {
    await api.action.openPopup()
    return { opened: true, mode: 'popup' }
  }

  return { opened: false, mode: 'noop' }
}

export async function sendRuntimeMessage<TReq = unknown, TRes = any>(
  message: TReq,
  globalScope?: Record<string, any>,
): Promise<TRes | null> {
  const api = getRawExtensionApi(globalScope)
  if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') {
    return null
  }

  // Prefer promise-based browser.runtime.sendMessage or modern chrome.runtime.sendMessage
  if (api.runtime.sendMessage.length <= 1) {
    const maybePromise = api.runtime.sendMessage(message)
    if (maybePromise && typeof maybePromise.then === 'function') {
      return await maybePromise
    }
  }

  return await new Promise<TRes | null>((resolve, reject) => {
    try {
      const maybePromise = api.runtime.sendMessage(
        message,
        (response: TRes) => {
          const lastError = api.runtime?.lastError
          if (lastError) {
            reject(new Error(lastError.message || String(lastError)))
            return
          }
          resolve(response ?? null)
        },
      )
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject)
      }
    } catch (err) {
      reject(err)
    }
  })
}

export function onRuntimeMessage<TReq = any, TRes = any>(
  handler: (message: TReq, sender: any) => Promise<TRes> | TRes,
  globalScope?: Record<string, any>,
): () => void {
  const api = getRawExtensionApi(globalScope)
  if (
    !api ||
    !api.runtime?.onMessage ||
    typeof api.runtime.onMessage.addListener !== 'function'
  ) {
    return () => {
      // Safe no-op in standalone PWA
    }
  }

  const listener = (
    message: TReq,
    sender: any,
    sendResponse: (res: any) => void,
  ) => {
    try {
      const result = handler(message, sender)
      if (result && typeof (result as Promise<TRes>).then === 'function') {
        ;(result as Promise<TRes>)
          .then(res => sendResponse(res))
          .catch(err =>
            sendResponse({
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          )
        return true
      }
      if (result !== undefined) {
        sendResponse(result)
      }
      return false
    } catch (err) {
      sendResponse({
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      })
      return false
    }
  }

  api.runtime.onMessage.addListener(listener)
  return () => {
    if (typeof api.runtime?.onMessage?.removeListener === 'function') {
      api.runtime.onMessage.removeListener(listener)
    }
  }
}

export function getExtensionResourceUrl(
  resourcePath: string,
  globalScope?: Record<string, any>,
): string | null {
  const api = getRawExtensionApi(globalScope)
  if (!api || typeof api.runtime?.getURL !== 'function') {
    return null
  }
  return String(api.runtime.getURL(resourcePath))
}

export async function openExtensionInWindow(
  options: { path?: string; width?: number; height?: number } = {},
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<{
  opened: boolean
  mode: 'window' | 'tab' | 'noop'
  url: string
}> {
  const path = options.path ?? 'index.html?extMode=window'
  const width = options.width ?? 440
  const height = options.height ?? 740
  const url = getExtensionResourceUrl(path, globalScope) ?? path
  const api = getRawExtensionApi(globalScope)

  if (api?.windows && typeof api.windows.create === 'function') {
    await api.windows.create({
      url,
      type: 'popup',
      width,
      height,
    })
    return { opened: true, mode: 'window', url }
  }

  if (api?.tabs && typeof api.tabs.create === 'function') {
    const tabPath = options.path ?? 'index.html?extMode=tab'
    const tabUrl = getExtensionResourceUrl(tabPath, globalScope) ?? tabPath
    await api.tabs.create({ url: tabUrl })
    return { opened: true, mode: 'tab', url: tabUrl }
  }

  const winOpen =
    typeof globalScope.open === 'function'
      ? globalScope.open.bind(globalScope)
      : typeof globalScope.window?.open === 'function'
        ? globalScope.window.open.bind(globalScope.window)
        : typeof window !== 'undefined' && typeof window.open === 'function'
          ? window.open.bind(window)
          : null

  if (winOpen) {
    winOpen(url, '_blank', `popup=yes,width=${width},height=${height}`)
    return { opened: true, mode: 'window', url }
  }

  return { opened: false, mode: 'noop', url }
}

export async function openExtensionWindow(
  options: { path?: string; width?: number; height?: number } = {},
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<{
  opened: boolean
  mode: 'window' | 'tab' | 'noop'
  url: string
}> {
  return openExtensionInWindow(options, globalScope)
}

export async function openExtensionTab(
  options: { path?: string } = {},
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<{
  opened: boolean
  mode: 'tab' | 'noop'
  url: string
}> {
  const path = options.path ?? 'index.html?extMode=tab'
  const url = getExtensionResourceUrl(path, globalScope) ?? path
  const api = getRawExtensionApi(globalScope)

  if (api?.tabs && typeof api.tabs.create === 'function') {
    await api.tabs.create({ url })
    return { opened: true, mode: 'tab', url }
  }

  const winOpen =
    typeof globalScope.open === 'function'
      ? globalScope.open.bind(globalScope)
      : typeof globalScope.window?.open === 'function'
        ? globalScope.window.open.bind(globalScope.window)
        : typeof window !== 'undefined' && typeof window.open === 'function'
          ? window.open.bind(window)
          : null

  if (winOpen) {
    winOpen(url, '_blank')
    return { opened: true, mode: 'tab', url }
  }

  return { opened: false, mode: 'noop', url }
}


