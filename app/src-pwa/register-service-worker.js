import { Notify } from 'quasar'
import { register } from 'register-service-worker'

let updateNotice
let deferredWorker
let reloadAfterActivation = false
let lastUpdateCheck = 0
let activeRegistration = null
let updateCheck = null
let refreshing = false
let currentController =
  typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null
let controllerReplaced = false

function reloadForUpdate() {
  if (refreshing) return
  refreshing = true
  reloadAfterActivation = false
  window.location.reload()
}

export function offerUpdate(registration) {
  const reg = registration || activeRegistration
  if (
    refreshing ||
    reloadAfterActivation ||
    updateNotice ||
    (!reg?.waiting && !controllerReplaced) ||
    (reg?.waiting && !reg.active && !currentController) ||
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
          const worker = reg?.waiting
          if (worker) {
            reloadAfterActivation = true
            // Do not depend solely on controllerchange reaching this page. Activation of the
            // accepted worker also makes the new release available to the next navigation.
            const activated = () => {
              if (worker.state === 'activated') {
                worker.removeEventListener('statechange', activated)
                reloadForUpdate()
              }
            }
            worker.addEventListener('statechange', activated)
            worker.postMessage({ type: 'SKIP_WAITING' })
          } else {
            reloadForUpdate()
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

const watchedWorkers = typeof WeakSet === 'function' ? new WeakSet() : null
const watchedRegistrations =
  typeof WeakSet === 'function' ? new WeakSet() : null

function watchInstallingWorker(registration, worker) {
  if (!worker || typeof worker.addEventListener !== 'function') return
  if (watchedWorkers) {
    if (watchedWorkers.has(worker)) return
    watchedWorkers.add(worker)
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && registration?.waiting) {
      offerUpdate(registration)
    }
  })
}

function attachRegistrationListeners(registration) {
  if (!registration || typeof registration !== 'object') return
  if (registration.waiting) {
    offerUpdate(registration)
  }
  if (registration.installing) {
    watchInstallingWorker(registration, registration.installing)
  }
  if (typeof registration.addEventListener === 'function') {
    if (watchedRegistrations) {
      if (watchedRegistrations.has(registration)) return
      watchedRegistrations.add(registration)
    }
    registration.addEventListener('updatefound', () => {
      watchInstallingWorker(registration, registration.installing)
    })
  }
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
      attachRegistrationListeners(registration)
      await registration.update()
      if (refreshing) return null
      if (registration.installing) {
        watchInstallingWorker(registration, registration.installing)
      }
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
  if (now - lastUpdateCheck < 5_000) return
  lastUpdateCheck = now
  void checkForAppUpdate({ resetDeferral: false })
}

const isHttpOrHttpsOrigin =
  typeof window === 'undefined' ||
  !window.location?.protocol ||
  window.location.protocol === 'https:' ||
  window.location.protocol === 'http:'

if (
  isHttpOrHttpsOrigin &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator
) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return
    const controller = navigator.serviceWorker.controller
    if (!controller || controller === currentController) return
    const previousController = currentController
    currentController = controller
    if (reloadAfterActivation) {
      reloadForUpdate()
      return
    }
    // clientsClaim also fires on first installation. That is not evidence of a new release:
    // offering a reload there can show the same notice again after every uncontrolled visit.
    if (previousController) {
      controllerReplaced = true
      offerUpdate(activeRegistration)
    }
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

if (isHttpOrHttpsOrigin) {
  register(import.meta.env.QUASAR_SERVICE_WORKER_FILE, {
    ready(registration) {
      activeRegistration = registration
      attachRegistrationListeners(registration)
      checkForUpdate()
      import('src/utils/webpush-sync')
        .then(
          ({ ensureBrowserPushSubscription, syncRelayNotificationPolicy }) =>
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
      attachRegistrationListeners(registration)
      checkForUpdate()
      document.addEventListener('visibilitychange', checkForUpdate)
      if (
        typeof window !== 'undefined' &&
        typeof window.addEventListener === 'function'
      ) {
        window.addEventListener('focus', checkForUpdate)
      }
      if (typeof setInterval === 'function') {
        const timer = setInterval(checkForUpdate, 60_000)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    },

    updated(registration) {
      activeRegistration = registration
      offerUpdate(registration)
    },

    offline() {
      console.log(
        'No internet connection found. App is running in offline mode.',
      )
    },

    error(error) {
      console.error('Error during service worker registration:', error)
    },
  })
}
