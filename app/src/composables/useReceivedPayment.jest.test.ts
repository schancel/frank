/** @jest-environment jsdom */

import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { ReceivedPayment } from '@frank/wallet/chain/chain-wallet'
import { useReceivedPayment } from './useReceivedPayment'
import { useActiveWallet } from './useActiveWallet'

jest.mock('./useActiveWallet', () => ({ useActiveWallet: jest.fn() }))

const RECHECK_MS = 10
const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const afterRecheck = (times = 1) =>
  new Promise<void>(resolve => setTimeout(resolve, RECHECK_MS * times * 3))

const KEY = '02' + '22'.repeat(32)
const coin = (overrides: Partial<ReceivedPayment> = {}): ReceivedPayment => ({
  address: '0x' + 'a1'.repeat(20),
  origin: 'stealth',
  status: 'pending',
  amountWei: 0n,
  claimedAmountWei: 5n,
  spendable: false,
  ephemeralPubKey: KEY,
  ...overrides,
})

function harness(key: string | undefined) {
  let payment!: ReturnType<typeof useReceivedPayment>['payment']
  const wrapper = mount(
    defineComponent({
      setup() {
        payment = useReceivedPayment(() => key, RECHECK_MS).payment
        return () => h('div')
      },
    }),
  )
  return { wrapper, payment: () => payment.value }
}

describe('useReceivedPayment', () => {
  const wallet = {
    getReceivedPayments: jest.fn<ReceivedPayment[], []>(),
    refreshReceivedPayments: jest.fn<Promise<ReceivedPayment[]>, []>(),
  }
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useActiveWallet as jest.Mock).mockResolvedValue(wallet)
  })

  it('has nothing to say when the wallet holds no coin for the item, and asks the chain nothing', async () => {
    wallet.getReceivedPayments.mockReturnValue([
      coin({ ephemeralPubKey: '03' + '44'.repeat(32) }),
    ])
    const { wrapper, payment } = harness(
      `0x${KEY.toUpperCase()}`.replace('0X', '0x'),
    )
    await flushPromises()
    expect(payment()).toBeUndefined()
    expect(wallet.refreshReceivedPayments).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('a pending payment is read from the chain, and again later, until the chain shows it', async () => {
    wallet.getReceivedPayments.mockReturnValue([coin()])
    wallet.refreshReceivedPayments
      .mockResolvedValueOnce([coin()])
      .mockResolvedValueOnce([
        coin({ status: 'received', amountWei: 5n, spendable: true }),
      ])
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    expect(payment()?.status).toBe('pending')
    expect(wallet.refreshReceivedPayments).toHaveBeenCalledTimes(1)

    wallet.getReceivedPayments.mockReturnValue([coin()])
    await afterRecheck()
    expect(payment()).toMatchObject({ status: 'received', spendable: true })
    expect(wallet.refreshReceivedPayments).toHaveBeenCalledTimes(2)

    // Received: nothing more is asked.
    await afterRecheck(3)
    expect(wallet.refreshReceivedPayments).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('a node that cannot be read leaves the wallet last answer in place and is tried again', async () => {
    wallet.getReceivedPayments.mockReturnValue([coin({ status: 'not-found' })])
    wallet.refreshReceivedPayments.mockRejectedValue(new Error('node down'))
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    expect(payment()?.status).toBe('not-found')
    await afterRecheck()
    expect(
      wallet.refreshReceivedPayments.mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
    expect(payment()?.status).toBe('not-found')
    // Unmounted: it stops asking.
    wrapper.unmount()
    const asked = wallet.refreshReceivedPayments.mock.calls.length
    await afterRecheck(3)
    expect(wallet.refreshReceivedPayments).toHaveBeenCalledTimes(asked)
  })

  it('asks nothing for an item with no key (a payment this wallet sent)', async () => {
    const { wrapper, payment } = harness(undefined)
    await flushPromises()
    expect(payment()).toBeUndefined()
    expect(useActiveWallet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reports a claimed payment that did not arrive once, however often it is looked at', async () => {
    const missing = coin({ status: 'not-received', address: '0xmissing' })
    wallet.getReceivedPayments.mockReturnValue([missing])
    wallet.refreshReceivedPayments.mockResolvedValue([missing])
    const told: ReceivedPayment[] = []
    const mounts = [0, 1].map(() =>
      mount(
        defineComponent({
          setup() {
            useReceivedPayment(
              () => KEY,
              RECHECK_MS,
              payment => told.push(payment),
            )
            return () => h('div')
          },
        }),
      ),
    )
    await afterRecheck(2)
    expect(told).toEqual([missing])
    mounts.forEach(wrapper => wrapper.unmount())
  })
})
