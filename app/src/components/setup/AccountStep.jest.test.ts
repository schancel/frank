/** @jest-environment jsdom */

import { defineComponent, nextTick } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { copyToClipboard } from 'quasar'
import { generateMnemonic } from 'bip39'

import AccountStep from './AccountStep.vue'
import enUs from '../../i18n/en-us'
import frFr from '../../i18n/fr-fr'
import {
  commitValidatedSetupName,
  commitValidatedSetupSeed,
} from '../../utils/setup-account'

jest.mock('quasar', () => ({
  copyToClipboard: jest.fn(() => Promise.resolve()),
}))
jest.mock('bip39', () => ({
  ...jest.requireActual('bip39'),
  generateMnemonic: jest.fn(
    () => 'test test test test test test test test test test test junk',
  ),
}))
jest.mock('../../utils/notifications', () => ({
  seedCopiedNotify: jest.fn(),
}))

const VALID_MNEMONIC =
  'test test test test test test test test test test test junk'

const QBtnStub = defineComponent({
  inheritAttrs: false,
  props: {
    ariaLabel: { type: String, default: '' },
    icon: { type: String, default: '' },
    label: { type: String, default: '' },
  },
  emits: ['click'],
  template:
    '<button :aria-label="ariaLabel" :data-icon="icon" @click="$emit(\'click\')">{{ label }}</button>',
})

const QInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    label: { type: String, default: '' },
    modelValue: { type: String, default: '' },
    readonly: { type: Boolean, default: false },
    // Like Quasar's QInput: the first rule that does not return `true` supplies the error text.
    rules: { type: Array, default: () => [] },
  },
  emits: ['update:modelValue', 'blur'],
  computed: {
    error(): string {
      for (const rule of this.rules as Array<(v: string) => true | string>) {
        const outcome = rule(this.modelValue)
        if (outcome !== true) return outcome
      }
      return ''
    },
  },
  template:
    '<div><textarea :aria-label="label" :readonly="readonly" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" /><span v-if="error" role="alert" :data-error-for="label">{{ error }}</span></div>',
})

const messages: Record<string, string> = {
  'accountStep.newAccount': 'New Account',
  'accountStep.importAccount': 'Import Account',
  'accountStep.copyRecoveryPhrase': 'Copy recovery phrase',
  'accountStep.refreshRecoveryPhrase': 'Generate a new recovery phrase',
}

function mountStep(seed = 'eagerly generated unrelated seed') {
  return shallowMount(AccountStep, {
    props: {
      accountData: { name: '', seed, valid: false },
    },
    global: {
      mocks: {
        $t: (key: string) => messages[key] ?? key,
      },
      stubs: {
        QBtn: QBtnStub,
        QInput: QInputStub,
        QSpace: true,
      },
    },
  })
}

describe('AccountStep import flow', () => {
  it('emits a literal false for invalid imported text', async () => {
    const wrapper = mountStep()
    const vm = wrapper.vm as unknown as {
      importAccount(): void
    }

    vm.importAccount()
    await nextTick()
    await wrapper
      .find('textarea[aria-label="profile.seedEntry"]')
      .setValue('not a recovery phrase')

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: '',
      seed: 'not a recovery phrase',
      valid: false,
      nameRequired: false,
    })
  })

  it('normalizes a valid imported phrase and emits literal true', async () => {
    const wrapper = mountStep()
    const vm = wrapper.vm as unknown as {
      importAccount(): void
    }

    vm.importAccount()
    await nextTick()
    await wrapper
      .find('textarea[aria-label="profile.seedEntry"]')
      .setValue(`  ${VALID_MNEMONIC.toUpperCase()}  `)

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: '',
      seed: VALID_MNEMONIC,
      valid: true,
      nameRequired: false,
    })
  })
})

describe('AccountStep import account finalization', () => {
  it('lets an imported account (no name collected) commit with the historical default', async () => {
    const wrapper = mountStep()
    const vm = wrapper.vm as unknown as { importAccount(): void }
    vm.importAccount()
    await nextTick()
    await wrapper
      .find('textarea[aria-label="profile.seedEntry"]')
      .setValue(VALID_MNEMONIC)
    const emitted = wrapper.emitted('update:account-data')?.at(-1)?.[0] as {
      name: string
      nameRequired: boolean
      valid: boolean
    }
    const persistName = jest.fn()

    expect(emitted.valid).toBe(true)
    expect(emitted.name).toBe('')
    expect(
      commitValidatedSetupName(emitted.name, emitted.nameRequired, persistName),
    ).toBe('Frank User')
    expect(persistName).toHaveBeenCalledWith('Frank User')
  })

  it('still requires a valid name for a new account at finalization', async () => {
    const wrapper = mountStep(VALID_MNEMONIC)
    const vm = wrapper.vm as unknown as { newAccount(): void }
    vm.newAccount()
    await nextTick()
    await wrapper.find('textarea[aria-label="profile.name"]').setValue('   ')
    const emitted = wrapper.emitted('update:account-data')?.at(-1)?.[0] as {
      name: string
      nameRequired: boolean
    }

    expect(emitted.nameRequired).toBe(true)
    expect(() =>
      commitValidatedSetupName(emitted.name, emitted.nameRequired, jest.fn()),
    ).toThrow(/invalid profile display name/i)
  })
})

