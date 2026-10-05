/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import SendStealthDialog from './SendStealthDialog.vue'
import enUS from '../../i18n/en-us'

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
            template: '<select :value="modelValue"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
          },
          QInput: {
            props: ['modelValue'],
            template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
        },
      },
    })
  }

  it('renders contact name and defaults to monad-testnet', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Alice')
    expect((wrapper.vm as any).selectedChainId).toBe('monad-testnet')
  })

  it('disables send button when amount is empty or non-positive', () => {
    const wrapper = mountDialog()
    expect((wrapper.vm as any).canSend).toBe(false)
  })

  it('emits send with multi-chain payload when confirmed', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({
      selectedChainId: 'solana-testnet',
      amount: '2.5',
      memo: 'Secret bet cover',
    })
    expect((wrapper.vm as any).canSend).toBe(true)

    ;(wrapper.vm as any).sendStealth()

    const emitted = wrapper.emitted('send')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toEqual({
      address: '0xAlice',
      chainId: 'solana-testnet',
      amount: 2.5,
      memo: 'Secret bet cover',
    })
  })
})
