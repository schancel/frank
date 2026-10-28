import type {
  RouteLocationNormalizedLoaded,
  RouteLocationRaw,
  Router,
} from 'vue-router'

/**
 * The forum's topic filter is in its address: `/forum?topic=<name>`, and `/forum` for every
 * topic. That one address is what picking a topic (in the drawer, on a post, in the forum's
 * own controls) shows, and what `/topic/<name>` (an older link) leads to, so Back, Forward, a
 * reload and a link all show the same screen.
 */

/** The forum's address for `topic` ('' for every topic). */
export function forumTopicLocation(topic: string): RouteLocationRaw {
  return topic ? { path: '/forum', query: { topic } } : { path: '/forum' }
}

/** The topic the forum's address names ('' for every topic). */
export function routeForumTopic(
  route: Pick<RouteLocationNormalizedLoaded, 'query'>,
): string {
  const raw = route.query?.topic
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

/**
 * Shows the forum filtered to `topic` ('' for every topic). On the forum the filter changes in
 * place (a replace: no history entry); from anywhere else the forum opens (a push).
 */
export function showForumTopic(router: Router, topic: string) {
  const location = forumTopicLocation(topic)
  return router.currentRoute?.value?.path === '/forum'
    ? router.replace(location)
    : router.push(location)
}
