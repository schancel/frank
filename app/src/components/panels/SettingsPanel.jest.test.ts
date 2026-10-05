/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { legacyLotusModeForFlag } from 'src/utils/legacy-mode'

let mockLegacyFlag: string | undefined
jest.mock('src/utils/runtime-mode', () => ({
  legacyLotusModeEnabled: () => legacyLotusModeForFlag(mockLegacyFlag),
}))

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
  beforeEach(() => {
    setActivePinia(createPinia())
    mockLegacyFlag = undefined
  })

  function mountPanel() {
    const router = {
      push: jest.fn(),
      replace: jest.fn(),
      currentRoute: { value: { path: '/forum' } },
    }
    const wrapper = shallowMount(SettingsPanel, {
      global: {
        mocks: { $t: (key: string) => key, $router: router },
        stubs: {
          QDialog: true,
          QScrollArea: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<button><slot /></button>' },
          QItemLabel: { template: '<span><slot /></span>' },
          QIcon: true,
          QItemSection: { template: '<div><slot /></div>' },
          QSeparator: true,
        },
        directives: { ripple: {} },
      },
    })
    return { wrapper, router }
  }

  it('keeps settings controls but no longer owns wallet actions or recovery reveal', () => {
    const { wrapper } = mountPanel()
    expect(wrapper.text()).toContain('SettingPanel.profile')
    expect(wrapper.text()).toContain('SettingPanel.settings')
    expect(wrapper.text()).not.toContain('SettingPanel.sendMonad')
    expect(wrapper.text()).not.toContain('SettingPanel.receiveMonad')
    expect(wrapper.text()).not.toContain('SettingPanel.showSeed')
    expect(wrapper.text()).not.toContain('SettingPanel.newContact')
    expect(wrapper.text()).not.toContain('SettingPanel.contacts')
    wrapper.unmount()
  })

  it('does not offer legacy relay deletion in default Monad settings', () => {
    const { wrapper, router } = mountPanel()
    expect(wrapper.text()).not.toContain('SettingPanel.wipeAndSave')
    expect(router.push).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('opens the legacy confirmation route only in explicit Lotus mode', async () => {
    mockLegacyFlag = 'false'
    const { wrapper, router } = mountPanel()
    const action = wrapper
      .findAll('button')
      .find(button => button.text() === 'SettingPanel.wipeAndSave')
    expect(action).toBeDefined()
    await action!.trigger('click')
    expect(router.push).toHaveBeenCalledWith('/wipe-wallet')
    wrapper.unmount()
  })

  it('renders standard 50px settings header', () => {
    const { wrapper } = mountPanel()
    expect(wrapper.text()).toContain('leftDrawer.settings')
    wrapper.unmount()
  })
})
