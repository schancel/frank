/** @jest-environment jsdom */

import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import SendStealthDialog from './SendStealthDialog.vue'
import enUS from '../../i18n/en-us'
import { activeChain } from '@frank/wallet/chain'

const mockBalance = ref(2500000000000000000n)
const mockFormattedBalance = ref('2.50 MON')
const mockLoaded = ref(true)

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    balance: mockBalance,
    formattedBalance: mockFormattedBalance,
    loaded: mockLoaded,
  }),
}))

function translator(messages: unknown) {
  return (key: string, params?: Record<string, unknown>) => {
    let value: unknown = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
    if (typeof value === 'string' && params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v))
      }
    }
    return typeof value === 'string' ? value : key
  }
}

describe('SendStealthDialog', () => {
  const mountDialog = (props = {}) => {
    return mount(SendStealthDialog, {
      props: {
        address: '0xAlice',
        contact: { name: 'Alice' },
        ...props,
      },
      global: {
        mocks: { $t: translator(enUS) },
        directives: { 'close-popup': {} },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QSelect: {
            props: ['modelValue', 'options'],
            template:
              '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
          },
          QInput: {
            props: ['modelValue', 'error', 'errorMessage', 'hint'],
            template:
              '<div><input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span v-if="error" class="error-text">{{ errorMessage }}</span></div>',
          },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
        },
      },
    })
  }

  beforeEach(() => {
    mockLoaded.value = true
  })

  it('names the contact and pays in the wallet own unit: no other wallet is offered', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Alice')
    expect((wrapper.vm as any).currentUnit).toBe(activeChain.unit)
    expect(wrapper.find('[data-testid="stealth-wallet-select"]').exists()).toBe(
      false,
    )
  })

  it('shows the wallet real balance, and no figure at all while it is not known', async () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-testid="wallet-balance-value"]').text()).toBe(
      '2.50 MON',
    )
    mockLoaded.value = false
    await wrapper.vm.$nextTick()
    const unknown = wrapper.find('[data-testid="wallet-balance-value"]').text()
    expect(unknown).toBe('…')
    expect(unknown).not.toMatch(/\d/)
  })

  it('cannot send an empty, zero, negative or unparseable amount', async () => {
    const wrapper = mountDialog()
    for (const amount of ['', '0', '-1', 'abc']) {
      await wrapper.setData({ amount })
      expect((wrapper.vm as any).canSend).toBe(false)
      ;(wrapper.vm as any).sendStealth()
    }
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('emits the amount in the chain base unit and the memo: what the wallet needs to pay', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({ amount: '2.5', memo: '  lunch  ' })
    expect((wrapper.vm as any).canSend).toBe(true)
    ;(wrapper.vm as any).sendStealth()

    const emitted = wrapper.emitted('send')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toEqual({
      address: '0xAlice',
      value: activeChain.fromDisplayAmount('2.5'),
      memo: 'lunch',
    })
    expect(activeChain.fromDisplayAmount('2.5')).toBe(
      2_500_000_000_000_000_000n,
    )
  })
})
