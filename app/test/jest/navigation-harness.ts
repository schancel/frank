/**
 * A real vue-router on jsdom's real session history (hash mode, as the app ships), for tests
 * that walk forward and back and check where Back lands. `history.state.position` is the
 * entry's index, as in a browser.
 */
import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'
import { installNavigation } from '../../src/utils/navigation'

const Blank = { render: () => null }

/** Lets every pending timer, microtask and popstate run. */
export async function flushHistory() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Resolves after the router's next navigation ends (committed or refused). */
export function afterNavigation(router: Router): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      stop()
      void flushHistory().then(resolve)
    }
    const stop = router.afterEach(finish)
    setTimeout(finish, 1000)
  })
}

/** The browser's (or the phone's) Back button. */
export async function userBack(router: Router) {
  const done = afterNavigation(router)
  window.history.back()
  await done
}

/** The browser's Forward button. */
export async function userForward(router: Router) {
  const done = afterNavigation(router)
  window.history.forward()
  await done
}

/** `history.state.position`: which entry of the session history is current. */
export function historyPosition(): number {
  return (window.history.state as { position: number }).position
}

/**
 * Opens the app at `start` in a tab that already has a page from before the app (so leaving the
 * app is a real entry, as in a browser). `routes` are paths with blank pages, or full records.
 */
export async function openApp(
  routes: (string | RouteRecordRaw)[],
  start: string,
  options: NavigationOptions = {
    backClosesOverlays: () => true,
  },
) {
  window.history.pushState(null, '', '#/before-the-app')
  window.history.pushState(null, '', `#${start}`)
  return startRouter(routes, start, options)
}

interface NavigationOptions {
  backClosesOverlays: () => boolean
  /** Installs more on the router and its history, as `router/index.ts` does. */
  install?: (router: Router, history: RouterHistory) => void
}

/**
 * A reload: the page's session history entries stay (with their `history.state`); a new router
 * starts on the current entry. The previous router must have been destroyed.
 */
export async function reloadApp(
  routes: (string | RouteRecordRaw)[],
  options: NavigationOptions = { backClosesOverlays: () => true },
) {
  const start = window.location.hash.slice(1) || '/'
  return startRouter(routes, start, options)
}

async function startRouter(
  routes: (string | RouteRecordRaw)[],
  start: string,
  options: NavigationOptions,
) {
  const history = createWebHashHistory()
  const router = createRouter({
    history,
    routes: routes.map(route =>
      typeof route === 'string' ? { path: route, component: Blank } : route,
    ),
  })
  installNavigation(router, history, options)
  options.install?.(router, history)
  await router.push(start)
  await router.isReady()
  return { router, destroy: () => history.destroy() }
}
