/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Setup from './Setup.vue'
import { useTabCoordinatorStore } from '../stores/tab-coordinator'
import en from '../i18n/en-us'

const mockPush = jest.fn(async () => undefined)
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))

jest.mock('../accounts/session', () => ({
  accountStatus: jest.requireActual('vue').reactive({
    status: 'locked',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingError: null,
    error: 'unavailable',
  }),
  accountSession: {
    initialize: jest.fn(async () => undefined),
    retry: jest.fn(async () => undefined),
    reset: jest.fn(async () => undefined),
    activatePending: jest.fn(async () => undefined),
    stage: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({
      revision: 0,
      active: null,
      pending: null,
    })),
    setBip39Params: jest.fn(),
    yieldCustody: jest.fn(async () => undefined),
    setStandby: jest.fn(),
  },
  importBip39Wallet: jest.fn(),
}))

const { accountStatus: mockAccount, accountSession: mockSession } =
  jest.requireMock('../accounts/session')

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({ cancel: jest.fn() }),
  recoveryErrorMessage: () => 'Account operation failed',
}))

const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

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
          props: ['label', 'disable', 'loading'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
        QCheckbox: true,
        QOptionGroup: true,
        QExpansionItem: true,
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QAvatar: { template: '<span><slot /></span>' },
        QForm: {
          template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>',
        },
        QInput: {
          props: ['modelValue'],
          template:
            '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  })
}

describe('Setup.vue Multi-Tab Awareness & Takeover', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPush.mockClear()
    mockSession.retry.mockClear()
    Object.assign(mockAccount, {
      status: 'locked',
      revision: 0,
      account: null,
      pending: null,
      pendingReady: false,
      pendingError: null,
      error: 'unavailable',
    })
    const tabStore = useTabCoordinatorStore()
    tabStore.resetForTesting()
  })

  it('renders multi-tab takeover card instead of setup/import forms when otherTabActive is true', async () => {
    const tabStore = useTabCoordinatorStore()
    tabStore.otherTabActive = true

    const view = render()
    await flushPromises()

    // Multi-tab container must be present
    expect(view.find('[data-test="multi-tab-locked-container"]').exists()).toBe(
      true,
    )
    expect(view.find('[data-test="use-frank-here-btn"]').exists()).toBe(true)
    expect(view.find('[data-test="switch-tab-btn"]').exists()).toBe(true)

    // Heading and status text must reflect multi-tab condition
    expect(view.get('#account-heading').text()).toContain(
      'Frank is open in another tab',
    )
    expect(view.get('[data-test="account-status"]').text()).toContain(
      'Frank is open in another tab',
    )

    // Setup, seed import, and reset storage must NOT be shown
    expect(view.find('[data-test="retry-account"]').exists()).toBe(false)
    expect(view.find('[data-test="reset-account-storage"]').exists()).toBe(
      false,
    )
    expect(view.find('[data-test="new-account"]').exists()).toBe(false)
    expect(view.find('[data-test="restore-account"]').exists()).toBe(false)
    expect(view.find('[data-test="legacy-phrase"]').exists()).toBe(false)
    expect(view.find('[data-test="account-error"]').exists()).toBe(false)

    view.unmount()
  })

  it('clicking "Use Frank here" triggers takeover request and navigates to /wallet on success', async () => {
    const tabStore = useTabCoordinatorStore()
    tabStore.otherTabActive = true
    const takeoverSpy = jest
      .spyOn(tabStore, 'requestTakeover')
      .mockImplementation(async () => {
        mockAccount.status = 'ready'
        tabStore.otherTabActive = false
      })

    const view = render()
    await flushPromises()

    await view.get('[data-test="use-frank-here-btn"]').trigger('click')
    await flushPromises()

    expect(takeoverSpy).toHaveBeenCalledTimes(1)
    expect(view.emitted('setupCompleted')).toBeTruthy()
    expect(mockPush).toHaveBeenCalledWith('/wallet')

    view.unmount()
  })

  it('clicking "Switch to open tab" requests tab focus via broadcast', async () => {
    const tabStore = useTabCoordinatorStore()
    tabStore.otherTabActive = true
    const focusSpy = jest.spyOn(tabStore, 'requestTabFocus')

    const view = render()
    await flushPromises()

    await view.get('[data-test="switch-tab-btn"]').trigger('click')
    expect(focusSpy).toHaveBeenCalledTimes(1)

    view.unmount()
  })

  it('auto-navigates to /wallet when other tab closes and wasAutoReleased triggers', async () => {
    const tabStore = useTabCoordinatorStore()
    tabStore.otherTabActive = true

    const view = render()
    await flushPromises()

    expect(mockPush).not.toHaveBeenCalled()

    // Simulate other tab closing
    tabStore.otherTabActive = false
    tabStore.wasAutoReleased = true
    mockAccount.status = 'ready'
    await flushPromises()

    expect(mockPush).toHaveBeenCalledWith('/wallet')
    expect(tabStore.wasAutoReleased).toBe(false)

    view.unmount()
  })
})
