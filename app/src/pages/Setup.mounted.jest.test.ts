/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

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
  useChatStore: () => ({ reset: jest.fn() }),
}))
jest.mock('src/stores/relay-client', () => ({
  useRelayClientStore: () => ({ setToken: jest.fn() }),
}))
jest.mock('src/stores/appearance', () => ({
  useAppearanceStore: () => ({ setDarkMode: jest.fn() }),
}))
let mockProfileName: string | undefined
const mockSetRelayData = jest.fn()
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: mockProfileName },
    setRelayData: mockSetRelayData,
  }),
}))
jest.mock('../utils/setup-account', () => {
  const actual = jest.requireActual('../utils/setup-account')
  return {
    ...actual,
    commitValidatedSetupSeed: jest.fn(actual.commitValidatedSetupSeed),
  }
})

import Setup from './Setup.vue'
import { useWalletStore } from 'src/stores/wallet'
import { commitValidatedSetupSeed } from '../utils/setup-account'

const STORED = 'test test test test test test test test test test test junk'

async function mountSetup() {
  const wallet = useWalletStore()
  const setSeed = jest.fn()
  wallet.$onAction(({ name }) => {
    if (name === 'setSeedPhrase') setSeed()
  })
  const wrapper = shallowMount(Setup, {
    global: {
      stubs: Object.fromEntries(
        [
          'q-header',
          'q-toolbar',
          'q-toolbar-title',
          'q-btn',
          'q-page-container',
          'q-page',
          'q-stepper',
          'q-step',
          'q-stepper-navigation',
          'q-banner',
        ].map(name => [name, true]),
      ),
      mocks: {
        $t: (k: string) => k,
        $q: { loading: { show: jest.fn(), hide: jest.fn() } },
      },
    },
  })
  await nextTick()
  return { wallet, setSeed, wrapper }
}