describe('AccountStep display name contract', () => {
  async function enterNewAccountName(name: string) {
    const wrapper = mountStep(VALID_MNEMONIC)
    const vm = wrapper.vm as unknown as { newAccount(): void }
    vm.newAccount()
    await nextTick()
    await wrapper.find('textarea[aria-label="profile.name"]').setValue(name)
    return wrapper
  }

  it.each(['', '   ', '\t\n', '\u00a0\u2003'])(
    'rejects a blank display name %#',
    async name => {
      const wrapper = await enterNewAccountName(name)
      const emitted = wrapper.emitted('update:account-data')?.at(-1)?.[0]

      expect(emitted).toEqual({
        name: '',
        seed: VALID_MNEMONIC,
        valid: false,
        nameRequired: true,
      })
      expect(typeof (emitted as { valid: unknown }).valid).toBe('boolean')
    },
  )

  it('emits a trimmed valid name without rewriting the field on every keystroke', async () => {
    const wrapper = await enterNewAccountName('  Alice  ')

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: 'Alice',
      seed: VALID_MNEMONIC,
      valid: true,
      nameRequired: true,
    })
    expect(
      wrapper.find('textarea[aria-label="profile.name"]').element.value,
    ).toBe('  Alice  ')

    await wrapper.find('textarea[aria-label="profile.name"]').trigger('blur')
    expect(
      wrapper.find('textarea[aria-label="profile.name"]').element.value,
    ).toBe('Alice')
  })

  it('preserves meaningful interior spacing', async () => {
    const wrapper = await enterNewAccountName('Alice  Bob')

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: 'Alice  Bob',
      seed: VALID_MNEMONIC,
      valid: true,
      nameRequired: true,
    })
  })
})

// Ticket #268: each way a name can fail says what is wrong and what to do, in both locales.
describe('AccountStep name error messages', () => {
  const translator =
    (locale: typeof enUs) =>
    (key: string, params: Record<string, unknown> = {}) =>
      String(
        key
          .split('.')
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)?.[part],
            locale,
          ),
      ).replace(/\{(\w+)\}/g, (_m, name) => String(params[name]))

  const cases: Array<[string, string, RegExp]> = [
    ['empty', '', /empty|only spaces|vide/i],
    ['spaces only', '   ', /empty|only spaces|vide/i],
    ['200 letters', 'x'.repeat(200), /128/],
    ['a control character', 'a\u0007b', /control|contrôle/i],
    ['a line break', 'a\nb', /control|contrôle/i],
  ]

  it.each([
    ['en-us', enUs],
    ['fr-fr', frFr],
  ])(
    '%s: shows a distinct, actionable message per failure class',
    async (_n, locale) => {
      const label = locale.profile.name
      const seen = new Set<string>()
      for (const [, name, expected] of cases) {
        const wrapper = shallowMount(AccountStep, {
          props: {
            accountData: { name: '', seed: VALID_MNEMONIC, valid: false },
          },
          global: {
            mocks: { $t: translator(locale) },
            stubs: { QBtn: QBtnStub, QInput: QInputStub, QSpace: true },
          },
        })
        ;(wrapper.vm as unknown as { newAccount(): void }).newAccount()
        await nextTick()
        await wrapper.find(`textarea[aria-label="${label}"]`).setValue(name)
        const text = wrapper.find(`[data-error-for="${label}"]`).text()
        expect(text).toMatch(expected)
        seen.add(text)
      }
      // blank (x2) share a message; too long, and the two control-character cases, each differ.
      expect(seen.size).toBe(3)
    },
  )

  it('never uses the old "be more creative" wording, and a valid name shows no error', async () => {
    for (const locale of [enUs, frFr]) {
      expect(JSON.stringify(locale)).not.toMatch(/creative|créatif/i)
    }
    const wrapper = shallowMount(AccountStep, {
      props: { accountData: { name: '', seed: VALID_MNEMONIC, valid: false } },
      global: {
        mocks: { $t: translator(enUs) },
        stubs: { QBtn: QBtnStub, QInput: QInputStub, QSpace: true },
      },
    })
    ;(wrapper.vm as unknown as { newAccount(): void }).newAccount()
    await nextTick()
    await wrapper
      .find(`textarea[aria-label="${enUs.profile.name}"]`)
      .setValue('Alice')
    expect(
      wrapper.find(`[data-error-for="${enUs.profile.name}"]`).exists(),
    ).toBe(false)
  })
})

