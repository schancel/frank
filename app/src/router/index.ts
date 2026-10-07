import {
  createRouter,
  createMemoryHistory,
  createWebHistory,
  createWebHashHistory,
} from 'vue-router'
import type { RouteLocationNormalized } from 'vue-router'
import { createRoutes } from './routes'
import { useContactStore } from 'src/stores/contacts'
import { useChatStore } from 'src/stores/chats'
import { isChainAddress } from 'src/utils/chain-address'
import { accountSession, accountStatus } from '../accounts/session'

async function ensureChatState(address?: string) {
  const chatStore = useChatStore()
  if (!address) {
    if (typeof chatStore.setActiveConversation === 'function') {
      chatStore.setActiveConversation(null)
    } else {
      chatStore.setActiveChat(null)
    }
    return
  }

  try {
    if (chatStore.conversations && address in chatStore.conversations) {
      if (typeof chatStore.setActiveConversation === 'function') {
        chatStore.setActiveConversation(address)
        return
      }
    }
    if (isChainAddress(address)) {
      const contactsStore = useContactStore()
      void contactsStore.fetchAndAddContact({ address, contact: {} }).catch(err => {
        console.debug('fetchAndAddContact suppressed error:', err)
      })
    }
    if (typeof chatStore.setActiveConversation === 'function') {
      chatStore.setActiveConversation(address)
    } else {
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
    if (
      to.fullPath.startsWith('/chat') &&
      to.params.address &&
      typeof to.params.address === 'string'
    ) {
      ensureChatState(to.params.address as string)
    } else {
      ensureChatState()
    }

    await accountSession.initialize()
    // Release notes, documentation, and legal notices are readable without an account.
    if (
      to.path === '/setup' ||
      to.path === '/changelog' ||
      to.path === '/about' ||
      to.path === '/docs' ||
      to.path.startsWith('/docs/') ||
      to.path === '/' ||
      to.path.startsWith('/forum') ||
      to.path.startsWith('/topic')
    ) {
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
  Router.beforeEach(redirectIfNoProfile)

  return Router
}
