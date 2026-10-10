/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import OfferSwapDialog from './OfferSwapDialog.vue'
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

describe('OfferSwapDialog', () => {
  const mountDialog = (props = {}) => {
    return mount(OfferSwapDialog, {
      props: {
        address: '0xBob',
        contact: { name: 'Bob' },
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
              '<select :value="modelValue"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
          },
          QInput: {
            props: ['modelValue'],
            template:
              '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
          QBtn: {
            props: ['disable'],
            template: '<button :disabled="disable"><slot /></button>',
          },
        },
      },
    })
  }

  it('renders contact name and default chains', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('Bob')
    expect((wrapper.vm as any).offeredChain).toBe('monad-testnet')
    expect((wrapper.vm as any).requestedChain).toBe('solana-devnet')
  })

  it('offers only the networks the app has a wallet for', () => {
    const wrapper = mountDialog()
    const offered = (wrapper.vm as any).chainOptions.map(
      (option: { value: string }) => option.value,
    )
    expect(offered.sort()).toEqual([
      'bch-testnet',
      'btc-testnet',
      'monad-mainnet',
      'monad-testnet',
      'solana-devnet',
      'solana-mainnet',
      'xec-testnet',
    ])
  })

  it('disables offer button until both amounts are valid and chains differ', async () => {
    const wrapper = mountDialog()
    expect((wrapper.vm as any).canOffer).toBe(false)

    await wrapper.setData({ offeredAmount: '1.0' })
    expect((wrapper.vm as any).canOffer).toBe(false)

    await wrapper.setData({ requestedAmount: '5.0' })
    expect((wrapper.vm as any).canOffer).toBe(true)

    // Cannot swap same chain for same chain
    await wrapper.setData({ requestedChain: 'monad-testnet' })
    expect((wrapper.vm as any).canOffer).toBe(false)
  })

  it('emits offer event with complete cross-chain swap offer payload', async () => {
    const wrapper = mountDialog()
    await wrapper.setData({
      offeredChain: 'monad-testnet',
      offeredAmount: '10.5',
      requestedChain: 'solana-devnet',
      requestedAmount: '1.25',
    })
    expect((wrapper.vm as any).canOffer).toBe(true)
    ;(wrapper.vm as any).offerSwap()

    const emitted = wrapper.emitted('offer')
    expect(emitted).toHaveLength(1)
    const payload = emitted![0][0] as any
    expect(payload.type).toBe('swap-offer')
    expect(payload.offeredChain).toBe('monad-testnet')
    expect(payload.offeredAsset).toBe('MON')
    expect(payload.offeredAmount).toBe('10.5')
    expect(payload.requestedChain).toBe('solana-devnet')
    expect(payload.requestedAsset).toBe('SOL')
    expect(payload.requestedAmount).toBe('1.25')
    expect(payload.status).toBe('pending')
    expect(payload.recipientAddress).toBe('0xBob')
    expect(payload.swapId).toHaveLength(32)
  })
})
