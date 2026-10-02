/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, nextTick } from 'vue'
import type { LevelDB } from 'level'

jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({
    loadData: jest.fn(),
    getUtxoMap: jest.fn(() => new Map()),
  }),
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
jest.mock('../utils/monad-identity-session', () => ({
  initializeMonadIdentity: jest.fn(async () => 'started'),
  setupFinishReloads: jest.fn(() => false),
  configureMonadIdentitySession: jest.fn(),
}))

import Setup from './Setup.vue'
import { useWalletStore } from 'src/stores/wallet'
import { useProfileStore } from 'src/stores/my-profile'
import { createStoragePlugin } from '../boot/pinia'
import { resetSetupCommitLock } from '../utils/setup-lock'

const SEED_A = 'test test test test test test test test test test test junk'
const SEED_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const SEED_REPLACE =
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createSharedLevelStorage(initialData: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initialData))
  const get = jest.fn(async (key: string) => {
    const val = data.get(key)
    if (val === undefined) {
      const err = new Error(`Key ${key} not found`) as Error & {
        notFound: boolean
      }
      err.notFound = true
      throw err
    }
    return val
  })
  const put = jest.fn(async (key: string, value: string) => {
    data.set(key, value)
  })
  return {
    data,
    get,
    put,
  } as unknown as LevelDB & {
    data: Map<string, string>
    get: jest.Mock
    put: jest.Mock
  }
}

function createTabPinia(storage: LevelDB) {
  const pinia = createPinia()
  pinia.use(
    createStoragePlugin(
      storage,
      Promise.resolve({ networkName: 'test', version: 4 }),
    ),
  )
  createApp({}).use(pinia)
  return pinia
}

