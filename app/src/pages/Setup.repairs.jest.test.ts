/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Setup from './Setup.vue'
import { inspectLegacyWallet } from '../accounts/legacy'
import { usePersistentStorageStore } from '../stores/persistent-storage'
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
  },
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
        QForm: { template: '<form><slot /></form>' },
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
