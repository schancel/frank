import type { LocationQueryRaw, Router } from 'vue-router'

/** Opens a conversation the user picked: a page of its own, so Back returns here. `replace`
 * when the conversation takes the place of the current screen (a finished form, a redirect). */
export function openChat(
  router: Router,
  address: string,
  options?: { replace?: boolean; query?: LocationQueryRaw },
) {
  const path = `/chat/${address}`
  const chatRoute =
    options?.query && Object.keys(options.query).length
      ? { path, query: options.query }
      : path
  return options?.replace ? router.replace(chatRoute) : router.push(chatRoute)
}

/** Opens a contact's profile (the conversation's Info view) as a page of its own. */
export function openContactProfile(router: Router, address: string) {
  return router.push(`/chat/${address}?info=true`)
}
