/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

jest.mock('../../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(() =>
    Promise.resolve({ identity: { displayAddress: '0x0' } }),
  ),
}))
jest.mock('./ContactCard.vue', () => ({ template: '<div />' }))

import SettingsPanel from './SettingsPanel.vue'

describe('SettingsPanel wallet-action split (#399)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('keeps settings controls but no longer owns wallet actions or recovery reveal', () => {
    const wrapper = shallowMount(SettingsPanel, {
      global: {
        mocks: { $t: (key: string) => key, $router: { push: jest.fn() } },
        stubs: {
          QDialog: true,
          QScrollArea: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<div><slot /></div>' },
          QIcon: true,
          QItemSection: { template: '<div><slot /></div>' },
          QSeparator: true,
        },
        directives: { ripple: {} },
      },
    })

    expect(wrapper.text()).toContain('SettingPanel.profile')
    expect(wrapper.text()).toContain('SettingPanel.settings')
    expect(wrapper.text()).not.toContain('SettingPanel.sendMonad')
    expect(wrapper.text()).not.toContain('SettingPanel.receiveMonad')
    expect(wrapper.text()).not.toContain('SettingPanel.showSeed')
    expect(wrapper.text()).not.toContain('SettingPanel.newContact')
    expect(wrapper.text()).not.toContain('SettingPanel.contacts')
  })
})
