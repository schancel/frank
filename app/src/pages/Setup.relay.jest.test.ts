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

const mockChoose = jest.fn(async (_index: number, _name: string) => ({
  isRestore: true,
  discoveredRelayUrl: undefined,
}))

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancelCeremony,
    beginNew: mockBeginNew,
    share: mockShare,
    beginRestore: mockBeginRestore,
    confirm: mockConfirm,
    choose: mockChoose,
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

describe('Setup page restore from more shares than the threshold', () => {
  const verdict = (
    position: number,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    position,
    identifier: 'abcd',
    index: 'qpzry9'[position],
    status,
    candidate: status === 'supports' ? 0 : null,
    code: null,
    ...extra,
  })
  const pendingAccount = {
    status: 'fresh',
    pending: {
      status: 'staging',
      account: { displayName: 'Restored', descriptor: 'PUBLIC-DESC' },
      expectedActive: { revision: 0, accountId: null },
    },
    pendingReady: true,
    pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
  }
  beforeEach(async () => {
    setActivePinia(createPinia())
    Object.assign(mockAccount, {
      status: 'fresh',
      revision: 0,
      account: null,
      pending: null,
      pendingReady: false,
      pendingIdentityAddress: null,
      pendingError: null,
    })
    await inspectLegacyWallet({
      get: async () => {
        throw { notFound: true }
      },
    })
    mockConfirm.mockClear()
    mockChoose.mockClear()
  })
  async function enterShares(lines: string) {
    const view = render()
    await view.get('[data-test="restore-account"]').trigger('click')
    await flushPromises()
    expect(view.text()).toContain(
      en.accountRecovery.enter_at_least_the_threshold_number_of_shares,
    )
    await view.get('[data-test="confirm-shares"] input').setValue(lines)
    await view.get('[data-test="display-name"] input').setValue('Restored')
    await view.get('form').trigger('submit')
    await flushPromises()
    return view
  }

  test('accepts extra shares and says which were used and which were not, and why', async () => {
    mockConfirm.mockImplementationOnce(async () => {
      Object.assign(mockAccount, pendingAccount)
      return {
        isRestore: true,
        discoveredRelayUrl: undefined,
        report: [
          verdict(0, 'supports'),
          verdict(1, 'inconsistent'),
          verdict(2, 'different-set', { identifier: 'wxyz' }),
          verdict(3, 'duplicate'),
          verdict(4, 'invalid', { identifier: null, index: null }),
          verdict(5, 'supports'),
        ],
      } as never
    })
    const view = await enterShares('a\nb\nc\nd\ne\nf')
    const report = view.get('[data-test="share-report"]').text()
    expect(report).toContain('Share 1 (index q): used.')
    expect(report).toContain(
      'Share 2 (index p): does not belong to this backup',
    )
    expect(report).toContain('Share 3 (set wxyz): from a different backup set.')
    expect(report).toContain('Share 4: entered more than once.')
    expect(report).toContain('Share 5: could not be read.')
    expect(report).toContain('Share 6 (index 9): used.')
    // The pending screen still shows whose account this is before Activate.
    expect(view.get('[data-test="pending-identity-address"]').text()).toBe(
      pendingAccount.pendingIdentityAddress,
    )
    view.unmount()
  })

  test('complete backups of two accounts: shows both addresses and stages only the one the user picks', async () => {
    mockConfirm.mockImplementationOnce(
      async () =>
        ({
          isRestore: true,
          report: [0, 1, 2, 3].map(position => ({
            ...verdict(position, 'supports'),
            candidate: position % 2,
          })),
          candidates: [
            { address: '0xAAAA', descriptor: 'desc-a', supporting: [0, 2] },
            { address: '0xBBBB', descriptor: 'desc-b', supporting: [1, 3] },
          ],
        } as never),
    )
    const view = await enterShares('a\nb\nc\nd')
    expect(view.get('[data-test="restore-choose-warning"]').text()).toBe(
      en.accountRecovery.restore_choose_explained,
    )
    const candidates = view.findAll('[data-test="restore-candidate"]')
    expect(
      candidates.map(c =>
        c.get('[data-test="restore-candidate-address"]').text(),
      ),
    ).toEqual(['0xAAAA', '0xBBBB'])
    expect(
      candidates.map(c =>
        c.get('[data-test="restore-candidate-shares"]').text(),
      ),
    ).toEqual(['Built from shares 1, 3.', 'Built from shares 2, 4.'])
    // Nothing is staged or offered for activation until the user picks.
    expect(mockChoose).not.toHaveBeenCalled()
    expect(view.find('[data-test="activate-account"]').exists()).toBe(false)

    mockChoose.mockImplementationOnce(async () => {
      Object.assign(mockAccount, pendingAccount)
      return { isRestore: true, discoveredRelayUrl: undefined }
    })
    await candidates[1]
      .get('[data-test="restore-candidate-pick"]')
      .trigger('click')
    await flushPromises()
    expect(mockChoose).toHaveBeenCalledWith(1, 'Restored')
    const report = view.get('[data-test="share-report"]').text()
    expect(report).toContain('Share 2 (index p): used.')
    expect(report).toContain(
      'Share 1 (index q): does not belong to this backup',
    )
    expect(view.find('[data-test="activate-account"]').exists()).toBe(true)
    view.unmount()
  })

  test('a refused restore still says which share was wrong', async () => {
    mockConfirm.mockImplementationOnce(async () => {
      throw Object.assign(new Error('refused'), {
        code: 'bad-checksum',
        shares: [
          verdict(0, 'invalid', { index: null }),
          verdict(1, 'inconsistent'),
        ],
      })
    })
    const view = await enterShares('a\nb')
    expect(view.get('[data-test="account-error"]').text()).toBe('refused')
    expect(view.get('[data-test="share-report"]').text()).toContain(
      'Share 1: could not be read.',
    )
    expect(view.find('[data-test="activate-account"]').exists()).toBe(false)
    view.unmount()
  })
})
