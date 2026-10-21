/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'
const mockStatus = reactive({
  status: 'fresh',
  revision: 1,
  account: null as object | null,
  pending: null,
})
const mockReceive = jest.fn()
const mockRestore = jest.fn()
const mockNavigate = jest.fn()
const mockRoute = { query: {} as Record<string, string> }
let mockLeaveGuard: (() => boolean) | null = null
jest.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  onBeforeRouteLeave: (guard: () => boolean) => {
    mockLeaveGuard = guard
  },
}))
jest.mock('../accounts/session', () => ({ accountStatus: mockStatus }))
jest.mock('../utils/extension-account-sync', () => ({
  canReceiveSyncedAccount: () =>
    mockStatus.status === 'fresh' && !mockStatus.account && !mockStatus.pending,
  receiveAccountOverBridge: (...args: unknown[]) => mockReceive(...args),
  restoreAccountFromExtensionBundle: (...args: unknown[]) =>
    mockRestore(...args),
  requestWebAccountSyncSender: () => mockNavigate(),
}))
import AccountSyncReceive from './AccountSyncReceive.vue'
function render(messages = enUS) {
  return mount(AccountSyncReceive, {
    global: {
      mocks: {
        $t: (key: string) =>
          key
            .split('.')
            .reduce<unknown>(
              (value, part) =>
                (value as Record<string, unknown> | undefined)?.[part],
              messages,
            ) ?? key,
      },
      stubs: {
        QPageContainer: { template: '<main><slot /></main>' },
        QPage: { template: '<section><slot /></section>' },
        QIcon: true,
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable"><slot />{{ label }}</button>',
        },
        QInput: {
          props: ['modelValue', 'disable'],
          template:
            '<input :disabled="disable" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const bundle = { displayName: 'Ann', backupShares: ['share-one', 'share-two'] }
async function enterPin(wrapper: ReturnType<typeof render>, pin = '123456') {
  await wrapper.get('[data-test="sync-pin-input"]').setValue(pin)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
beforeEach(() => {
  mockStatus.status = 'fresh'
  mockStatus.revision = 1
  mockStatus.account = null
  mockRestore.mockReset().mockResolvedValue(true)
  mockReceive.mockReset()
  mockNavigate.mockReset().mockResolvedValue(true)
  mockRoute.query = {}
  mockLeaveGuard = null
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'chrome')
})

describe('full-page account receiver', () => {
  it('restores only after the typed PIN pairs, then offers only Done without redirecting early', async () => {
    const wrapper = render()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(mockRestore).not.toHaveBeenCalled()
    mockReceive.mockResolvedValue({ ok: true, bundle })
    await enterPin(wrapper)
    expect(mockRestore).toHaveBeenCalledWith(bundle, undefined)
    expect(wrapper.findAll('button').map(button => button.text())).toEqual([
      enUS.accountSync.done,
    ])
    expect(wrapper.get('[data-test="sync-done"]').attributes('to')).toBe(
      '/forum',
    )
    wrapper.unmount()
  })
  it.each([
    ['pin-mismatch', 'pinMismatch'],
    ['no-sender', 'noSender'],
    ['expired', 'noSender'],
    ['has-account', 'hasAccount'],
  ])('shows %s without restoring', async (reason, key) => {
    const wrapper = render(frFR)
    mockReceive.mockResolvedValue({ ok: false, reason })
    await enterPin(wrapper)
    expect(wrapper.get('[role="alert"]').text()).toBe(
      (frFR.accountSync as Record<string, string>)[key],
    )
    expect(mockRestore).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('shows bridge rejection and restore failure visibly', async () => {
    const wrapper = render()
    mockReceive.mockRejectedValueOnce(new Error('Bridge unavailable'))
    await enterPin(wrapper)
    expect(wrapper.get('[data-test="sync-pin-error"]').text()).toBe(
      enUS.accountSync.failed,
    )
    expect(mockRestore).not.toHaveBeenCalled()
    mockReceive.mockResolvedValue({ ok: true, bundle })
    mockRestore.mockResolvedValueOnce(false)
    await enterPin(wrapper)
    expect(wrapper.get('[data-test="sync-restore-error"]').text()).toBe(
      enUS.accountSync.restoreFailed,
    )
    expect(wrapper.find('[data-test="sync-done"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('does not submit an incomplete PIN', async () => {
    const wrapper = render()
    await enterPin(wrapper, '12345')
    expect(mockReceive).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it.each(['ready', 'locked', 'standby', 'pending'])(
    'does not pair into a device with status %s',
    async status => {
      mockStatus.status = status
      const wrapper = render()
      expect(wrapper.find('form').exists()).toBe(false)
      expect(wrapper.text()).toContain(enUS.accountSync.hasAccount)
      expect(mockReceive).not.toHaveBeenCalled()
      wrapper.unmount()
    },
  )
  it('asks the existing web tab to open its sender route but never exports or restores on that event', async () => {
    Object.assign(globalThis, { chrome: { runtime: { id: 'extension' } } })
    const wrapper = render()
    await flushPromises()
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockRestore).not.toHaveBeenCalled()
    expect(mockReceive).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(enUS.accountSync.senderOpened)
    wrapper.unmount()
  })
  it('aborts a pending PIN exchange on back/unmount and ignores its late bundle', async () => {
    const pairing = deferred<{ ok: boolean; bundle: typeof bundle }>()
    mockReceive.mockReturnValueOnce(pairing.promise)
    const wrapper = render()
    await enterPin(wrapper)
    const signal = mockReceive.mock.calls[0][2].signal as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
    pairing.resolve({ ok: true, bundle })
    await flushPromises()
    expect(mockRestore).not.toHaveBeenCalled()
  })
  it('aborts pending pairing on account session replacement', async () => {
    const pairing = deferred<{ ok: boolean; bundle: typeof bundle }>()
    mockReceive.mockReturnValueOnce(pairing.promise)
    const wrapper = render()
    await enterPin(wrapper)
    mockStatus.revision += 1
    pairing.resolve({ ok: true, bundle })
    await flushPromises()
    expect(mockRestore).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('prevents leaving during the already-authorized restore and then shows terminal Done', async () => {
    const restoration = deferred<boolean>()
    mockReceive.mockResolvedValue({ ok: true, bundle })
    mockRestore.mockReturnValueOnce(restoration.promise)
    const wrapper = render()
    await enterPin(wrapper)
    expect(mockLeaveGuard?.()).toBe(false)
    restoration.resolve(true)
    await flushPromises()
    expect(mockLeaveGuard?.()).toBe(true)
    expect(wrapper.find('[data-test="sync-done"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('preserves an onboarding continuation but rejects arbitrary return targets', async () => {
    mockRoute.query = {
      returnTo: '/onboard?peer=alice&conversationId=thread-2',
      displayName: 'User chosen name',
    }
    const wrapper = render()
    mockReceive.mockResolvedValue({ ok: true, bundle })
    await enterPin(wrapper)
    expect(mockRestore).toHaveBeenCalledWith(bundle, {
      preferredDisplayName: 'User chosen name',
    })
    expect(wrapper.get('[data-test="sync-done"]').attributes('to')).toBe(
      mockRoute.query.returnTo,
    )
    wrapper.unmount()
    mockRoute.query = { returnTo: '//evil.example' }
    const other = render()
    mockReceive.mockResolvedValue({ ok: true, bundle })
    await enterPin(other)
    expect(other.get('[data-test="sync-done"]').attributes('to')).toBe('/forum')
    other.unmount()
  })
})
