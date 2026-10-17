import { defineStore } from 'pinia'
import { LevelDB } from 'level'

import { defaultLocale } from 'src/i18n'
import { DEFAULT_SIGNET_THEME, SignetStone } from 'src/utils/theme'
import {
  DEFAULT_UI_SCALE,
  UiScaleSetting,
  getSavedUiScaleSetting,
  normalizeUiScaleSetting,
  saveUiScaleSetting,
} from 'src/utils/mobile-viewport-scale'

export interface State {
  darkMode: boolean
  lastDismissed: number
  /** The committed (Saved) UI locale -- ticket #156. Never written directly from a Settings
   * draft in progress; only `save()` in `Settings.vue` commits a new value here. */
  locale: string
  /** The committed UI color theme (Signet stone). Defaults to 'carnelian'. */
  theme: SignetStone
  /** The committed UI display scale ('auto' | 85 | 100 | 115 | 130 | 150). */
  uiScale?: UiScaleSetting
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
  if (deserializedProfile.uiScale !== undefined) {
    saveUiScaleSetting(normalizeUiScaleSetting(deserializedProfile.uiScale))
  }
  return deserializedProfile
}

export const useAppearanceStore = defineStore('appearance', {
  state: (): State => ({
    darkMode: false,
    lastDismissed: 0,
    locale: defaultLocale,
    theme: DEFAULT_SIGNET_THEME,
    uiScale: getSavedUiScaleSetting() || DEFAULT_UI_SCALE,
  }),
  actions: {
    setDarkMode(darkMode: boolean) {
      this.darkMode = darkMode
    },
    setTheme(theme: SignetStone) {
      this.theme = theme
    },
    setUiScale(uiScale: UiScaleSetting) {
      const normalized = normalizeUiScaleSetting(uiScale)
      this.uiScale = normalized
      saveUiScaleSetting(normalized)
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
