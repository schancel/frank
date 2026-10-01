/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, nextTick } from 'vue'
import type { LevelDB } from 'level'

jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../adapters/pinia-relay-adapter', () => ({
  getRelayClient: jest.fn(),
}))
jest.mock('@frank/cashweb/registry', () => ({ RegistryHandler: jest.fn() }))
jest.mock('@frank/cashweb/pop', () => ({ __esModule: true, default: {} }))
jest.mock('../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('src/stores/contacts', () => ({
  defaultRelayData: { profile: {}, inbox: { acceptancePrice: 0 } },
  useContactStore: () => ({
    updateInterval: 10_000,
    setUpdateInterval: jest.fn(),
  }),
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({ reset: jest.fn(), restored: Promise.resolve(true) }),
}))
jest.mock('src/stores/relay-client', () => ({
  useRelayClientStore: () => ({ setToken: jest.fn() }),
}))
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () => ({ setDarkMode: jest.fn() }),
}))

const mockFlushProfile = jest.fn(() => Promise.resolve())
const mockSetRelayData = jest.fn()
const mockProfile = { name: 'Alice' as string | undefined }
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: mockProfile,
    setRelayData: mockSetRelayData,
    flushPersistence: () => mockFlushProfile(),
    restored: Promise.resolve(true),
  }),
}))
jest.mock('../utils/monad-identity-session', () => ({
  initializeMonadIdentity: jest.fn(async () => 'started'),
  configureMonadIdentitySession: jest.fn(),
}))

import Setup from './Setup.vue'
import { useWalletStore } from 'src/stores/wallet'
import { initializeMonadIdentity } from '../utils/monad-identity-session'
import { errorNotify } from '../utils/notifications'
import { createStoragePlugin } from '../boot/pinia'
import { classifyAccount } from '../utils/account-state'

const STORED = 'test test test test test test test test test test test junk'
const OTHER =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

const SlotStub = defineComponent({ template: '<div><slot /></div>' })
const StepperStub = defineComponent({
  template: '<div><slot /><slot name="navigation" /></div>',
})
const QBtnStub = defineComponent({
  inheritAttrs: false,
  props: {
    disable: { type: Boolean, default: false },
    label: { type: String, default: '' },
  },
  emits: ['click'],
  template:
    '<button :disabled="disable || undefined" @click="$emit(\'click\')">{{ label }}</button>',
})
const routerPush = jest.fn(() => Promise.resolve())

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function mountFinish(options: { productionWallet?: boolean } = {}) {
  const wallet = useWalletStore()
  if (!options.productionWallet) {
    wallet.flushPersistence = jest.fn(() => Promise.resolve())
  }
  const wrapper = shallowMount(Setup, {
    global: {
      stubs: {
        'QPageContainer': SlotStub,
        'QPage': SlotStub,
        'q-header': true,
        'q-toolbar': true,
        'q-toolbar-title': true,
        'q-btn': QBtnStub,
        'q-stepper': StepperStub,
        'q-step': SlotStub,
        'q-stepper-navigation': SlotStub,
        'q-banner': true,
      },
      mocks: {
        $t: (key: string) => key,
        $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        $router: { push: routerPush },
      },
    },
  })
  await nextTick()
  const vm = wrapper.vm as unknown as {
    step: number
    avatar: string
    accountData: {
      seed: string
      name: string
      nameRequired: boolean
      valid?: boolean
    }
    onSeedConfirmed: () => void
    next: () => Promise<void>
    acknowledgeReplace: () => void
    acknowledgeResumeImport: () => void
    completionPending: boolean
    completionPhase: string
    forwardEnabled: boolean
    selectRandomAvatar: () => Promise<string>
  }
  vm.avatar = 'data:avatar'
  return { wallet, vm, wrapper }
}

function installProductionStoragePinia(storage: LevelDB) {
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage,
      Promise.resolve({ networkName: 'test', version: 4 }),
    ),
  )
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}

