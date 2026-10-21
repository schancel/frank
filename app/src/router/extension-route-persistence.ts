export const EXT_LAST_ROUTE_STORAGE_KEY = 'frank:ext-last-route'

export function isExtensionContext(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): boolean {
  if (!win || !win.location) return false
  const search =
    typeof win.location.search === 'string' ? win.location.search : ''
  if (search.includes('extMode=')) return true
  const protocol =
    typeof win.location.protocol === 'string' ? win.location.protocol : ''
  return (
    protocol === 'chrome-extension:' ||
    protocol === 'moz-extension:' ||
    protocol === 'safari-web-extension:'
  )
}

export function isPersistableExtensionRoute(path: string): boolean {
  if (!path || typeof path !== 'string' || !path.startsWith('/')) return false
  if (
    path === '/' ||
    path === '/welcome' ||
    path === '/account-sync' ||
    path.startsWith('/account-sync/') ||
    path === '/setup' ||
    path === '/onboard' ||
    path.startsWith('/onboard/') ||
    path.startsWith('/claim=')
  ) {
    return false
  }
  return true
}

export function resolveSavedExtensionRoute(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): string | null {
  if (!isExtensionContext(win)) return null
  try {
    const storage =
      (win as unknown as { localStorage?: Storage })?.localStorage ??
      (typeof localStorage !== 'undefined' ? localStorage : undefined)
    if (!storage || typeof storage.getItem !== 'function') return null
    const saved = storage.getItem(EXT_LAST_ROUTE_STORAGE_KEY)
    if (!saved) return null
    const pathOnly = saved.split('?')[0].split('#')[0]
    if (!isPersistableExtensionRoute(pathOnly)) return null
    return saved
  } catch {
    return null
  }
}
