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

export type ExtensionLaunchMode = 'popup' | 'sidepanel' | 'window'

export const FRANK_EXT_LAUNCH_MODE_KEY = 'frank_ext_launch_mode'

export async function openCompanionPanel(
  options: {
    windowId?: number
    tabId?: number
    persistSidePanelOnActionClick?: boolean
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
    if (options.persistSidePanelOnActionClick !== false) {
      if (typeof api.sidePanel.setPanelBehavior === 'function') {
        try {
          await Promise.resolve(
            api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
          ).catch(() => {})
        } catch {
          // Ignore sidePanel behavior errors
        }
      }
      if (typeof api.storage?.local?.set === 'function') {
        try {
          await Promise.resolve(
            api.storage.local.set({
              [FRANK_EXT_LAUNCH_MODE_KEY]: 'sidepanel',
              frankOpenPanelOnActionClick: true,
            }),
          ).catch(() => {})
        } catch {
          // Ignore storage errors
        }
      }
    }

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
  const { windowId: _windowId, ...res } = await createExtensionWindow(
    options,
    globalScope,
  )
  return res
}

async function createExtensionWindow(
  options: { path?: string; width?: number; height?: number },
  globalScope: Record<string, any>,
): Promise<{
  opened: boolean
  mode: 'window' | 'tab' | 'noop'
  url: string
  windowId?: number
}> {
  const path = options.path ?? 'index.html?extMode=window'
  const width = options.width ?? 440
  const height = options.height ?? 740
  const url = getExtensionResourceUrl(path, globalScope) ?? path
  const api = getRawExtensionApi(globalScope)

  if (typeof api?.storage?.local?.set === 'function') {
    try {
      await Promise.resolve(
        api.storage.local.set({
          [FRANK_EXT_LAUNCH_MODE_KEY]: 'window',
        }),
      ).catch(() => {})
    } catch {
      // Ignore storage errors
    }
  }

  if (api?.windows && typeof api.windows.create === 'function') {
    const created = await api.windows.create({
      url,
      type: 'popup',
      width,
      height,
    })
    return {
      opened: true,
      mode: 'window',
      url,
      ...(typeof created?.id === 'number' ? { windowId: created.id } : {}),
    }
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

/**
 * The one main pop-out window (extMode=window). Ordinary wallets keep a single pop-out:
 * opening it again focuses the existing window. Its ID lives in `storage.session` (it
 * survives a stopped service worker, and every extension page reads the same record),
 * falling back to `storage.local` where the browser has no session storage. A recorded ID
 * counts only while that window still exists and still shows the main Frank page.
 *
 * Only windows opened through focusOrOpenMainExtensionWindow are recorded, so a dApp
 * approval window or any other extension window is never mistaken for the main instance.
 */
export const FRANK_MAIN_WINDOW_ID_KEY = 'frankMainWindowId'
const MAIN_WINDOW_PATH = 'index.html?extMode=window'

function mainWindowStorage(
  api: Record<string, any>,
): Record<string, any> | null {
  const session = api.storage?.session
  if (session && typeof session.get === 'function') return session
  const local = api.storage?.local
  if (local && typeof local.get === 'function') return local
  return null
}

function isMainExtensionWindowUrl(url: unknown, mainUrl: string): boolean {
  if (typeof url !== 'string') return false
  const base = mainUrl.slice(0, mainUrl.indexOf('?'))
  if (!url.startsWith(base)) return false
  const query = url.slice(base.length).split('#')[0]
  return new URLSearchParams(query).get('extMode') === 'window'
}

/** The open main pop-out window's ID, or null when none is open. */
export async function findMainExtensionWindow(
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<number | null> {
  const api = getRawExtensionApi(globalScope)
  const store = api ? mainWindowStorage(api) : null
  if (!api || !store || typeof api.windows?.get !== 'function') return null
  let windowId: unknown
  try {
    const stored = await store.get(FRANK_MAIN_WINDOW_ID_KEY)
    windowId = stored?.[FRANK_MAIN_WINDOW_ID_KEY]
  } catch {
    return null
  }
  if (typeof windowId !== 'number') return null
  const mainUrl = getExtensionResourceUrl(MAIN_WINDOW_PATH, globalScope) ?? ''
  try {
    const win = await api.windows.get(windowId, { populate: true })
    const tabs: Array<{ url?: string; pendingUrl?: string }> = win?.tabs ?? []
    if (
      tabs.some(
        tab =>
          isMainExtensionWindowUrl(tab.url, mainUrl) ||
          isMainExtensionWindowUrl(tab.pendingUrl, mainUrl),
      )
    ) {
      return windowId
    }
  } catch {
    // windows.get rejects for a closed window.
  }
  try {
    await store.remove?.(FRANK_MAIN_WINDOW_ID_KEY)
  } catch {
    // A stale record is re-verified on every lookup.
  }
  return null
}

let mainWindowOpening: Promise<{
  opened: boolean
  focused: boolean
  mode: 'window' | 'tab' | 'noop'
  url: string
}> | null = null

/**
 * Focuses the main pop-out window when one is open; opens and records it otherwise.
 * Every "open in window" path (toolbar launch mode, pop-out buttons, settings) uses this.
 */
export async function focusOrOpenMainExtensionWindow(
  options: { width?: number; height?: number } = {},
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<{
  opened: boolean
  focused: boolean
  mode: 'window' | 'tab' | 'noop'
  url: string
}> {
  // A double click must not race two windows.create calls in this context.
  mainWindowOpening ??= (async () => {
    const url =
      getExtensionResourceUrl(MAIN_WINDOW_PATH, globalScope) ?? MAIN_WINDOW_PATH
    const existing = await findMainExtensionWindow(globalScope)
    const api = getRawExtensionApi(globalScope)
    if (existing !== null && typeof api?.windows?.update === 'function') {
      try {
        await api.windows.update(existing, { focused: true })
        return { opened: true, focused: true, mode: 'window' as const, url }
      } catch {
        // The window closed between lookup and focus: open a new one.
      }
    }
    const created = await createExtensionWindow(
      { ...options, path: MAIN_WINDOW_PATH },
      globalScope,
    )
    const store = api ? mainWindowStorage(api) : null
    if (
      created.windowId !== undefined &&
      store &&
      typeof store.set === 'function'
    ) {
      try {
        await store.set({ [FRANK_MAIN_WINDOW_ID_KEY]: created.windowId })
      } catch {
        // Without a record the next open cannot focus this window.
      }
    }
    const { windowId: _windowId, ...res } = created
    return { ...res, focused: false }
  })().finally(() => {
    mainWindowOpening = null
  })
  return await mainWindowOpening
}

/**
 * Raises the extension view this page runs in: its tab and its browser window. A page's own
 * window.focus() cannot raise a background window in Chromium; the extension windows API can.
 * Returns false outside an extension or when the browser refuses.
 */
export async function focusOwnExtensionView(
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<boolean> {
  const api = getRawExtensionApi(globalScope)
  if (!api || typeof api.windows?.update !== 'function') return false
  try {
    const tab =
      typeof api.tabs?.getCurrent === 'function'
        ? await api.tabs.getCurrent()
        : undefined
    if (tab && typeof tab.id === 'number') {
      if (typeof api.tabs?.update === 'function') {
        await api.tabs.update(tab.id, { active: true })
      }
      if (typeof tab.windowId === 'number') {
        await api.windows.update(tab.windowId, { focused: true })
        return true
      }
    }
    // A side panel or popup is not a tab; raise the browser window that hosts it.
    if (typeof api.windows?.getCurrent === 'function') {
      const win = await api.windows.getCurrent()
      if (win && typeof win.id === 'number') {
        await api.windows.update(win.id, { focused: true })
        return true
      }
    }
  } catch {
    // Focus is best effort; the caller keeps its manual fallback.
  }
  return false
}

/**
 * Whether another extension page (popup, side panel, pop-out window or extension tab) is
 * open besides the calling page. Null when the browser cannot tell.
 */
export async function hasOtherExtensionViews(
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<boolean | null> {
  const api = getRawExtensionApi(globalScope)
  if (!api) return null
  try {
    if (typeof api.runtime?.getContexts === 'function') {
      // Lists the calling page too.
      const contexts = await api.runtime.getContexts({
        contextTypes: ['TAB', 'POPUP', 'SIDE_PANEL'],
      })
      if (Array.isArray(contexts)) return contexts.length > 1
    }
    if (typeof api.extension?.getViews === 'function') {
      const views = api.extension.getViews()
      if (Array.isArray(views)) {
        const self = globalScope.window ?? globalScope
        return views.some(view => view !== self)
      }
    }
  } catch {
    // Unknown: the caller keeps its default.
  }
  return null
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


