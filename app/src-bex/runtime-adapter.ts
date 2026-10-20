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

export async function openCompanionPanel(
  options: { windowId?: number; tabId?: number } = {},
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
    await api.sidePanel.open({
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
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

export async function openExtensionWindow(
  options: { path?: string; width?: number; height?: number } = {},
  globalScope: Record<string, any> = typeof globalThis !== 'undefined'
    ? (globalThis as Record<string, any>)
    : {},
): Promise<{
  opened: boolean
  mode: 'window' | 'noop'
  url: string
}> {
  const path = options.path ?? 'index.html?extMode=window'
  const width = options.width ?? 420
  const height = options.height ?? 720
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

