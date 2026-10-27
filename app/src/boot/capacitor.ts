import { defineBoot as boot } from '@quasar/app-vite'
import { Plugins } from '@capacitor/core'
import { APP_STATE_EVENT } from 'src/composables/useBalance'
import { handleHardwareBack } from 'src/utils/navigation'
const { Browser, App } = Plugins

export default boot(({ app, router }) => {
  // Android's Back button: closes an open dialog, menu or drawer, else goes back, and on the
  // start screen leaves the app (utils/navigation). Quasar's own handler is off
  // (quasar.config.js `capacitor.backButton`): it never left the app, since #/ always redirects.
  App.addListener('backButton', () =>
    handleHardwareBack(router, () => App.exitApp()),
  )

  // Native pause/resume for the shared balance poll (ticket #213). Capacitor-mode only, so the
  // SPA/Electron builds never load @capacitor/core.
  App.addListener('appStateChange', (state: { isActive: boolean }) => {
    window.dispatchEvent(
      new CustomEvent(APP_STATE_EVENT, {
        detail: { isActive: state.isActive },
      }),
    )
  })

  app.config.globalProperties.updateBadge = function () {
    // do nothing
  }

  app.config.globalProperties.openURL = (url: string) => {
    Browser.open({ url, windowName: '_blank' })
  }
})
