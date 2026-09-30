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
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({ setRelayData: jest.fn() }),
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

  it('commits the seed exactly once, at the final account step', async () => {
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as {
      accountData: { seed: string; name: string; nameRequired: boolean }
      step: number
      persistSetupAndReload: () => Promise<void>
      next: () => Promise<void>
    }
    const draft = vm.accountData.seed
    vm.step = 2
    vm.accountData.name = 'Alice'
    vm.accountData.nameRequired = true
    vm.persistSetupAndReload = jest.fn(() => Promise.resolve())
    ;(vm as unknown as { avatar: string }).avatar = 'data:avatar'

    await vm.next()

    expect(commitValidatedSetupSeed).toHaveBeenCalledTimes(1)
    expect(setSeed).toHaveBeenCalledTimes(1)
    expect(wallet.seedPhrase).toBe(draft)
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
  })
})
