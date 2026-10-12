/** @jest-environment jsdom */
import {
  getActiveChain,
  setActiveChain,
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
} from '@frank/wallet/chain'
import { probeDirectoryRelay } from '@frank/cashweb/relay'
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
import * as ownProfile from '../utils/own-profile'
import { inspectLegacyWallet } from '../accounts/legacy'
import en from '../i18n/en-us'

jest.mock('@frank/cashweb/relay', () => ({
  probeDirectoryRelay: jest.fn(async () => undefined),
}))

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
const t = (locale: 'en' | 'fr') => (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[part]
          : undefined,
      locale === 'fr' ? fr : en,
    )
  return typeof value === 'string' ? value : key
}
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
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QCheckbox: {
          props: ['modelValue'],
          template:
            '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
        },
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
async function choosePasskey(
  view: ReturnType<typeof render>,
  action: 'create' | 'login',
) {
  if (!view.find('[data-test="mera-choices"]').exists())
    await view.get('[data-test="mera-continue"]').trigger('click')
  await view.get(`[data-test="mera-${action}"]`).trigger('click')
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
    mockAccount.account = mockAccount.pending?.account ?? null
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
          await choosePasskey(view, action)
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
    const entry = view.get('[data-test="mera-continue"]')
    expect(entry.attributes('disabled')).toBeDefined()
    await entry.trigger('click')
    expect(view.find('[data-test="mera-choices"]').exists()).toBe(false)
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
    await choosePasskey(view, 'login')
    await flushPromises()
    expect(mockPasskey).toHaveBeenCalledWith('login')
    expect(view.find('[data-test="activate-account"]').exists()).toBe(true)
    expect(view.get('[data-test="account-found"]').text()).toBe(
      'Confirm identity',
    )
    expect(view.get('[data-test="pending-identity"]').text()).toContain(
      'Its published profile will be loaded separately',
    )
    expect(mockSession.activatePending).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(view.emitted('setupCompleted')).toBeUndefined()
  } finally {
    view.unmount()
  }
})

test.each([
  'cancel',
  'unmount',
  'chain',
  'chain-roundtrip',
  'replacement',
  'close-reopen',
] as const)(
  'late directory result after %s cannot select a relay or activate',
  async race => {
    const home = 'https://current-account-relay.example'
    setCustomRelayBaseUrl(home)
    const previousChain = getActiveChain()
    const probe = jest.mocked(probeDirectoryRelay)
    probe.mockClear()
    let answer!: (result: {
      isRestore: boolean
      subject: string
      discoveredRelayUrl?: string
    }) => void
    mockPasskey.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = resolve
        }),
    )
    const view = render()
    let unmounted = false
    try {
      await choosePasskey(view, 'login')
      if (race === 'cancel') (view.vm as unknown as { cancel(): void }).cancel()
      if (race === 'unmount') {
        view.unmount()
        unmounted = true
      }
      if (race === 'chain' || race === 'chain-roundtrip')
        setActiveChain({
          ...previousChain,
          chainIdentifier: 'ethereum-sepolia',
        })
      if (race === 'chain-roundtrip') setActiveChain(previousChain)
      if (race === 'replacement')
        Object.assign(mockAccount, {
          revision: 1,
          account: { ...pending.account },
        })
      if (race === 'close-reopen') {
        mockAccount.status = 'locked'
        mockAccount.status = 'fresh'
      }
      answer({
        isRestore: true,
        subject: '02' + 'dd'.repeat(32),
        discoveredRelayUrl: 'https://stale-account-relay.example',
        loginVerification: 'existing',
        attemptId: 'attempt',
      })
      await flushPromises()
      expect(getCustomRelayBaseUrl()).toBe(home)
      expect(probe).not.toHaveBeenCalled()
      expect(mockSession.activatePending).not.toHaveBeenCalled()
      expect(mockPush).not.toHaveBeenCalled()
    } finally {
      if (!unmounted) view.unmount()
      probe.mockClear()
      setActiveChain(previousChain)
      setCustomRelayBaseUrl(undefined)
    }
  },
)

test('a completed negative directory lookup is not retried by presentation', async () => {
  const home = 'https://current-account-relay.example'
  setCustomRelayBaseUrl(home)
  const probe = jest.mocked(probeDirectoryRelay)
  probe.mockClear()
  probe.mockResolvedValueOnce('https://unexpected-second-lookup.example')
  mockPasskey.mockResolvedValueOnce({
    isRestore: true,
    subject: '02' + 'dd'.repeat(32),
    discoveredRelayUrl: undefined,
  })
  const view = render()
  try {
    await choosePasskey(view, 'login')
    await flushPromises()
    expect(probe).not.toHaveBeenCalled()
    expect(getCustomRelayBaseUrl()).toBe(home)
    expect(mockSession.activatePending).not.toHaveBeenCalled()
  } finally {
    view.unmount()
    probe.mockReset()
    setCustomRelayBaseUrl(undefined)
  }
})

