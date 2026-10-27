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

  it('a received coin the wallet holds as too small to move is never said to be spendable', () => {
    // 0.01 received while the payment floor is about 0.0214: the balance breakdown lists it as
    // too small to move, and the card says the same.
    mockPayment.value = coin({
      status: 'received',
      amountWei: ONE / 100n,
      receivedAmountWei: ONE / 100n,
      claimedAmountWei: ONE / 100n,
      spendable: true,
      tooSmall: true,
    })
    const wrapper = mountComponent({ amount: Number(ONE / 100n) })
    expect(text(wrapper, 'stealth-status-badge')).toBe('Received')
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'Too small to move: worth less than ten times the network fee to move it. Not part of your balance.',
    )
    expect(wrapper.text()).not.toMatch(/spendable balance/i)
  })

  it('never shows a green Received without an amount the chain showed arriving', () => {
    // What a forged item used to produce: "received", nothing arrived, the sender's figure.
    mockPayment.value = coin({
      status: 'received',
      amountWei: 0n,
      claimedAmountWei: 1000n * ONE,
      spendable: false,
    })
    const wrapper = mountComponent({ amount: Number(1000n * ONE) })
    expect(text(wrapper, 'stealth-status-badge')).toBe('Pending')
    expect(text(wrapper, 'stealth-status-badge')).not.toBe('Received')
    // The figure is the sender's, and is labelled as such.
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(1000n * ONE),
    )
    expect(text(wrapper, 'stealth-amount-claimed')).toBe('(claimed)')
    expect(wrapper.text()).not.toMatch(/spendable balance|Received,/)
  })

  it('compares exact amounts: a claim a JS number cannot hold raises no false difference', () => {
    const exact = 1234567890123456789n
    mockPayment.value = coin({
      status: 'received',
      amountWei: exact,
      receivedAmountWei: exact,
      claimedAmountWei: exact,
      spendable: true,
    })
    // The item's approximate number differs from the exact figure; the exact one is used.
    expect(BigInt(Number(exact))).not.toBe(exact)
    const wrapper = mountComponent({
      amount: Number(exact),
      amountWei: exact.toString(),
    })
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(exact),
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

  it('shows intended amount, observed settled amount, and pending/partial status when some transactions settle and others are pending (#1249)', () => {
    mockPayment.value = coin({
      status: 'pending',
      partial: true,
      amountWei: ONE,
      receivedAmountWei: ONE,
      claimedAmountWei: 2n * ONE,
      spendable: true,
    })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe('Pending')
    expect(text(wrapper, 'stealth-amount')).toBe(
      activeChain.toDisplayAmount(ONE),
    )
    expect(
      wrapper.find('[data-testid="stealth-amount-claimed"]').exists(),
    ).toBe(false)
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

  it('a payment the node cannot show either way reads "can\'t check now", not "not received"', () => {
    mockPayment.value = coin({ status: 'unverifiable' })
    const wrapper = mountComponent()
    expect(text(wrapper, 'stealth-status-badge')).toBe("Can't check now")
    expect(text(wrapper, 'stealth-status-hint')).toBe(
      'The network node cannot show this payment right now (it may no longer keep those blocks), and nothing shows it failed. Your wallet keeps checking.',
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

  it.each([
    ['prepared', 'Pending'],
    ['delivered', 'Pending'],
    ['paid', 'Paid'],
    ['failed', 'Transfer delivery failed'],
    ['released', 'Cancelled before sending'],
  ])(
    'uses the transfer owner state %s without borrowing the message stamp state',
    (state, label) => {
      const wrapper = mountComponent({ outbound: true, outboundState: state })
      expect(text(wrapper, 'stealth-status-badge')).toBe(label)
    },
  )

  it('an outbound item alone does not claim a payment settled', () => {
    mockPayment.value = coin({ status: 'received', spendable: true })
    const wrapper = mountComponent({ outbound: true, memo: 'lunch' })
    expect(mockAskedFor).toEqual([undefined])
    expect(text(wrapper, 'stealth-title')).toBe('Stealth Payment')
    expect(text(wrapper, 'stealth-status-badge')).toBe('Not checked')
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

  describe('a sent payment, as the paying wallet journal shows it', () => {
    const HASH_A = '0x' + 'a7'.repeat(32)
    const HASH_B = '0x' + 'b8'.repeat(32)
    const sent = (
      outboundState: string,
      members: {
        txHash: string
        recipientAmountAtomic: bigint
        state: 'unsent' | 'pending' | 'landed' | 'failed'
        failure?: 'reverted' | 'replaced'
      }[],
      extra: {
        verifiedReceivedAmountAtomic?: bigint
        nativeFeeAtomic?: bigint
      } = {},
    ) =>
      mountComponent({
        outbound: true,
        amountWei: (2n * ONE).toString(),
        outboundState,
        stampWei: 1000n,
        outboundPayment: {
          intendedAmountAtomic: 2n * ONE,
          members,
          ...extra,
        },
      })
    const states = (wrapper: ReturnType<typeof mountComponent>) =>
      wrapper
        .findAll('[data-testid="stealth-sent-transfer-state"]')
        .map(node => node.text())

    it('not sent yet: says so, with the recipient amount apart from fee and stamp', () => {
      const wrapper = sent('unsent', [
        { txHash: HASH_A, recipientAmountAtomic: ONE, state: 'unsent' },
        { txHash: HASH_B, recipientAmountAtomic: ONE, state: 'unsent' },
      ])
      expect(mockAskedFor).toEqual([undefined])
      expect(text(wrapper, 'stealth-status-badge')).toBe('Not sent yet')
      expect(text(wrapper, 'stealth-status-hint')).toMatch(
        /not been handed to the chain yet/,
      )
      expect(text(wrapper, 'stealth-sent-recipient')).toBe(
        `Recipient gets: ${activeChain.toDisplayAmount(2n * ONE)} MONT`,
      )
      expect(text(wrapper, 'stealth-sent-fee')).toBe(
        'Network fee: not known yet',
      )
      expect(text(wrapper, 'stealth-sent-stamp')).toBe(
        `Message stamp: ${activeChain.toDisplayAmount(1000n)} ${
          activeChain.unit
        }`,
      )
      expect(states(wrapper)).toEqual(['not sent yet', 'not sent yet'])
      expect(wrapper.html()).toContain(
        `${HASH_A.slice(0, 8)}...${HASH_A.slice(-6)}`,
      )
      expect(wrapper.html()).toContain(
        `${HASH_B.slice(0, 8)}...${HASH_B.slice(-6)}`,
      )
    })

    it('pending until the chain includes it', () => {
      const wrapper = sent('pending', [
        { txHash: HASH_A, recipientAmountAtomic: 2n * ONE, state: 'pending' },
      ])
      expect(text(wrapper, 'stealth-status-badge')).toBe('Pending')
      expect(text(wrapper, 'stealth-status-hint')).toBe(
        'Waiting for the chain to include the payment.',
      )
      expect(states(wrapper)).toEqual(['pending'])
      expect(wrapper.find('[data-testid="stealth-sent-landed"]').exists()).toBe(
        false,
      )
    })

    it('partly landed: exactly what landed, and each transfer as the chain showed it', () => {
      const wrapper = sent(
        'partial',
        [
          { txHash: HASH_A, recipientAmountAtomic: ONE, state: 'landed' },
          { txHash: HASH_B, recipientAmountAtomic: ONE, state: 'pending' },
        ],
        { verifiedReceivedAmountAtomic: ONE, nativeFeeAtomic: 21000n },
      )
      expect(text(wrapper, 'stealth-status-badge')).toBe('Partly landed')
      expect(text(wrapper, 'stealth-sent-landed')).toBe(
        `Landed on chain: ${activeChain.toDisplayAmount(ONE)} MONT`,
      )
      expect(text(wrapper, 'stealth-sent-fee')).toBe(
        `Network fee: ${activeChain.toDisplayAmount(21000n)} ${
          activeChain.unit
        }`,
      )
      expect(states(wrapper)).toEqual(['landed', 'pending'])
    })

    it('a fee known only in part is shown as History shows it, and says it is partial', () => {
      const wrapper = sent(
        'paid',
        [{ txHash: HASH_A, recipientAmountAtomic: 2n * ONE, state: 'landed' }],
        {
          verifiedReceivedAmountAtomic: 2n * ONE,
          nativeFeeAtomic: 21000n,
          nativeFeePartial: true,
        },
      )
      expect(text(wrapper, 'stealth-sent-fee')).toBe(
        `Network fee: ${activeChain.toDisplayAmount(21000n)} ${
          activeChain.unit
        } so far (partial)`,
      )
    })

    it('paid once every transfer landed', () => {
      const wrapper = sent(
        'paid',
        [{ txHash: HASH_A, recipientAmountAtomic: 2n * ONE, state: 'landed' }],
        { verifiedReceivedAmountAtomic: 2n * ONE, nativeFeeAtomic: 21000n },
      )
      expect(text(wrapper, 'stealth-status-badge')).toBe('Paid')
      expect(text(wrapper, 'stealth-status-hint')).toBe(
        'The chain shows the whole payment landed.',
      )
      expect(states(wrapper)).toEqual(['landed'])
    })

    it('failed, with the reason, when a transfer reverted or was replaced', () => {
      const reverted = sent('chainFailed', [
        {
          txHash: HASH_A,
          recipientAmountAtomic: 2n * ONE,
          state: 'failed',
          failure: 'reverted',
        },
      ])
      expect(text(reverted, 'stealth-status-badge')).toBe('Payment failed')
      expect(text(reverted, 'stealth-status-hint')).toMatch(/reverted on chain/)
      expect(states(reverted)).toEqual(['reverted'])
      const replaced = sent(
        'partial',
        [
          { txHash: HASH_A, recipientAmountAtomic: ONE, state: 'landed' },
          {
            txHash: HASH_B,
            recipientAmountAtomic: ONE,
            state: 'failed',
            failure: 'replaced',
          },
        ],
        { verifiedReceivedAmountAtomic: ONE },
      )
      expect(text(replaced, 'stealth-status-badge')).toBe('Partly landed')
      expect(text(replaced, 'stealth-status-hint')).toMatch(
        /took a transfer’s place/,
      )
      expect(states(replaced)).toEqual(['landed', 'replaced'])
    })
  })
})
