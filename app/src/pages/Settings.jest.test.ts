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

// See navigate-back.jest.test.ts: vue-router 5's ESM-only dev-only dependencies.
// The panel's own behaviour is covered by its test; Settings only mounts it.
jest.mock('../utils/identity-session', () => ({
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
  // The real settings module is loaded for its pure address helpers; its store is replaced below.
  defineStore: () => () => undefined,
  storeToRefs: (store: object) => jest.requireActual('vue').toRefs(store),
}))
const mockSetTheme = jest.fn((theme: string) => {
  mockAppearanceStore.theme = theme
})
const mockSetDarkMode = jest.fn((darkMode: boolean) => {
  mockAppearanceStore.darkMode = darkMode
})
const mockSetUiScale = jest.fn((uiScale: unknown) => {
  mockAppearanceStore.uiScale = uiScale
})
const mockAppearanceStore = jest.requireActual('vue').reactive({
  darkMode: false,
  locale: 'en-us',
  theme: 'carnelian',
  uiScale: 'auto' as unknown,
  setDarkMode: mockSetDarkMode,
  setTheme: mockSetTheme,
  setUiScale: mockSetUiScale,
})
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () => mockAppearanceStore,
}))
const mockContactStore = jest.requireActual('vue').reactive({
  updateInterval: 60_000,
})
jest.mock('src/stores/contacts', () => ({
  useContactStore: () => mockContactStore,
}))
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ profile: { name: 'Ada', avatar: '' } }),
}))
jest.mock('src/utils/own-address', () => ({
  useReactiveOwnCanonicalAddress: () =>
    jest.requireActual('vue').ref('0x1111111111111111111111111111111111111111'),
}))
const mockSyncRelayNotificationPolicy = jest.fn((_policy: unknown) =>
  Promise.resolve(),
)
jest.mock('src/utils/webpush-sync', () => ({
  syncRelayNotificationPolicy: (policy: unknown) =>
    mockSyncRelayNotificationPolicy(policy),
}))
const mockSetEmailGatewayAddress = jest.fn((address: string) => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `Invalid Ethereum address: "${address}". Expected format: 0x followed by 40 hex characters.`,
    )
  }
  mockSettingsStore.emailGatewayAddress = address
  mockSettingsStore.emailGatewayOverride = {
    address,
  }
})
const mockResetEmailGatewayAddress = jest.fn(() => {
  mockSettingsStore.emailGatewayAddress = ''
  mockSettingsStore.emailGatewayOverride = null
})
const mockClearEmailGatewayOverride = jest.fn(() => {
  mockSettingsStore.emailGatewayOverride = null
})
const mockAcceptAdvertisedEmailGateway = jest.fn(() => {
  mockSettingsStore.emailGatewayStatus = 'ready'
  mockSettingsStore.emailGatewayOverride = null
})
const mockSetNotificationFeeThresholdAvu = jest.fn((val: number | string) => {
  mockSettingsStore.notificationFeeThresholdAvu = Math.max(0, Number(val) || 0)
})
const mockSetAllowContactNotificationBypass = jest.fn((allow: boolean) => {
  mockSettingsStore.allowContactNotificationBypass = Boolean(allow)
})
const mockSetColdVaultSweep = jest.fn(
  (input: {
    enabled?: boolean
    externalVaultAddress?: string
    maxHotBalanceDisplay?: string
  }) => {
    const enabled = input.enabled ?? mockSettingsStore.coldVaultSweep.enabled
    const externalVaultAddress = (
      input.externalVaultAddress ??
      mockSettingsStore.coldVaultSweep.externalVaultAddress
    ).trim()
    const maxHotBalanceDisplay = (
      input.maxHotBalanceDisplay ??
      mockSettingsStore.coldVaultSweep.maxHotBalanceDisplay
    ).trim()
    if (enabled && !externalVaultAddress) {
      throw new Error(
        'External vault address is required when Cold-Wallet Auto-Sweep is enabled.',
      )
    }
    if (
      externalVaultAddress &&
      !/^0x[a-fA-F0-9]{40}$/.test(externalVaultAddress) &&
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(externalVaultAddress)
    ) {
      throw new Error(
        `Invalid external vault address: "${externalVaultAddress}"`,
      )
    }
    mockSettingsStore.coldVaultSweep = {
      enabled,
      externalVaultAddress,
      maxHotBalanceDisplay,
    }
  },
)
const mockResetColdVaultSweep = jest.fn(() => {
  mockSettingsStore.coldVaultSweep = {
    enabled: false,
    externalVaultAddress: '',
    maxHotBalanceDisplay: '1500',
  }
})
const mockSettingsStore = jest.requireActual('vue').reactive({
  emailGatewayAddress: '',
  emailGatewayOverride: null as {
    address: string
  } | null,
  advertisedEmailGateway: null,
  emailGatewayStatus: 'unavailable',
  notificationFeeThresholdAvu: 0,
  allowContactNotificationBypass: true,
  coldVaultSweep: {
    enabled: false,
    externalVaultAddress: '',
    maxHotBalanceDisplay: '1500',
  },
  setEmailGatewayAddress: mockSetEmailGatewayAddress,
  resetEmailGatewayAddress: mockResetEmailGatewayAddress,
  acceptAdvertisedEmailGateway: mockAcceptAdvertisedEmailGateway,
  clearEmailGatewayOverride: mockClearEmailGatewayOverride,
  setNotificationFeeThresholdAvu: mockSetNotificationFeeThresholdAvu,
  setAllowContactNotificationBypass: mockSetAllowContactNotificationBypass,
  setColdVaultSweep: mockSetColdVaultSweep,
  resetColdVaultSweep: mockResetColdVaultSweep,
})
jest.mock('src/stores/settings', () => ({
  externalVaultAddressChain: jest.requireActual('src/stores/settings')
    .externalVaultAddressChain,
  useSettingsStore: () => mockSettingsStore,
}))
jest.mock('src/components/settings/PersistentStoragePanel.vue', () => ({
  template: '<div />',
}))
const mockApplyLocale = jest.fn((_options: unknown) => Promise.resolve())
jest.mock('src/utils/apply-locale', () => ({
  applyLocale: (options: unknown) => mockApplyLocale(options),
}))

