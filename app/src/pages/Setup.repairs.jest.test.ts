/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, toRaw } from 'vue'
import { AbstractProvider } from 'ethers'
import {
  accountSession as mockSession,
  accountStatus,
} from '../accounts/session'
import * as sessionApi from '../accounts/session'
import * as bip39Scanner from '@frank/wallet/bip39-import'
import * as chain from '@frank/wallet/chain'
import * as relay from '@frank/cashweb/relay'
import fr from '../i18n/fr-fr'
import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import en from '../i18n/en-us'

jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({ cancel: jest.fn() }),
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

test('Retry repeats a failed read-only legacy inspection and shows the quarantined state without a write', async () => {
  const raw = JSON.stringify({ seedPhrase: 'SYNTHETIC-LEGACY-SENTINEL' })
  const source = {
    get: jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(raw),
    put: jest.fn(),
  }
  await inspectLegacyWallet(source)
  const view = render()
  expect(view.find('[data-test="new-account"]').exists()).toBe(false)
  await view.get('[data-test="retry-account"]').trigger('click')
  await flushPromises()
  expect(source.get).toHaveBeenCalledTimes(2)
  expect(source.put).not.toHaveBeenCalled()
  expect(view.find('[data-test="replace-ack"]').exists()).toBe(true)
  expect(
    view.get('[data-test="new-account"]').attributes('disabled'),
  ).toBeDefined()
  view.unmount()
})
test('healthy active account with failed pending cleanup exposes retry/cancel while blocking another replacement', () => {
  Object.assign(mockAccount, {
    status: 'ready',
    account: { displayName: 'Active' },
    pending,
    pendingError: 'storage-failed',
  })
  const view = render()
  expect(view.get('[data-test="pending-error"]').text()).toContain(
    'active account is unchanged',
  )
  expect(view.find('[data-test="retry-pending"]').exists()).toBe(true)
  expect(view.find('[data-test="cancel-pending"]').exists()).toBe(true)
  expect(view.find('[data-test="new-account"]').exists()).toBe(false)
  view.unmount()
})
test.each(['denied', 'hanging'])(
  'fresh activation requests persistent storage once without blocking ready/navigation when %s',
  async outcome => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    const persist = jest.fn(() =>
      outcome === 'hanging'
        ? new Promise<boolean>(() => undefined)
        : Promise.resolve(false),
    )
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist },
    })
    const storage = usePersistentStorageStore()
    await storage.ensureForAccount()
    expect(persist).not.toHaveBeenCalled()
    Object.assign(mockAccount, {
      pending,
      pendingReady: true,
      pendingIdentityAddress: '0x00000000000000000000000000000000000000Aa',
    })
    const view = render()
    await view.get('[data-test="activate-account"]').trigger('click')
    await flushPromises()
    expect(mockAccount.status).toBe('ready')
    expect(mockPush).toHaveBeenCalledWith('/wallet')
    expect(persist).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1000)
    expect(storage.status).toBe(
      outcome === 'hanging' ? 'unknown' : 'not-granted',
    )
    view.unmount()
  },
)

const PUBLIC_PHRASE =
  'test test test test test test test test test test test junk'
const CANDIDATE = '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650'
const CANDIDATE_PATH = "m/44'/60'/1'/0/0"

