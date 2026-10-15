/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Plugin } from 'vue'

// Quasar's browser UMD bundle publishes its plugin on the global object.
declare global {
  let Quasar: Plugin
}
import Panel from './PersistentStoragePanel.vue'
import { usePersistentStorageStore } from '../../stores/persistent-storage'

jest.mock('../../accounts/session', () => ({
  accountStatus: { account: null },
}))

test('the real chip preserves colors through all four owner statuses', async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const storage = usePersistentStorageStore()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { persisted: jest.fn(async () => false) },
  })
  Object.defineProperty(globalThis, 'Vue', {
    configurable: true,
    value: jest.requireActual('vue'),
  })
  jest.requireActual('quasar/dist/quasar.umd.prod.js')
  const page = mount(Panel, {
    global: {
      plugins: [pinia, Quasar],
      mocks: { $t: (key: string) => key },
    },
  })
  try {
    await flushPromises()
    for (const [status, color, textColor] of [
      ['granted', 'positive', 'white'],
      ['not-granted', 'warning', 'dark'],
      ['unsupported', 'grey-6', 'white'],
      ['unknown', 'grey-5', 'white'],
      ['not-granted', 'warning', 'dark'],
    ] as const) {
      storage.status = status
      await flushPromises()
      const chip = page.findComponent({ name: 'QChip' })
      expect(chip.props('color')).toBe(color)
      expect(chip.props('textColor')).toBe(textColor)
      expect(chip.classes()).toContain(`bg-${color}`)
      expect(chip.classes()).toContain(`text-${textColor}`)
    }
  } finally {
    page.unmount()
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    })
  }
})
