import { toRaw } from 'vue'
import type { PiniaPlugin } from 'pinia'

/**
 * Calls every store action the way a development build does. There Pinia installs its
 * devtools plugin, whose `patchActionForGrouping` replaces each action of an options store
 * with a function that runs it with a NEW Proxy of the store as `this`, one per call (so
 * devtools can tell which action made a mutation). Jest runs with NODE_ENV=test, where
 * Pinia leaves that plugin out, so a store that only works when `this` is the same object
 * on every call passes every unit test and fails in `quasar dev`: the oracle store did
 * exactly that, and the app never asked for a price.
 *
 * This is that one function of Pinia (pinia/dist/pinia.mjs, `patchActionForGrouping`),
 * without the devtools bookkeeping.
 */
export const developmentBuildActions: PiniaPlugin = ({ store, options }) => {
  const actions = (options as { actions?: Record<string, unknown> }).actions
  const raw = toRaw(store) as Record<string, (...args: unknown[]) => unknown>
  const patched = store as unknown as Record<string, unknown>
  for (const name of Object.keys(actions ?? {})) {
    const action = raw[name]
    patched[name] = function (...args: unknown[]) {
      const trackedStore = new Proxy(store, {
        get: (...access) => Reflect.get(...access),
        set: (...access) => Reflect.set(...access),
      })
      return action.apply(trackedStore, args)
    }
  }
}
