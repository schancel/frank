/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { nextTick } from 'vue'

import AccountStep from './AccountStep.vue'

const VALID_MNEMONIC =
  'test test test test test test test test test test test junk'

describe('AccountStep import flow', () => {
  function mountStep() {
    return shallowMount(AccountStep, {
      props: {
        accountData: {
          name: '',
          seed: 'eagerly generated unrelated seed',
          valid: false,
        },
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          QSpace: true,
          QBtn: true,
          QInput: true,
        },
      },
    })
  }

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
