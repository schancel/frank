/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import type { ContactPaymentInfo } from '@frank/wallet/chain'
import { activeChain } from '@frank/wallet/chain'
import HeldContactPayments from './HeldContactPayments.vue'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import enUS from '../../i18n/en-us'

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('src/utils/notifications', () => ({ errorNotify: jest.fn() }))

const t = (key: string) =>
  (key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS) as
    | string
    | undefined) ?? key
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const payment = (
  overrides: Partial<ContactPaymentInfo>,
): ContactPaymentInfo => ({
  messageId: 'm',
  ephemeralPubKey: '02aa',
  holdsFunds: true,
  recipientAddress: '0xbob',
  valueWei: 10n ** 18n,
  state: 'prepared',
  ...overrides,
})

describe('HeldContactPayments', () => {
  let payments: ContactPaymentInfo[]
  const settleContactPayment = jest.fn()
  const mountList = () =>
    mount(HeldContactPayments, {
      // Long enough that only the mount's own read happens during a test.
      props: { refreshMs: 60_000 },
      global: {
        mocks: { $t: t },
        stubs: {
          QList: { template: '<div><slot /></div>' },
          QItem: { template: '<div><slot /></div>' },
          QItemSection: { template: '<div><slot /></div>' },
          QItemLabel: { template: '<div><slot /></div>' },
          QBtn: {
            props: ['label'],
            template: '<button @click="$emit(\'click\')">{{ label }}</button>',
          },
        },
      },
    })

  beforeEach(() => {
    jest.clearAllMocks()
    payments = []
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      getContactPayments: () => payments,
      settleContactPayment,
    })
  })

  it('shows nothing when no payment is in progress', async () => {
    payments = [
      payment({ state: 'paid', holdsFunds: false }),
      payment({
        state: 'released',
        holdsFunds: false,
        ephemeralPubKey: '02bb',
      }),
    ]
    const wrapper = mountList()
    await settle()
    expect(wrapper.find('[data-testid="held-contact-payments"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('lists each unfinished payment with its amount and the wallet state for it', async () => {
    payments = [
      payment({ state: 'prepared' }),
      payment({
        state: 'failed',
        ephemeralPubKey: '02bb',
        valueWei: 2n * 10n ** 18n,
      }),
      payment({
        state: 'delivered',
        ephemeralPubKey: '02cc',
        holdsFunds: false,
      }),
    ]
    const wrapper = mountList()
    await settle()
    const rows = wrapper.findAll('[data-testid="held-contact-payment"]')
    expect(rows).toHaveLength(3)
    expect(
      rows[0].find('[data-testid="held-contact-payment-amount"]').text(),
    ).toBe(`${activeChain.toDisplayAmount(10n ** 18n)} ${activeChain.unit}`)
    expect(
      rows.map(row =>
        row.find('[data-testid="held-contact-payment-state"]').text(),
      ),
    ).toEqual([
      'Signed. Waiting for its message to be delivered; its funds are held.',
      'Its message could not be delivered. The payment is kept; its funds are held.',
      'Message delivered. The payment is on its way to the chain.',
    ])
    wrapper.unmount()
  })

  it('Finish asks the wallet to settle that payment and then shows what the wallet says', async () => {
    payments = [payment({ state: 'prepared', ephemeralPubKey: '02dd' })]
    settleContactPayment.mockImplementation(async () => {
      payments = [
        payment({
          state: 'released',
          holdsFunds: false,
          ephemeralPubKey: '02dd',
        }),
      ]
      return 'released'
    })
    const wrapper = mountList()
    await settle()
    await wrapper
      .find('[data-testid="held-contact-payment-finish"]')
      .trigger('click')
    await settle()
    expect(settleContactPayment).toHaveBeenCalledWith('02dd')
    expect(wrapper.find('[data-testid="held-contact-payments"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })
})
