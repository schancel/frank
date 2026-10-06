/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import ChatMessageStealth from './ChatMessageStealth.vue'
import enUS from '../../../i18n/en-us'

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

describe('ChatMessageStealth', () => {
  const mountComponent = (props = {}) => {
    return mount(ChatMessageStealth, {
      props: {
        amount: 2.5,
        ...props,
      },
      global: {
        mocks: {
          $t: translator(enUS),
          $q: { dark: { isActive: false } },
        },
        provide: {
          _q_: { dark: { isActive: false } },
        },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QIcon: { template: '<i />' },
          QBadge: { template: '<span><slot /></span>' },
        },
      },
    })
  }

  it('renders received stealth payment by default with amount, currency badge, and confirmed status', () => {
    const wrapper = mountComponent({
      amount: 2.5,
      networkTag: 'MONT',
    })
    expect(wrapper.find('[data-testid="stealth-title"]').text()).toBe(
      'Received Stealth Payment',
    )
    expect(wrapper.find('[data-testid="stealth-amount"]').text()).toBe('2.5')
    expect(wrapper.find('[data-testid="stealth-currency-badge"]').text()).toBe(
      'MONT',
    )
    expect(wrapper.find('[data-testid="stealth-status-badge"]').text()).toBe(
      'Confirmed',
    )
  })

  it('renders sent stealth payment title when outbound is true', () => {
    const wrapper = mountComponent({
      amount: 1.0,
      outbound: true,
      networkTag: 'MONT',
    })
    expect(wrapper.find('[data-testid="stealth-title"]').text()).toBe(
      'Sent Stealth Payment',
    )
  })

  it('renders Solana stealth payment with tSOL unit and Solana chain badge', () => {
    const wrapper = mountComponent({
      amount: 0.05,
      networkTag: 'solana-devnet',
    })
    expect(wrapper.find('[data-testid="stealth-amount"]').text()).toBe('0.05')
    expect(wrapper.find('[data-testid="stealth-currency-badge"]').text()).toBe(
      'tSOL',
    )
    expect(wrapper.find('[data-testid="stealth-chain-badge"]').text()).toBe(
      'Solana',
    )
  })

  it('renders eCash stealth payment with XEC unit and eCash chain badge', () => {
    const wrapper = mountComponent({
      amount: 500,
      networkTag: 'ecash-mainnet',
    })
    expect(wrapper.find('[data-testid="stealth-amount"]').text()).toBe('500')
    expect(wrapper.find('[data-testid="stealth-currency-badge"]').text()).toBe(
      'XEC',
    )
    expect(wrapper.find('[data-testid="stealth-chain-badge"]').text()).toBe(
      'eCash',
    )
  })

  it('displays direct credit indicator and verifies no sweep button exists', () => {
    const wrapper = mountComponent()
    expect(
      wrapper.find('[data-testid="stealth-direct-credit-hint"]').text(),
    ).toBe('Indexed into spendable balance')
    // Asserts that no sweep action button is rendered in the component
    expect(wrapper.find('[data-testid="stealth-sweep-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.text().toLowerCase()).not.toContain('sweep')
  })

  it('displays memo when provided', () => {
    const wrapper = mountComponent({
      memo: 'For secret dinner yesterday',
    })
    expect(wrapper.find('[data-testid="stealth-memo"]').text()).toContain(
      'For secret dinner yesterday',
    )
  })

  it('renders block explorer link for Monad testnet transaction', () => {
    const wrapper = mountComponent({
      networkTag: 'MONT',
      transactions: ['0x1234567890abcdef1234567890abcdef12345678'],
    })
    const link = wrapper.find('[data-testid="stealth-explorer-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(
      'https://testnet.monadscan.com/tx/0x1234567890abcdef1234567890abcdef12345678',
    )
    expect(link.text()).toBe('0x123456...345678')
  })

  it('renders block explorer link for Solana devnet transaction', () => {
    const wrapper = mountComponent({
      networkTag: 'solana-devnet',
      transactions: ['5K6yZ...solSig123456789'],
    })
    const link = wrapper.find('[data-testid="stealth-explorer-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toContain('explorer.solana.com/tx/5K6yZ')
    expect(link.attributes('href')).toContain('cluster=devnet')
  })

  it('renders block explorer link for eCash transaction', () => {
    const wrapper = mountComponent({
      networkTag: 'ecash-mainnet',
      transactions: ['ecashTxId1234567890'],
    })
    const link = wrapper.find('[data-testid="stealth-explorer-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(
      'https://blockchair.com/ecash/transaction/ecashTxId1234567890',
    )
  })
})
