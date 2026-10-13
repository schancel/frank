declare global {
  interface Window {
    checkForAppUpdate?: () => Promise<ServiceWorkerRegistration | null>
    forceCacheRefresh?: () => Promise<void>
    offerUpdate?: (registration?: ServiceWorkerRegistration | null) => void
    isUpdateAvailable?: () => boolean
  }
}

let lastNavigationCheck = 0

/**
 * Trigger an update check on the active ServiceWorkerRegistration.
 * If running in PWA mode, delegates to the PWA registration.
 * In a standard browser with serviceWorker support, triggers registration.update().
 */
export async function checkForAppUpdate(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined') return null

  if (typeof window.checkForAppUpdate === 'function') {
    return window.checkForAppUpdate()
  }

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg) {
        await reg.update()
        return reg
      }
    } catch (err) {
      console.warn('Could not check for an app update:', err)
    }
  }
  return null
}

/**
 * Checks if an update notice is currently active or an update is waiting.
 */
export function isUpdateAvailable(): boolean {
  if (
    typeof window !== 'undefined' &&
    typeof window.isUpdateAvailable === 'function'
  ) {
    return window.isUpdateAvailable()
  }
  return false
}

/**
 * Debounced check called during client-side navigation (e.g. router.afterEach).
 * Ensures Safari SPA navigation triggers background byte-checks at most once every interval.
 */
export function checkDebouncedAppUpdate(minIntervalMs = 30_000): void {
  const now = Date.now()
  if (now - lastNavigationCheck < minIntervalMs) return
  lastNavigationCheck = now
  void checkForAppUpdate()
}

/**
 * Unregisters all service workers, clears CacheStorage, and reloads the window.
 */
export async function forceCacheRefresh(): Promise<void> {
  if (typeof window === 'undefined') return

  if (typeof window.forceCacheRefresh === 'function') {
    await window.forceCacheRefresh()
    return
  }

  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      for (const reg of registrations) {
        await reg.unregister()
      }
    }
    if (typeof window !== 'undefined' && 'caches' in window) {
      const cacheKeys = await window.caches.keys()
      for (const key of cacheKeys) {
        await window.caches.delete(key)
      }
    }
  } catch (err) {
    console.warn('Error clearing service worker and caches:', err)
  }
  try {
    window.location.reload()
  } catch (err) {
    console.warn('Error reloading window:', err)
  }
}
