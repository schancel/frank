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

const mockRouterPush = jest.fn()
const mockRouterReplace = jest.fn()
let mockCurrentPath = '/forum'
jest.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    currentRoute: { value: { path: mockCurrentPath } },
  }),
}))

let mockWidth = 1024
jest.mock('quasar', () => ({
  useQuasar: () => ({ screen: { width: mockWidth } }),
}))

import SettingsPanel from './SettingsPanel.vue'
import { useSettingsStore } from 'src/stores/settings'
import { defaultEmailGatewayAddress } from 'src/utils/constants'

describe('SettingsPanel wallet-action split (#399)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockLegacyFlag = undefined
    mockRouterPush.mockReset()
    mockRouterReplace.mockReset()
    mockCurrentPath = '/forum'
    mockWidth = 1024
  })

  function mountPanel() {
    const router = {
      push: mockRouterPush,
      replace: mockRouterReplace,
      currentRoute: { value: { path: mockCurrentPath } },
    }
    const wrapper = shallowMount(SettingsPanel, {
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback || key,
          $router: router,
        },
        stubs: {
          QDialog: true,
          Codex32BackupDialog: true,
          QScrollArea: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<button v-bind="$attrs"><slot /></button>' },
          QItemLabel: { template: '<span><slot /></span>' },
          QIcon: true,
          QItemSection: { template: '<div><slot /></div>' },
          QSeparator: true,
          QInput: {
            props: ['modelValue', 'error', 'errorMessage'],
            emits: ['update:modelValue'],
            template:
              '<input v-bind="$attrs" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
          QBtn: {
            props: ['label'],
            emits: ['click'],
            template:
              '<button v-bind="$attrs" @click="$emit(\'click\', $event)"><slot>{{ label }}</slot></button>',
          },
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

  it('navigates to settings and profile via openPage', async () => {
    const { wrapper } = mountPanel()
    const settingsBtn = wrapper
      .findAll('button')
      .find(b => b.text() === 'SettingPanel.settings')
    expect(settingsBtn).toBeDefined()
    await settingsBtn!.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/settings')

    const profileBtn = wrapper
      .findAll('button')
      .find(b => b.text() === 'SettingPanel.profile')
    expect(profileBtn).toBeDefined()
    await profileBtn!.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/profile')
    wrapper.unmount()
  })

  it('emits closeDrawer on narrow screen when navigating', async () => {
    mockWidth = 390
    const { wrapper } = mountPanel()
    const settingsBtn = wrapper
      .findAll('button')
      .find(b => b.text() === 'SettingPanel.settings')
    await settingsBtn!.trigger('click')
    expect(wrapper.emitted('closeDrawer')).toHaveLength(1)
    wrapper.unmount()
  })

  it('does not emit closeDrawer on desktop when navigating', async () => {
    mockWidth = 1024
    const { wrapper } = mountPanel()
    const settingsBtn = wrapper
      .findAll('button')
      .find(b => b.text() === 'SettingPanel.settings')
    await settingsBtn!.trigger('click')
    expect(wrapper.emitted('closeDrawer')).toBeUndefined()
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

  it('renders prominent Codex32 backup button and navigates to /backup', async () => {
    const { wrapper } = mountPanel()
    const backupBtn = wrapper.find('[data-test="backup-codex32-button"]')
    expect(backupBtn.exists()).toBe(true)
    expect(backupBtn.text()).toContain('accountRecovery.backup_account_codex32')

    await backupBtn.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/backup')
    wrapper.unmount()
  })

  describe('User-Configurable Email Gateway Address', () => {
    it('initializes input with defaultEmailGatewayAddress from settings store', () => {
      const { wrapper } = mountPanel()
      const input = wrapper.find('[data-test="email-gateway-input"]')
      expect(input.exists()).toBe(true)
      expect((input.element as HTMLInputElement).value).toBe(
        defaultEmailGatewayAddress,
      )
      wrapper.unmount()
    })

    it('saves a valid new Ethereum hex gateway address to settings store', async () => {
      const { wrapper } = mountPanel()
      const settingsStore = useSettingsStore()
      const validAddress = '0x1234567890123456789012345678901234567890'

      const input = wrapper.find('[data-test="email-gateway-input"]')
      await input.setValue(validAddress)

      const saveBtn = wrapper.find('[data-test="save-email-gateway-btn"]')
      expect(saveBtn.exists()).toBe(true)
      await saveBtn.trigger('click')

      expect(settingsStore.emailGatewayAddress).toBe(validAddress)
      expect((wrapper.vm as any).emailGatewayError).toBe('')
      wrapper.unmount()
    })

    it('displays error message and does not update store when address is invalid', async () => {
      const { wrapper } = mountPanel()
      const settingsStore = useSettingsStore()
      const originalAddress = settingsStore.emailGatewayAddress

      const input = wrapper.find('[data-test="email-gateway-input"]')
      await input.setValue('0xinvalid')

      const saveBtn = wrapper.find('[data-test="save-email-gateway-btn"]')
      await saveBtn.trigger('click')

      expect(settingsStore.emailGatewayAddress).toBe(originalAddress)
      expect((wrapper.vm as any).emailGatewayError).toBeTruthy()
      expect(
        wrapper.find('[data-test="email-gateway-error"]').text(),
      ).toContain('Invalid Ethereum address')
      wrapper.unmount()
    })

    it('resets email gateway address to default when reset button is clicked', async () => {
      const { wrapper } = mountPanel()
      const settingsStore = useSettingsStore()
      const customAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      settingsStore.setEmailGatewayAddress(customAddr)

      const input = wrapper.find('[data-test="email-gateway-input"]')
      await input.setValue(customAddr)
      await wrapper
        .find('[data-test="save-email-gateway-btn"]')
        .trigger('click')
      expect(settingsStore.emailGatewayAddress).toBe(customAddr)

      const resetBtn = wrapper.find('[data-test="reset-email-gateway-btn"]')
      expect(resetBtn.exists()).toBe(true)
      await resetBtn.trigger('click')

      expect(settingsStore.emailGatewayAddress).toBe(defaultEmailGatewayAddress)
      expect((input.element as HTMLInputElement).value).toBe(
        defaultEmailGatewayAddress,
      )
      wrapper.unmount()
    })
  })
})
