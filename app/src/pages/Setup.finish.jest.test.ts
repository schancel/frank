/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

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
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: 'Alice' },
    setRelayData: mockSetRelayData,
    flushPersistence: () => mockFlushProfile(),
    restored: Promise.resolve(true),
  }),
}))
jest.mock('../utils/monad-identity-session', () => ({
  initializeMonadIdentity: jest.fn(async () => 'started'),
  setupFinishReloads: jest.fn(() => false),
  configureMonadIdentitySession: jest.fn(),
}))

import Setup from './Setup.vue'
import { useWalletStore } from 'src/stores/wallet'
import {
  initializeMonadIdentity,
  setupFinishReloads,
} from '../utils/monad-identity-session'
import { errorNotify } from '../utils/notifications'

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

async function mountFinish() {
  const wallet = useWalletStore()
  wallet.flushPersistence = jest.fn(() => Promise.resolve())
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
    completionPending: boolean
    forwardEnabled: boolean
  }
  vm.avatar = 'data:avatar'
  return { wallet, vm, wrapper }
}

describe('Setup finish does not reload (#389)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    ;(setupFinishReloads as jest.Mock).mockReturnValue(false)
    mockFlushProfile.mockImplementation(() => Promise.resolve())
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

  it('a failed profile write never initializes or navigates', async () => {
    const { wallet, vm } = await mountFinish()
    mockFlushProfile.mockImplementation(() =>
      Promise.reject(new Error('disk full')),
    )
    vm.step = 2
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    }

    await expect(vm.next()).rejects.toThrow('disk full')

    expect(wallet.seedPhrase).toBe(STORED)
    expect(initializeMonadIdentity).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error))
  })

  it('serializes completion and clears the pending guard for a retry after failure', async () => {
    let rejectFirstFlush!: (error: Error) => void
    const firstFlush = new Promise<void>((_resolve, reject) => {
      rejectFirstFlush = reject
    })
    mockFlushProfile.mockImplementationOnce(() => firstFlush)
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
      expect(initializeMonadIdentity).not.toHaveBeenCalled()
      expect(routerPush).not.toHaveBeenCalled()

      rejectFirstFlush(new Error('disk full'))
      await firstFailure
      await duplicate
      await nextTick()
      expect(vm.completionPending).toBe(false)
      expect(vm.forwardEnabled).toBe(true)

      await vm.next()

      expect(setSeedPhrase).toHaveBeenCalledTimes(2)
      expect(mockSetRelayData).toHaveBeenCalledTimes(2)
      expect(persisted).toHaveBeenCalledTimes(2)
      expect(persist).toHaveBeenCalledTimes(2)
      expect(wallet.flushPersistence).toHaveBeenCalledTimes(2)
      expect(mockFlushProfile).toHaveBeenCalledTimes(2)
      expect(initializeMonadIdentity).toHaveBeenCalledTimes(1)
      expect(routerPush).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: undefined,
      })
    }
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
