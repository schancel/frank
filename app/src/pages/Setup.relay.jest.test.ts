/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import {
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
  getDefaultRelayBaseUrl,
} from '@frank/wallet/chain'
import en from '../i18n/en-us'

jest.mock('../accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({
    status: 'fresh',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingIdentityAddress: null,
    pendingError: null,
  }),
  accountSession: {
    retry: jest.fn(async () => undefined),
    activatePending: jest.fn(async () => undefined),
    stage: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({
      revision: 0,
      active: null,
      pending: null,
    })),
    setBip39Params: jest.fn(),
  },
  importBip39Wallet: jest.fn(),
}))

const mockBeginNew = jest.fn(async () => 'synth-descriptor')
const mockShare = jest.fn(() => 'synth-share')
const mockCancelCeremony = jest.fn()
const mockBeginRestore = jest.fn(async (text?: string) => text ?? '')
const mockConfirm = jest.fn(
  async (_shares: readonly string[], _name: string) => ({
    isRestore: false,
    discoveredRelayUrl: undefined,
  }),
)

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancelCeremony,
    beginNew: mockBeginNew,
    share: mockShare,
    beginRestore: mockBeginRestore,
    confirm: mockConfirm,
  }),
  recoveryErrorMessage: (err: unknown) =>
    (err as Error)?.message ?? 'Account operation failed',
}))

const mockPush = jest.fn(async () => undefined)
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))

const { accountStatus: mockAccount } = jest.requireMock('../accounts/session')

const t = (key: string, params?: Record<string, unknown>) => {
  let str = key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)?.[part] ?? key,
      en,
    ) as string
  if (params && typeof str === 'string') {
    for (const [paramKey, paramVal] of Object.entries(params)) {
      str = str.replaceAll(`{${paramKey}}`, String(paramVal))
    }
  }
  return str
}

function render() {
  return mount(Setup, {
    global: {
      mocks: { $t: t, $router: { push: mockPush } },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<div><slot /></div>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
        QCheckbox: true,
        QOptionGroup: {
          props: ['modelValue', 'options'],
          template: `
            <div>
              <label v-for="opt in options" :key="opt.value">
                <input
                  type="radio"
                  :value="opt.value"
                  :checked="modelValue === opt.value"
                  @change="$emit('update:modelValue', opt.value)"
                />
                {{ opt.label }}
              </label>
            </div>
          `,
        },
        QExpansionItem: {
          props: ['label', 'caption'],
          template: '<div class="q-expansion-item"><slot /></div>',
        },
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QAvatar: { template: '<span><slot /></span>' },
        QForm: {
          template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>',
        },
        QInput: {
          props: ['modelValue', 'placeholder', 'label', 'hint'],
          template: `
            <div class="q-input-stub" :data-test="$attrs['data-test']">
              <input
                data-test="custom-relay-input-inner"
                :value="modelValue"
                :placeholder="placeholder"
                @input="$emit('update:modelValue', $event.target.value)"
              />
              <slot name="append" />
            </div>
          `,
        },
      },
    },
  })
}

