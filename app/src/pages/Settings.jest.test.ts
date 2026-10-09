/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createRouter, createWebHashHistory, Router } from 'vue-router'

const mockAccountStatus = {
  status: 'ready',
  revision: 1,
  account: {
    descriptor: 'frankdesc1testdescriptor',
    fingerprint: 'abcd1234',
  },
}
const mockAccountSession = {
  state: mockAccountStatus,
  backupCodex32: jest.fn(async () => ['share1', 'share2', 'share3']),
}
jest.mock('src/accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: mockAccountSession,
}))

import { defaultEmailGatewayAddress } from 'src/utils/constants'

// See navigate-back.jest.test.ts: vue-router 5's ESM-only dev-only dependencies.
// The panel's own behaviour is covered by its test; Settings only mounts it.
jest.mock('../utils/monad-identity-session', () => ({
  messagingState: { status: 'pending', reason: null, participants: {} },
  exportPublicIdentity: jest.fn(),
  refreshMessaging: jest.fn(),
}))
jest.mock(
  require.resolve('@vue/devtools-api', {
    paths: [require.resolve('vue-router')],
  }),
  () => ({ setupDevtoolsPlugin: () => undefined }),
)
jest.mock('nostics', () => ({
  createConsoleReporter: () => ({}),
  defineDiagnostics: () => new Proxy({}, { get: () => () => undefined }),
}))
const mockApplyTheme = jest.fn()
jest.mock('src/utils/theme', () => {
  const actual = jest.requireActual('src/utils/theme')
  return {
    ...actual,
    applyTheme: (...args: any[]) => mockApplyTheme(...args),
  }
})
jest.mock('pinia', () => ({
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
const mockSetTheme = jest.fn((theme: string) => {
  mockAppearanceStore.theme = theme
})
const mockSetDarkMode = jest.fn((darkMode: boolean) => {
  mockAppearanceStore.darkMode = darkMode
})
const mockAppearanceStore = jest.requireActual('vue').reactive({
  darkMode: false,
  locale: 'en-us',
  theme: 'carnelian',
  setDarkMode: mockSetDarkMode,
  setTheme: mockSetTheme,
})
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () => mockAppearanceStore,
}))
jest.mock('src/stores/contacts', () => ({
  useContactStore: () =>
    jest.requireActual('vue').reactive({ updateInterval: 60_000 }),
}))
const mockSetEmailGatewayAddress = jest.fn((address: string) => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `Invalid Ethereum address: "${address}". Expected format: 0x followed by 40 hex characters.`,
    )
  }
  mockSettingsStore.emailGatewayAddress = address
})
const mockResetEmailGatewayAddress = jest.fn(() => {
  mockSettingsStore.emailGatewayAddress = defaultEmailGatewayAddress
})
const mockSetNetworkMode = jest.fn((mode: 'testnet' | 'mainnet') => {
  mockSettingsStore.networkMode = mode
})
const mockSettingsStore = jest.requireActual('vue').reactive({
  emailGatewayAddress: defaultEmailGatewayAddress,
  networkMode: 'testnet',
  setEmailGatewayAddress: mockSetEmailGatewayAddress,
  resetEmailGatewayAddress: mockResetEmailGatewayAddress,
  setNetworkMode: mockSetNetworkMode,
})
jest.mock('src/stores/settings', () => ({
  useSettingsStore: () => mockSettingsStore,
}))
jest.mock('src/components/settings/PersistentStoragePanel.vue', () => ({
  template: '<div />',
}))
jest.mock('src/utils/apply-locale', () => ({
  applyLocale: jest.fn(() => Promise.resolve()),
}))

import SettingsPage from './Settings.vue'

const Blank = { render: () => null }

async function openDirectly(hash: string): Promise<Router> {
  // Entries from before the SPA (new-tab page, previous site) make history.length > 1 while the
  // app has no earlier route of its own -- the case from ticket #275.
  window.history.pushState(null, '', '#/before-the-app')
  window.history.pushState(null, '', hash)
  const router = createRouter({
    history: createWebHashHistory(),
    routes: ['/', '/forum', '/settings'].map(path => ({
      path,
      component: Blank,
    })),
  })
  await router.push(hash.slice(1))
  await router.isReady()
  return router
}

