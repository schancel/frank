import { ref, watch, type Ref } from 'vue'
import {
  useRoute,
  useRouter,
  type LocationQuery,
  type RouteLocationNormalizedLoaded,
} from 'vue-router'

/** No router (a component on its own): nothing in the address. */
const NO_ROUTE = {
  path: '',
  fullPath: '',
  query: {},
  hash: '',
} as unknown as RouteLocationNormalizedLoaded

/** The first string a query value holds. */
function queryString(value: LocationQuery[string] | undefined) {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : undefined
}

export interface QueryStateOptions<T extends string> {
  /** The value when the address has none; never written to the address. */
  fallback: T
  /** The values the address may hold; anything else reads as `fallback`. */
  allowed?: readonly T[]
  /**
   * The routes this state belongs to. Elsewhere (a list shown beside another page) it is kept
   * in the component only, and the address is left alone. Default: every route.
   */
  owns?: (route: RouteLocationNormalizedLoaded) => boolean
}

/**
 * A page's view state kept in the address (`?<key>=`): a tab, a search, a filter. It is read
 * from the route, so Back, Forward, a reload and a link all show it, and written with
 * `router.replace`, so changing it in place adds no history entry. Every component showing the
 * same state (a list on the page and the same list in the sidebar) reads the same address, so
 * they agree, and one that is rebuilt (a phone turned to a wide screen) keeps it.
 */
export function useQueryState<T extends string>(
  key: string,
  options: QueryStateOptions<T>,
): Ref<T> {
  // The router's current route (reactive): what every component on screen reads.
  const router = useRouter()
  const route = typeof useRoute === 'function' ? useRoute() : undefined
  const current = (): RouteLocationNormalizedLoaded =>
    router?.currentRoute?.value ?? route ?? NO_ROUTE
  const owns = options.owns ?? (() => true)
  const read = (from: RouteLocationNormalizedLoaded): T => {
    const raw = queryString(from.query?.[key])
    if (raw === undefined || raw === '') return options.fallback
    if (options.allowed && !options.allowed.includes(raw as T))
      return options.fallback
    return raw as T
  }
  const state = ref(
    owns(current()) ? read(current()) : options.fallback,
  ) as Ref<T>
  // Values written and not yet committed, oldest first. The route committing one of them is
  // this component's own write landing (the user may have typed on since): it is not read back.
  const pending: T[] = []
  watch(
    () => current().fullPath,
    () => {
      if (!owns(current())) return
      const value = read(current())
      const index = pending.indexOf(value)
      if (index !== -1) {
        pending.splice(0, index + 1)
        return
      }
      pending.splice(0)
      state.value = value
    },
    { flush: 'sync' },
  )
  watch(state, value => {
    const at = current()
    if (!router?.replace || !owns(at) || read(at) === value) return
    const query: LocationQuery = { ...at.query }
    if (value === options.fallback) delete query[key]
    else query[key] = value
    pending.push(value)
    void Promise.resolve(
      router.replace({ path: at.path, query, hash: at.hash }),
    ).then(
      failure => {
        if (failure) {
          const index = pending.indexOf(value)
          if (index !== -1) pending.splice(index, 1)
        }
      },
      () => {
        const index = pending.indexOf(value)
        if (index !== -1) pending.splice(index, 1)
      },
    )
  })
  return state
}
