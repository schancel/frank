/** @jest-environment jsdom */

import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { QStep, QStepper, QStepperNavigation } from 'quasar'
import { defineComponent, nextTick, type App } from 'vue'

import enUs from '../i18n/en-us'
import frFr from '../i18n/fr-fr'

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
const mockFlushProfile = jest.fn(() => Promise.resolve())
const mockRouterPush = jest.fn()
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: mockProfileName },
    setRelayData: mockSetRelayData,
    flushPersistence: mockFlushProfile,
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
import AccountStep from '../components/setup/AccountStep.vue'
import ReplaceAccountGuard from '../components/setup/ReplaceAccountGuard.vue'
import { useWalletStore } from 'src/stores/wallet'
import { commitValidatedSetupSeed } from '../utils/setup-account'

const STORED = 'test test test test test test test test test test test junk'
const OTHER =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const SlotStub = defineComponent({ template: '<div><slot /></div>' })

const QBtnStub = defineComponent({
  inheritAttrs: false,
  props: {
    ariaLabel: { type: String, default: '' },
    disable: { type: Boolean, default: false },
    label: { type: String, default: '' },
  },
  emits: ['click'],
  template:
    '<button v-bind="$attrs" :aria-label="ariaLabel" :disabled="disable || undefined" @click="$emit(\'click\')">{{ label }}</button>',
})

const QInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    label: { type: String, default: '' },
    modelValue: { type: String, default: '' },
    readonly: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'blur'],
  methods: {
    focus() {
      ;(this.$refs.control as HTMLTextAreaElement).focus()
    },
  },
  template:
    '<textarea ref="control" :aria-label="label" :readonly="readonly || undefined" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" />',
})

type Translate = (key: string, params?: { word?: string }) => string
const attachedResumePages: Array<{ unmount(): void }> = []

const quasarStepperTestPlugin = {
  install(app: App) {
    const $q = {
      dark: { isActive: false },
      iconMapFn: null,
      iconSet: {
        stepper: { active: 'edit', done: 'done', error: 'warning' },
      },
      lang: { rtl: false },
      platform: { is: { chrome: false, ios: false } },
    }
    app.config.globalProperties.$q = $q
    app.provide('_q_', $q)
  },
}

/** Real QStepper and AccountStep inside the setup page. Unrelated Quasar chrome is stubbed. */
async function mountResumeImport(translate: Translate) {
  const wallet = useWalletStore()
  wallet.flushPersistence = jest.fn(() => Promise.resolve())
  const setSeed = jest.fn()
  wallet.$onAction(({ name }) => {
    if (name === 'setSeedPhrase') setSeed()
  })
  const wrapper = mount(Setup, {
    attachTo: document.body,
    global: {
      components: { QStep, QStepper, QStepperNavigation },
      plugins: [quasarStepperTestPlugin],
      stubs: {
        QPageContainer: SlotStub,
        QPage: SlotStub,
        // Slot-rendering stubs: the header holds the layout drawer toggle whose locked state
        // the navigation-lock test asserts on.
        QHeader: SlotStub,
        QToolbar: SlotStub,
        QToolbarTitle: SlotStub,
        QBanner: true,
        QBtn: QBtnStub,
        QInput: QInputStub,
        QSpace: true,
        EulaStep: true,
        DepositStep: true,
        SeedConfirmStep: true,
        ReplaceAccountGuard: true,
      },
      mocks: {
        $t: translate,
        $router: { push: mockRouterPush },
      },
    },
  })
  attachedResumePages.push(wrapper)
  await nextTick()
  return { wallet, setSeed, wrapper }
}

async function mountSetup(extraStubs: Record<string, unknown> = {}) {
  const wallet = useWalletStore()
  wallet.flushPersistence = jest.fn(() => Promise.resolve())
  const setSeed = jest.fn()
  wallet.$onAction(({ name }) => {
    if (name === 'setSeedPhrase') setSeed()
  })
  const wrapper = shallowMount(Setup, {
    global: {
      stubs: {
        QPageContainer: SlotStub,
        QPage: SlotStub,
        ...Object.fromEntries(
          [
            'q-header',
            'q-toolbar',
            'q-toolbar-title',
            'q-btn',
            'q-stepper',
            'q-step',
            'q-stepper-navigation',
            'q-banner',
          ]
            .filter(
              name =>
                !(
                  name.replace(/(^|-)(\w)/g, (_m, _d, c: string) =>
                    c.toUpperCase(),
                  ) in extraStubs
                ),
            )
            .map(name => [name, true]),
        ),
        ...extraStubs,
      },
      mocks: {
        $t: (k: string) => k,
        $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        $router: { push: mockRouterPush },
      },
    },
  })
  await nextTick()
  return { wallet, setSeed, wrapper }
}

