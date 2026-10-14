import { Notify } from 'quasar'
import { register } from 'register-service-worker'

let updateNotice
let deferredWorker
let reloadAfterActivation = false
let lastUpdateCheck = 0
let activeRegistration = null
let updateCheck = null
let refreshing = false
let hadPriorController =
  typeof navigator !== 'undefined' &&
  Boolean(navigator.serviceWorker?.controller)

export function offerUpdate(registration) {
  const reg = registration || activeRegistration
  if (
    refreshing ||
    updateNotice ||
    (reg?.waiting && reg.waiting === deferredWorker) ||
    (!reg?.waiting && deferredWorker === true)
  ) {
    return
  }

  updateNotice = Notify.create({
    message: 'A new version of Frank is ready.',
    color: 'dark',
    timeout: 0,
    actions: [
      {
        label: 'Update now',
        color: 'white',
        handler: () => {
          if (reg?.waiting) {
            reloadAfterActivation = true
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
          } else {
            window.location.reload()
          }
        },
      },
      {
        label: 'Later',
        color: 'white',
        handler: () => {
          deferredWorker = reg?.waiting || true
        },
      },
    ],
    onDismiss: () => {
      updateNotice = undefined
    },
  })
}

export function isUpdateAvailable() {
  return Boolean(updateNotice || activeRegistration?.waiting)
}

export async function checkForAppUpdate({ resetDeferral = true } = {}) {
  if (
    refreshing ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return null
  }
  if (resetDeferral) deferredWorker = undefined
  if (updateCheck) return updateCheck
  updateCheck = (async () => {
    try {
      // A registration captured by a visibility listener can have been unregistered
      // in this or another tab. Resolve the current browser-owned registration.
      const registration = await navigator.serviceWorker.getRegistration()
      if (refreshing) return null
      activeRegistration = registration || null
      if (!registration) return null
      await registration.update()
      if (refreshing) return null
      if (registration.waiting) offerUpdate(registration)
      return registration
    } catch (error) {
      if (!refreshing) {
        console.warn('Could not check for an app update:', error)
      }
      return null
    } finally {
      updateCheck = null
    }
  })()
  return updateCheck
}

export async function forceCacheRefresh() {
  refreshing = true
  activeRegistration = null
  reloadAfterActivation = false
  updateNotice?.()
  updateNotice = undefined
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      for (const reg of registrations) {
        await reg.unregister()
      }
    }
    if (typeof window !== 'undefined' && 'caches' in window) {
      const cacheNames = await window.caches.keys()
      for (const name of cacheNames) {
        await window.caches.delete(name)
      }
    }
  } catch (error) {
    console.warn('Error clearing caches and service worker:', error)
  }
  if (typeof window !== 'undefined') {
    window.location.reload()
  }
}

function checkForUpdate() {
  if (
    refreshing ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  ) {
    return
  }
  const now = Date.now()
  if (now - lastUpdateCheck < 30_000) return
  lastUpdateCheck = now
  void checkForAppUpdate({ resetDeferral: false })
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadAfterActivation) {
      reloadAfterActivation = false
      window.location.reload()
      return
    }
    if (hadPriorController || navigator.serviceWorker.controller) {
      offerUpdate(activeRegistration)
    }
    hadPriorController = true
  })

  navigator.serviceWorker.addEventListener('message', event => {
    if (event?.data?.type === 'FRANK_BLIND_WAKEUP_SYNC') {
      if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function'
      ) {
        window.dispatchEvent(
          new CustomEvent('frank:blind-wakeup-sync', { detail: event.data }),
        )
      }
    }
  })
}

if (typeof window !== 'undefined') {
  window.checkForAppUpdate = checkForAppUpdate
  window.forceCacheRefresh = forceCacheRefresh
  window.offerUpdate = offerUpdate
  window.isUpdateAvailable = isUpdateAvailable
}

register(import.meta.env.QUASAR_SERVICE_WORKER_FILE, {
  ready(registration) {
    activeRegistration = registration
    checkForUpdate()
    import('src/utils/webpush-sync')
      .then(({ ensureBrowserPushSubscription, syncRelayNotificationPolicy }) =>
        ensureBrowserPushSubscription({
          serviceWorkerRegistration: registration,
        }).then(sub => {
          if (sub) {
            return syncRelayNotificationPolicy({ pushSubscription: sub })
          }
          return null
        }),
      )
      .catch(() => undefined)
  },

  registered(registration) {
    activeRegistration = registration
    if (registration.waiting) {
      offerUpdate(registration)
    }
    checkForUpdate()
    document.addEventListener('visibilitychange', checkForUpdate)
  },

  updated(registration) {
    activeRegistration = registration
    offerUpdate(registration)
  },

  offline() {
    console.log('No internet connection found. App is running in offline mode.')
  },

  error(error) {
    console.error('Error during service worker registration:', error)
  },
})
