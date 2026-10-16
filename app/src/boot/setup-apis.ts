import { defineBoot as boot } from '@quasar/app-vite'
import { Quasar } from 'quasar'
import { reactive, watch } from 'vue'
import { setStartupRestoration } from './startup-state'
import { store as messageStore } from '../adapters/level-message-store'
import { applyLocale } from '../utils/apply-locale'
import { defaultLocalePreference } from '../i18n'
import { useWalletStore } from '../stores/wallet'
import { useProfileStore } from '../stores/my-profile'
import { useContactStore } from '../stores/contacts'
import { useAppearanceStore } from '../stores/appearance'
import { useForumStore } from '../stores/forum'
import { useTopicStore } from '../stores/topics'
import { useChatStore } from '../stores/chats'
import { useTabCoordinatorStore } from '../stores/tab-coordinator'
import { accountSession, accountStatus } from '../accounts/session'

export default boot(async ({ app }) => {
  const status = reactive({ loaded: false, setup: false })
  app.config.globalProperties.$status = status
  applyLocale({ $q: Quasar, locale: defaultLocalePreference })
  try {
    // Wallet inspection remains first and never hydrates secrets.
    await useWalletStore().restored
    // Observe every started restoration and wait for siblings to settle before showing failure.
    // The original store promises remain rejected; this only contains the composition failure.
    const results = await Promise.all(
      [
        () => useProfileStore().restored,
        () => useContactStore().restored,
        () => useAppearanceStore().restored,
        () => useForumStore().restored,
        () => useChatStore().restored,
        () => useTopicStore().restored,
        // Chat metadata may skip hydration; required database admission cannot be skipped.
        () => messageStore,
      ].map(restore =>
        Promise.resolve()
          .then(async () => {
            await restore()
          })
          .then(
            () => true,
            () => false,
          ),
      ),
    )
    if (results[2]) {
      const appearance = useAppearanceStore()
      const updateLocale = () =>
        applyLocale({ $q: Quasar, locale: appearance.locale })
      const stopLocaleWatch = watch(() => appearance.locale, updateLocale, {
        immediate: true,
      })
      const onLanguageChange = () => {
        if (appearance.locale === 'auto') updateLocale()
      }
      if (typeof window !== 'undefined')
        window.addEventListener('languagechange', onLanguageChange)
      app.onUnmount(() => {
        stopLocaleWatch()
        if (typeof window !== 'undefined')
          window.removeEventListener('languagechange', onLanguageChange)
      })
    }
    if (results.some(success => !success)) {
      setStartupRestoration({ phase: 'failed', reason: 'state-restore-failed' })
      return
    }
  } catch {
    setStartupRestoration({ phase: 'failed', reason: 'state-restore-failed' })
    return
  }
  setStartupRestoration({ phase: 'restored' })
  watch(
    () => accountStatus.status,
    value => {
      status.setup = value === 'ready'
      status.loaded = value !== 'loading'
    },
    { immediate: true },
  )
  try {
    const tabCoordinator = useTabCoordinatorStore()
    await tabCoordinator.init()
    if (tabCoordinator.otherTabActive) {
      accountSession.setStandby?.()
    }
  } catch {
    // tab coordinator optional in headless/test environments
  }
  await accountSession.initialize()
})