import SettingsPage from './Settings.vue'

const Blank = { render: () => null }

async function openAt(path: string): Promise<Router> {
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      ...['/', '/forum', '/profile', '/backup', '/docs'].map(p => ({
        path: p,
        component: Blank,
      })),
      { path: '/settings/:section?', component: Blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  return router
}

const NARROW = { screen: { width: 375 } }
const WIDE = { screen: { width: 1280 } }

function mountSettings(
  router: Router,
  qMocks: Record<string, any> = WIDE,
  renderSections = false,
) {
  return shallowMount(SettingsPage, {
    global: {
      stubs: {
        ...(renderSections
          ? Object.fromEntries(
              [
                'q-page-container',
                'q-page',
                'q-list',
                'q-item',
                'q-item-section',
                'q-item-label',
              ].map(name => [name, { template: '<div><slot /></div>' }]),
            )
          : {}),
        QItem: {
          emits: ['click'],
          template:
            '<div v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></div>',
        },
        QInput: {
          props: ['modelValue', 'error', 'errorMessage'],
          emits: ['update:modelValue'],
          template:
            '<input v-bind="$attrs" :value="modelValue" :data-error-message="errorMessage" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QToggle: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template:
            '<input type="checkbox" v-bind="$attrs" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
        },
        QDialog: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<div v-if="modelValue" v-bind="$attrs"><slot /></div>',
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

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function settle(router: Router) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await router.isReady()
}

beforeEach(() => {
  mockApplyTheme.mockClear()
  mockSetTheme.mockClear()
  mockSetDarkMode.mockClear()
  mockSetUiScale.mockClear()
  mockApplyLocale.mockClear()
  mockAppearanceStore.darkMode = false
  mockAppearanceStore.locale = 'en-us'
  mockAppearanceStore.theme = 'carnelian'
  mockContactStore.updateInterval = 60_000
})

describe('Settings list and section navigation', () => {
  it('shows the grouped list with a profile row, every section, and the other pages', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router, NARROW)

    expect(wrapper.find('[data-test="settings-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="settings-row-profile"]').text()).toContain(
      'Ada',
    )
    for (const id of [
      'networking',
      'appearance',
      'notifications',
      'storage',
      'gateways',
      'backup',
      'docs',
      'changelog',
      'about',
    ]) {
      expect(wrapper.find(`[data-test="settings-row-${id}"]`).exists()).toBe(
        true,
      )
    }
    expect(
      wrapper.find('[data-test="settings-row-dapp-bridge"]').exists(),
    ).toBe(false)
    // Phone, no section chosen: the list alone, no Save/Cancel bar, no tabs.
    expect(wrapper.find('[data-test="settings-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="save-email-gateway-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('q-tabs-stub').exists()).toBe(false)
  })

  it('on a phone a section row opens the section as its own page with a back arrow', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router, NARROW)

    await wrapper.find('[data-test="settings-row-appearance"]').trigger('click')
    await settle(router)
    await wrapper.vm.$nextTick()

    expect(router.currentRoute.value.path).toBe('/settings/appearance')
    expect(wrapper.find('[data-test="settings-list"]').exists()).toBe(false)
    expect(
      wrapper.find('[data-test="settings-section"]').attributes('data-section'),
    ).toBe('appearance')
    expect(wrapper.find('[data-test="settings-title"]').text()).toBe(
      'settings.appearance',
    )
    expect(wrapper.find('[data-test="settings-menu"]').exists()).toBe(false)

    await wrapper.find('[data-test="settings-back"]').trigger('click')
    await settle(router)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('a deep link to a section opens it, and back lands on the list', async () => {
    const router = await openAt('/settings/gateways')
    const wrapper = mountSettings(router, NARROW)

    expect(
      wrapper.find('[data-test="settings-section"]').attributes('data-section'),
    ).toBe('gateways')
    await wrapper.find('[data-test="settings-back"]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('an unknown section goes back to the list', async () => {
    const router = await openAt('/settings/nope')
    mountSettings(router, NARROW)
    await settle(router)
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('on a wide layout shows the list beside the selected section (the first one by default)', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router, WIDE)

    expect(wrapper.find('[data-test="settings-list"]').exists()).toBe(true)
    expect(
      wrapper.find('[data-test="settings-section"]').attributes('data-section'),
    ).toBe('networking')

    await wrapper.find('[data-test="settings-row-storage"]').trigger('click')
    await settle(router)
    await wrapper.vm.$nextTick()
    expect(router.currentRoute.value.path).toBe('/settings/storage')
    expect(wrapper.find('[data-test="settings-list"]').exists()).toBe(true)
    expect(wrapper.find('persistent-storage-panel-stub').exists()).toBe(true)
  })

  it('rows for other pages and the profile row navigate there', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router, NARROW)

    await wrapper.find('[data-test="settings-row-backup"]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.path).toBe('/backup')

    await router.push('/settings')
    await wrapper.find('[data-test="settings-row-profile"]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.path).toBe('/profile')

    await router.push('/settings')
    await wrapper
      .find('[data-test="settings-row-identity-qr"]')
      .trigger('click')
    await settle(router)
    expect(router.currentRoute.value.fullPath).toBe('/profile?tab=identity')
  })

  it('the list header has the title and the menu control that toggles the drawer', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router, NARROW)

    expect(wrapper.find('[data-test="settings-title"]').text()).toBe(
      'settings.title',
    )
    expect(wrapper.find('[data-test="settings-back"]').exists()).toBe(false)
    const menu = wrapper.find('[data-test="settings-menu"]')
    expect(menu.attributes('aria-label')).toBe('settings.openMenu')
    await menu.trigger('click')
    expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
  })
})

describe('Settings apply immediately, without Save', () => {
  it('a theme stone, dark mode and display size are written to the store on change', async () => {
    const router = await openAt('/settings/appearance')
    const wrapper = mountSettings(router)
    const vm = wrapper.vm as any

    vm.selectTheme('lapis')
    expect(mockSetTheme).toHaveBeenCalledWith('lapis')
    expect(vm.theme).toBe('lapis')

    await wrapper.find('[data-test="dark-mode-toggle"]').setValue(true)
    expect(mockSetDarkMode).toHaveBeenCalledWith(true)
    expect(vm.darkMode).toBe(true)

    vm.selectUiScale(115)
    expect(mockSetUiScale).toHaveBeenCalledWith(115)

    // Nothing to revert on leaving: the store is the setting.
    mockApplyTheme.mockClear()
    wrapper.unmount()
    expect(mockApplyTheme).not.toHaveBeenCalled()
    expect(mockAppearanceStore.theme).toBe('lapis')
  })

  it('a language choice is stored and applied at once', async () => {
    const router = await openAt('/settings/appearance')
    const wrapper = mountSettings(router)
    ;(wrapper.vm as any).locale = 'fr-fr'
    expect(mockAppearanceStore.locale).toBe('fr-fr')
    expect(mockApplyLocale).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'fr-fr' }),
    )
  })

  it('the contact refresh interval saves once typing pauses, and an invalid value is never saved', async () => {
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router)
    const input = wrapper.find('[data-test="contact-refresh-interval-input"]')

    await input.setValue('5')
    await wait(300)
    expect(mockContactStore.updateInterval).toBe(60_000)
    await wait(400)
    expect(mockContactStore.updateInterval).toBe(5 * 60_000)

    await input.setValue('0')
    await wait(650)
    await wrapper.vm.$nextTick()
    expect(mockContactStore.updateInterval).toBe(5 * 60_000)
    expect(
      wrapper
        .find('[data-test="contact-refresh-interval-input"]')
        .attributes('data-error-message'),
    ).toBe('settings.invalidRefreshInterval')

    await input.setValue('0.5')
    await input.trigger('blur')
    expect(mockContactStore.updateInterval).toBe(5 * 60_000)
    expect((wrapper.vm as any).updateIntervalError).toBe(
      'settings.invalidRefreshInterval',
    )

    // Blur commits without waiting.
    await input.setValue('10')
    await input.trigger('blur')
    expect(mockContactStore.updateInterval).toBe(10 * 60_000)
    expect((wrapper.vm as any).updateIntervalError).toBe('')
    wrapper.unmount()
  })

  it('a pending valid edit is applied when the page is left', async () => {
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router)
    await wrapper
      .find('[data-test="contact-refresh-interval-input"]')
      .setValue('3')
    wrapper.unmount()
    expect(mockContactStore.updateInterval).toBe(3 * 60_000)
  })
})

