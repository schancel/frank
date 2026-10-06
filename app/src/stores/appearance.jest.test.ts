import { setActivePinia, createPinia } from 'pinia'
import { LevelDB } from 'level'

import {
  restoreAppearance,
  saveAppearance,
  State,
  useAppearanceStore,
} from './appearance'
import { defaultLocale } from 'src/i18n'
import { DEFAULT_SIGNET_THEME } from 'src/utils/theme'

function fakeStorage(initial: Record<string, string> = {}): LevelDB {
  const data = { ...initial }
  return {
    put: (key: string, value: string) => {
      data[key] = value
      return Promise.resolve()
    },
    get: (key: string) => {
      if (!(key in data)) return Promise.reject(new Error('not found'))
      return Promise.resolve(data[key])
    },
  } as unknown as LevelDB
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useAppearanceStore', () => {
  it('defaults to the app default locale and carnelian theme', () => {
    const store = useAppearanceStore()
    expect(store.locale).toBe(defaultLocale)
    expect(store.theme).toBe(DEFAULT_SIGNET_THEME)
  })
})

/**
 * Ticket #156: a fresh boot must restore the saved locale, not silently reset to the default --
 * exercises the exact `save`/`restore` pair `boot/pinia.ts`'s generic plugin calls, directly.
 */
describe('saveAppearance / restoreAppearance', () => {
  it('round-trips locale and theme (and every other field) through storage', async () => {
    const storage = fakeStorage()
    const state: State = {
      darkMode: true,
      lastDismissed: 42,
      locale: 'fr-fr',
      theme: 'lapis',
    }

    await saveAppearance(storage, state)
    const restored = await restoreAppearance(storage)

    expect(restored).toEqual(state)
  })

  it('falls back to an empty object when nothing was ever saved', async () => {
    const storage = fakeStorage()

    const restored = await restoreAppearance(storage)

    expect(restored).toEqual({})
  })

  it('a restore missing `locale` or `theme` (a pre-existing persisted blob) never overrides the store default', async () => {
    // Simulates a real user's pre-existing `appearance` blob, saved before `locale`/`theme` existed.
    const storage = fakeStorage({
      appearance: JSON.stringify({ darkMode: true, lastDismissed: 1 }),
    })
    const store = useAppearanceStore()

    const restored = await restoreAppearance(storage)
    store.$patch(restored)

    expect(store.locale).toBe(defaultLocale)
    expect(store.theme).toBe('carnelian')
    expect(store.darkMode).toBe(true)
  })
})