describe('Setup page advanced relay configuration', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    setCustomRelayBaseUrl(undefined)
    Object.assign(mockAccount, {
      status: 'fresh',
      revision: 0,
      account: null,
      pending: null,
      pendingReady: false,
      pendingError: null,
    })
    await inspectLegacyWallet({
      get: async () => {
        throw { notFound: true }
      },
    })
    mockPush.mockClear()
    mockBeginNew.mockClear()
    mockBeginRestore.mockClear()
    mockConfirm.mockClear()
    jest.restoreAllMocks()
  })

  afterEach(() => {
    setCustomRelayBaseUrl(undefined)
    localStorage.clear()
  })

  test('renders advanced relay server section with default relay URL during account creation', async () => {
    const view = render()
    // Click Create Frank Account (new account)
    await view.get('[data-test="new-account"]').trigger('click')
    await flushPromises()

    // Advanced relay expansion should be visible
    expect(view.find('[data-test="advanced-relay-expansion"]').exists()).toBe(
      true,
    )

    // Inner input should have default relay URL
    const defaultRelay = getDefaultRelayBaseUrl()
    const input = view.get('[data-test="custom-relay-input-inner"]')
    expect((input.element as HTMLInputElement).value).toBe(defaultRelay)

    view.unmount()
  })

  test('allows entering a custom relay URL and saving it upon account creation', async () => {
    const view = render()
    await view.get('[data-test="new-account"]').trigger('click')
    await flushPromises()

    // Select policy
    const policyRadios = view.findAll('input[type="radio"]')
    expect(policyRadios.length).toBeGreaterThan(0)
    await policyRadios[0].setValue(true)
    await flushPromises()

    // Enter custom relay URL
    const customUrl = 'https://custom-relay.example.com'
    const input = view.get('[data-test="custom-relay-input-inner"]')
    await input.setValue(customUrl)
    await flushPromises()

    // Reset button should now be present
    expect(view.find('[data-test="reset-default-relay"]').exists()).toBe(true)

    // Submit form
    await view.get('form').trigger('submit')
    await flushPromises()

    // Custom relay should now be persisted in custom relay store
    expect(getCustomRelayBaseUrl()).toBe(customUrl)

    view.unmount()
  })

  test('reset button restores default relay URL and clears custom relay setting', async () => {
    const view = render()
    await view.get('[data-test="new-account"]').trigger('click')
    await flushPromises()

    // Select policy
    const policyRadios = view.findAll('input[type="radio"]')
    await policyRadios[0].setValue(true)
    await flushPromises()

    const defaultRelay = getDefaultRelayBaseUrl()
    const customUrl = 'https://custom-relay.example.com'
    const input = view.get('[data-test="custom-relay-input-inner"]')
    await input.setValue(customUrl)
    await flushPromises()

    expect(view.find('[data-test="reset-default-relay"]').exists()).toBe(true)

    // Click reset button
    await view.get('[data-test="reset-default-relay"]').trigger('click')
    await flushPromises()

    // Input should be back to default relay
    expect((input.element as HTMLInputElement).value).toBe(defaultRelay)

    // Submit form
    await view.get('form').trigger('submit')
    await flushPromises()

    // Should NOT have custom relay saved
    expect(getCustomRelayBaseUrl()).toBeUndefined()

    view.unmount()
  })

  test('restores account with existing directory entry: sets custom relay and reflects in UI', async () => {
    const discoveredRelay = 'https://home-relay-discovered.example.com'
    mockConfirm.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'fresh',
        pending: {
          status: 'staging',
          account: { displayName: 'Restored User', descriptor: 'PUBLIC-DESC' },
          expectedActive: { revision: 0, accountId: null },
        },
        pendingReady: true,
        pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
      })
      return {
        isRestore: true,
        subject: '02' + 'aa'.repeat(32),
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        discoveredRelayUrl: discoveredRelay,
      }
    })

    const view = render()
    // Click Restore Frank Account
    await view.get('[data-test="restore-account"]').trigger('click')
    await flushPromises()

    // Mode is now restore-shares
    await view
      .get('[data-test="confirm-shares"] input')
      .setValue('share1\nshare2')
    await view.get('[data-test="display-name"] input').setValue('Restored User')
    await flushPromises()

    // Submit restore form
    await view.get('form').trigger('submit')
    await flushPromises()

    // setCustomRelayBaseUrl should be called and custom relay persisted
    expect(getCustomRelayBaseUrl()).toBe(discoveredRelay)

    // UI should reflect discovered relay
    const statusNotice = view.find('[data-test="relay-discovered-status"]')
    expect(statusNotice.exists()).toBe(true)
    expect(statusNotice.text()).toContain(discoveredRelay)

    // Advanced options relay input should be populated with discovered relay
    const relayInput = view.get('[data-test="custom-relay-input"] input')
    expect((relayInput.element as HTMLInputElement).value).toBe(discoveredRelay)

    view.unmount()
  })

  test('restores account with no directory entry: preserves default relay', async () => {
    mockConfirm.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'fresh',
        pending: {
          status: 'staging',
          account: {
            displayName: 'Offline Account',
            descriptor: 'PUBLIC-DESC',
          },
          expectedActive: { revision: 0, accountId: null },
        },
        pendingReady: true,
        pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
      })
      return {
        isRestore: true,
        subject: '02' + 'bb'.repeat(32),
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        discoveredRelayUrl: undefined,
      }
    })

    const view = render()
    await view.get('[data-test="restore-account"]').trigger('click')
    await flushPromises()

    await view
      .get('[data-test="confirm-shares"] input')
      .setValue('share1\nshare2')
    await view
      .get('[data-test="display-name"] input')
      .setValue('Offline Account')
    await flushPromises()

    await view.get('form').trigger('submit')
    await flushPromises()

    // Default relay preserved, custom relay is undefined
    expect(getCustomRelayBaseUrl()).toBeUndefined()

    // No discovered status notice shown
    expect(view.find('[data-test="relay-discovered-status"]').exists()).toBe(
      false,
    )

    // Advanced relay input reflects default relay
    const defaultRelay = getDefaultRelayBaseUrl()
    const relayInput = view.get('[data-test="custom-relay-input"] input')
    expect((relayInput.element as HTMLInputElement).value).toBe(defaultRelay)

    view.unmount()
  })

  test('handles probe error/offline during restore gracefully and preserves default relay', async () => {
    mockConfirm.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'fresh',
        pending: {
          status: 'staging',
          account: { displayName: 'Error Account', descriptor: 'PUBLIC-DESC' },
          expectedActive: { revision: 0, accountId: null },
        },
        pendingReady: true,
        pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
      })
      return {
        isRestore: true,
        subject: '02' + 'cc'.repeat(32),
        address: '0xcccccccccccccccccccccccccccccccccccccccc',
        discoveredRelayUrl: undefined,
      }
    })

    const view = render()
    await view.get('[data-test="restore-account"]').trigger('click')
    await flushPromises()

    await view
      .get('[data-test="confirm-shares"] input')
      .setValue('share1\nshare2')
    await view.get('[data-test="display-name"] input').setValue('Error Account')
    await flushPromises()

    await view.get('form').trigger('submit')
    await flushPromises()

    // Account recovery is not blocked, default relay preserved
    expect(getCustomRelayBaseUrl()).toBeUndefined()
    expect(view.find('[data-test="relay-discovered-status"]').exists()).toBe(
      false,
    )
    expect(view.find('[data-test="activate-account"]').exists()).toBe(true)

    view.unmount()
  })

  test('probes directory during restore and configures discovered relay', async () => {
    const discoveredRelay = 'https://probed-relay.example.com'
    const cashwebRelay = await import('@frank/cashweb/relay')
    const probeSpy = jest
      .spyOn(cashwebRelay, 'probeDirectoryRelay')
      .mockResolvedValueOnce(discoveredRelay)

    mockConfirm.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'fresh',
        pending: {
          status: 'staging',
          account: { displayName: 'Probe Test', descriptor: 'PUBLIC-DESC' },
          expectedActive: { revision: 0, accountId: null },
        },
        pendingReady: true,
        pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
      })
      return {
        isRestore: true,
        subject: '02' + 'dd'.repeat(32),
        address: '0xdddddddddddddddddddddddddddddddddddddddd',
        discoveredRelayUrl: undefined,
      }
    })

    const view = render()
    await view.get('[data-test="restore-account"]').trigger('click')
    await flushPromises()

    await view
      .get('[data-test="confirm-shares"] input')
      .setValue('share1\nshare2')
    await view.get('[data-test="display-name"] input').setValue('Probe Test')
    await flushPromises()

    await view.get('form').trigger('submit')
    await flushPromises()

    expect(probeSpy).toHaveBeenCalledWith({
      subject: '02' + 'dd'.repeat(32),
      address: '0xdddddddddddddddddddddddddddddddddddddddd',
    })
    expect(getCustomRelayBaseUrl()).toBe(discoveredRelay)
    expect(view.find('[data-test="relay-discovered-status"]').text()).toContain(
      discoveredRelay,
    )

    probeSpy.mockRestore()
    view.unmount()
  })

  test('BIP39 identification leaves the configured home relay unchanged', async () => {
    const discoveredRelay = 'https://legacy-discovered.example.com'
    const existingRelay = 'https://existing.example.com'
    setCustomRelayBaseUrl(existingRelay)
    const cashwebRelay = await import('@frank/cashweb/relay')
    const probeSpy = jest
      .spyOn(cashwebRelay, 'probeDirectoryRelay')
      .mockResolvedValueOnce(discoveredRelay)

    const view = render()
    await view.get('[data-test="legacy-recovery"]').trigger('click')
    await flushPromises()

    const input = view.get('[data-test="legacy-phrase"] input')
    await input.setValue(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    )
    await flushPromises()

    await view.get('form').trigger('submit')
    await flushPromises()

    expect(probeSpy).not.toHaveBeenCalled()
    expect(getCustomRelayBaseUrl()).toBe(existingRelay)
    expect(view.find('[data-test="custom-relay-input"]').exists()).toBe(false)
    expect(mockPush).not.toHaveBeenCalled()

    probeSpy.mockRestore()
    view.unmount()
  })
})