it('has no directory installation controls and retains storage and notification controls', async () => {
  const router = await openAt('/settings/storage')
  const wrapper = mountSettings(router)
  expect(wrapper.find('persistent-storage-panel-stub').exists()).toBe(true)
  expect(
    wrapper.find('[data-test="settings-row-notifications"]').exists(),
  ).toBe(true)
  expect(wrapper.find('directory-provisioning-panel-stub').exists()).toBe(false)
  expect(wrapper.html()).not.toMatch(/directory/i)

  await router.push('/settings/notifications')
  await wrapper.vm.$nextTick()
  expect(wrapper.find('notification-permission-panel-stub').exists()).toBe(true)
})

it('does not contain account recovery tab, backup button, or descriptor', async () => {
  const router = await openAt('/settings')
  const wrapper = mountSettings(router)
  expect(wrapper.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="backup-codex32-button"]').exists()).toBe(
    false,
  )
  expect(wrapper.text()).not.toContain('accountRecovery.frank_account_recovery')
})

describe('Settings Gateways section and Email Gateway Configuration (#1133)', () => {
  beforeEach(() => {
    mockSetEmailGatewayAddress.mockClear()
    mockResetEmailGatewayAddress.mockClear()
    mockAcceptAdvertisedEmailGateway.mockClear()
    mockClearEmailGatewayOverride.mockClear()
    mockSettingsStore.emailGatewayAddress = ''
    mockSettingsStore.emailGatewayOverride = null
    mockSettingsStore.emailGatewayStatus = 'unavailable'
    mockSettingsStore.advertisedEmailGateway = null
  })

  async function openGateways() {
    const router = await openAt('/settings/gateways')
    return mountSettings(router)
  }

  it('lists the gateways section with its icon', async () => {
    const router = await openAt('/settings')
    const wrapper = mountSettings(router)
    const row = wrapper.find('[data-test="settings-row-gateways"]')
    expect(row.exists()).toBe(true)
    expect(row.html()).toContain('alt_route')
    wrapper.unmount()
  })

  it('starts without an override or compiled payment destination', async () => {
    const wrapper = await openGateways()
    const input = wrapper.find('[data-test="email-gateway-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('')
    wrapper.unmount()
  })

  it('saves a valid gateway address once typing pauses', async () => {
    const wrapper = await openGateways()
    const validAddress = '0x1234567890123456789012345678901234567890'

    await wrapper
      .find('[data-test="email-gateway-input"]')
      .setValue(validAddress)
    expect(mockSetEmailGatewayAddress).not.toHaveBeenCalled()
    await wait(650)

    expect(mockSetEmailGatewayAddress).toHaveBeenCalledWith(validAddress)
    expect(mockSettingsStore.emailGatewayAddress).toBe(validAddress)
    expect((wrapper.vm as any).emailGatewayError).toBe('')
    wrapper.unmount()
  })

  it('shows an inline error and does not update the store when the address is invalid', async () => {
    const wrapper = await openGateways()
    const input = wrapper.find('[data-test="email-gateway-input"]')
    await input.setValue('0xinvalid')
    await input.trigger('blur')

    expect(mockSettingsStore.emailGatewayAddress).toBe('')
    expect(mockSettingsStore.emailGatewayOverride).toBeNull()
    expect(wrapper.find('[data-test="email-gateway-error"]').text()).toContain(
      'Invalid Ethereum address',
    )
    wrapper.unmount()
  })

  it('clears the override when relay gateway is selected', async () => {
    const wrapper = await openGateways()
    const customAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    mockSettingsStore.emailGatewayAddress = customAddr
    mockSettingsStore.emailGatewayOverride = { address: customAddr }
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-test="reset-email-gateway-btn"]').trigger('click')

    expect(mockResetEmailGatewayAddress).toHaveBeenCalled()
    expect(mockSettingsStore.emailGatewayAddress).toBe('')
    expect((wrapper.vm as any).emailGatewayInput).toBe('')
    wrapper.unmount()
  })

  it('accepting a changed relay gateway stays on its button', async () => {
    const wrapper = await openGateways()
    const customAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    mockSettingsStore.emailGatewayOverride = { address: customAddr }
    mockSettingsStore.emailGatewayStatus = 'changed'
    await wrapper.vm.$nextTick()

    // Emptying the field drops the override but does not accept the changed gateway.
    await wrapper.find('[data-test="email-gateway-input"]').setValue('')
    await wait(650)
    expect(mockClearEmailGatewayOverride).toHaveBeenCalled()
    expect(mockAcceptAdvertisedEmailGateway).not.toHaveBeenCalled()
    expect(mockResetEmailGatewayAddress).not.toHaveBeenCalled()

    await wrapper.find('[data-test="reset-email-gateway-btn"]').trigger('click')
    expect(mockAcceptAdvertisedEmailGateway).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('emptying the field drops the override', async () => {
    const wrapper = await openGateways()
    const customAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    mockSettingsStore.emailGatewayOverride = { address: customAddr }
    mockSettingsStore.emailGatewayStatus = 'ready'
    await wrapper.vm.$nextTick()

    const input = wrapper.find('[data-test="email-gateway-input"]')
    await input.setValue('   ')
    await input.trigger('blur')

    expect(mockClearEmailGatewayOverride).toHaveBeenCalled()
    expect((wrapper.vm as any).emailGatewayError).toBe('')
    wrapper.unmount()
  })

  it('updates input value when store address changes', async () => {
    const wrapper = await openGateways()
    const newAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    mockSettingsStore.emailGatewayOverride = { address: newAddress }
    await wrapper.vm.$nextTick()

    const input = wrapper.find('[data-test="email-gateway-input"]')
    expect((input.element as HTMLInputElement).value).toBe(newAddress)
    wrapper.unmount()
  })

  it('populates input with advertised address when relay gateway is selected', async () => {
    const wrapper = await openGateways()
    const relayAddr = '0x9999999999999999999999999999999999999999'
    mockSettingsStore.advertisedEmailGateway = {
      address: relayAddr,
      domain: 'relay.example',
    } as any
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-test="reset-email-gateway-btn"]').trigger('click')

    expect((wrapper.vm as any).emailGatewayInput).toBe(relayAddr)
    wrapper.unmount()
  })
})

describe('Network Environment & Chains Section', () => {
  it('shows the Testnet toggle on and locked, and says mainnet switching is locked', async () => {
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router, WIDE, true)

    const toggle = wrapper.get('[data-test="testnet-mode-toggle"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(toggle.attributes('disable')).toBeDefined()
    expect(wrapper.get('[data-test="mainnet-locked-hint"]').text()).toBe(
      'settings.mainnetLockedBanner',
    )
    // Nothing to call: the page has no way to change the network.
    expect((wrapper.vm as any).isTestnetMode).toBe(true)
    expect(mockSettingsStore.setNetworkMode).toBeUndefined()

    const captions = wrapper.findAll('[caption]').map(caption => caption.text())
    expect(captions).toContain('Solana Devnet')
    expect(captions).toContain('walletPanel.monadTestnet')
    wrapper.unmount()
  })

  it('renders the supported settlement networks list', async () => {
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router)

    const chainIds = (wrapper.vm as any).supportedChains.map((c: any) => c.id)
    expect(chainIds.length).toBeGreaterThanOrEqual(9)
    for (const id of [
      'monad',
      'bitcoin',
      'bitcoincash',
      'dogecoin',
      'ecash',
      'solana',
      'tempo',
      'ethereum',
      'hyperliquid',
    ]) {
      expect(chainIds).toContain(id)
    }
    wrapper.unmount()
  })

  it('does not call a network active that the app cannot use', async () => {
    mockSettingsStore.networkMode = 'testnet'
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router)
    const vm = wrapper.vm as any
    const status = Object.fromEntries(
      vm.supportedChains.map((chain: { id: string }) => [
        chain.id,
        vm.chainStatusKey(chain),
      ]),
    )
    expect(status).toEqual({
      monad: 'settings.chainSendReceive',
      solana: 'settings.chainSendReceive',
      ecash: 'settings.chainSendReceive',
      bitcoin: 'settings.chainSendReceive',
      bitcoincash: 'settings.chainSendReceive',
      dogecoin: 'settings.chainSendReceive',
      litecoin: 'settings.chainSendReceive',
      tempo: 'settings.chainSendReceive',
      ethereum: 'settings.chainSendReceive',
      bnb: 'settings.chainSendReceive',
      polygon: 'settings.chainSendReceive',
      base: 'settings.chainSendReceive',
      arbitrum: 'settings.chainSendReceive',
      hyperliquid: 'settings.chainSendReceive',
    })
    expect(vm.chainStatusKey({ id: 'unsupported-chain' })).toBe(
      'settings.chainUnsupported',
    )
    wrapper.unmount()
  })
})

