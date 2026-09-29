import { boot } from 'quasar/wrappers'
import { Plugins } from '@capacitor/core'
import { APP_STATE_EVENT } from 'src/composables/useBalance'
const { Browser, App } = Plugins

export default boot(({ app }) => {
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
