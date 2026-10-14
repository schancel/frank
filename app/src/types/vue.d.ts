// Augment the public Vue module, alongside the installed router, Quasar and i18n
// plugins. Augmenting runtime-core separately splits their component-property symbols.
import 'vue'

declare module 'vue' {
  interface ComponentCustomProperties {
    $status: {
      loaded: boolean
      setup: boolean
    }

    // Installed only by Electron/Capacitor boot, not by the browser/PWA host.
    openURL?: (url: string) => void
  }
}
