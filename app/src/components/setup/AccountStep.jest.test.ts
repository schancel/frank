/** @jest-environment jsdom */

import { defineComponent, nextTick } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { copyToClipboard } from 'quasar'
import { generateMnemonic } from 'bip39'

import AccountStep from './AccountStep.vue'
import enUs from '../../i18n/en-us'
import frFr from '../../i18n/fr-fr'
import { commitValidatedSetupSeed } from '../../utils/setup-account'

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
        QInput: true,
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
      seed: string
    }

    vm.importAccount()
    vm.seed = 'not a recovery phrase'
    await nextTick()

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: '',
      seed: 'not a recovery phrase',
      valid: false,
    })
  })

  it('normalizes a valid imported phrase and emits literal true', async () => {
    const wrapper = mountStep()
    const vm = wrapper.vm as unknown as {
      importAccount(): void
      seed: string
    }

    vm.importAccount()
    vm.seed = `  ${VALID_MNEMONIC.toUpperCase()}  `
    await nextTick()

    expect(wrapper.emitted('update:account-data')?.at(-1)?.[0]).toEqual({
      name: '',
      seed: VALID_MNEMONIC,
      valid: true,
    })
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
    })
    expect(vm.rawSeed).toBe(VALID_MNEMONIC)

    vm.copySeed()
    expect(copyToClipboard).toHaveBeenLastCalledWith(VALID_MNEMONIC)

    const persistSeed = jest.fn()
    const committed = commitValidatedSetupSeed(
      (emitted as { seed: string }).seed,
      persistSeed,
    )
    expect(persistSeed).toHaveBeenCalledWith(VALID_MNEMONIC)
    expect(committed).toBe(VALID_MNEMONIC)
  })
})
