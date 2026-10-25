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
      colorScheme: 'dark',
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
      appearance: JSON.stringify({ colorScheme: 'dark', lastDismissed: 1 }),
    })
    const store = useAppearanceStore()

    const restored = await restoreAppearance(storage)
    store.$patch(restored)

    expect(store.locale).toBe(defaultLocale)
    expect(store.theme).toBe('carnelian')
    expect(store.darkMode).toBe(true)
  })

  it('an older saved darkMode, or anything that is not a scheme, is not restored: the system is followed', async () => {
    const storage = fakeStorage({
      appearance: JSON.stringify({ darkMode: true, colorScheme: 'sepia' }),
    })
    const restored = await restoreAppearance(storage)
    expect(restored).toEqual({})
    const store = useAppearanceStore()
    store.$patch(restored)
    expect(store.colorScheme).toBe('system')
  })
})

describe('color scheme', () => {
  it('follows the system by default, and an explicit choice overrides it', async () => {
    const listeners: Array<(e: { matches: boolean }) => void> = []
    const query = {
      matches: true,
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) =>
        listeners.push(l),
    }
    const g = globalThis as { window?: unknown }
    const original = g.window
    g.window = { matchMedia: jest.fn(() => query) }
    jest.resetModules()
    try {
      const { createPinia, setActivePinia } = jest.requireActual('pinia')
      setActivePinia(createPinia())
      const { useAppearanceStore: fresh } = jest.requireActual(
        './appearance',
      ) as typeof import('./appearance')
      const store = fresh()
      expect(store.colorScheme).toBe('system')
      expect(store.darkMode).toBe(true)
      listeners.forEach(l => l({ matches: false }))
      expect(store.darkMode).toBe(false)
      store.setColorScheme('dark')
      expect(store.darkMode).toBe(true)
      store.setColorScheme('light')
      listeners.forEach(l => l({ matches: true }))
      expect(store.darkMode).toBe(false)
    } finally {
      g.window = original
    }
  })
})
