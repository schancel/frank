import { defineStore } from 'pinia'
import { LevelDB } from 'level'

import { defaultLocale } from 'src/i18n'

export interface State {
  darkMode: boolean
  lastDismissed: number
  /** The committed (Saved) UI locale -- ticket #156. Never written directly from a Settings
   * draft in progress; only `save()` in `Settings.vue` commits a new value here. */
  locale: string
}

/** Extracted from the `storage` option below (same behavior) so it's directly unit-testable --
 * `boot/pinia.ts`'s generic persistence plugin is what actually wires these into the store's
 * lifecycle, which isn't worth reproducing in a unit test just to exercise this logic. */
export function saveAppearance(storage: LevelDB, state: State): Promise<void> {
  return storage.put('appearance', JSON.stringify(state))
}

export async function restoreAppearance(
  storage: LevelDB,
): Promise<Partial<State>> {
  let appearance = '{}'
  try {
    appearance = await storage.get('appearance')
  } catch (err) {
    //
  }
  const deserializedProfile = JSON.parse(appearance) as State
  return deserializedProfile
}

export const useAppearanceStore = defineStore('appearance', {
  state: (): State => ({
    darkMode: false,
    lastDismissed: 0,
    locale: defaultLocale,
  }),
  actions: {
    setDarkMode(darkMode: boolean) {
      this.darkMode = darkMode
    },
  },
  storage: {
    save(storage, _mutation, state): Promise<void> {
      return saveAppearance(storage, state)
    },
    restore(storage): Promise<Partial<State>> {
      return restoreAppearance(storage)
    },
  },
})
