/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import en from '../i18n/en-us'

const mockImportBip39Wallet = jest.fn(
  async (phrase: string, chosenPath?: string) => ({
    path: chosenPath ?? "m/44'/60'/1'/0/0",
    address: '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650',
    label: 'Canonical Frank',
  }),
)

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
  importBip39Wallet: (...args: any[]) => mockImportBip39Wallet(...args),
}))
jest.mock('../accounts/ceremony', () => ({
  createAccountCeremony: () => ({ cancel: jest.fn() }),
  recoveryErrorMessage: () => 'Account operation failed',
}))
const mockPush = jest.fn(async () => undefined)
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))
const { accountStatus: mockAccount, accountSession: mockSession } =
  jest.requireMock('../accounts/session')
const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value[part], en)
const pending = {
  status: 'staging',
  account: {
    displayName: 'Synthetic account',
    descriptor: 'PUBLIC',
    receipt: { operationId: 'attempt' },
  },
  expectedActive: { revision: 0, accountId: null },
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
          template: '<button :disabled="disable">{{ label }}</button>',
        },
        QCheckbox: true,
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
    pendingError: null,
  })
  await inspectLegacyWallet({
    get: async () => {
      throw { notFound: true }
    },
  })
  mockPush.mockClear()
  mockSession.retry.mockClear()
  mockSession.activatePending.mockImplementation(async () => {
    mockAccount.status = 'ready'
    mockAccount.revision = 1
    mockAccount.pending = null
  })
  localStorage.clear()
})
afterEach(() => {
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
    Object.assign(mockAccount, { pending, pendingReady: true })
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

test('choice screen labels the import button "Import BIP39 seed"', () => {
  const view = render()
  const importBtn = view.get('[data-test="legacy-recovery"]')
  expect(importBtn.text()).toBe('Import BIP39 seed')
  view.unmount()
})

test('submitting BIP-39 phrase in legacy mode runs derivation scanner, stages/activates wallet, and navigates to /wallet', async () => {
  mockImportBip39Wallet.mockClear()
  mockPush.mockClear()
  const view = render()

  // Switch to legacy / import seed mode
  await view.get('[data-test="legacy-recovery"]').trigger('click')
  await flushPromises()

  expect(view.find('form').exists()).toBe(true)

  // Input phrase
  const phraseInput = view.get('[data-test="legacy-phrase"]')
  await phraseInput.setValue(
    'test test test test test test test test test test test junk',
  )
  await flushPromises()

  // Submit form
  await view.get('form').trigger('submit')
  await flushPromises()

  expect(mockImportBip39Wallet).toHaveBeenCalledWith(
    'test test test test test test test test test test test junk',
    "m/44'/60'/1'/0/0",
  )
  expect(mockPush).toHaveBeenCalledWith('/wallet')
  view.unmount()
}, 10000)