describe('Setup finish lifecycle (#389)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    ;(initializeMonadIdentity as jest.Mock).mockResolvedValue('started')
    routerPush.mockResolvedValue(undefined)
    mockFlushProfile.mockImplementation(() => Promise.resolve())
    mockProfile.name = 'Alice'
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: class {
        set src(_: string) {
          /* never loads */
        }
      },
    })
    delete (window as { __frankStay?: string }).__frankStay
  })

  it('New Account finish initializes once and opens the forum without reload', async () => {
    const { wallet, vm } = await mountFinish()
    const draft = vm.accountData.seed
    ;(window as { __frankStay?: string }).__frankStay = 'stay'
    vm.step = 2
    vm.accountData.name = 'Alice'
    vm.accountData.nameRequired = true
    vm.accountData.valid = true

    await vm.next()
    await nextTick()
    expect(initializeMonadIdentity).not.toHaveBeenCalled()

    vm.onSeedConfirmed()
    await vm.next()

    expect(wallet.seedPhrase).toBe(draft)
    expect(initializeMonadIdentity).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/forum')
    expect((window as { __frankStay?: string }).__frankStay).toBe('stay')
    expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
    expect(mockFlushProfile).toHaveBeenCalledTimes(1)
  })

  it('Import finish initializes once and opens the forum without reload', async () => {
    const { wallet, vm } = await mountFinish()
    ;(window as { __frankStay?: string }).__frankStay = 'stay'
    vm.step = 2
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await vm.next()

    expect(wallet.seedPhrase).toBe(STORED)
    expect(initializeMonadIdentity).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/forum')
    expect((window as { __frankStay?: string }).__frankStay).toBe('stay')
  })

  it('never starts the profile mutation when the wallet write fails', async () => {
    mockProfile.name = undefined
    const initialWallet = useWalletStore()
    initialWallet.seedPhrase = STORED
    initialWallet.seedConfirmedAt = 5
    const { wallet, vm } = await mountFinish()
    const failure = new Error('wallet disk full')
    ;(wallet.flushPersistence as jest.Mock).mockRejectedValue(failure)
    vm.acknowledgeResumeImport()
    vm.step = 2
    vm.accountData = {
      seed: OTHER,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('wallet disk full')

    expect(wallet.seedPhrase).toBe(OTHER)
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(mockFlushProfile).not.toHaveBeenCalled()
    expect(initializeMonadIdentity).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('terminal')
    expect(vm.forwardEnabled).toBe(false)
    expect(
      classifyAccount({
        seedPhrase: STORED,
        seedConfirmedAt: 5,
        name: undefined,
      }),
    ).toBe('needs-recovery')
  })

  it('serializes completion and leaves a profile persistence failure terminal', async () => {
    const profileWrite = deferred()
    mockFlushProfile.mockImplementationOnce(() => profileWrite.promise)
    const persisted = jest.fn(async () => false)
    const persist = jest.fn(async () => true)
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted, persist },
    })

    try {
      const { wallet, vm, wrapper } = await mountFinish()
      const setSeedPhrase = jest.spyOn(wallet, 'setSeedPhrase')
      vm.step = 2
      vm.accountData = {
        seed: STORED,
        name: '',
        nameRequired: false,
        valid: true,
      }

      const first = vm.next()
      const firstFailure = expect(first).rejects.toThrow('disk full')
      await flushPromises()
      const duplicate = vm.next()
      await flushPromises()
      await nextTick()

      expect(vm.completionPending).toBe(true)
      expect(vm.forwardEnabled).toBe(false)
      const nextButton = wrapper
        .findAll('button')
        .find(button => button.text() === 'setup.accountSetupNext')
      expect(nextButton?.attributes('disabled')).toBeDefined()
      expect(setSeedPhrase).toHaveBeenCalledTimes(1)
      expect(mockSetRelayData).toHaveBeenCalledTimes(1)
      expect(persisted).toHaveBeenCalledTimes(1)
      expect(persist).toHaveBeenCalledTimes(1)
      expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
      expect(mockFlushProfile).toHaveBeenCalledTimes(1)
      expect(
        (wallet.flushPersistence as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan(mockSetRelayData.mock.invocationCallOrder[0])
      expect(initializeMonadIdentity).not.toHaveBeenCalled()
      expect(routerPush).not.toHaveBeenCalled()

      profileWrite.reject(new Error('disk full'))
      await firstFailure
      await duplicate
      await nextTick()
      expect(vm.completionPending).toBe(false)
      expect(vm.completionPhase).toBe('terminal')
      expect(vm.forwardEnabled).toBe(false)
      expect(errorNotify).toHaveBeenCalledTimes(1)

      await vm.next()

      expect(setSeedPhrase).toHaveBeenCalledTimes(1)
      expect(mockSetRelayData).toHaveBeenCalledTimes(1)
      expect(persisted).toHaveBeenCalledTimes(1)
      expect(persist).toHaveBeenCalledTimes(1)
      expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
      expect(mockFlushProfile).toHaveBeenCalledTimes(1)
      expect(initializeMonadIdentity).not.toHaveBeenCalled()
      expect(routerPush).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: undefined,
      })
    }
  })

  it('does not reload or mutate the profile while a later physical wallet write is outstanding behind a poisoned barrier', async () => {
    mockProfile.name = undefined
    const priorFailure = new Error('prior disk failure')
    const laterWrite = deferred()
    const put = jest.fn<Promise<void>, [string, string]>()
    put
      .mockRejectedValueOnce(priorFailure)
      .mockReturnValueOnce(laterWrite.promise)
    const storage = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          seedPhrase: STORED,
          seedConfirmedAt: 5,
          xPrivKey: null,
        }),
      ),
      put,
    } as unknown as LevelDB
    const pinia = installProductionStoragePinia(storage)
    const wallet = useWalletStore(pinia)
    await wallet.restored
    await nextTick()
    await expect(wallet.flushPersistence()).rejects.toThrow(
      'prior disk failure',
    )

    const { vm, wrapper } = await mountFinish({
      productionWallet: true,
    })
    vm.acknowledgeResumeImport()
    vm.step = 2
    vm.accountData = {
      seed: OTHER,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('prior disk failure')

    expect(put).toHaveBeenCalledTimes(2)
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(mockFlushProfile).not.toHaveBeenCalled()
    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('terminal')
    expect(vm.forwardEnabled).toBe(false)
    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(initializeMonadIdentity).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    const nextButton = wrapper
      .findAll('button')
      .find(button => button.text() === 'setup.accountSetupNext')
    expect(nextButton?.attributes('disabled')).toBeDefined()

    await vm.next()
    await nextTick()
    expect(put).toHaveBeenCalledTimes(2)
    laterWrite.resolve()
    await laterWrite.promise
  })

  it('clears the pending guard when avatar selection fails before any write', async () => {
    const { wallet, vm } = await mountFinish()
    const setSeedPhrase = jest.spyOn(wallet, 'setSeedPhrase')
    vm.step = 2
    vm.avatar = ''
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }
    vm.selectRandomAvatar = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('avatar unavailable'))
      .mockResolvedValue('data:avatar')

    await expect(vm.next()).rejects.toThrow('avatar unavailable')

    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('editing')
    expect(vm.forwardEnabled).toBe(true)
    expect(setSeedPhrase).not.toHaveBeenCalled()
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledTimes(1)

    await vm.next()

    expect(setSeedPhrase).toHaveBeenCalledTimes(1)
    expect(mockSetRelayData).toHaveBeenCalledTimes(1)
    expect(initializeMonadIdentity).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledTimes(1)
  })

  it('reports a synchronous post-write failure once and remains terminal', async () => {
    const { wallet, vm } = await mountFinish()
    const originalSetSeedPhrase = wallet.setSeedPhrase.bind(wallet)
    jest.spyOn(wallet, 'setSeedPhrase').mockImplementation((seed, at) => {
      originalSetSeedPhrase(seed, at)
      throw new Error('synchronous wallet failure')
    })
    vm.step = 2
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('synchronous wallet failure')

    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('terminal')
    expect(vm.forwardEnabled).toBe(false)
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(wallet.flushPersistence).not.toHaveBeenCalled()
  })

  it('reports an initialization failure once and serializes a retry without rewriting stores', async () => {
    const retryInitialization = deferred()
    ;(initializeMonadIdentity as jest.Mock)
      .mockRejectedValueOnce(new Error('identity unavailable'))
      .mockReturnValueOnce(retryInitialization.promise)
    const { wallet, vm } = await mountFinish()
    const setSeedPhrase = jest.spyOn(wallet, 'setSeedPhrase')
    vm.step = 2
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('identity unavailable')

    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('entering')
    expect(vm.forwardEnabled).toBe(true)
    expect(setSeedPhrase).toHaveBeenCalledTimes(1)
    expect(mockSetRelayData).toHaveBeenCalledTimes(1)
    expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
    expect(mockFlushProfile).toHaveBeenCalledTimes(1)

    const retry = vm.next()
    await flushPromises()
    const duplicate = vm.next()
    await flushPromises()
    expect(vm.completionPending).toBe(true)
    expect(initializeMonadIdentity).toHaveBeenCalledTimes(2)

    retryInitialization.resolve()
    await retry
    await duplicate

    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(setSeedPhrase).toHaveBeenCalledTimes(1)
    expect(mockSetRelayData).toHaveBeenCalledTimes(1)
    expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
    expect(mockFlushProfile).toHaveBeenCalledTimes(1)
    expect(vm.completionPhase).toBe('completed')
    expect(errorNotify).toHaveBeenCalledTimes(1)
  })

  it('reports a navigation failure once and serializes a retry without rewriting stores', async () => {
    const retryNavigation = deferred()
    routerPush
      .mockRejectedValueOnce(new Error('navigation unavailable'))
      .mockReturnValueOnce(retryNavigation.promise)
    const { wallet, vm } = await mountFinish()
    const setSeedPhrase = jest.spyOn(wallet, 'setSeedPhrase')
    vm.step = 2
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('navigation unavailable')

    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(vm.completionPending).toBe(false)
    expect(vm.completionPhase).toBe('entering')
    expect(vm.forwardEnabled).toBe(true)

    const retry = vm.next()
    await flushPromises()
    const duplicate = vm.next()
    await flushPromises()
    expect(vm.completionPending).toBe(true)
    expect(routerPush).toHaveBeenCalledTimes(2)

    retryNavigation.resolve()
    await retry
    await duplicate

    expect(initializeMonadIdentity).toHaveBeenCalledTimes(2)
    expect(setSeedPhrase).toHaveBeenCalledTimes(1)
    expect(mockSetRelayData).toHaveBeenCalledTimes(1)
    expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
    expect(mockFlushProfile).toHaveBeenCalledTimes(1)
    expect(vm.completionPhase).toBe('completed')
    expect(errorNotify).toHaveBeenCalledTimes(1)
  })

  it('replace finish tears down by initializing the new seed in place', async () => {
    useWalletStore().seedPhrase = STORED
    useWalletStore().seedConfirmedAt = 5
    const { wallet, vm } = await mountFinish()
    vm.acknowledgeReplace()
    vm.step = 2
    vm.accountData = {
      seed: OTHER,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await vm.next()

    expect(wallet.seedPhrase).toBe(OTHER)
    expect(initializeMonadIdentity).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/forum')
  })
})
