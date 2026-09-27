import {
  createRouter,
  createMemoryHistory,
  createWebHistory,
  createWebHashHistory,
} from 'vue-router'
import type { RouteLocationNormalized, NavigationGuardNext } from 'vue-router'
import { createRoutes } from './routes'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { useChatStore } from 'src/stores/chats'
import { useWalletStore } from 'src/stores/wallet'

// Found live tonight (autonomous overnight session, 2026-09-27), by actually driving a real
// browser: this guard's `profileStore.profile.name` check can never become true through the
// Monad-only demo path. `Setup.vue`'s wizard is still entirely Lotus-network-dependent end to end
// (`forwardEnabled()` hard-blocks on `this.$indexer.connected` -- a live chronik indexer this repo
// never stands up for the demo -- and step 3 additionally requires a funded *Lotus* balance, which
// has no meaning/way to satisfy on Monad testnet). Meanwhile `Setup.vue`'s `setup()` hook already
// unconditionally generates and persists a seed phrase the instant `/setup` is visited, and
// `boot/monad-direct-messages.ts` (fixed tonight) already registers a real Monad identity with the
// relay from that seed on the next boot -- confirmed live, the Monad-side wallet/messaging stack
// works completely independently of whether the Lotus wizard's "Next" button was ever clickable.
// So the router was the actual remaining blocker: it never let a Monad-only user reach a `/chat`
// route at all, regardless of the wallet/identity already working underneath.
//
// Toggleable per this session's own "temporarily relaxed for the demo, not a permanent design
// decision" framing: `MONAD_SKIP_LEGACY_SETUP_GATE` defaults to on (skip -- a seed phrase existing
// is enough), set it to the literal string "false" to restore the original Lotus-wizard-completion
// requirement once #47 (porting Setup.vue to Monad) actually lands.
const skipLegacySetupGate = process.env.MONAD_SKIP_LEGACY_SETUP_GATE !== 'false'

const unprotectedRoutes = ['/', '/setup', '/forum', '/changelog']
const protectedRoutes = ['/forum/new-post']

async function ensureChatState(address?: string) {
  const chatStore = useChatStore()
  if (!address) {
    chatStore.setActiveChat(null)
    return
  }

  try {
    const contactsStore = useContactStore()
    contactsStore.fetchAndAddContact({ address, contact: {} })
    chatStore.setActiveChat(address)
  } catch (ex) {
    console.error('addContactFromNavigation error:', ex)
  }
}

// Note: ssrContext is also available
export default () => {
  async function redirectIfNoProfile(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: NavigationGuardNext,
  ) {
    if (
      to.fullPath.startsWith('/chat') &&
      to.params.address &&
      typeof to.params.address === 'string'
    ) {
      ensureChatState(to.params.address as string)
    } else {
      ensureChatState()
    }

    const profileStore = useProfileStore()
    const walletStore = useWalletStore()
    console.log(
      'Navigating to',
      to.fullPath,
      to.params.address,
      profileStore.profile.name,
    )
    if (
      profileStore.profile.name ||
      (skipLegacySetupGate && !!walletStore.seedPhrase) ||
      (unprotectedRoutes.some(path => to.fullPath.startsWith(path)) &&
        !protectedRoutes.some(path => to.fullPath.startsWith(path)))
    ) {
      next()
    } else {
      console.log('nav to setup!')
      next('/setup')
    }
  }

  const routes = createRoutes()
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : process.env.VUE_ROUTER_MODE === 'history'
    ? createWebHistory
    : createWebHashHistory

  const Router = createRouter({
    routes,
    scrollBehavior: () => ({ left: 0, top: 0 }),

    // Leave this as is and make changes in quasar.conf.js instead!
    // quasar.conf.js -> build -> vueRouterMode
    // quasar.conf.js -> build -> publicPath
    history: createHistory(
      process.env.MODE === 'ssr' ? undefined : process.env.VUE_ROUTER_BASE,
    ),
  })
  Router.beforeEach(redirectIfNoProfile)

  return Router
}