async function waitForPath(router: Router, path: string) {
  for (let i = 0; i < 50 && router.currentRoute.value.path !== path; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return router.currentRoute.value.path
}

function mountSettings(
  router: Router,
  qMocks: Record<string, any> = {},
  renderNetworks = false,
) {
  return shallowMount(SettingsPage, {
    global: {
      stubs: {
        ...(renderNetworks
          ? Object.fromEntries(
              [
                'q-page-container',
                'q-page',
                'q-card',
                'q-tab-panels',
                'q-tab-panel',
                'q-list',
                'q-item',
                'q-item-section',
                'q-item-label',
              ].map(name => [name, { template: '<div><slot /></div>' }]),
            )
          : {}),
        QSplitter: {
          template: '<div><slot name="before" /><slot name="after" /></div>',
        },
        QInput: {
          props: ['modelValue', 'error', 'errorMessage'],
          emits: ['update:modelValue'],
          methods: { focus: jest.fn() },
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
      mocks: {
        $t: (key: string) => key,
        $q: { dark: { set: jest.fn() }, notify: jest.fn(), ...qMocks },
        $i18n: { locale: 'en-us' },
        $router: router,
      },
    },
  })
}

type SettingsVm = { save: () => void; cancel: () => void }

describe('Settings Save/Cancel navigation (ticket #275 / #1001)', () => {
  beforeEach(() => {
    mockApplyTheme.mockClear()
    mockSetTheme.mockClear()
    mockSetDarkMode.mockClear()
    mockAppearanceStore.darkMode = false
    mockAppearanceStore.locale = 'en-us'
    mockAppearanceStore.theme = 'carnelian'
  })

  it('cancel stays inside the app when Settings was opened directly', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(await waitForPath(router, '/')).toBe('/')
    expect(window.location.hash).toBe('#/')
  })

  it('cancel returns to the previous in-app route when there is one', async () => {
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(await waitForPath(router, '/forum')).toBe('/forum')
  })

  it('save commits settings and stays on settings page with notification feedback (#1001)', async () => {
    const notifyMock = jest.fn()
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router, { notify: notifyMock })

    ;(wrapper.vm as unknown as SettingsVm).save()

    // Must stay on /settings without abruptly kicking the user back to /forum
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'positive',
        message: 'settings.savedNotification',
      }),
    )
  })
})

describe('Settings Signet Theme Live Preview and Persistence (#1041)', () => {
  beforeEach(() => {
    mockApplyTheme.mockClear()
    mockSetTheme.mockClear()
    mockSetDarkMode.mockClear()
    mockAppearanceStore.darkMode = false
    mockAppearanceStore.locale = 'en-us'
    mockAppearanceStore.theme = 'carnelian'
  })

  it('selecting a theme stone applies live preview immediately', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('lapis')

    expect((wrapper.vm as any).theme).toBe('lapis')
    expect(mockApplyTheme).toHaveBeenCalledWith('lapis', false)
  })

  it('onSelectTheme also updates theme and applies live preview', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).onSelectTheme('bloodstone')

    expect((wrapper.vm as any).theme).toBe('bloodstone')
    expect(mockApplyTheme).toHaveBeenCalledWith('bloodstone', false)
  })

  it('cancel reverts the previewed theme to the store theme and navigates back', async () => {
    const router = await openDirectly('#/forum')
    await router.push('/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('bloodstone')
    expect(mockApplyTheme).toHaveBeenCalledWith('bloodstone', false)
    ;(wrapper.vm as unknown as SettingsVm).cancel()

    expect(mockApplyTheme).toHaveBeenLastCalledWith('carnelian', false)
    expect(await waitForPath(router, '/forum')).toBe('/forum')
  })

  it('unmounting without saving reverts the previewed theme to the store theme', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    ;(wrapper.vm as any).selectTheme('onyx')
    expect(mockApplyTheme).toHaveBeenCalledWith('onyx', false)

    wrapper.unmount()

    expect(mockApplyTheme).toHaveBeenLastCalledWith('carnelian', false)
  })

  it('save calls appearanceStore.setTheme and appearanceStore.setDarkMode, applies theme, and stays on settings', async () => {
    const notifyMock = jest.fn()
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router, { notify: notifyMock })

    ;(wrapper.vm as any).selectTheme('sardonyx')
    ;(wrapper.vm as any).darkMode = true
    ;(wrapper.vm as unknown as SettingsVm).save()

    expect(mockSetTheme).toHaveBeenCalledWith('sardonyx')
    expect(mockSetDarkMode).toHaveBeenCalledWith(true)
    expect(mockApplyTheme).toHaveBeenCalledWith('sardonyx', true)
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'positive',
        message: 'settings.savedNotification',
      }),
    )

    // Unmounting after save must not revert to old carnelian theme
    mockApplyTheme.mockClear()
    wrapper.unmount()
    expect(mockApplyTheme).not.toHaveBeenCalled()
  })
})