describe('Notification Fee Threshold (AVU) (#1574)', () => {
  beforeEach(() => {
    mockSettingsStore.notificationFeeThresholdAvu = 0
    mockSettingsStore.allowContactNotificationBypass = true
    mockSetNotificationFeeThresholdAvu.mockClear()
    mockSetAllowContactNotificationBypass.mockClear()
    mockSyncRelayNotificationPolicy.mockClear()
  })

  it('saves a valid threshold once typing pauses and the contact bypass toggle at once', async () => {
    const router = await openAt('/settings/notifications')
    const wrapper = mountSettings(router)

    await wrapper
      .find('[data-test="notification-fee-threshold-input"]')
      .setValue('0.25')
    await wait(650)
    expect(mockSetNotificationFeeThresholdAvu).toHaveBeenCalledWith(0.25)
    expect(mockSettingsStore.notificationFeeThresholdAvu).toBe(0.25)
    // The relay hears about it when the user leaves the field, not at each pause.
    expect(mockSyncRelayNotificationPolicy).not.toHaveBeenCalled()
    await wrapper
      .find('[data-test="notification-fee-threshold-input"]')
      .trigger('blur')
    await wait(0)
    expect(mockSyncRelayNotificationPolicy).toHaveBeenCalledTimes(1)
    expect(mockSyncRelayNotificationPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ avuThreshold: 0.25 }),
    )

    await wrapper
      .find('[data-test="notification-contact-bypass-toggle"]')
      .setValue(false)
    expect(mockSetAllowContactNotificationBypass).toHaveBeenCalledWith(false)
    expect(mockSettingsStore.allowContactNotificationBypass).toBe(false)
    wrapper.unmount()
  })

  it('a negative threshold shows an error and is not saved', async () => {
    const router = await openAt('/settings/notifications')
    const wrapper = mountSettings(router)
    const input = wrapper.find('[data-test="notification-fee-threshold-input"]')
    await input.setValue('-1')
    await input.trigger('blur')

    expect(mockSetNotificationFeeThresholdAvu).not.toHaveBeenCalled()
    expect((wrapper.vm as any).notificationFeeThresholdError).toBe(
      'settings.invalidNotificationFeeThreshold',
    )
    wrapper.unmount()
  })
})

