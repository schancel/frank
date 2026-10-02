import { inject, ref, type Ref } from 'vue'

/** Provide/inject key for the main navigation drawer's open state (provided by MainLayout). */
export const MY_DRAWER_OPEN_KEY = 'myDrawerOpen'

/**
 * Whether the main navigation drawer is open, for the header "menu" buttons' `aria-expanded`.
 * `undefined` (attribute omitted) when nothing provides it, e.g. a component mounted on its own.
 */
export function useMyDrawerOpen(): Ref<boolean | undefined> {
  return inject<Ref<boolean | undefined>>(MY_DRAWER_OPEN_KEY, ref(undefined))
}
