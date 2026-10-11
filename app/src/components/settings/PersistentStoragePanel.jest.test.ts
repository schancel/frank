/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from './PersistentStoragePanel.vue'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'
import { usePersistentStorageStore } from '../../stores/persistent-storage'
jest.mock('../../accounts/session', () => ({
  accountStatus: { account: { descriptor: 'public' } },
}))
const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)
test('storage persistence is separate from backup proof and exposes an explicit request', async () => {
  setActivePinia(createPinia())
  const persist = jest.fn(async () => true)
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { persisted: async () => false, persist },
  })
  const view = mount(Panel, {
    global: {
      mocks: { $t: t },
      stubs: {
        QBtn: { props: ['label'], template: '<button>{{label}}</button>' },
      },
    },
  })
  await flushPromises()
  expect(view.get('[data-test="persistent-storage-chip"]').text()).toBe(
    en.persistentStorage.notGranted,
  )
  expect(view.text()).not.toContain('not-granted')
  expect(view.find('[data-test="status-raw"]').exists()).toBe(false)
  expect(view.text()).toContain('Keep an independent backup')
  expect(view.text()).not.toContain('verified before activation')
  await view.get('button').trigger('click')
  await flushPromises()
  expect(persist).toHaveBeenCalledTimes(1)
  expect(view.get('[data-test="persistent-storage-chip"]').text()).toBe(
    en.persistentStorage.granted,
  )
})

test.each(['en', 'fr'] as const)(
  'announces each human-readable storage status once (%s)',
  async locale => {
    setActivePinia(createPinia())
    const store = usePersistentStorageStore()
    jest.spyOn(store, 'refresh').mockResolvedValue()
    const messages = locale === 'fr' ? fr : en
    const view = mount(Panel, {
      global: {
        mocks: {
          $t: (key: string) =>
            key.split('.').reduce((value: any, part) => value[part], messages),
        },
      },
    })
    for (const [status, label] of [
      ['granted', messages.persistentStorage.granted],
      ['not-granted', messages.persistentStorage.notGranted],
      ['unsupported', messages.persistentStorage.unsupported],
      ['unknown', messages.persistentStorage.unknown],
    ] as const) {
      store.status = status
      await flushPromises()
      const chip = view.get('[data-test="persistent-storage-chip"]')
      expect(chip.text()).toBe(label)
      expect(chip.attributes('role')).toBe('status')
      expect(chip.attributes('aria-live')).toBe('polite')
      expect(view.text().split(label)).toHaveLength(2)
      expect(view.find('[data-test="status-raw"]').exists()).toBe(false)
    }
    view.unmount()
  },
)
