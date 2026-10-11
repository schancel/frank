/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, toRaw } from 'vue'
import {
  accountSession as mockSession,
  accountStatus,
} from '../accounts/session'
import { MeraAccountError } from '../accounts/mera-passkey'
import fr from '../i18n/fr-fr'
import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import en from '../i18n/en-us'

const mockPasskey = jest.fn()
const mockCancel = jest.fn()
jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({
    cancel: mockCancel,
    beginPasskey: mockPasskey,
  }),
  recoveryErrorMessage: () => 'Account operation failed',
}))
const mockPush = jest.fn(async () => undefined)
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))
const mockAccount = reactive(toRaw(accountStatus))
const t = (locale: 'en' | 'fr') => (key: string) =>
  key
    .split('.')
    .reduce((value: any, part) => value[part], locale === 'fr' ? fr : en)
const pending = {
  status: 'staging',
  account: {
    displayName: 'Synthetic account',
    descriptor: 'PUBLIC',
    receipt: { operationId: 'attempt' },
  },
  expectedActive: { revision: 0, accountId: null },
}
function render(locale: 'en' | 'fr' = 'en') {
  return mount(Setup, {
    global: {
      mocks: { $t: t(locale), $router: { push: mockPush } },
      stubs: {
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<div><slot /></div>' },
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
        QCheckbox: true,
        QOptionGroup: true,
        QExpansionItem: true,
        QCard: true,
        QCardSection: true,
        QCardActions: true,
        QAvatar: true,
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
  mockPush.mockClear()
  mockPasskey.mockReset()
  mockCancel.mockClear()
  jest.spyOn(mockSession, 'retry').mockResolvedValue(undefined)
  jest.spyOn(mockSession, 'initialize').mockResolvedValue(undefined)
  jest.spyOn(mockSession, 'reset').mockResolvedValue(undefined)
  jest.spyOn(mockSession, 'stage').mockResolvedValue(undefined)
  jest
    .spyOn(mockSession, 'snapshot')
    .mockResolvedValue({ schema: 1, revision: 0, active: null, pending: null })
  jest
    .spyOn(mockSession, 'getWallet')
    .mockRejectedValue(new Error('No live wallet in this fixture'))
  jest.spyOn(mockSession, 'activatePending').mockImplementation(async () => {
    mockAccount.status = 'ready'
    mockAccount.revision = 1
    mockAccount.pending = null
  })
  localStorage.clear()
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: undefined,
  })
})

test.each(['en', 'fr'] as const)(
  'passkey actions remain distinct and failures localized in %s',
  async locale => {
    const view = render(locale)
    try {
      expect(view.get('[data-test="mera-unsupported"]').text()).toBe(
        t(locale)('accountRecovery.mera_unsupported'),
      )
      for (const action of ['create', 'login'] as const) {
        for (const code of [
          'cancelled',
          'unsupported',
          'prf',
          'failed',
        ] as const) {
          mockPasskey.mockRejectedValueOnce(new MeraAccountError(code))
          await view.get(`[data-test="mera-${action}"]`).trigger('click')
          await flushPromises()
          expect(mockPasskey).toHaveBeenLastCalledWith(action)
          expect(view.get('[data-test="account-error"]').text()).toBe(
            t(locale)(`accountRecovery.mera_${code}`),
          )
          expect(mockSession.stage).not.toHaveBeenCalled()
          expect(mockSession.activatePending).not.toHaveBeenCalled()
          expect(mockPush).not.toHaveBeenCalled()
        }
      }
    } finally {
      view.unmount()
    }
  },
)

test('passkey account replacement requires the existing explicit acknowledgement', async () => {
  Object.assign(mockAccount, {
    status: 'ready',
    revision: 1,
    account: pending.account,
  })
  const view = render()
  try {
    for (const action of ['create', 'login']) {
      expect(
        view.get(`[data-test="mera-${action}"]`).attributes('disabled'),
      ).toBeDefined()
      await view.get(`[data-test="mera-${action}"]`).trigger('click')
    }
    expect(mockPasskey).not.toHaveBeenCalled()
  } finally {
    view.unmount()
  }
})

test.each(['loading', 'locked', 'unavailable', 'standby'] as const)(
  'required account restoration gates passkey actions while %s',
  status => {
    Object.assign(mockAccount, { status })
    const view = render()
    try {
      expect(view.find('[data-test="mera-create"]').exists()).toBe(false)
      expect(view.find('[data-test="mera-login"]').exists()).toBe(false)
      expect(mockPasskey).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  },
)

test('successful passkey login enters pending review without activation or navigation', async () => {
  mockPasskey.mockImplementationOnce(async () => {
    Object.assign(mockAccount, {
      status: 'pending',
      pending,
      pendingReady: true,
      pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
    })
    return { isRestore: true }
  })
  const view = render()
  try {
    await view.get('[data-test="mera-login"]').trigger('click')
    await flushPromises()
    expect(mockPasskey).toHaveBeenCalledWith('login')
    expect(view.find('[data-test="activate-account"]').exists()).toBe(true)
    expect(mockSession.activatePending).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(view.emitted('setupCompleted')).toBeUndefined()
  } finally {
    view.unmount()
  }
})
