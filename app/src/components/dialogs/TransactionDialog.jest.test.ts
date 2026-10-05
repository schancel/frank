/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import TransactionDialog from './TransactionDialog.vue'
import enUS from '../../i18n/en-us'
import * as explorer from 'src/utils/explorer'
import { copyToClipboard } from 'quasar'

jest.mock('quasar', () => ({
  copyToClipboard: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('src/utils/notifications', () => ({
  infoNotify: jest.fn(),
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

describe('TransactionDialog', () => {
  const stampPayments = [
    {
      txHash: '0x71f8b14d1234567890abcdef',
      destinationAddress: '0xrecipient',
      valueWei: 10000000000000000n,
    },
  ]

  it('renders external explorer link when explorer is available', () => {
    jest
      .spyOn(explorer, 'transactionExplorerUrl')
      .mockReturnValue(
        'https://testnet.monadscan.com/tx/0x71f8b14d1234567890abcdef',
      )

    const wrapper = mount(TransactionDialog, {
      props: {
        title: 'Transaction Details',
        stampPayments,
      },
      global: {
        mocks: { $t: translator(enUS) },
        directives: { 'close-popup': {} },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<div><slot /></div>' },
          QItemSection: { template: '<div><slot /></div>' },
          QItemLabel: { template: '<div><slot /></div>' },
          QTabs: { template: '<div />' },
          QTab: { template: '<div />' },
          QTabPanels: { template: '<div />' },
          QTabPanel: { template: '<div />' },
          QBtn: { template: '<button><slot /></button>' },
          QTooltip: { template: '<span />' },
        },
      },
    })

    const link = wrapper.find(
      'a[href="https://testnet.monadscan.com/tx/0x71f8b14d1234567890abcdef"]',
    )
    expect(link.exists()).toBe(true)
    expect(wrapper.find('[data-testid="local-chain-notice"]').exists()).toBe(
      false,
    )
  })

  it('handles local chain gracefully by displaying notice and offering copy button', async () => {
    jest.spyOn(explorer, 'transactionExplorerUrl').mockReturnValue(undefined)

    const wrapper = mount(TransactionDialog, {
      props: {
        title: 'Transaction Details',
        stampPayments,
      },
      global: {
        mocks: { $t: translator(enUS) },
        directives: { 'close-popup': {} },
        stubs: {
          QCard: { template: '<div><slot /></div>' },
          QCardSection: { template: '<div><slot /></div>' },
          QCardActions: { template: '<div><slot /></div>' },
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<div><slot /></div>' },
          QItemSection: { template: '<div><slot /></div>' },
          QItemLabel: { template: '<div><slot /></div>' },
          QTabs: { template: '<div />' },
          QTab: { template: '<div />' },
          QTabPanels: { template: '<div />' },
          QTabPanel: { template: '<div />' },
          QBtn: {
            template: '<button @click="$emit(\'click\')"><slot /></button>',
          },
          QTooltip: { template: '<span />' },
        },
      },
    })

    expect(wrapper.find('a').exists()).toBe(false)
    const notice = wrapper.get('[data-testid="local-chain-notice"]')
    expect(notice.text()).toContain('Local stack / chain shim')
    expect(notice.text()).toContain('0x71f8b14d1234567890abcdef')

    const copyBtn = wrapper.get('button[aria-label="Copy transaction hash"]')
    await copyBtn.trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith('0x71f8b14d1234567890abcdef')
  })
})