describe('Settings header (ticket #369)', () => {
  it('has a title and a labelled Back control that leaves Settings like Cancel does', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)

    expect(wrapper.find('q-toolbar-title').text()).toBe('settings.title')
    const back = wrapper.find('[data-test="settings-back"]')
    expect(back.attributes('aria-label')).toBe('settings.back')

    await back.trigger('click')

    expect(await waitForPath(router, '/')).toBe('/')
  })

  it('has a labelled menu control that asks the layout to toggle the drawer', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const menu = wrapper.find('[data-test="settings-menu"]')
    expect(menu.attributes('aria-label')).toBe('settings.openMenu')

    await menu.trigger('click')

    expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
  })
})

it('has no directory installation controls and retains storage controls', async () => {
  const router = await openDirectly('#/settings')
  const wrapper = mountSettings(router)
  expect(wrapper.find('persistent-storage-panel-stub').exists()).toBe(true)
  expect(wrapper.find('directory-provisioning-panel-stub').exists()).toBe(false)
  expect(wrapper.html()).not.toMatch(/directory/i)
  expect(wrapper.find('[data-test="settings-back"]').exists()).toBe(true)
})

it('does not contain account recovery tab, backup button, or descriptor', async () => {
  const router = await openDirectly('#/settings')
  const wrapper = mountSettings(router)
  expect(wrapper.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="backup-codex32-button"]').exists()).toBe(
    false,
  )
  expect(wrapper.text()).not.toContain('accountRecovery.frank_account_recovery')
})

