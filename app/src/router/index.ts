import {
  createRouter,
  createMemoryHistory,
  createWebHistory,
  createWebHashHistory,
} from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { createRoutes } from './routes'
import { startupRestoration } from '../boot/startup-state'
import { useContactStore } from 'src/stores/contacts'
import {
  hasConversationIdSalt,
  resolveConversation,
  useChatStore,
} from 'src/stores/chats'
import { isChainAddress } from 'src/utils/chain-address'
import { accountSession, accountStatus } from '../accounts/session'
import { notePendingChatRoute, takeInterruptedChatRoute } from './pending-chat'

async function ensureChatState(
  address: string | undefined,
  stillCurrent: () => boolean,
) {
  const chatStore = useChatStore()
  if (!address) {
    chatStore.setActiveConversation(null)
    return
  }
  try {
    // Also a conversation that was dropped for the peer's own: the one that replaced it.
    if (resolveConversation(chatStore.conversations, address)) {
      chatStore.setActiveConversation(address)
      return
    }
    if (isChainAddress(address)) {
      const contactsStore = useContactStore()
      void contactsStore
        .fetchAndAddContact({ address, contact: {} })
        .catch(err => {
          console.debug('fetchAndAddContact suppressed error:', err)
        })
      // Opening a chat allocates its ID from the account's salt. At launch a route can be
      // followed before the wallet is at hand: wait for it then.
      if (!hasConversationIdSalt()) {
        const { ensureConversationIdSalt } = await import(
          '../utils/monad-identity-session'
        )
        await ensureConversationIdSalt()
        // The user may have gone elsewhere while the wallet opened.
        if (!stillCurrent()) return
      }
      chatStore.setActiveChat(address)
    }
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
  async function redirectIfNoProfile(to: RouteLocationNormalized) {
    if (startupRestoration.value.phase !== 'restored') return
    await accountSession.initialize()
    // Release notes, documentation, and legal notices are readable without an account.
    if (
      to.path === '/setup' ||
      to.path === '/changelog' ||
      to.path === '/about' ||
      to.path === '/welcome' ||
      to.path === '/docs' ||
      to.path.startsWith('/docs/') ||
      to.path === '/' ||
      to.path.startsWith('/forum') ||
      to.path.startsWith('/topic')
    ) {
      if (to.path === '/') {
        return accountStatus.status === 'ready' ? '/forum' : '/welcome'
      }
      return
    }
    if (accountStatus.status !== 'ready') return '/setup'
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
  // Read before the first navigation starts: a chat that was being opened when the page was
  // reloaded (see `./pending-chat`).
  const interrupted = takeInterruptedChatRoute()
  let latest: RouteLocationNormalized | undefined
  Router.beforeEach((to, from) => {
    latest = to
    notePendingChatRoute(
      to.path.startsWith('/chat/') ? to.fullPath : null,
      from.fullPath,
    )
  })
  Router.beforeEach(redirectIfNoProfile)
  // A navigation that ended in an error (the page's code could not be loaded) is over too.
  Router.onError(() => notePendingChatRoute(null))
  if (interrupted) {
    void Router.isReady()
      .then(() => {
        // Only from where the click was made; the user may have gone elsewhere on purpose.
        if (Router.currentRoute.value.fullPath === interrupted.from)
          return Router.push(interrupted.to)
      })
      .catch(() => undefined)
  }
  Router.afterEach((to, _from, failure) => {
    // The navigation the user asked for last has ended (committed, or refused): nothing is
    // pending. One that a later navigation replaced ends without touching the later one's note.
    if (to === latest) notePendingChatRoute(null)
    // Only a committed route owns selection/read state. Publishing from beforeEach lets
    // selection observers replace in-flight query navigation or mark canceled targets read.
    if (failure || startupRestoration.value.phase !== 'restored') return
    const address =
      to.path.startsWith('/chat/') && typeof to.params.address === 'string'
        ? to.params.address
        : undefined
    void ensureChatState(address, () => {
      const current = Router.currentRoute.value
      return (
        current.path.startsWith('/chat/') && current.params.address === address
      )
    })
  })

  return Router
}
