import { Notify } from 'quasar'
import { register } from 'register-service-worker'

let updateNotice
let deferredWorker
let reloadAfterActivation = false
let lastUpdateCheck = 0

function offerUpdate(registration) {
  if (
    !navigator.serviceWorker.controller ||
    !registration.waiting ||
    updateNotice ||
    registration.waiting === deferredWorker
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
          if (!registration.waiting) return
          reloadAfterActivation = true
          registration.waiting.postMessage({ type: 'SKIP_WAITING' })
        },
      },
      {
        label: 'Later',
        color: 'white',
        handler: () => {
          deferredWorker = registration.waiting
        },
      },
    ],
    onDismiss: () => {
      updateNotice = undefined
    },
  })
}

function checkForUpdate(registration) {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (now - lastUpdateCheck < 60_000) return
  lastUpdateCheck = now
  void registration.update().catch(error => {
    console.warn('Could not check for an app update:', error)
  })
  offerUpdate(registration)
}

navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!reloadAfterActivation) return
  reloadAfterActivation = false
  window.location.reload()
})

register(import.meta.env.QUASAR_SERVICE_WORKER_FILE, {
  ready(registration) {
    checkForUpdate(registration)
  },

  registered(registration) {
    offerUpdate(registration)
    checkForUpdate(registration)
    document.addEventListener('visibilitychange', () =>
      checkForUpdate(registration),
    )
  },

  updated(registration) {
    offerUpdate(registration)
  },

  offline() {
    console.log('No internet connection found. App is running in offline mode.')
  },

  error(error) {
    console.error('Error during service worker registration:', error)
  },
})
