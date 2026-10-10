/** @jest-environment jsdom */

import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { Wallet } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import type { ReceivedPayment } from '@frank/wallet/chain/chain-wallet'
import ChatMessageStealth from './ChatMessageStealth.vue'
import enUS from '../../../i18n/en-us'
import { errorNotify } from '../../../utils/notifications'

// The wallet's answer about the payment. The bubble never decides this itself.
const mockPayment = ref<ReceivedPayment | undefined>()
const mockAskedFor: (string | undefined)[] = []
let mockOnNotReceived: ((payment: ReceivedPayment) => void) | undefined
jest.mock('../../../composables/useReceivedPayment', () => ({
  useReceivedPayment: (
    ephemeralPubKey: () => string | undefined,
    _recheckMs?: number,
    onNotReceived?: (payment: ReceivedPayment) => void,
  ) => {
    mockAskedFor.push(ephemeralPubKey())
    mockOnNotReceived = onNotReceived
    return { payment: mockPayment }
  },
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))

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

const ONE = 10n ** 18n
const KEY = '02' + '22'.repeat(32)
const coin = (overrides: Partial<ReceivedPayment>): ReceivedPayment => ({
  address: '0x' + 'a1'.repeat(20),
  origin: 'stealth',
  status: 'pending',
  amountWei: 0n,
  claimedAmountWei: 2n * ONE,
  spendable: false,
  ephemeralPubKey: KEY,
  ...overrides,
})

describe('ChatMessageStealth', () => {
  const mountComponent = (props = {}) =>
    mount(ChatMessageStealth, {
      props: {
        amount: Number(2n * ONE),
        networkTag: 'MONT',
        ephemeralPubKey: KEY,
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
  const text = (wrapper: ReturnType<typeof mountComponent>, id: string) =>
    wrapper.find(`[data-testid="${id}"]`).text()

  beforeEach(() => {
    mockPayment.value = undefined
    mockAskedFor.length = 0
  })

  it('a payment the wallet holds no coin for is not checked: nothing says it arrived', () => {
    const wrapper = mountComponent()
    expect(mockAskedFor).toEqual([KEY])
    expect(text(wrapper, 'stealth-title')).toBe('Received Stealth Payment')
    // The stated amount, in display units, with the wallet's unit.
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(2n * ONE),
    )
    expect(text(wrapper, 'stealth-currency-badge')).toBe('MONT')
    expect(text(wrapper, 'stealth-status-badge')).toBe('Not checked')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'Your wallet has not checked this payment against the chain.',
    )
    expect(wrapper.text()).not.toMatch(/Confirmed|spendable balance/i)
  })

  it('pending until the chain shows it: not in the balance', () => {
    mockPayment.value = coin({ status: 'pending' })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe('Pending')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'Waiting for the chain to show this payment. It is not in your balance yet.',
    )
    expect(wrapper.text()).not.toMatch(/spendable balance/i)
  })

  it('received and spendable only when the wallet says the chain shows the money', () => {
    mockPayment.value = coin({
      status: 'received',
      amountWei: 2n * ONE,
      receivedAmountWei: 2n * ONE,
      spendable: true,
    })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe('Received')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'In your spendable balance',
    )
    expect(
      wrapper.find('[data-testid="stealth-amount-mismatch"]').exists(),
    ).toBe(false)
  })

  it('shows the amount the chain showed when the sender stated more', () => {
    mockPayment.value = coin({
      status: 'received',
      amountWei: ONE,
      receivedAmountWei: ONE,
      claimedAmountWei: 2n * ONE,
      spendable: true,
    })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(ONE),
    )
    expect(text(wrapper, 'stealth-amount-mismatch')).toBe(
      `The sender stated ${activeChain.toDisplayAmount(
        2n * ONE,
      )} MONT; the chain shows ${activeChain.toDisplayAmount(ONE)} MONT.`,
    )
  })

  it('received and spent since: still the amount that arrived, no longer called spendable', () => {
    mockPayment.value = coin({
      status: 'received',
      amountWei: 0n,
      receivedAmountWei: 2n * ONE,
      spendable: false,
    })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(2n * ONE),
    )
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'Received, and spent since',
    )
  })

  it('a claimed payment that did not arrive says so, with the amount shown as claimed', () => {
    mockPayment.value = coin({ status: 'not-received' })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe('Payment not received')
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(2n * ONE),
    )
    expect(text(wrapper, 'stealth-amount-claimed')).toBe('(claimed)')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'The sender claimed this payment, and the chain shows no such transfer. It is not in your balance. Your wallet keeps checking.',
    )
  })

  it('a payment that can never arrive is shown as failed', () => {
    mockPayment.value = coin({ status: 'failed' })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe('Payment failed')
    expect(text(wrapper, 'stealth-amount-claimed')).toBe('(claimed)')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'This payment can never arrive: its transaction failed or was replaced. It is not in your balance.',
    )
  })

  it('the user is told once, at notification level, when the wallet reports a claimed payment missing', () => {
    mockPayment.value = coin({ status: 'not-received' })
    mountComponent()
    expect(mockOnNotReceived).toBeDefined()
    mockOnNotReceived!(mockPayment.value!)
    const notice = `A payment a sender claimed (${activeChain.toDisplayAmount(
      2n * ONE,
    )} ${activeChain.unit}) did not arrive.`
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      safeMessage: notice,
    })
  })

  it('a payment this wallet sent claims nothing about the chain and does not ask the wallet', () => {
    mockPayment.value = coin({ status: 'received', spendable: true })
    const wrapper = mountComponent({ outbound: true, memo: 'lunch' })
    expect(mockAskedFor).toEqual([undefined])
    expect(text(wrapper, 'stealth-title')).toBe('Sent Stealth Payment')
    expect(text(wrapper, 'stealth-status-badge')).toBe('Sent')
    expect(wrapper.find('[data-testid="stealth-status-hint"]').exists()).toBe(
      false,
    )
    expect(text(wrapper, 'stealth-memo')).toBe('"lunch"')
  })

  it('links the transfer the item carries by its hash, whether a hash or a signed transaction', async () => {
    const hash = '0x' + '9a'.repeat(32)
    const byHash = mountComponent({ transactions: [hash.slice(2)] })
    expect(byHash.html()).toContain('0x9a9a9a...9a9a9a')

    const raw = await new Wallet('0x' + '0a'.repeat(32)).signTransaction({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      to: '0x' + 'a1'.repeat(20),
      value: 1n,
      gasLimit: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })
    const bySigned = mountComponent({ transactions: [raw.slice(2)] })
    const { Transaction } = await import('ethers')
    const signedHash = Transaction.from(raw).hash!
    expect(bySigned.html()).toContain(
      `${signedHash.slice(0, 8)}...${signedHash.slice(-6)}`,
    )
    // Not a transfer at all: nothing is linked.
    const junk = mountComponent({ transactions: ['zz'] })
    expect(junk.find('[data-testid="stealth-tx-hash"]').exists()).toBe(false)
    expect(junk.find('[data-testid="stealth-explorer-link"]').exists()).toBe(
      false,
    )
  })
})