// The Setup.vue `import.meta.url` asset lookups load via
// test/jest/vue-import-meta-transform.js.
describe('Setup page mounted (#267)', () => {
  afterEach(() => {
    for (const wrapper of attachedResumePages.splice(0)) wrapper.unmount()
  })

  beforeEach(() => {
    mockProfileName = undefined
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
    finishSetup: () => Promise<void>
    onSeedConfirmed: () => void
    next: () => Promise<void>
  }
  async function newAccountVm(extraStubs: Record<string, unknown> = {}) {
    const ctx = await mountSetup(extraStubs)
    const vm = ctx.wrapper.vm as unknown as Vm
    vm.step = 2
    vm.accountData.name = 'Alice'
    vm.accountData.nameRequired = true
    ;(vm.accountData as { valid?: boolean }).valid = true
    vm.finishSetup = jest.fn(() => Promise.resolve())
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
    expect(vm.finishSetup).not.toHaveBeenCalled()
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
    expect(vm.finishSetup).not.toHaveBeenCalled()
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
    expect(vm.finishSetup).toHaveBeenCalledTimes(1)
  })

  it('New Account: asks the browser for persistent storage after the commit, before identity init (ticket #370)', async () => {
    const order: string[] = []
    const persist = jest.fn(async () => {
      order.push('persist')
      return true
    })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist },
    })
    try {
      const { setSeed, vm } = await newAccountVm()
      setSeed.mockImplementation(() => order.push('commit'))
      vm.finishSetup = jest.fn(() => {
        order.push('finish')
        return Promise.resolve()
      })
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()

      await vm.next()

      expect(persist).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['commit', 'persist', 'finish'])
    } finally {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: undefined,
      })
    }
  })

  it('New Account: a denied or unsupported persist() never blocks the signup', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist: async () => false },
    })
    try {
      const { vm } = await newAccountVm()
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()
      await vm.next()
      expect(vm.finishSetup).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: undefined,
      })
    }
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

  it('no choice made yet: next() at step 2 commits nothing and stamps no marker', async () => {
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as Vm
    vm.step = 2
    vm.finishSetup = jest.fn(() => Promise.resolve())
    vm.avatar = 'data:avatar'
    // Initial state: neither New nor Import chosen (valid false, nameRequired false).
    await vm.next()

    expect(vm.step).toBe(2)
    expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedPhrase).toBeNull()
    expect(wallet.seedConfirmedAt).toBeNull()
    expect(vm.finishSetup).not.toHaveBeenCalled()
  })

  it('an invalid import cannot be committed or stamped', async () => {
    const { wallet, setSeed, wrapper } = await mountSetup()
    const vm = wrapper.vm as unknown as Vm
    vm.step = 2
    vm.accountData = {
      seed: 'not a phrase',
      name: '',
      nameRequired: false,
      valid: false,
    } as typeof vm.accountData
    await vm.next()
    expect(setSeed).not.toHaveBeenCalled()
    expect(wallet.seedConfirmedAt).toBeNull()
  })

  it('the confirmation matches the phrase only after normalization, never a different phrase', async () => {
    const { vm } = await newAccountVm()
    await vm.next()
    await nextTick()
    vm.onSeedConfirmed()
    expect(vm.isSeedConfirmed).toBe(true)
    vm.accountData.seed = `  ${vm.accountData.seed.toUpperCase()} `
    expect(vm.isSeedConfirmed).toBe(true)
    vm.accountData.seed = STORED
    expect(vm.isSeedConfirmed).toBe(false)
    // A phrase change followed by a fresh challenge does not inherit the old confirmation.
    vm.step = 2
    await nextTick()
    vm.step = 3
    await nextTick()
    expect(vm.challenge?.seed).toBe(STORED)
    expect(vm.isSeedConfirmed).toBe(false)
  })

  it('with no secure RNG, step 3 shows an accessible error, commits nothing, and Back still works', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    const { wallet, setSeed, wrapper, vm } = await newAccountVm({
      QPageContainer: SlotStub,
      QPage: SlotStub,
      QStepper: SlotStub,
      QStep: SlotStub,
    })
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    })
    try {
      await vm.next()
      await nextTick()
      expect(vm.step).toBe(3)
      const v = vm as unknown as {
        challengeError: boolean
        challenge: unknown
      }
      expect(v.challengeError).toBe(true)
      const alert = wrapper.get('[role="alert"]')
      expect(alert.text()).toBe('seedConfirm.unavailable')
      expect(v.challenge).toBeNull()
      await vm.next()
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBeNull()

      // Back works, and the step retries once a secure RNG exists again.
      vm.step = 2
      await nextTick()
      if (original) Object.defineProperty(globalThis, 'crypto', original)
      vm.step = 3
      await nextTick()
      expect(v.challengeError).toBe(false)
      expect(v.challenge).not.toBeNull()
      void wrapper
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original)
    }
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
    vm.accountData = {
      seed: STORED,
      name: '',
      nameRequired: false,
      valid: true,
    } as typeof vm.accountData
    vm.avatar = 'data:avatar'
    ;(vm as unknown as { finishSetup: unknown }).finishSetup = jest.fn(() =>
      Promise.resolve(),
    )

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
      vm.finishSetup = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'
      vm.step = 2
      vm.accountData.name = 'Alice'
      vm.accountData.nameRequired = true
      ;(vm.accountData as { valid?: boolean }).valid = true
      await nextTick()
      return { ...ctx, vm }
    }

    async function resumeImportContext(
      options: { locale?: 'en-us' | 'fr-fr' } = {},
    ) {
      setActivePinia(createPinia())
      useWalletStore().seedPhrase = STORED
      const catalogue = options.locale === 'fr-fr' ? frFr : undefined
      const translate: Translate = (key, params) => {
        if (catalogue) {
          const parts = key.split('.')
          let current: unknown = catalogue
          for (const part of parts) {
            if (current && typeof current === 'object' && part in current) {
              current = (current as Record<string, unknown>)[part]
            } else {
              current = undefined
              break
            }
          }
          if (typeof current === 'string') {
            if (params) {
              let res = current
              for (const [k, v] of Object.entries(params)) {
                res = res.replaceAll(`{${k}}`, String(v))
              }
              return res
            }
            return current
          }
        }
        if (key === 'replaceGuard.word') return 'REPLACE'
        if (key === 'replaceGuard.typeLabel') {
          return `Type ${params?.word ?? ''} to continue`
        }
        return key
      }
      const ctx = await mountResumeImport(translate)
      const vm = ctx.wrapper.vm as unknown as Vm & {
        finishSetup: () => Promise<void>
        avatar: string
        previous: () => void
      }
      vm.finishSetup = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'
      vm.step = 2
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

    it('offers import of a different phrase only after the typed replace confirmation, and writes nothing before it (#387)', async () => {
      const OTHER =
        'legal winner thank year wave sausage worth useful legal winner thank yellow'
      expect(enUs.accountStep.importDifferentPhrase).toBe(
        'I already have a different recovery phrase',
      )
      expect(frFr.accountStep.importDifferentPhrase).toMatch(
        /phrase de récupération/i,
      )
      expect(frFr.accountStep.importDifferentPhrase).not.toBe(
        enUs.accountStep.importDifferentPhrase,
      )
      expect(enUs.accountStep.confirmStoredFirst).toMatch(/stored/i)
      expect(frFr.accountStep.confirmStoredFirst).toMatch(
        /phrase de récupération/i,
      )

      const { wallet, setSeed, wrapper, vm } = await resumeImportContext()

      const secondary = wrapper.get('[data-test="import-different-phrase"]')
      expect(secondary.text()).toBe('accountStep.importDifferentPhrase')
      expect(wrapper.get('[data-test="confirm-stored-first"]').text()).toBe(
        'accountStep.confirmStoredFirst',
      )
      expect(wrapper.find('[data-test="import-different-form"]').exists()).toBe(
        false,
      )
      const storedBox = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      expect(storedBox.attributes('readonly')).toBeDefined()
      expect((storedBox.element as HTMLTextAreaElement).value).toBe(STORED)
      expect(
        wrapper
          .find('[aria-label="accountStep.refreshRecoveryPhrase"]')
          .exists(),
      ).toBe(false)
      expect(
        wrapper.find('[aria-label="accountStep.copyRecoveryPhrase"]').exists(),
      ).toBe(true)
      expect(setSeed).not.toHaveBeenCalled()
      expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)

      await secondary.trigger('click')
      await nextTick()
      expect(wrapper.find('[data-test="import-different-form"]').exists()).toBe(
        true,
      )
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
      expect(
        (
          wrapper.get('textarea[aria-label="profile.seedEntry"]')
            .element as HTMLTextAreaElement
        ).value,
      ).toBe(STORED)

      const input = wrapper.get('[data-test="import-different-input"]')
      await input.setValue('replace')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      await nextTick()
      expect(wrapper.get('[role="status"]').text()).toBe(
        'replaceGuard.mismatch',
      )
      expect(setSeed).not.toHaveBeenCalled()
      expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
      expect(
        wrapper
          .get('textarea[aria-label="profile.seedEntry"]')
          .attributes('readonly'),
      ).toBeDefined()

      await input.setValue('  REPLACE ')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      await nextTick()
      expect(setSeed).not.toHaveBeenCalled()
      expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)

      const importBox = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      expect(importBox.attributes('readonly')).toBeUndefined()
      expect((importBox.element as HTMLTextAreaElement).value).toBe('')

      await importBox.setValue(OTHER)
      await nextTick()

      expect(commitValidatedSetupSeed).not.toHaveBeenCalled()
      expect(setSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(mockFlushProfile).not.toHaveBeenCalled()
      expect(wallet.flushPersistence).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
      expect(wallet.seedConfirmedAt).toBeNull()

      await vm.next()

      expect(commitValidatedSetupSeed).toHaveBeenCalledTimes(1)
      expect(setSeed).toHaveBeenCalledTimes(1)
      expect(mockSetRelayData).toHaveBeenCalledTimes(1)
      expect(mockFlushProfile).toHaveBeenCalledTimes(1)
      expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
      expect(wallet.seedPhrase).toBe(OTHER)
      expect(wallet.seedConfirmedAt).toEqual(expect.any(Number))
    })

    it('requires the localized confirmation token in French (REPLACE rejected, REMPLACER unlocks import) (#479)', async () => {
      const { wrapper } = await resumeImportContext({ locale: 'fr-fr' })

      const secondary = wrapper.get('[data-test="import-different-phrase"]')
      await secondary.trigger('click')
      await nextTick()

      const input = wrapper.get('[data-test="import-different-input"]')
      const form = wrapper.get('[data-test="import-different-form"]')
      const status = wrapper.get('[role="status"]')
      const importBox = wrapper.get(
        `textarea[aria-label="${frFr.profile.seedEntry}"]`,
      )

      expect(importBox.attributes('readonly')).toBeDefined()

      // In French, typing the English token "REPLACE" is rejected
      await input.setValue('REPLACE')
      await form.trigger('submit')
      await nextTick()

      expect(status.text()).toBe(frFr.replaceGuard.mismatch)
      expect(importBox.attributes('readonly')).toBeDefined()

      // Whitespace and case variants of English token are also rejected
      await input.setValue('  replace  ')
      await form.trigger('submit')
      await nextTick()

      expect(status.text()).toBe(frFr.replaceGuard.mismatch)
      expect(importBox.attributes('readonly')).toBeDefined()

      // Typing the French token "REMPLACER" unlocks the editable Import field
      await input.setValue('  REMPLACER ')
      await form.trigger('submit')
      await nextTick()

      expect(importBox.attributes('readonly')).toBeUndefined()
      expect((importBox.element as HTMLTextAreaElement).value).toBe('')
    })

    it('describes the acknowledgement field with the destructive-loss warning', async () => {
      const { wrapper } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      await nextTick()

      const input = wrapper.get('[data-test="import-different-input"]')
      const describedIds = input.attributes('aria-describedby').split(' ')
      expect(document.activeElement).toBe(input.element)
      expect(describedIds).toHaveLength(2)
      expect(describedIds.map(id => wrapper.get(`#${id}`).text())).toContain(
        'replaceGuard.warning',
      )
    })

    it('moves focus to the editable phrase after acknowledgement', async () => {
      const { wrapper } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      const input = wrapper.get('[data-test="import-different-input"]')
      await input.setValue('REPLACE')

      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      await nextTick()

      const importBox = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      expect(importBox.attributes('readonly')).toBeUndefined()
      expect(document.activeElement).toBe(importBox.element)
    })

    it('preserves the acknowledged import draft across real QStepper Back/remount', async () => {
      const { wrapper, vm } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      const input = wrapper.get('[data-test="import-different-input"]')
      await input.setValue('REPLACE')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      await nextTick()
      await wrapper
        .get('textarea[aria-label="profile.seedEntry"]')
        .setValue(OTHER)

      vm.previous()
      await nextTick()
      expect(vm.step).toBe(1)
      expect(
        wrapper.find('textarea[aria-label="profile.seedEntry"]').exists(),
      ).toBe(false)

      await vm.next()
      await nextTick()
      expect(vm.step).toBe(2)
      const remountedImport = wrapper.get(
        'textarea[aria-label="profile.seedEntry"]',
      )
      expect(remountedImport.attributes('readonly')).toBeUndefined()
      expect((remountedImport.element as HTMLTextAreaElement).value).toBe(OTHER)
      expect(vm.accountData.nameRequired).toBe(false)
    })

    it('freezes the visible import identity and navigation while wallet durability is pending', async () => {
      const walletWrite = deferred()
      const { wallet, setSeed, wrapper, vm } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      await wrapper
        .get('[data-test="import-different-input"]')
        .setValue('REPLACE')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      const importBox = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      await importBox.setValue(OTHER)
      wallet.flushPersistence = jest.fn(() => walletWrite.promise)

      const completion = vm.next()
      await flushPromises()
      expect(wallet.seedPhrase).toBe(OTHER)
      const committedName = vm.accountData.name

      const editor = wrapper.findComponent(AccountStep).vm as unknown as {
        seed: string
        name: string
      }
      editor.seed = STORED
      editor.name = 'Changed after submit'
      vm.previous()
      await wrapper.findAll('.q-stepper__tab')[0].trigger('click')
      await nextTick()

      expect(vm.step).toBe(2)
      expect(vm.accountData.seed).toBe(OTHER)
      expect(vm.accountData.name).toBe(committedName)
      expect((importBox.element as HTMLTextAreaElement).value).toBe(OTHER)
      expect(importBox.attributes('readonly')).toBeDefined()

      walletWrite.resolve()
      await completion
      expect(setSeed).toHaveBeenCalledTimes(1)
      expect(wallet.seedPhrase).toBe(OTHER)
      expect(mockSetRelayData).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ name: committedName }),
        }),
      )
    })

    it('keeps an entry-failure retry on the committed identity without rewriting stores', async () => {
      const { wallet, setSeed, wrapper, vm } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      await wrapper
        .get('[data-test="import-different-input"]')
        .setValue('REPLACE')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      const importBox = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      await importBox.setValue(OTHER)
      vm.finishSetup = jest
        .fn()
        .mockRejectedValueOnce(new Error('entry failed'))
        .mockResolvedValueOnce(undefined)

      await expect(vm.next()).rejects.toThrow('entry failed')
      expect(wallet.seedPhrase).toBe(OTHER)
      const committedName = vm.accountData.name
      const editor = wrapper.findComponent(AccountStep).vm as unknown as {
        seed: string
        name: string
      }
      editor.seed = STORED
      editor.name = 'Changed after entry failure'
      vm.previous()
      await wrapper.findAll('.q-stepper__tab')[0].trigger('click')
      await nextTick()

      expect(vm.step).toBe(2)
      expect(vm.accountData.seed).toBe(OTHER)
      expect(vm.accountData.name).toBe(committedName)
      expect((importBox.element as HTMLTextAreaElement).value).toBe(OTHER)
      expect(importBox.attributes('readonly')).toBeDefined()

      await vm.next()
      expect(vm.finishSetup).toHaveBeenCalledTimes(2)
      expect(setSeed).toHaveBeenCalledTimes(1)
      expect(wallet.flushPersistence).toHaveBeenCalledTimes(1)
      expect(mockSetRelayData).toHaveBeenCalledTimes(1)
      expect(mockFlushProfile).toHaveBeenCalledTimes(1)
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

    it('the header menu button navigates the layout while editing and is disabled once the account step is locked (#387)', async () => {
      const walletWrite = deferred()
      const { wallet, wrapper, vm } = await resumeImportContext()
      await wrapper
        .get('[data-test="import-different-phrase"]')
        .trigger('click')
      await wrapper
        .get('[data-test="import-different-input"]')
        .setValue('REPLACE')
      await wrapper.get('[data-test="import-different-form"]').trigger('submit')
      await wrapper
        .get('textarea[aria-label="profile.seedEntry"]')
        .setValue(OTHER)
      wallet.flushPersistence = jest.fn(() => walletWrite.promise)

      const menu = wrapper.get('[data-test="setup-header-menu"]')
      // Editing is a safe (pre-lock) state: the layout drawer toggle works as before.
      expect(menu.attributes('disabled')).toBeUndefined()
      await menu.trigger('click')
      expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
      expect(wrapper.emitted('setupNavigationLocked')).toBeUndefined()

      const completion = vm.next()
      await flushPromises()

      // Pending persistence: the menu can no longer route away through the layout drawer.
      expect(menu.attributes('disabled')).toBeDefined()
      expect(wrapper.emitted('toggleMyDrawerOpen')).toHaveLength(1)
      expect(wrapper.emitted('setupNavigationLocked')).toEqual([[true]])

      walletWrite.resolve()
      await completion
      // Completed is still a locked state; the layout keeps its lock until the authorized
      // completion navigation settles (MainLayout resets it in its afterEach).
      expect(
        (vm as unknown as { completionPhase: string }).completionPhase,
      ).toBe('completed')
      expect(wrapper.emitted('setupNavigationLocked')).toEqual([[true]])
    })
  })

  describe('layout-wide navigation lock (#387)', () => {
    it('reports lock transitions to the layout so the drawer can be frozen for their duration', async () => {
      const { wrapper } = await mountSetup()
      const vm = wrapper.vm as unknown as { completionPending: boolean }

      vm.completionPending = true
      await nextTick()
      expect(wrapper.emitted('setupNavigationLocked')).toEqual([[true]])

      vm.completionPending = false
      await nextTick()
      expect(wrapper.emitted('setupNavigationLocked')).toEqual([
        [true],
        [false],
      ])
    })

    it('rejects route departures while locked, allows safe states, and allows the authorized completion push', () => {
      type GuardThis = {
        completionLocked: boolean
        completionNavigationAuthorized: boolean
      }
      const guard = (
        Setup as unknown as {
          beforeRouteLeave?: (this: GuardThis) => boolean
        }
      ).beforeRouteLeave
      expect(typeof guard).toBe('function')
      const instance = (locked: boolean, authorized: boolean): GuardThis => ({
        completionLocked: locked,
        completionNavigationAuthorized: authorized,
      })

      // Safe (pre-lock) states keep navigating as before: editing step 1 is not trapped.
      expect(guard?.call(instance(false, false))).toBe(true)
      // Locked states block every unauthorized departure: pending persistence, terminal,
      // and entry retry.
      expect(guard?.call(instance(true, false))).toBe(false)
      // The internally authorized completion push is the only allowed departure while locked.
      expect(guard?.call(instance(true, true))).toBe(true)
    })
  })

  describe('replacing an existing account (#304)', () => {
    const OTHER =
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    type GuardVm = Vm & {
      guardActive: boolean
      existingAccount: boolean
      replaceAcknowledged: boolean
      acknowledgeReplace: () => void
    }
    async function existingVm(confirmedAt: number | null = null) {
      mockProfileName = 'Alice'
      setActivePinia(createPinia())
      const w = useWalletStore()
      w.seedPhrase = STORED
      w.seedConfirmedAt = confirmedAt
      const ctx = await mountSetup()
      const vm = ctx.wrapper.vm as unknown as GuardVm
      vm.finishSetup = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'
      return { ...ctx, vm }
    }

    it.each([
      ['fresh (no seed)', undefined, null, null, false],
      ['resume (seed, no name)', undefined, STORED, null, false],
      ['completed, unconfirmed', 'Alice', STORED, null, true],
      ['confirmed', 'Alice', STORED, 5, true],
      ['name without seed (profile only, #308)', 'Alice', null, null, true],
    ])('guard for %s: %s', async (_l, name, seed, at, expected) => {
      mockProfileName = name
      setActivePinia(createPinia())
      const w = useWalletStore()
      w.seedPhrase = seed
      w.seedConfirmedAt = at
      const { wrapper } = await mountSetup()
      expect((wrapper.vm as unknown as GuardVm).guardActive).toBe(expected)
      expect(wrapper.findComponent(ReplaceAccountGuard).exists()).toBe(expected)
    })

    it('a name-only profile cannot be overwritten without acknowledgement (#308)', async () => {
      mockProfileName = 'Alice'
      setActivePinia(createPinia())
      const w = useWalletStore()
      w.seedPhrase = null
      const ctx = await mountSetup()
      const vm = ctx.wrapper.vm as unknown as GuardVm
      vm.finishSetup = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'

      vm.step = 2
      vm.accountData.name = 'Bob'
      vm.accountData.nameRequired = true
      ;(vm.accountData as { valid?: boolean }).valid = true
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()
      await expect(vm.next()).rejects.toThrow()
      expect(ctx.setSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(w.seedPhrase).toBeNull()
    })

    it('acknowledging replace on a name-only profile unlocks setup and overwrites name (#308)', async () => {
      mockProfileName = 'Alice'
      setActivePinia(createPinia())
      const w = useWalletStore()
      w.seedPhrase = null
      const ctx = await mountSetup()
      const vm = ctx.wrapper.vm as unknown as GuardVm
      vm.finishSetup = jest.fn(() => Promise.resolve())
      vm.avatar = 'data:avatar'

      vm.acknowledgeReplace()
      await nextTick()
      expect(vm.guardActive).toBe(false)
      expect(vm.accountData.seed.split(' ')).toHaveLength(12)

      vm.step = 2
      vm.accountData.name = 'Bob'
      vm.accountData.nameRequired = true
      ;(vm.accountData as { valid?: boolean }).valid = true
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()
      await vm.next()

      expect(ctx.setSeed).toHaveBeenCalled()
      expect(mockSetRelayData).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ name: 'Bob' }),
        }),
      )
    })

    it('an existing account cannot be replaced by an import without acknowledgement', async () => {
      const { wallet, setSeed, vm } = await existingVm()
      vm.step = 2
      vm.accountData = {
        seed: OTHER,
        name: '',
        nameRequired: false,
        valid: true,
      } as typeof vm.accountData

      await expect(vm.next()).rejects.toThrow()

      expect(setSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(vm.finishSetup).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
    })

    it('nor can New Account (even with the same phrase) overwrite the profile unacknowledged', async () => {
      const { wallet, setSeed, vm } = await existingVm()
      vm.step = 2
      vm.accountData.name = 'Mallory'
      vm.accountData.nameRequired = true
      ;(vm.accountData as { valid?: boolean }).valid = true
      await vm.next()
      await nextTick()
      vm.onSeedConfirmed()
      await expect(vm.next()).rejects.toThrow()
      expect(setSeed).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
    })

    it('acknowledging starts from a FRESH phrase, not the stored one, and then import works', async () => {
      const { wallet, setSeed, vm } = await existingVm(5)
      vm.acknowledgeReplace()
      await nextTick()
      expect(vm.guardActive).toBe(false)
      expect(vm.accountData.seed).not.toBe(STORED)
      expect(vm.accountData.seed.split(' ')).toHaveLength(12)
      // Nothing was written by acknowledging alone.
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)

      vm.step = 2
      vm.accountData = {
        seed: OTHER,
        name: '',
        nameRequired: false,
        valid: true,
      } as typeof vm.accountData
      await vm.next()

      expect(wallet.seedPhrase).toBe(OTHER)
      // Marker follows the NEW phrase (import => confirmed), not the old one.
      expect(wallet.seedConfirmedAt).toEqual(expect.any(Number))
      expect(wallet.seedConfirmedAt).not.toBe(5)
    })

    it('cancel returns to the app and changes nothing', async () => {
      const { wallet, setSeed, wrapper } = await existingVm()
      wrapper.findComponent(ReplaceAccountGuard).vm.$emit('cancel')
      expect(mockRouterPush).toHaveBeenCalledWith('/')
      expect(setSeed).not.toHaveBeenCalled()
      expect(wallet.seedPhrase).toBe(STORED)
    })
  })

  describe('multi-tab setup race condition (#308)', () => {
    it('Tab A opened on fresh device is blocked from committing if Tab B creates an account', async () => {
      let persistedSeed: string | null = null
      let persistedName: string | undefined = undefined
      let persistedConfirmedAt: number | null = null

      mockProfileName = undefined
      setActivePinia(createPinia())
      const walletA = useWalletStore()
      walletA.seedPhrase = null
      walletA.seedConfirmedAt = null

      const { wrapper: wrapperA, setSeed: setSeedA } = await mountSetup()
      const vmA = wrapperA.vm as unknown as GuardVm & {
        step: number
        next: () => Promise<void>
        onSeedConfirmed: () => void
        rehydrateStores: () => Promise<void>
        accountData: {
          seed: string
          name: string
          nameRequired: boolean
          valid: boolean
        }
      }

      vmA.avatar = 'data:avatar'
      vmA.rehydrateStores = jest.fn(async () => {
        walletA.seedPhrase = persistedSeed
        walletA.seedConfirmedAt = persistedConfirmedAt
        mockProfileName = persistedName
      })

      expect(vmA.guardActive).toBe(false)

      vmA.step = 2
      vmA.accountData.name = 'TabA User'
      vmA.accountData.nameRequired = true
      ;(vmA.accountData as { valid?: boolean }).valid = true
      await vmA.next()
      await nextTick()
      expect(vmA.step).toBe(3)
      vmA.onSeedConfirmed()

      // Tab B completes setup in the background
      persistedSeed =
        'test test test test test test test test test test test junk'
      persistedName = 'TabB User'
      persistedConfirmedAt = 12345

      // Tab A attempts to commit
      await expect(vmA.next()).rejects.toThrow('setup.replaceNotAcknowledged')

      expect(setSeedA).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(vmA.guardActive).toBe(true)
    })

    it('Tab A opened in resume mode is blocked if Tab B changes the stored seed', async () => {
      let persistedSeed = STORED
      let persistedName: string | undefined = undefined

      mockProfileName = undefined
      setActivePinia(createPinia())
      const walletA = useWalletStore()
      walletA.seedPhrase = persistedSeed
      walletA.seedConfirmedAt = null

      const { wrapper: wrapperA, setSeed: setSeedA } = await mountSetup()
      const vmA = wrapperA.vm as unknown as GuardVm & {
        step: number
        next: () => Promise<void>
        onSeedConfirmed: () => void
        rehydrateStores: () => Promise<void>
        accountData: {
          seed: string
          name: string
          nameRequired: boolean
          valid: boolean
        }
      }

      vmA.avatar = 'data:avatar'
      vmA.rehydrateStores = jest.fn(async () => {
        walletA.seedPhrase = persistedSeed
        mockProfileName = persistedName
      })

      expect(vmA.guardActive).toBe(false)

      // Tab B in background replaces or completes with OTHER seed
      persistedSeed = OTHER
      persistedName = 'TabB User'

      vmA.step = 2
      vmA.accountData.name = 'TabA User'
      vmA.accountData.nameRequired = true
      ;(vmA.accountData as { valid?: boolean }).valid = true
      await vmA.next()
      await nextTick()
      vmA.onSeedConfirmed()

      await expect(vmA.next()).rejects.toThrow()
      expect(setSeedA).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(vmA.guardActive).toBe(true)
    })
  })

  describe('real-Quasar guard-then-stepper integration (#308)', () => {
    it('mounts real ReplaceAccountGuard with real QStepper and transitions after typing confirmation word', async () => {
      mockProfileName = 'Alice'
      setActivePinia(createPinia())
      const wallet = useWalletStore()
      wallet.seedPhrase = STORED
      wallet.seedConfirmedAt = null

      const translate: Translate = (key, params) => {
        if (key === 'replaceGuard.word') return 'REPLACE'
        if (key === 'replaceGuard.typeLabel') {
          return `Type ${params?.word} to continue`
        }
        return key
      }

      const wrapper = mount(Setup, {
        attachTo: document.body,
        global: {
          components: {
            QStep,
            QStepper,
            QStepperNavigation,
            ReplaceAccountGuard,
          },
          plugins: [quasarStepperTestPlugin],
          stubs: {
            QPageContainer: SlotStub,
            QPage: SlotStub,
            QHeader: SlotStub,
            QToolbar: SlotStub,
            QToolbarTitle: SlotStub,
            QBanner: true,
            QBtn: QBtnStub,
            QInput: QInputStub,
            QSpace: true,
            EulaStep: true,
            DepositStep: true,
            SeedConfirmStep: true,
          },
          mocks: {
            $t: translate,
            $router: { push: mockRouterPush },
          },
        },
      })
      attachedResumePages.push(wrapper)
      await nextTick()

      // Replace guard is visible initially; QStepper is not rendered
      expect(wrapper.find('[data-test="replace-guard"]').exists()).toBe(true)
      expect(wrapper.findComponent(QStepper).exists()).toBe(false)

      // User opens the replace form in ReplaceAccountGuard
      await wrapper.get('[data-test="replace-toggle"]').trigger('click')
      await nextTick()
      expect(wrapper.find('[data-test="replace-form"]').exists()).toBe(true)

      // User types the confirmation word and submits
      await wrapper.get('input').setValue('REPLACE')
      await wrapper.get('[data-test="replace-form"]').trigger('submit')
      await nextTick()

      // Guard is gone, real QStepper is rendered!
      expect(wrapper.find('[data-test="replace-guard"]').exists()).toBe(false)
      expect(wrapper.findComponent(QStepper).exists()).toBe(true)
      expect((wrapper.vm as unknown as { step: number }).step).toBe(1)
    })
  })

  describe('abandoned import mode switching (#516)', () => {
    it('generates a fresh valid phrase when switching from abandoned Import to New Account', async () => {
      setActivePinia(createPinia())
      const translate: Translate = key => key
      const { wrapper } = await mountResumeImport(translate)
      const vm = wrapper.vm as unknown as {
        step: number
        next: () => Promise<void>
        previous: () => void
        accountData: {
          seed: string
          name: string
          valid: boolean
          nameRequired: boolean
        }
      }

      // Step 1: EULA -> Agree
      expect(vm.step).toBe(1)
      await vm.next()
      await nextTick()
      expect(vm.step).toBe(2)

      // Step 2: Choose Import Account
      const importBtn = wrapper
        .findAll('button')
        .find(b => b.text() === 'accountStep.importAccount')
      expect(importBtn).toBeDefined()
      await importBtn?.trigger('click')
      await nextTick()

      // User enters invalid placeholder text in the recovery-phrase field
      const importDraft = 'invalid abandoned import phrase placeholder'
      const textarea = wrapper.get('textarea[aria-label="profile.seedEntry"]')
      await textarea.setValue(importDraft)
      await nextTick()

      expect(vm.accountData.seed).toBe(importDraft)
      expect(vm.accountData.valid).toBe(false)

      // User selects Back (step 2 -> step 1)
      vm.previous()
      await nextTick()
      expect(vm.step).toBe(1)

      // User selects Agree (step 1 -> step 2)
      await vm.next()
      await nextTick()
      expect(vm.step).toBe(2)

      // User selects New Account
      const newAccBtn = wrapper
        .findAll('button')
        .find(b => b.text() === 'accountStep.newAccount')
      expect(newAccBtn).toBeDefined()
      await newAccBtn?.trigger('click')
      await nextTick()

      // Recovery phrase must be newly generated, valid, distinct from import draft, and textarea read-only
      const readOnlyBox = wrapper.get(
        'textarea[aria-label="profile.seedEntry"]',
      )
      expect(readOnlyBox.attributes('readonly')).toBeDefined()
      expect(vm.accountData.seed).not.toBe(importDraft)
      expect(vm.accountData.seed.split(' ').filter(Boolean)).toHaveLength(12)
      expect(vm.accountData.nameRequired).toBe(true)

      // Entering a valid name enables progressing to Step 3
      const nameBox = wrapper.get('textarea[aria-label="profile.name"]')
      await nameBox.setValue('Alice')
      await nextTick()
      expect(vm.accountData.valid).toBe(true)

      await vm.next()
      await nextTick()
      expect(vm.step).toBe(3)
    })
  })
})
