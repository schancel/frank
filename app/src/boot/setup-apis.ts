import { defineBoot as boot } from '@quasar/app-vite'
import { Quasar } from 'quasar'
import { reactive, watch } from 'vue'
import { setStartupRestoration } from './startup-state'
import { store as messageStore } from '../adapters/level-message-store'
import { applyLocale } from '../utils/apply-locale'
import { defaultLocale, messages } from '../i18n'
import { useWalletStore } from '../stores/wallet'
import { useProfileStore } from '../stores/my-profile'
import { useContactStore } from '../stores/contacts'
import { useAppearanceStore } from '../stores/appearance'
import { useForumStore } from '../stores/forum'
import { useTopicStore } from '../stores/topics'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chats'
import { useTabCoordinatorStore } from '../stores/tab-coordinator'
import { accountSession, accountStatus } from '../accounts/session'
import { preloadAppRuntime } from '../App.vue'
import { hasOtherExtensionViews } from '../../src-bex/runtime-adapter'

const EXTENSION_PEER_PING_TIMEOUT_MS = 300

export default boot(async ({ app }) => {
  const status = reactive({ loaded: false, setup: false })
  app.config.globalProperties.$status = status
  applyLocale({ $q: Quasar, locale: defaultLocale })
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
        () => useSettingsStore().restored,
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
      const locale = useAppearanceStore().locale
      if (Object.prototype.hasOwnProperty.call(messages, locale)) {
        applyLocale({ $q: Quasar, locale })
      }
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
  if (typeof process === 'undefined' || !process.env?.JEST_WORKER_ID) {
    void preloadAppRuntime().catch(() => undefined)
  }
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
    const extMode =
      typeof window !== 'undefined' &&
      typeof window.location?.search === 'string'
        ? new URLSearchParams(window.location.search).get('extMode')
        : null
    const isExtensionSurface =
      Boolean(extMode) ||
      (typeof window !== 'undefined' &&
        /^(chrome-extension|moz-extension|safari-web-extension):$/i.test(
          window.location?.protocol || '',
        ))
    if (
      isExtensionSurface &&
      (typeof process === 'undefined' || !process.env?.JEST_WORKER_ID)
    ) {
      void import('../layouts/MainLayout.vue').catch(() => undefined)
      void import('../layouts/ForumLayout.vue').catch(() => undefined)
      void import('../pages/Forum.vue').catch(() => undefined)
      void import('../pages/Wallet.vue').catch(() => undefined)
      void import('../pages/Welcome.vue').catch(() => undefined)
      void import('../pages/Setup.vue').catch(() => undefined)
    }
    // The popup boots fast when it is the only extension view. With another view open (the
    // pop-out, say) it waits long enough for that view to answer: a late answer would let
    // both views take the account and leave both on the lock screen.
    const otherViews = isExtensionSurface
      ? await hasOtherExtensionViews().catch(() => null)
      : null
    await tabCoordinator.init(
      isExtensionSurface
        ? { pingTimeoutMs: otherViews ? EXTENSION_PEER_PING_TIMEOUT_MS : 4 }
        : undefined,
    )
    if (tabCoordinator.otherTabActive) {
      accountSession.setStandby?.()
      // Clicking the toolbar icon with the pop-out open raises the pop-out; it never
      // lands on the lock screen. The lock screen remains when the holder cannot answer.
      if (
        isExtensionSurface &&
        (await tabCoordinator.deferToActiveExtensionView())
      ) {
        return
      }
    }
  } catch {
    // tab coordinator optional in headless/test environments
  }
  await accountSession.initialize()
})
