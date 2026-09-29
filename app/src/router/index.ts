import {
  createRouter,
  createMemoryHistory,
  createWebHistory,
  createWebHashHistory,
} from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { createRoutes } from './routes'
import { useContactStore } from 'src/stores/contacts'
import { useProfileStore } from 'src/stores/my-profile'
import { useChatStore } from 'src/stores/chats'
import { useWalletStore } from 'src/stores/wallet'
import { monadModeEnabled } from 'src/utils/runtime-mode'

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
//
// Ticket #54 fix (found live doing real end-to-end GUI testing): this was
// `process.env.MONAD_SKIP_LEGACY_SETUP_GATE`, silently always `undefined` in the browser bundle
// under this toolchain regardless of what's configured (see `app/quasar.config.js`'s own
// investigation for the full story -- `viteConf.define` doesn't reach first-party source at all
// here). `import.meta.env.QCLI_KEY` (Quasar's own env-var-prefix convention) is the mechanism
// that actually works, confirmed live: set `QCLI_MONAD_SKIP_LEGACY_SETUP_GATE=false` (not
// `MONAD_SKIP_LEGACY_SETUP_GATE=false`) to restore the strict gate.
const skipLegacySetupGate = monadModeEnabled()

const unprotectedRoutes = ['/setup', '/changelog']
const walletRequiredRoutes = ['/forum', '/new-post']
// Was '/forum/new-post' -- routes.ts declares this child route's path with a leading slash
// (`/new-post`), which Vue Router treats as absolute (top-level), not relative to its `forum`
// parent. The real route (confirmed against every actual `:to` link in the app -- ForumDrawer.vue,
// ForumLayout.vue, ForumMessage.vue, ForumPost.vue) is `/new-post`; `/forum/new-post` never
// matches any navigation at all, so this gate silently never fired, in either
// `skipLegacySetupGate` mode (masked by the bypass anyway) or the strict mode
// `MONAD_SKIP_LEGACY_SETUP_GATE=false` is meant to restore.
const protectedRoutes = ['/new-post']

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
  // Ticket-adjacent fix (console noise found live throughout tonight's testing): rewritten from
  // the deprecated `next()` callback style to Vue Router 4's own preferred return-value style
  // (see https://router.vuejs.org/guide/advanced/navigation-guards.html#Optional-third-argument-next)
  // -- `next()` becomes `return` (undefined = allow navigation), `next('/setup')` becomes
  // `return '/setup'`. Purely mechanical; the actual gating logic is unchanged.
  async function redirectIfNoProfile(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
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
    const walletRequired = walletRequiredRoutes.some(
      path => to.path === path || to.path.startsWith(`${path}/`),
    )
    if (walletRequired && !walletStore.seedPhrase) {
      console.log('nav to setup!')
      return '/setup'
    }

    if (
      profileStore.profile.name ||
      (skipLegacySetupGate && !!walletStore.seedPhrase) ||
      (unprotectedRoutes.some(path => to.fullPath.startsWith(path)) &&
        !protectedRoutes.some(path => to.fullPath.startsWith(path)))
    ) {
      return
    } else {
      console.log('nav to setup!')
      return '/setup'
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