describe('Cold-Wallet Auto-Sweep Vault Section (#1572)', () => {
  beforeEach(() => {
    mockSetColdVaultSweep.mockClear()
    mockResetColdVaultSweep.mockClear()
    mockSettingsStore.coldVaultSweep = {
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '1500',
    }
  })

  async function openNetworking() {
    const router = await openAt('/settings/networking')
    return mountSettings(router)
  }

  it('renders the Cold-Wallet Auto-Sweep Vault section with default 1500 MON hot-float ceiling', async () => {
    const wrapper = await openNetworking()
    expect(
      wrapper.find('[data-test="cold-vault-sweep-section"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-test="cold-vault-sweep-title"]').text()).toBe(
      'settings.coldVaultTitle',
    )
    expect((wrapper.vm as any).coldVaultEnabled).toBe(false)
    expect((wrapper.vm as any).coldVaultAddressInput).toBe('')
    expect((wrapper.vm as any).coldVaultMaxHotBalanceInput).toBe('1500')
    wrapper.unmount()
  })

  async function confirmAddress(
    wrapper: ReturnType<typeof mountSettings>,
    address: string,
  ) {
    await wrapper
      .find('[data-test="cold-vault-address-input"]')
      .setValue(address)
    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-test="cold-vault-confirm-address"]').text(),
    ).toBe(address)
    await wrapper
      .find('[data-test="cold-vault-confirm-accept"]')
      .trigger('click')
  }

  it('saves a vault address only after the confirm dialog shows it back with its chain', async () => {
    const wrapper = await openNetworking()
    const vaultAddr = '0x8888888888888888888888888888888888888888'
    const input = wrapper.find('[data-test="cold-vault-address-input"]')

    await input.setValue(vaultAddr)
    await input.trigger('blur')
    await wait(650)
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()
    expect(
      wrapper.find('[data-test="cold-vault-address-unconfirmed"]').exists(),
    ).toBe(true)

    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-test="cold-vault-confirm-address"]').text(),
    ).toBe(vaultAddr)
    expect(wrapper.find('[data-test="cold-vault-confirm-chain"]').text()).toBe(
      'settings.coldVaultChainEvm',
    )
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()

    await wrapper
      .find('[data-test="cold-vault-confirm-accept"]')
      .trigger('click')
    expect(mockSetColdVaultSweep).toHaveBeenLastCalledWith({
      externalVaultAddress: vaultAddr,
    })
    expect(mockSettingsStore.coldVaultSweep.externalVaultAddress).toBe(
      vaultAddr,
    )
    expect(
      wrapper.find('[data-test="cold-vault-confirm-dialog"]').exists(),
    ).toBe(false)
    expect(
      wrapper.find('[data-test="cold-vault-address-use-btn"]').exists(),
    ).toBe(false)

    await wrapper.find('[data-test="cold-vault-enabled-toggle"]').setValue(true)
    expect(mockSetColdVaultSweep).toHaveBeenLastCalledWith({
      enabled: true,
      externalVaultAddress: vaultAddr,
      maxHotBalanceDisplay: '1500',
    })
    expect(mockSettingsStore.coldVaultSweep.enabled).toBe(true)
    expect((wrapper.vm as any).coldVaultError).toBe('')
    wrapper.unmount()
  })

  it('a half-pasted Solana address that is still well formed is never saved on blur or leaving', async () => {
    // The 44-character USDC mint's 43-character prefix also decodes to 32 bytes.
    const full = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const truncated = full.slice(0, 43)
    const wrapper = await openNetworking()
    const input = wrapper.find('[data-test="cold-vault-address-input"]')

    await input.setValue(truncated)
    await input.trigger('blur')
    // Saving the ceiling meanwhile keeps the stored address and the typed one.
    const ceiling = wrapper.find(
      '[data-test="cold-vault-max-hot-balance-input"]',
    )
    await ceiling.setValue('1000')
    await ceiling.trigger('blur')
    expect(mockSettingsStore.coldVaultSweep).toEqual({
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '1000',
    })
    expect((wrapper.vm as any).coldVaultAddressInput).toBe(truncated)

    wrapper.unmount()
    expect(mockSettingsStore.coldVaultSweep.externalVaultAddress).toBe('')
    for (const call of mockSetColdVaultSweep.mock.calls as any[]) {
      expect(call[0].externalVaultAddress ?? '').not.toBe(truncated)
    }

    // Next visit shows nothing was saved.
    const again = await openNetworking()
    expect((again.vm as any).coldVaultAddressInput).toBe('')
    again.unmount()
  })

  it('the confirm dialog names a Solana address and cancelling saves nothing', async () => {
    const full = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const wrapper = await openNetworking()
    await wrapper.find('[data-test="cold-vault-address-input"]').setValue(full)
    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-test="cold-vault-confirm-chain"]').text()).toBe(
      'settings.coldVaultChainSolana',
    )
    await wrapper
      .find('[data-test="cold-vault-confirm-cancel"]')
      .trigger('click')
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()

    await confirmAddress(wrapper, full)
    expect(mockSettingsStore.coldVaultSweep.externalVaultAddress).toBe(full)
    wrapper.unmount()
  })

  it('the vault ceiling saves on blur or leaving, never at a typing pause', async () => {
    const wrapper = await openNetworking()
    const ceiling = wrapper.find(
      '[data-test="cold-vault-max-hot-balance-input"]',
    )

    // "1" on the way to "1000" is a valid ceiling, so a pause must not save it.
    await ceiling.setValue('1')
    await wait(650)
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()

    await ceiling.setValue('1000')
    await ceiling.trigger('blur')
    expect(mockSettingsStore.coldVaultSweep.maxHotBalanceDisplay).toBe('1000')

    await ceiling.setValue('2000')
    wrapper.unmount()
    expect(mockSettingsStore.coldVaultSweep.maxHotBalanceDisplay).toBe('2000')
  })

  it('an invalid address cannot be confirmed and enabling without a saved address shows an error', async () => {
    const wrapper = await openNetworking()

    await wrapper
      .find('[data-test="cold-vault-address-input"]')
      .setValue('not-an-address')
    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-test="cold-vault-confirm-dialog"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-test="cold-vault-error"]').text()).toContain(
      'Invalid external vault address',
    )

    await wrapper.find('[data-test="cold-vault-enabled-toggle"]').setValue(true)
    expect((wrapper.vm as any).coldVaultError).toContain(
      'External vault address is required',
    )
    expect(mockSettingsStore.coldVaultSweep.enabled).toBe(false)
    wrapper.unmount()
  })

  it('on a wide layout switching section applies a pending edit and drops an unconfirmed address', async () => {
    const router = await openAt('/settings/networking')
    const wrapper = mountSettings(router, WIDE)
    await wrapper
      .find('[data-test="cold-vault-address-input"]')
      .setValue('0x8888888888888888888888888888888888888888')
    await wrapper
      .find('[data-test="cold-vault-max-hot-balance-input"]')
      .setValue('2500')

    await router.replace('/settings/appearance')
    await settle(router)
    await wrapper.vm.$nextTick()

    expect(mockSettingsStore.coldVaultSweep).toEqual({
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '2500',
    })
    expect((wrapper.vm as any).coldVaultAddressInput).toBe('')
    wrapper.unmount()
  })

  it('emptying the field with a saved address says sweeps still go there and offers Remove', async () => {
    const saved = '0x8888888888888888888888888888888888888888'
    mockSettingsStore.coldVaultSweep = {
      enabled: true,
      externalVaultAddress: saved,
      maxHotBalanceDisplay: '2500',
    }
    const wrapper = await openNetworking()
    await wrapper.find('[data-test="cold-vault-address-input"]').setValue('')

    expect(
      wrapper.find('[data-test="cold-vault-address-still-stored"]').text(),
    ).toBe('settings.coldVaultAddressStillStored')
    expect(
      wrapper.find('[data-test="cold-vault-address-use-btn"]').exists(),
    ).toBe(false)

    await wrapper
      .find('[data-test="cold-vault-address-remove-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-test="cold-vault-confirm-title"]').text()).toBe(
      'settings.coldVaultRemoveTitle',
    )
    expect(
      wrapper.find('[data-test="cold-vault-confirm-address"]').text(),
    ).toBe(saved)
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()

    await wrapper
      .find('[data-test="cold-vault-confirm-accept"]')
      .trigger('click')
    expect(mockSetColdVaultSweep).toHaveBeenLastCalledWith({
      enabled: false,
      externalVaultAddress: '',
    })
    expect(mockSettingsStore.coldVaultSweep).toEqual({
      enabled: false,
      externalVaultAddress: '',
      maxHotBalanceDisplay: '2500',
    })
    expect((wrapper.vm as any).coldVaultEnabled).toBe(false)
    expect(
      wrapper.find('[data-test="cold-vault-address-still-stored"]').exists(),
    ).toBe(false)
    wrapper.unmount()
  })

  it('cancelling Remove keeps the saved address, and leaving restores it in the field', async () => {
    const saved = '0x8888888888888888888888888888888888888888'
    mockSettingsStore.coldVaultSweep = {
      enabled: true,
      externalVaultAddress: saved,
      maxHotBalanceDisplay: '1500',
    }
    const wrapper = await openNetworking()
    await wrapper.find('[data-test="cold-vault-address-input"]').setValue('')
    await wrapper
      .find('[data-test="cold-vault-address-remove-btn"]')
      .trigger('click')
    await wrapper
      .find('[data-test="cold-vault-confirm-cancel"]')
      .trigger('click')
    expect(mockSetColdVaultSweep).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(mockSettingsStore.coldVaultSweep.externalVaultAddress).toBe(saved)
    expect(mockSettingsStore.coldVaultSweep.enabled).toBe(true)
  })

  it('turning sweeping on without a saved address reverts the toggle; confirming an address then turns it on', async () => {
    const wrapper = await openNetworking()
    const toggle = wrapper.find('[data-test="cold-vault-enabled-toggle"]')

    await toggle.setValue(true)
    expect((wrapper.vm as any).coldVaultError).toContain(
      'External vault address is required',
    )
    expect((wrapper.vm as any).coldVaultEnabled).toBe(false)
    expect(mockSettingsStore.coldVaultSweep.enabled).toBe(false)

    const vaultAddr = '0x8888888888888888888888888888888888888888'
    await wrapper
      .find('[data-test="cold-vault-address-input"]')
      .setValue(vaultAddr)
    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-test="cold-vault-confirm-title"]').text()).toBe(
      'settings.coldVaultConfirmTitleAndEnable',
    )
    expect(wrapper.find('[data-test="cold-vault-confirm-body"]').text()).toBe(
      'settings.coldVaultConfirmBodyAndEnable',
    )
    await wrapper
      .find('[data-test="cold-vault-confirm-accept"]')
      .trigger('click')

    expect(mockSetColdVaultSweep).toHaveBeenLastCalledWith({
      externalVaultAddress: vaultAddr,
      enabled: true,
    })
    expect(mockSettingsStore.coldVaultSweep).toEqual({
      enabled: true,
      externalVaultAddress: vaultAddr,
      maxHotBalanceDisplay: '1500',
    })
    expect((wrapper.vm as any).coldVaultEnabled).toBe(true)
    wrapper.unmount()
  })

  it('turning the refused toggle back off means confirming an address does not turn sweeping on', async () => {
    const wrapper = await openNetworking()
    const toggle = wrapper.find('[data-test="cold-vault-enabled-toggle"]')
    await toggle.setValue(true)
    await toggle.setValue(true)
    await toggle.setValue(false)

    const vaultAddr = '0x8888888888888888888888888888888888888888'
    await wrapper
      .find('[data-test="cold-vault-address-input"]')
      .setValue(vaultAddr)
    await wrapper
      .find('[data-test="cold-vault-address-use-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-test="cold-vault-confirm-title"]').text()).toBe(
      'settings.coldVaultConfirmTitle',
    )
    await wrapper
      .find('[data-test="cold-vault-confirm-accept"]')
      .trigger('click')
    expect(mockSetColdVaultSweep).toHaveBeenLastCalledWith({
      externalVaultAddress: vaultAddr,
    })
    expect(mockSettingsStore.coldVaultSweep.enabled).toBe(false)
    wrapper.unmount()
  })

  it('resets cold-vault sweep settings to defaults when reset button is clicked', async () => {
    const wrapper = await openNetworking()

    ;(wrapper.vm as any).coldVaultEnabled = true
    ;(wrapper.vm as any).coldVaultAddressInput =
      '0x8888888888888888888888888888888888888888'
    ;(wrapper.vm as any).coldVaultMaxHotBalanceInput = '2500'

    await wrapper.find('[data-test="reset-cold-vault-btn"]').trigger('click')

    expect(mockResetColdVaultSweep).toHaveBeenCalled()
    expect((wrapper.vm as any).coldVaultEnabled).toBe(false)
    expect((wrapper.vm as any).coldVaultAddressInput).toBe('')
    expect((wrapper.vm as any).coldVaultMaxHotBalanceInput).toBe('1500')
    wrapper.unmount()
  })
})
