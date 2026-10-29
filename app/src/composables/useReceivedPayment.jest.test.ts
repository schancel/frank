/** @jest-environment jsdom */

import { defineComponent, h, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { ReceivedPayment } from '@frank/wallet/chain/chain-wallet'
import { useReceivedPayment } from './useReceivedPayment'
import { peekActiveWallet, useActiveWallet } from './useActiveWallet'
import { receivedValueRevision } from '../utils/message-receipts'

const mockSessionState = reactive({
  status: 'ready',
  revision: 1,
  account: null,
})
jest.mock('../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockSessionState
    },
  },
}))
jest.mock('../utils/message-receipts', () => ({
  receivedValueRevision: jest.requireActual('vue').ref(0),
}))
jest.mock('./useActiveWallet', () => ({
  peekActiveWallet: jest.fn(),
  useActiveWallet: jest.fn(),
}))

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
    mockSessionState.status = 'ready'
    mockSessionState.revision++
    ;(peekActiveWallet as jest.Mock).mockReturnValue(wallet)
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
    wallet.getReceivedPayments.mockReturnValue([
      coin({ status: 'unverifiable' }),
    ])
    wallet.refreshReceivedPayments.mockRejectedValue(new Error('node down'))
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    expect(payment()?.status).toBe('unverifiable')
    await afterRecheck()
    expect(
      wallet.refreshReceivedPayments.mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
    expect(payment()?.status).toBe('unverifiable')
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
    expect(peekActiveWallet).not.toHaveBeenCalled()
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

  it('says nothing alarming for a payment the node cannot show either way, and keeps checking', async () => {
    const unclear = coin({ status: 'unverifiable', address: '0xunclear' })
    wallet.getReceivedPayments.mockReturnValue([unclear])
    wallet.refreshReceivedPayments.mockResolvedValue([unclear])
    const told: ReceivedPayment[] = []
    const wrapper = mount(
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
    )
    await afterRecheck(2)
    expect(told).toEqual([])
    expect(
      wallet.refreshReceivedPayments.mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
    wrapper.unmount()
  })

  it('a mounted received card rereads current funds on the shared revision without recovery or custody', async () => {
    wallet.getReceivedPayments.mockReturnValue([
      coin({
        status: 'received',
        receivedAmountWei: 5n,
        amountWei: 5n,
        spendable: true,
      }),
    ])
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    expect(payment()?.spendable).toBe(true)
    wallet.getReceivedPayments.mockReturnValue([
      coin({
        status: 'received',
        receivedAmountWei: 5n,
        amountWei: 0n,
        spendable: false,
      }),
    ])
    receivedValueRevision.value++
    expect(payment()).toMatchObject({
      status: 'received',
      receivedAmountWei: 5n,
      amountWei: 0n,
      spendable: false,
    })
    expect(wallet.refreshReceivedPayments).not.toHaveBeenCalled()
    expect(useActiveWallet).not.toHaveBeenCalled()
    wallet.getReceivedPayments.mockImplementationOnce(() => {
      throw new Error('snapshot unavailable')
    })
    receivedValueRevision.value++
    expect(payment()?.amountWei).toBe(0n)
    wrapper.unmount()
    const calls = wallet.getReceivedPayments.mock.calls.length
    receivedValueRevision.value++
    expect(wallet.getReceivedPayments).toHaveBeenCalledTimes(calls)
  })

  it.each([8, 16, 32])(
    'shares one indexed snapshot across %i received cards per revision',
    async count => {
      const keys = Array.from(
        { length: count },
        (_, i) => '02' + (i + 1).toString(16).padStart(64, '0'),
      )
      const received = keys.map(ephemeralPubKey =>
        coin({
          ephemeralPubKey,
          status: 'received',
          receivedAmountWei: 5n,
          amountWei: 5n,
          spendable: true,
        }),
      )
      wallet.getReceivedPayments.mockReturnValue(received)
      const cards = keys.map(key => harness(key))
      await flushPromises()
      wallet.getReceivedPayments.mockClear()
      wallet.getReceivedPayments.mockReturnValue(
        received.map(p => ({
          ...p,
          amountWei: 0n,
          spendable: false,
        })),
      )
      let fresh: ReturnType<typeof harness> | undefined
      try {
        receivedValueRevision.value++
        expect(wallet.getReceivedPayments).toHaveBeenCalledTimes(1)
        expect(cards.every(card => card.payment()?.amountWei === 0n)).toBe(true)
        receivedValueRevision.value++
        expect(wallet.getReceivedPayments).toHaveBeenCalledTimes(2)
        // A newly mounted card reads current owner facts, even in this same revision/turn.
        const freshKey = '03' + 'ff'.repeat(32)
        wallet.getReceivedPayments.mockReturnValue([
          coin({
            ephemeralPubKey: freshKey,
            status: 'received',
            amountWei: 9n,
            spendable: true,
          }),
        ])
        fresh = harness(freshKey)
        expect(fresh.payment()?.amountWei).toBe(9n)
        expect(wallet.refreshReceivedPayments).not.toHaveBeenCalled()
      } finally {
        cards.forEach(card => card.wrapper.unmount())
        fresh?.wrapper.unmount()
      }
      const calls = wallet.getReceivedPayments.mock.calls.length
      receivedValueRevision.value++
      expect(wallet.getReceivedPayments).toHaveBeenCalledTimes(calls)
    },
  )

  it('a late pending recovery cannot replace a newer confirmed empty projection', async () => {
    let finish!: (v: ReceivedPayment[]) => void
    wallet.getReceivedPayments.mockReturnValue([coin()])
    wallet.refreshReceivedPayments.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    wallet.getReceivedPayments.mockReturnValue([
      coin({
        status: 'received',
        receivedAmountWei: 5n,
        amountWei: 0n,
        spendable: false,
      }),
    ])
    receivedValueRevision.value++
    finish([
      coin({
        status: 'received',
        receivedAmountWei: 5n,
        amountWei: 5n,
        spendable: true,
      }),
    ])
    await flushPromises()
    expect(payment()).toMatchObject({
      status: 'received',
      receivedAmountWei: 5n,
      amountWei: 0n,
      spendable: false,
    })
    wrapper.unmount()
  })

  it('old async completion is ignored after the wallet/session/key changes or unmounts', async () => {
    let finish!: (v: ReceivedPayment[]) => void
    wallet.getReceivedPayments.mockReturnValue([coin()])
    wallet.refreshReceivedPayments.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    const key = ref(KEY)
    let payment!: ReturnType<typeof useReceivedPayment>['payment']
    const wrapper = mount(
      defineComponent({
        setup() {
          payment = useReceivedPayment(() => key.value, RECHECK_MS).payment
          return () => h('div')
        },
      }),
    )
    await flushPromises()
    const nextKey = '03' + '33'.repeat(32)
    const next = {
      getReceivedPayments: jest.fn(() => [
        coin({
          ephemeralPubKey: nextKey,
          status: 'received',
          receivedAmountWei: 9n,
          amountWei: 0n,
          spendable: false,
        }),
      ]),
      refreshReceivedPayments: jest.fn(),
    }
    ;(peekActiveWallet as jest.Mock).mockReturnValue(next)
    key.value = nextKey
    mockSessionState.revision++
    expect(payment.value?.ephemeralPubKey).toBe(nextKey)
    finish([coin({ status: 'received', amountWei: 5n, spendable: true })])
    await flushPromises()
    expect(payment.value?.ephemeralPubKey).toBe(nextKey)
    expect(next.refreshReceivedPayments).not.toHaveBeenCalled()
    wrapper.unmount()
    receivedValueRevision.value++
    expect(payment.value?.amountWei).toBe(0n)
  })

  it('a locked wallet stays unopened until a ready owner is published', async () => {
    ;(peekActiveWallet as jest.Mock).mockReturnValue(undefined)
    const { wrapper, payment } = harness(KEY)
    await flushPromises()
    expect(payment()).toBeUndefined()
    expect(wallet.getReceivedPayments).not.toHaveBeenCalled()
    wallet.getReceivedPayments.mockReturnValue([
      coin({
        status: 'received',
        receivedAmountWei: 5n,
        amountWei: 5n,
        spendable: true,
      }),
    ])
    ;(peekActiveWallet as jest.Mock).mockReturnValue(wallet)
    mockSessionState.revision++
    expect(payment()?.status).toBe('received')
    expect(wallet.refreshReceivedPayments).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