// The Setup.vue `import.meta.url` asset lookups load via
// test/jest/vue-import-meta-transform.js.
describe('Setup page mounted (#267)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    Object.defineProperty(window, 'Image', {
      configurable: true,
      value: class {
        set src(_: string) {
          /* never loads */
        }
      },
    })
  })

  it('offers a 12-word in-memory draft without touching the wallet store', async () => {
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as { accountData: { seed: string } }

    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBeNull()
    expect(vm.accountData.seed.split(' ')).toHaveLength(12)
    expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
  })

  it('keeps the same draft across re-renders', async () => {
    const { wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as { accountData: { seed: string } }
    const draft = vm.accountData.seed

    await wrapper.setProps({})
    ;(wrapper.vm as unknown as { step: number }).step = 2
    await nextTick()
    await wrapper.vm.$forceUpdate()
    await nextTick()

    expect(vm.accountData.seed).toBe(draft)
  })

  it('never touches or overwrites an already stored seed', async () => {
    setActivePinia(createPinia())
    useWalletStore().seedPhrase = STORED
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as { accountData: { seed: string } }

    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBe(STORED)
    expect(vm.accountData.seed).toBe(STORED)
  })

  type Vm = {
    accountData: { seed: string; name: string; nameRequired: boolean }
    step: number
    avatar: string
    challenge: { seed: string; positions: number[] } | null
    isSeedConfirmed: boolean
    persistSetupAndReload: () => Promise<void>
    onSeedConfirmed: () => void
    next: () => Promise<void>
  }
  async function newAccountVm() {
    const ctx = await mountSetup()
    const vm = ctx.wrapper.vm as unknown as Vm
    vm.step = 2
    vm.accountData.name = 'Alice'
    vm.accountData.nameRequired = true
    vm.persistSetupAndReload = jest.fn(() => Promise.resolve())
    vm.avatar = 'data:avatar'
    await nextTick()
    return { ...ctx, vm }
  }

  it('New Account: Next on the account step does NOT commit; it opens the confirmation step', async () => {
    const { wallet, setSeed, vm } = await newAccountVm()

    await vm.next()
    await nextTick()

    expect(vm.step).toBe(3)
    expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBeNull()
    expect(vm.persistSetupAndReload).not.toHaveBeenCalled()
  })

  it('New Account: cannot reach the commit without a confirmation', async () => {
    const { wallet, setSeed, vm } = await newAccountVm()
    await vm.next()
    await nextTick()

    await vm.next()
    await vm.next()

    expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBeNull()
    expect(wallet.seedConfirmedAt).toBeNull()
    expect(vm.persistSetupAndReload).not.toHaveBeenCalled()
  })

  it('New Account: after confirmation the seed is committed once, with the marker', async () => {
    const { wallet, setSeed, vm } = await newAccountVm()
    const draft = vm.accountData.seed
    await vm.next()
    await nextTick()
    vm.onSeedConfirmed()
    const before = Date.now()

    await vm.next()

    expect(commitValidatedSetupSeed).toHaveBeenCalledTimes(1)
    expect(setSeed).toHaveBeenCalledTimes(1)
    expect(wallet.seedPhrase).toBe(draft)
    expect(wallet.seedConfirmedAt).toBeGreaterThanOrEqual(before)
    expect(vm.persistSetupAndReload).toHaveBeenCalledTimes(1)
  })

  it('a confirmation does not carry over to a different phrase', async () => {
    const { wallet, setSeed, vm } = await newAccountVm()
    await vm.next()
    await nextTick()
    vm.onSeedConfirmed()
    expect(vm.isSeedConfirmed).toBe(true)

    // User goes back and refreshes the phrase.
    vm.step = 2
    vm.accountData.seed = STORED
    await nextTick()
    expect(vm.isSeedConfirmed).toBe(false)
    vm.step = 3
    await vm.next()

    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBeNull()
  })

  it('challenge positions are stable across re-renders and regenerated for a new phrase', async () => {
    const { wrapper, vm } = await newAccountVm()
    vm.step = 3
    await nextTick()
    const first = vm.challenge
    expect(first?.positions).toHaveLength(3)
    expect(new Set(first?.positions).size).toBe(3)

    await wrapper.vm.$forceUpdate()
    await nextTick()
    vm.step = 2
    await nextTick()
    vm.step = 3
    await nextTick()
    expect(vm.challenge).toBe(first)

    vm.step = 2
    vm.accountData.seed = STORED
    await nextTick()
    vm.step = 3
    await nextTick()
    expect(vm.challenge).not.toBe(first)
    expect(vm.challenge?.seed).toBe(STORED)
  })

  it('import replaces the draft: the imported phrase is what is stored', async () => {
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as {
      accountData: { seed: string; name: string; nameRequired: boolean }
      step: number
      next: () => Promise<void>
      avatar: string
    }
    vm.step = 2
    vm.accountData = { seed: STORED, name: '', nameRequired: false }
    vm.avatar = 'data:avatar'
    ;(
      vm as unknown as { persistSetupAndReload: unknown }
    ).persistSetupAndReload = jest.fn(() => Promise.resolve())

    await vm.next()

    expect(setSeed).toHaveBeenCalledTimes(1)
    expect(wallet.seedPhrase).toBe(STORED)
    // Import needs no confirmation step and is marked confirmed at import.
    expect(wallet.seedConfirmedAt).toEqual(expect.any(Number))
    expect(vm.step).toBe(2)
  })

  it('an existing stored seed and its (absent) marker are untouched by opening /setup', async () => {
    setActivePinia(createPinia())
    useWalletStore().seedPhrase = STORED
    const { wallet, setSeed } = await mountSetup()

    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBe(STORED)
    expect(wallet.seedConfirmedAt).toBeNull()
  })

  describe('resume mode for a stored seed with no name (#284, the old #267 bug)', () => {
    async function resumeVm() {
      setActivePinia(createPinia())
      useWalletStore().seedPhrase = STORED
      const ctx = await mountSetup()
      const vm = ctx.wrapper.vm as unknown as Vm & {
        resume: boolean
        storedSeed: string | null
      }
      vm.persistSetupAndReload = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'
      vm.step = 2
      vm.accountData.name = 'Alice'
      vm.accountData.nameRequired = true
      await nextTick()
      return { ...ctx, vm }
    }

    beforeEach(() => {
      mockProfileName = undefined
    })

    it('shows the STORED phrase and does not regenerate or store anything on open', async () => {
      const { wallet, setSeed, vm } = await resumeVm()
      expect(vm.resume).toBe(true)
      expect(vm.accountData.seed).toBe(STORED)
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
    })

    it('needs the confirmation before anything is written', async () => {
      const { wallet, setSeed, vm } = await resumeVm()
      await vm.next()
      await nextTick()
      expect(vm.step).toBe(3)
      await vm.next()
      expect(setSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(wallet.seedConfirmedAt).toBeNull()
    })

    it('confirming re-stores the identical seed with the marker and sets the name', async () => {
      const { wallet, vm } = await resumeVm()
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()
      await vm.next()

      expect(wallet.seedPhrase).toBe(STORED)
      expect(wallet.seedConfirmedAt).toEqual(expect.any(Number))
      expect(mockSetRelayData).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ name: 'Alice' }),
        }),
      )
    })

    it('refuses to replace the stored phrase with a different one', async () => {
      const { wallet, setSeed, vm } = await resumeVm()
      await vm.next()
      await nextTick()
      vm.accountData.seed =
        'legal winner thank year wave sausage worth useful legal winner thank yellow'
      vm.onSeedConfirmed()

      // The changed phrase is unconfirmed, so the commit is blocked at step 3...
      await vm.next()
      expect(setSeed).not.toHaveBeenCalled()

      // ...and even a forced confirmation cannot overwrite the stored seed.
      ;(vm as unknown as { confirmedSeed: string }).confirmedSeed =
        vm.accountData.seed
      await expect(vm.next()).rejects.toThrow()
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
    })

    it('a stored seed WITH a name is not resume mode (completed-old is unaffected)', async () => {
      mockProfileName = 'Alice'
      setActivePinia(createPinia())
      useWalletStore().seedPhrase = STORED
      const { wrapper } = await mountSetup()
      expect((wrapper.vm as unknown as { resume: boolean }).resume).toBe(false)
    })

    it('a fresh device (no seed) is not resume mode', async () => {
      const { wrapper } = await mountSetup()
      expect((wrapper.vm as unknown as { resume: boolean }).resume).toBe(false)
    })
  })
})
