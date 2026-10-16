import { defineStore } from 'pinia'
import { LevelDB } from 'level'

import { defaultLocalePreference } from 'src/i18n/locale'
import { DEFAULT_SIGNET_THEME, SignetStone } from 'src/utils/theme'

export interface State {
  darkMode: boolean
  lastDismissed: number
  /** The saved UI language preference; auto follows the browser. Settings keeps a local
   * draft until Save. The effective language is derived and never persisted. */
  locale: string
  /** The committed UI color theme (Signet stone). Defaults to 'carnelian'. */
  theme: SignetStone
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
    locale: defaultLocalePreference,
    theme: DEFAULT_SIGNET_THEME,
  }),
  actions: {
    setDarkMode(darkMode: boolean) {
      this.darkMode = darkMode
    },
    setTheme(theme: SignetStone) {
      this.theme = theme
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