test.each(['en', 'fr'] as const)(
  'read-only identification is truthful in %s for ready and locked accounts',
  async locale => {
    for (const status of ['ready', 'locked'] as const) {
      Object.assign(mockAccount, {
        status,
        account: { displayName: 'Existing account' },
        pending: status === 'locked' ? pending : null,
      })
      const original = JSON.stringify(mockAccount)
      const sentinel = JSON.stringify({
        custody: 'EXISTING',
        journal: 'FUNDED PENDING OPERATION',
      })
      localStorage.setItem('synthetic-recovery-evidence', sentinel)
      const scan = jest.spyOn(bip39Scanner, 'scanBip39Accounts')
      const refuse = jest.spyOn(sessionApi, 'importBip39Wallet')
      const balance = jest
        .spyOn(AbstractProvider.prototype, 'getBalance')
        .mockRejectedValue(new Error('No RPC allowed'))
      const probe = jest
        .spyOn(relay, 'probeDirectoryRelay')
        .mockRejectedValue(new Error('No relay IO allowed'))
      const saveRelay = jest.spyOn(chain, 'setCustomRelayBaseUrl')
      const construct = jest
        .spyOn(chain.activeChain, 'createWallet')
        .mockRejectedValue(new Error('No wallet construction allowed'))
      const afterActivation = jest.spyOn(
        usePersistentStorageStore(),
        'afterActivation',
      )
      const view = render(locale)
      const entry =
        status === 'locked' ? 'legacy-locked-recovery' : 'legacy-recovery'
      expect(view.get(`[data-test="${entry}"]`).text()).toBe(
        t(locale)('accountRecovery.identify_legacy_account_locally'),
      )
      expect(
        view.get(`[data-test="${entry}"]`).attributes('disabled'),
      ).toBeUndefined()
      if (status === 'ready')
        expect(
          view.get('[data-test="new-account"]').attributes('disabled'),
        ).toBeDefined()
      await view.get(`[data-test="${entry}"]`).trigger('click')
      await view.get('[data-test="legacy-phrase"]').setValue(PUBLIC_PHRASE)
      await view.get('form').trigger('submit')
      await flushPromises()
      expect(scan).toHaveBeenCalledWith({ phrase: PUBLIC_PHRASE })
      expect(refuse).toHaveBeenCalledWith(PUBLIC_PHRASE, CANDIDATE_PATH)
      expect(view.get('[data-test="detected-account"]').text()).toContain(
        CANDIDATE,
      )
      expect(view.get('[data-test="detected-account"]').text()).toContain(
        CANDIDATE_PATH,
      )
      expect(view.get('[data-test="legacy-unavailable"]').text()).toBe(
        t(locale)('accountRecovery.bip39_import_unavailable'),
      )
      expect(view.find('[data-test="account-error"]').exists()).toBe(false)
      expect(view.find('[data-test="advanced-relay-expansion"]').exists()).toBe(
        false,
      )
      expect(view.find('[data-test="custom-relay-input"]').exists()).toBe(false)
      expect(view.emitted('setupCompleted')).toBeUndefined()
      expect(mockPush).not.toHaveBeenCalled()
      for (const action of [
        mockSession.snapshot,
        mockSession.reset,
        mockSession.stage,
        mockSession.activatePending,
        mockSession.getWallet,
        construct,
        afterActivation,
        probe,
        saveRelay,
        balance,
      ])
        expect(action).not.toHaveBeenCalled()
      expect(JSON.stringify(mockAccount)).toBe(original)
      expect(localStorage.getItem('synthetic-recovery-evidence')).toBe(sentinel)
      await view.get('[data-test="cancel-ceremony"]').trigger('click')
      await view.get(`[data-test="${entry}"]`).trigger('click')
      expect(
        (view.get('[data-test="legacy-phrase"]').element as HTMLTextAreaElement)
          .value,
      ).toBe('')
      expect(view.find('[data-test="detected-account"]').exists()).toBe(false)
      expect(view.find('[data-test="legacy-unavailable"]').exists()).toBe(false)
      view.unmount()
      for (const spy of [
        scan,
        refuse,
        balance,
        probe,
        saveRelay,
        construct,
        afterActivation,
      ])
        spy.mockRestore()
    }
  },
  30000,
)

test('locked account shows retry, restore, legacy recovery, and reset options', () => {
  Object.assign(mockAccount, {
    status: 'locked',
    account: { displayName: 'Corrupted' },
  })
  const view = render()
  expect(view.find('[data-test="retry-account"]').exists()).toBe(true)
  expect(view.find('[data-test="restore-locked-account"]').exists()).toBe(true)
  expect(view.find('[data-test="legacy-locked-recovery"]').exists()).toBe(true)
  expect(view.find('[data-test="reset-account-storage"]').exists()).toBe(true)
  view.unmount()
})