async function mountTab(pinia: ReturnType<typeof createPinia>) {
  setActivePinia(pinia)
  const wallet = useWalletStore(pinia)
  const profile = useProfileStore(pinia)
  await Promise.all([wallet.restored, profile.restored])
  await nextTick()

  const routerPush = jest.fn(() => Promise.resolve())
  const wrapper = shallowMount(Setup, {
    global: {
      plugins: [pinia],
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
        'ReplaceAccountGuard': true,
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
    guardActive: boolean
    existingAccount: boolean
    resume: boolean
    replaceAcknowledged: boolean
    resumeReplaceAcknowledged: boolean
    currentAccountDigest: string | null
    acknowledgedAccountDigest: string | null
    completionPhase: string
    completionPending: boolean
    forwardEnabled: boolean
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
    selectRandomAvatar: () => Promise<string>
  }
  vm.avatar = 'data:avatar'
  return { pinia, wallet, profile, wrapper, vm, routerPush }
}

describe('Setup concurrent shared-storage regressions (#308)', () => {
  beforeEach(() => {
    resetSetupCommitLock()
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

  it('Schedule 1: Two fresh tabs submit concurrently; one succeeds, the other throws setup.replaceNotAcknowledged without cross-pairing', async () => {
    const storage = createSharedLevelStorage()
    const piniaA = createTabPinia(storage)
    const piniaB = createTabPinia(storage)

    const tabA = await mountTab(piniaA)
    const tabB = await mountTab(piniaB)

    // Tab A prepares submission with SEED_A and Alice
    tabA.vm.step = 2
    tabA.vm.accountData.seed = SEED_A
    tabA.vm.accountData.name = 'Alice'
    tabA.vm.accountData.nameRequired = true
    tabA.vm.accountData.valid = true
    await tabA.vm.next()
    await nextTick()
    expect(tabA.vm.step).toBe(3)
    tabA.vm.onSeedConfirmed()

    // Tab B prepares submission with SEED_B and Bob
    tabB.vm.step = 2
    tabB.vm.accountData.seed = SEED_B
    tabB.vm.accountData.name = 'Bob'
    tabB.vm.accountData.nameRequired = true
    tabB.vm.accountData.valid = true
    await tabB.vm.next()
    await nextTick()
    expect(tabB.vm.step).toBe(3)
    tabB.vm.onSeedConfirmed()

    // Submit concurrently
    const results = await Promise.allSettled([tabA.vm.next(), tabB.vm.next()])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      'setup.replaceNotAcknowledged',
    )

    // Verify stored data in shared storage
    const storedWallet = JSON.parse(storage.data.get('wallet')!)
    const storedProfile = JSON.parse(storage.data.get('myProfile')!)

    // Assert that wallet and profile cannot cross-pair:
    // Either (SEED_A and Alice) OR (SEED_B and Bob), NEVER (SEED_A and Bob) or (SEED_B and Alice)
    const isTabAWinner =
      storedWallet.seedPhrase === SEED_A &&
      storedProfile.profile.name === 'Alice'
    const isTabBWinner =
      storedWallet.seedPhrase === SEED_B && storedProfile.profile.name === 'Bob'
    expect(isTabAWinner || isTabBWinner).toBe(true)

    // The losing tab has guardActive === true
    const loserTab = isTabAWinner ? tabB : tabA
    expect(loserTab.vm.guardActive).toBe(true)
  })

  it('Schedule 2: Tab A stalls during avatar loading; Tab B finishes setup; Tab A attempts commit and is blocked', async () => {
    const storage = createSharedLevelStorage()
    const piniaA = createTabPinia(storage)
    const piniaB = createTabPinia(storage)

    const tabA = await mountTab(piniaA)
    const tabB = await mountTab(piniaB)

    // Tab A prepares submission with SEED_A and Alice
    tabA.vm.step = 2
    tabA.vm.accountData.seed = SEED_A
    tabA.vm.accountData.name = 'Alice'
    tabA.vm.accountData.nameRequired = true
    tabA.vm.accountData.valid = true
    await tabA.vm.next()
    await nextTick()
    tabA.vm.onSeedConfirmed()

    // Tab A has no avatar and stalls in selectRandomAvatar
    tabA.vm.avatar = ''
    const avatarDeferred = deferred<string>()
    tabA.vm.selectRandomAvatar = jest.fn(() => avatarDeferred.promise)

    // Tab A initiates commit, which stalls in avatar loading before acquiring the lock
    const tabACommit = tabA.vm.next()
    await flushPromises()
    expect(tabA.vm.selectRandomAvatar).toHaveBeenCalledTimes(1)
    expect(tabA.vm.completionPending).toBe(true)

    // While Tab A is stalled, Tab B completes setup
    tabB.vm.step = 2
    tabB.vm.accountData.seed = SEED_B
    tabB.vm.accountData.name = 'Bob'
    tabB.vm.accountData.nameRequired = true
    tabB.vm.accountData.valid = true
    await tabB.vm.next()
    await nextTick()
    tabB.vm.onSeedConfirmed()

    await tabB.vm.next()
    expect(tabB.routerPush).toHaveBeenCalledWith('/forum')

    // Verify Tab B is durable in storage
    const storedWalletB = JSON.parse(storage.data.get('wallet')!)
    const storedProfileB = JSON.parse(storage.data.get('myProfile')!)
    expect(storedWalletB.seedPhrase).toBe(SEED_B)
    expect(storedProfileB.profile.name).toBe('Bob')

    // Now Tab A's avatar finishes loading
    avatarDeferred.resolve('data:avatar-alice')
    await expect(tabACommit).rejects.toThrow('setup.replaceNotAcknowledged')

    // Storage remains Tab B's account untouched
    const finalWallet = JSON.parse(storage.data.get('wallet')!)
    const finalProfile = JSON.parse(storage.data.get('myProfile')!)
    expect(finalWallet.seedPhrase).toBe(SEED_B)
    expect(finalProfile.profile.name).toBe('Bob')

    // Tab A's guard is now active
    expect(tabA.vm.guardActive).toBe(true)
  })

  it('Schedule 3: Crash / partial write; Tab A writes wallet, profile fails; Tab B mounts and enters needs-recovery without silent overwrite', async () => {
    const storage = createSharedLevelStorage()
    const piniaA = createTabPinia(storage)

    // Tab A starts setup
    const tabA = await mountTab(piniaA)
    tabA.vm.step = 2
    tabA.vm.accountData.seed = SEED_A
    tabA.vm.accountData.name = 'Alice'
    tabA.vm.accountData.nameRequired = true
    tabA.vm.accountData.valid = true
    await tabA.vm.next()
    await nextTick()
    tabA.vm.onSeedConfirmed()

    // Tab A's wallet write succeeds, but profile write fails
    storage.data.delete('myProfile')
    const originalPut = storage.put.bind(storage)
    storage.put = jest.fn(async (key: string, value: string) => {
      if (key === 'myProfile') {
        throw new Error('disk full on profile write')
      }
      return originalPut(key, value)
    })

    await expect(tabA.vm.next()).rejects.toThrow('disk full on profile write')
    expect(tabA.vm.completionPhase).toBe('terminal')

    // Storage contains wallet but NO profile
    expect(storage.data.has('wallet')).toBe(true)
    expect(storage.data.has('myProfile')).toBe(false)
    const partialWallet = JSON.parse(storage.data.get('wallet')!)
    expect(partialWallet.seedPhrase).toBe(SEED_A)

    // Restore storage.put for subsequent operations
    storage.put = originalPut

    // Now Tab B opens/mounts against this partial storage (simulating new tab or recovery session)
    const piniaB = createTabPinia(storage)
    const tabB = await mountTab(piniaB)

    // Tab B classifies the account as needs-recovery
    expect(tabB.vm.resume).toBe(true)
    expect(tabB.vm.existingAccount).toBe(false)
    expect(tabB.vm.guardActive).toBe(false)

    // If Tab B attempts to import a different seed without acknowledging replace, it is blocked
    tabB.vm.step = 2
    tabB.vm.accountData.seed = SEED_B
    tabB.vm.accountData.name = 'Bob'
    tabB.vm.accountData.nameRequired = false
    tabB.vm.accountData.valid = true

    await expect(tabB.vm.next()).rejects.toThrow('setup.storedSeedMismatch')

    // Tab B did NOT overwrite the stored seed
    const afterAttemptWallet = JSON.parse(storage.data.get('wallet')!)
    expect(afterAttemptWallet.seedPhrase).toBe(SEED_A)
  })

  it('Schedule 4: AUTH-ACK-TARGET invalidation; Tab A acknowledges replacing Account A; Tab B writes Account B; Tab A acknowledgement invalidated', async () => {
    // Storage initially has Account 1 (SEED_A, Alice)
    const storage = createSharedLevelStorage({
      wallet: JSON.stringify({
        seedPhrase: SEED_A,
        seedConfirmedAt: 1000,
        xPrivKey: null,
      }),
      myProfile: JSON.stringify({
        profile: { name: 'Alice', avatar: 'data:avatar-1' },
        inbox: {},
      }),
    })

    const piniaA = createTabPinia(storage)
    const tabA = await mountTab(piniaA)

    // Tab A detects Account 1
    expect(tabA.vm.existingAccount).toBe(true)
    expect(tabA.vm.guardActive).toBe(true)
    const initialDigest = tabA.vm.currentAccountDigest
    expect(initialDigest).toBeTruthy()

    // Tab A acknowledges replacing Account 1
    tabA.vm.acknowledgeReplace()
    expect(tabA.vm.replaceAcknowledged).toBe(true)
    expect(tabA.vm.acknowledgedAccountDigest).toBe(initialDigest)
    expect(tabA.vm.guardActive).toBe(false)

    // Tab A prepares new account
    tabA.vm.step = 2
    tabA.vm.accountData.seed = SEED_REPLACE
    tabA.vm.accountData.name = 'AliceNew'
    tabA.vm.accountData.nameRequired = true
    tabA.vm.accountData.valid = true
    await tabA.vm.next()
    await nextTick()
    tabA.vm.onSeedConfirmed()

    // Meanwhile, Tab B replaces Account 1 with Account 2 in storage
    const piniaB = createTabPinia(storage)
    const tabB = await mountTab(piniaB)
    tabB.vm.acknowledgeReplace()
    tabB.vm.step = 2
    tabB.vm.accountData.seed = SEED_B
    tabB.vm.accountData.name = 'Bob'
    tabB.vm.accountData.nameRequired = true
    tabB.vm.accountData.valid = true
    await tabB.vm.next()
    await nextTick()
    tabB.vm.onSeedConfirmed()
    await tabB.vm.next()

    // Verify Account 2 is now in storage
    const storedWalletB = JSON.parse(storage.data.get('wallet')!)
    const storedProfileB = JSON.parse(storage.data.get('myProfile')!)
    expect(storedWalletB.seedPhrase).toBe(SEED_B)
    expect(storedProfileB.profile.name).toBe('Bob')

    // Now Tab A attempts to commit its replacement
    await expect(tabA.vm.next()).rejects.toThrow('setup.replaceNotAcknowledged')

    // Tab A's replacement acknowledgement was invalidated
    expect(tabA.vm.replaceAcknowledged).toBe(false)
    expect(tabA.vm.acknowledgedAccountDigest).toBeNull()
    expect(tabA.vm.guardActive).toBe(true)

    // Account 2 in storage was NOT overwritten by Tab A
    const finalWallet = JSON.parse(storage.data.get('wallet')!)
    const finalProfile = JSON.parse(storage.data.get('myProfile')!)
    expect(finalWallet.seedPhrase).toBe(SEED_B)
    expect(finalProfile.profile.name).toBe('Bob')
  })
})