describe('Settings Gateways Tab and Email Gateway Configuration (#1133)', () => {
  beforeEach(() => {
    mockSetEmailGatewayAddress.mockClear()
    mockResetEmailGatewayAddress.mockClear()
    mockSettingsStore.emailGatewayAddress = defaultEmailGatewayAddress
  })

  it('renders the gateways tab with proper icon and data-test attribute', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const tab = wrapper.find('[data-test="settings-tab-gateways"]')
    expect(tab.exists()).toBe(true)
    expect(tab.attributes('icon')).toBe('alt_route')
    expect(tab.attributes('name')).toBe('gateways')
    wrapper.unmount()
  })

  it('initializes input with defaultEmailGatewayAddress from settings store', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const input = wrapper.find('[data-test="email-gateway-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe(
      defaultEmailGatewayAddress,
    )
    wrapper.unmount()
  })

  it('saves a valid new Ethereum hex gateway address to settings store', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const validAddress = '0x1234567890123456789012345678901234567890'

    const input = wrapper.find('[data-test="email-gateway-input"]')
    await input.setValue(validAddress)

    const saveBtn = wrapper.find('[data-test="save-email-gateway-btn"]')
    expect(saveBtn.exists()).toBe(true)
    await saveBtn.trigger('click')

    expect(mockSetEmailGatewayAddress).toHaveBeenCalledWith(validAddress)
    expect(mockSettingsStore.emailGatewayAddress).toBe(validAddress)
    expect((wrapper.vm as any).emailGatewayError).toBe('')
    wrapper.unmount()
  })

  it('displays error message and does not update store when address is invalid', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const originalAddress = mockSettingsStore.emailGatewayAddress

    const input = wrapper.find('[data-test="email-gateway-input"]')
    await input.setValue('0xinvalid')

    const saveBtn = wrapper.find('[data-test="save-email-gateway-btn"]')
    await saveBtn.trigger('click')

    expect(mockSettingsStore.emailGatewayAddress).toBe(originalAddress)
    expect((wrapper.vm as any).emailGatewayError).toBeTruthy()
    expect(wrapper.find('[data-test="email-gateway-error"]').text()).toContain(
      'Invalid Ethereum address',
    )
    wrapper.unmount()
  })

  it('resets email gateway address to default when reset button is clicked', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const customAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    mockSettingsStore.emailGatewayAddress = customAddr
    ;(wrapper.vm as any).emailGatewayInput = customAddr
    await wrapper.vm.$nextTick()

    const resetBtn = wrapper.find('[data-test="reset-email-gateway-btn"]')
    expect(resetBtn.exists()).toBe(true)
    await resetBtn.trigger('click')

    expect(mockResetEmailGatewayAddress).toHaveBeenCalled()
    expect(mockSettingsStore.emailGatewayAddress).toBe(
      defaultEmailGatewayAddress,
    )
    expect((wrapper.vm as any).emailGatewayInput).toBe(
      defaultEmailGatewayAddress,
    )
    wrapper.unmount()
  })

  it('updates input value when store address changes', async () => {
    const router = await openDirectly('#/settings')
    const wrapper = mountSettings(router)
    const newAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    mockSettingsStore.emailGatewayAddress = newAddress
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).emailGatewayInput).toBe(newAddress)
    const input = wrapper.find('[data-test="email-gateway-input"]')
    expect((input.element as HTMLInputElement).value).toBe(newAddress)
    wrapper.unmount()
  })

  describe('Network Environment & Chains Section', () => {
    it('renders the testnet mode toggle and allows switching to mainnet', async () => {
      mockSettingsStore.networkMode = 'testnet'
      const router = await openDirectly('#/settings')
      const wrapper = mountSettings(router)

      expect((wrapper.vm as any).isTestnetMode).toBe(true)
      const toggle = wrapper.find('[data-test="testnet-mode-toggle"]')
      expect(toggle.exists()).toBe(true)
      expect(toggle.attributes('disable')).toBeUndefined()

      // Toggle off to mainnet
      ;(wrapper.vm as any).isTestnetMode = false
      expect(mockSettingsStore.networkMode).toBe('mainnet')
      expect(mockSetNetworkMode).toHaveBeenCalledWith('mainnet')

      // Toggle back to testnet
      ;(wrapper.vm as any).isTestnetMode = true
      expect(mockSettingsStore.networkMode).toBe('testnet')
      expect(mockSetNetworkMode).toHaveBeenCalledWith('testnet')

      wrapper.unmount()
    })

    it.each([
      ['testnet', 'Solana Devnet', 'walletPanel.monadTestnet'],
      ['mainnet', 'Solana', 'walletPanel.monad'],
    ])(
      'shows configured settlement captions in %s mode',
      async (mode, solanaName, monadKey) => {
        mockSettingsStore.networkMode = mode
        const router = await openDirectly('#/settings')
        const wrapper = mountSettings(router, {}, true)
        const captions = wrapper
          .findAll('[caption]')
          .map(caption => caption.text())
        expect(captions).toContain(solanaName)
        expect(captions).toContain(monadKey)
        wrapper.unmount()
      },
    )

    it('renders the supported settlement networks list', async () => {
      const router = await openDirectly('#/settings')
      const wrapper = mountSettings(router)

      const supported = (wrapper.vm as any).supportedChains
      expect(supported).toBeDefined()
      expect(supported.length).toBeGreaterThanOrEqual(9)
      const chainIds = supported.map((c: any) => c.id)
      expect(chainIds).toContain('monad')
      expect(chainIds).toContain('bitcoin')
      expect(chainIds).toContain('bitcoincash')
      expect(chainIds).toContain('dogecoin')
      expect(chainIds).toContain('ecash')
      expect(chainIds).toContain('solana')
      expect(chainIds).toContain('tempo')
      expect(chainIds).toContain('ethereum')
      expect(chainIds).toContain('hyperliquid')

      wrapper.unmount()
    })
  })
})