test('clicking legacy recovery on locked account opens legacy phrase form', async () => {
  Object.assign(mockAccount, {
    status: 'locked',
    account: { displayName: 'Corrupted' },
  })
  const view = render()
  await view.get('[data-test="legacy-locked-recovery"]').trigger('click')
  await flushPromises()
  expect(view.find('[data-test="legacy-phrase"]').exists()).toBe(true)
  view.unmount()
})

test('clicking reset storage on locked account invokes accountSession.reset()', async () => {
  jest.mocked(mockSession.reset).mockClear()
  Object.assign(mockAccount, {
    status: 'locked',
    account: { displayName: 'Corrupted' },
  })
  // Mock window.confirm to return true
  const originalConfirm = window.confirm
  window.confirm = jest.fn(() => true)
  try {
    const view = render()
    await view.get('[data-test="reset-account-storage"]').trigger('click')
    await flushPromises()
    expect(mockSession.reset).toHaveBeenCalledTimes(1)
    view.unmount()
  } finally {
    window.confirm = originalConfirm
  }
})

test('invalid identification stays local and retains its input without claiming a candidate', async () => {
  const view = render()
  await view.get('[data-test="legacy-recovery"]').trigger('click')
  const phrase = 'not a valid mnemonic'
  await view.get('[data-test="legacy-phrase"]').setValue(phrase)
  await view.get('form').trigger('submit')
  await flushPromises()
  expect(
    (view.get('[data-test="legacy-phrase"]').element as HTMLTextAreaElement)
      .value,
  ).toBe(phrase)
  expect(view.find('[data-test="account-error"]').exists()).toBe(true)
  expect(view.find('[data-test="detected-account"]').exists()).toBe(false)
  expect(view.find('[data-test="legacy-unavailable"]').exists()).toBe(false)
  expect(mockSession.snapshot).not.toHaveBeenCalled()
  expect(mockSession.reset).not.toHaveBeenCalled()
  expect(mockSession.stage).not.toHaveBeenCalled()
  expect(mockSession.activatePending).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  view.unmount()
})

test.each(['en', 'fr'] as const)(
  'shows the identity a pending attempt would activate, and what to do if it is unexpected (%s)',
  async locale => {
    const address = '0x1234567890abcdef1234567890ABCDEF12345678'
    Object.assign(mockAccount, {
      status: 'pending',
      pending,
      pendingReady: true,
      pendingIdentityAddress: address,
    })
    const view = render(locale)
    expect(view.get('[data-test="pending-identity-address"]').text()).toBe(
      address,
    )
    const words = (locale === 'fr' ? fr : en).accountRecovery
    const shown = view.get('[data-test="pending-identity"]').text()
    expect(shown).toContain(words.pending_identity_address)
    expect(shown).toContain(words.pending_identity_stop_if_unexpected)
    expect(view.find('[data-test="activate-account"]').exists()).toBe(true)
  },
)

test('offers no Activate button while the identity of the attempt is unknown', async () => {
  Object.assign(mockAccount, {
    status: 'pending',
    pending,
    pendingReady: true,
    pendingIdentityAddress: null,
  })
  const view = render()
  expect(view.find('[data-test="pending-identity"]').exists()).toBe(false)
  expect(view.find('[data-test="activate-account"]').exists()).toBe(false)
})

test.each(['en', 'fr'] as const)(
  'an attempt saved before account roots were kept says it must be cancelled and redone (%s)',
  async locale => {
    Object.assign(mockAccount, {
      status: 'pending',
      pending,
      pendingReady: false,
      pendingIdentityAddress: null,
      pendingError: 'outdated-attempt',
    })
    const view = render(locale)
    expect(view.get('[data-test="pending-outdated"]').text()).toBe(
      (locale === 'fr' ? fr : en).accountRecovery
        .pending_outdated_cancel_and_redo,
    )
    // Retrying cannot help, so it is not offered; cancelling is.
    expect(view.find('[data-test="pending-error"]').exists()).toBe(false)
    expect(view.find('[data-test="retry-pending"]').exists()).toBe(false)
    expect(view.find('[data-test="activate-account"]').exists()).toBe(false)
    expect(view.find('[data-test="cancel-pending"]').exists()).toBe(true)
  },
)
