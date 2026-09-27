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
//
// KNOWN BROKEN (ticket #53 GUI verification, found live, driving a real browser): setting this
// env var currently has zero effect -- `process.env.MONAD_SKIP_LEGACY_SETUP_GATE` is always
// `undefined` in the served bundle regardless of what's configured. Tried and ruled out: (1) a
// `@rollup/plugin-inject`/Vite `define` collision over the `process` identifier (real, confirmed
// -- even Vite's own built-in `process.env.NODE_ENV` has it), and (2) a bare non-`process`-
// prefixed `define` global instead (`__MONAD_SKIP_LEGACY_SETUP_GATE__`) -- also silently never
// applied, confirmed via the production build: the whole guarded expression got dead-code-
// eliminated rather than resolving to a real value, meaning `viteConf.define` isn't reaching
// first-party source at all in this `@quasar/app-vite`/Vite 8/Rolldown combination, only
// pre-bundled `node_modules` dependency chunks (where `__VUE_OPTIONS_API__` above lives and does
// work). Needs real investigation into this toolchain's actual `define`/`import.meta.env`
// wiring, not a config tweak -- see the tracked follow-up issue. Until then, this flag can only
// be exercised by editing this default directly, not via the documented env var.
const skipLegacySetupGate = process.env.MONAD_SKIP_LEGACY_SETUP_GATE !== 'false'

const unprotectedRoutes = ['/', '/setup', '/forum', '/changelog']
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