test.each(['en', 'fr'] as const)(
  'one Mera entry contains its logo and reveals explicit choices in %s',
  async locale => {
    const view = render(locale)
    try {
      const entry = view.get('[data-test="mera-continue"]')
      expect(entry.text()).toBe(t(locale)('accountRecovery.mera_login'))
      expect(entry.get('[data-test="mera-logo"]').attributes('alt')).toBe('')
      expect(view.find('[data-test="mera-create"]').exists()).toBe(false)
      expect(view.find('[data-test="mera-login"]').exists()).toBe(false)
      expect(view.find('#mera-heading').exists()).toBe(false)
      await entry.trigger('click')
      expect(mockPasskey).not.toHaveBeenCalled()
      expect(view.get('[data-test="mera-login"]').text()).toBe(
        t(locale)('accountRecovery.mera_existing'),
      )
      expect(view.get('[data-test="mera-create"]').text()).toBe(
        t(locale)('accountRecovery.mera_new'),
      )
      await entry.trigger('click')
      expect(view.find('[data-test="mera-choices"]').exists()).toBe(false)
    } finally {
      view.unmount()
    }
  },
)

test.each(['existing', 'unverified', 'unreachable'] as const)(
  'fresh login activates automatically only with positive existing-account evidence: %s',
  async loginVerification => {
    mockPasskey.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'pending',
        pending,
        pendingReady: true,
      })
      return { isRestore: true, attemptId: 'attempt', loginVerification }
    })
    const view = render()
    try {
      await choosePasskey(view, 'login')
      await flushPromises()
      expect(mockSession.activatePending).toHaveBeenCalledTimes(
        loginVerification === 'existing' ? 1 : 0,
      )
      if (loginVerification === 'unreachable')
        expect(view.get('[data-test="account-error"]').text()).toBe(
          t('en')('accountRecovery.mera_verification_unreachable'),
        )
    } finally {
      view.unmount()
    }
  },
)

test('positive evidence cannot activate a different staged attempt', async () => {
  mockPasskey.mockImplementationOnce(async () => {
    Object.assign(mockAccount, {
      status: 'pending',
      pending,
      pendingReady: true,
    })
    return {
      isRestore: true,
      attemptId: 'foreign-attempt',
      loginVerification: 'existing',
    }
  })
  const view = render()
  try {
    await choosePasskey(view, 'login')
    await flushPromises()
    expect(mockSession.activatePending).not.toHaveBeenCalled()
  } finally {
    view.unmount()
  }
})

test.each(['adopted', 'missing', 'unreachable'] as const)(
  'automatic login keeps required profile restoration observable: %s',
  async profileOutcome => {
    const staged = {
      ...pending,
      account: { ...pending.account, displayName: '' },
    }
    mockPasskey.mockImplementationOnce(async () => {
      Object.assign(mockAccount, {
        status: 'pending',
        pending: staged,
        pendingReady: true,
      })
      return {
        isRestore: true,
        attemptId: 'attempt',
        loginVerification: 'existing',
      }
    })
    jest.mocked(mockSession.getWallet).mockResolvedValue({
      identity: {},
      relayBaseUrl: 'https://home.example',
    } as never)
    jest
      .spyOn(ownProfile, 'restoreOwnProfileWithRelay')
      .mockResolvedValue(profileOutcome)
    const view = render()
    try {
      await choosePasskey(view, 'login')
      await flushPromises()
      expect(mockSession.activatePending).toHaveBeenCalledWith(
        'attempt',
        pending.expectedActive,
      )
      if (profileOutcome === 'adopted')
        expect(mockPush).toHaveBeenCalledWith('/wallet')
      else if (profileOutcome === 'missing')
        expect(mockPush).toHaveBeenCalledWith('/profile')
      else {
        expect(mockPush).not.toHaveBeenCalled()
        expect(view.get('[data-test="account-error"]').text()).toBe(
          t('en')('accountRecovery.profile_restore_unreachable'),
        )
      }
    } finally {
      view.unmount()
    }
  },
)

test('acknowledged local replacement still requires pending activation confirmation', async () => {
  Object.assign(mockAccount, {
    status: 'ready',
    revision: 1,
    account: pending.account,
  })
  mockPasskey.mockImplementationOnce(async () => {
    Object.assign(mockAccount, {
      status: 'pending',
      pending,
      pendingReady: true,
    })
    return {
      isRestore: true,
      attemptId: 'attempt',
      loginVerification: 'existing',
    }
  })
  const view = render()
  try {
    await view.get('[data-test="replace-ack"]').setValue(true)
    await choosePasskey(view, 'login')
    await flushPromises()
    expect(mockPasskey).toHaveBeenCalledWith('login')
    expect(mockSession.activatePending).not.toHaveBeenCalled()
  } finally {
    view.unmount()
  }
})
