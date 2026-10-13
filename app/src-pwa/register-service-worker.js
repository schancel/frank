import { Notify } from 'quasar'
import { register } from 'register-service-worker'

let updateNotice
let deferredWorker
let reloadAfterActivation = false
let lastUpdateCheck = 0
let activeRegistration = null
let hadPriorController =
  typeof navigator !== 'undefined' &&
  Boolean(navigator.serviceWorker?.controller)

export function offerUpdate(registration) {
  const reg = registration || activeRegistration
  if (
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

export async function checkForAppUpdate() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null
  }
  try {
    if (!activeRegistration) {
      activeRegistration = await navigator.serviceWorker.getRegistration()
    }
    if (activeRegistration) {
      deferredWorker = undefined
      await activeRegistration.update()
      if (activeRegistration.waiting) {
        offerUpdate(activeRegistration)
      }
      return activeRegistration
    }
  } catch (error) {
    console.warn('Could not check for an app update:', error)
  }
  return null
}

export async function forceCacheRefresh() {
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

function checkForUpdate(registration) {
  if (
    typeof document !== 'undefined' &&
    document.visibilityState !== 'visible'
  ) {
    return
  }
  const now = Date.now()
  if (now - lastUpdateCheck < 30_000) return
  lastUpdateCheck = now
  const reg = registration || activeRegistration
  if (reg) {
    void reg.update().catch(error => {
      console.warn('Could not check for an app update:', error)
    })
    if (reg.waiting) {
      offerUpdate(reg)
    }
  }
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
    checkForUpdate(registration)
  },

  registered(registration) {
    activeRegistration = registration
    if (registration.waiting) {
      offerUpdate(registration)
    }
    checkForUpdate(registration)
    document.addEventListener('visibilitychange', () =>
      checkForUpdate(registration),
    )
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
