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

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancelCeremony,
    beginNew: mockBeginNew,
    share: mockShare,
  }),
  recoveryErrorMessage: (err: unknown) =>
    (err as Error)?.message ?? 'Account operation failed',
}))

const mockPush = jest.fn(async () => undefined)
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))

const { accountStatus: mockAccount } = jest.requireMock('../accounts/session')

const t = (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)?.[part] ?? key,
      en,
    ) as string

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
        QForm: {
          template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>',
        },
        QInput: {
          props: ['modelValue', 'placeholder', 'label', 'hint'],
          template: `
            <div class="q-input-stub">
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
})
