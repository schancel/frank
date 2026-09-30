import type { Router } from 'vue-router'

/**
 * "Back" for a page that was navigated to from somewhere else in the app (ticket #275).
 *
 * The idiom this replaces, `window.history.length > 1 ? router.go(-1) : router.push('/')`, counts
 * every entry in the tab's session history, including the ones from before the SPA (the new-tab
 * page, the previous site). Opening a page directly (bookmark, reload, deep link) therefore still
 * had `history.length > 1`, and going back left Frank entirely.
 *
 * vue-router records the previous in-app location in `history.state.back` (`null` for the first
 * in-app entry), which is exactly the question being asked: go back only when there is an in-app
 * page to return to, otherwise land on the home route.
 */
export function navigateBack(router: Pick<Router, 'back' | 'push'>): void {
  const previous = (window.history.state as { back?: unknown } | null)?.back
  if (typeof previous === 'string' && previous.length > 0) {
    router.back()
  } else {
    void router.push('/')
  }
}
