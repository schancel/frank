/** @jest-environment jsdom */

import { defineComponent } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { copyToClipboard } from 'quasar'
import { generateMnemonic } from 'bip39'

import AccountStep from './AccountStep.vue'
import enUs from '../../i18n/en-us'
import frFr from '../../i18n/fr-fr'

jest.mock('quasar', () => ({
  copyToClipboard: jest.fn(() => Promise.resolve()),
}))
jest.mock('bip39', () => ({
  generateMnemonic: jest.fn(() => 'fresh recovery phrase'),
  validateMnemonic: jest.fn(() => true),
}))
jest.mock('../../utils/notifications', () => ({
  seedCopiedNotify: jest.fn(),
}))

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

describe('AccountStep recovery phrase controls', () => {
  it.each([enUs, frFr])('ships distinct localized names', locale => {
    expect(locale.accountStep.copyRecoveryPhrase).toBeTruthy()
    expect(locale.accountStep.refreshRecoveryPhrase).toBeTruthy()
    expect(locale.accountStep.copyRecoveryPhrase).not.toBe(
      locale.accountStep.refreshRecoveryPhrase,
    )
  })

  it('names and preserves the copy and refresh actions', async () => {
    const wrapper = shallowMount(AccountStep, {
      props: {
        accountData: {
          name: '',
          seed: 'original recovery phrase',
        },
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
    expect(copy.attributes('aria-label')).not.toContain(
      'original recovery phrase',
    )

    await copy.trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith('original recovery phrase')

    await refresh.trigger('click')
    expect(generateMnemonic).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.rawSeed).toBe('fresh recovery phrase')
  })
})
