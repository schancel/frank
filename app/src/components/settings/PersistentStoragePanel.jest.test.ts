/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from './PersistentStoragePanel.vue'
import en from '../../i18n/en-us'
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
  expect(view.text()).toContain('not-granted')
  expect(view.text()).toContain('cannot be reconstructed')
  await view.get('button').trigger('click')
  await flushPromises()
  expect(persist).toHaveBeenCalledTimes(1)
  expect(view.text()).toContain('granted')
})