describe('AccountStep recovery phrase controls', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([enUs, frFr])('ships distinct localized names', locale => {
    expect(locale.accountStep.copyRecoveryPhrase).toBeTruthy()
    expect(locale.accountStep.refreshRecoveryPhrase).toBeTruthy()
    expect(locale.accountStep.copyRecoveryPhrase).not.toBe(
      locale.accountStep.refreshRecoveryPhrase,
    )
  })

  it('names and preserves the copy and refresh actions', async () => {
    const originalSeed = VALID_MNEMONIC
    const wrapper = mountStep(originalSeed)
    const newAccount = wrapper
      .findAll('button')
      .find(button => button.text() === 'New Account')
    expect(newAccount).toBeDefined()
    await newAccount?.trigger('click')

    const copy = wrapper.find('button[aria-label="Copy recovery phrase"]')
    const refresh = wrapper.find(
      'button[aria-label="Generate a new recovery phrase"]',
    )
    expect(copy.exists()).toBe(true)
    expect(refresh.exists()).toBe(true)
    expect(copy.attributes('aria-label')).not.toBe(
      refresh.attributes('aria-label'),
    )
    expect(copy.attributes('aria-label')).not.toContain(originalSeed)

    await copy.trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith(originalSeed)

    await refresh.trigger('click')
    expect(generateMnemonic).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.rawSeed).toBe(VALID_MNEMONIC)
  })

  it('makes the refreshed phrase the parent and wallet identity authority', async () => {
    const wrapper = mountStep(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    )
    const vm = wrapper.vm as unknown as {
      newAccount(): void
      generateMnemonic(): void
      copySeed(): void
      name: string
      rawSeed: string
    }

    vm.newAccount()
    vm.name = 'Alice'
    vm.generateMnemonic()
    await nextTick()

    const emitted = wrapper.emitted('update:account-data')?.at(-1)?.[0]
    expect(emitted).toEqual({
      name: 'Alice',
      seed: VALID_MNEMONIC,
      valid: true,
      nameRequired: true,
    })
    expect(vm.rawSeed).toBe(VALID_MNEMONIC)
    expect(
      wrapper.find('textarea[aria-label="profile.seedEntry"]').element.value,
    ).toBe(VALID_MNEMONIC)

    vm.copySeed()
    expect(copyToClipboard).toHaveBeenLastCalledWith(VALID_MNEMONIC)

    const persistSeed = jest.fn()
    const committed = commitValidatedSetupSeed(
      (emitted as { seed: string }).seed,
      persistSeed,
    )
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC, null)
    expect(committed).toBe(VALID_MNEMONIC)
  })
})

describe('AccountStep resume mode (#284)', () => {
  function mountResume() {
    return shallowMount(AccountStep, {
      props: {
        resume: true,
        accountData: { name: '', seed: VALID_MNEMONIC, valid: false },
      },
      global: {
        mocks: { $t: (key: string) => messages[key] ?? key },
        stubs: { QBtn: QBtnStub, QInput: QInputStub, QSpace: true },
      },
    })
  }

  it('goes straight to the stored phrase, read-only, with a notice and no New/Import/refresh controls', async () => {
    const wrapper = mountResume()
    await nextTick()

    expect(wrapper.find('[data-test="resume-notice"]').exists()).toBe(true)
    const buttons = wrapper
      .findAll('button')
      .map(b => b.attributes('aria-label'))
    expect(buttons).not.toContain('Generate a new recovery phrase')
    expect(wrapper.text()).not.toContain('New Account')
    expect(wrapper.text()).not.toContain('Import Account')
    const seedBox = wrapper.find('textarea[aria-label="profile.seedEntry"]')
    expect(seedBox.attributes('readonly')).toBeDefined()
    expect((seedBox.element as HTMLTextAreaElement).value).toBe(VALID_MNEMONIC)
  })

  it('publishes the stored seed as a New-Account-shaped draft on mount', async () => {
    const wrapper = mountResume()
    await nextTick()
    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toMatchObject({
      seed: VALID_MNEMONIC,
      nameRequired: true,
    })
  })

  it('cannot regenerate or import over the stored phrase', async () => {
    const wrapper = mountResume()
    const vm = wrapper.vm as unknown as {
      generateMnemonic(): void
      importAccount(): void
    }
    vm.generateMnemonic()
    vm.importAccount()
    await nextTick()
    const emitted = wrapper.emitted('update:account-data') ?? []
    for (const [data] of emitted) {
      expect((data as { seed: string }).seed).toBe(VALID_MNEMONIC)
      expect((data as { nameRequired: boolean }).nameRequired).toBe(true)
    }
  })
})
