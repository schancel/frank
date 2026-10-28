/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SendContact from './SendContact.vue'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useContactStore } from 'src/stores/contacts'
import {
  sentTransactionNotify,
  errorNotify,
  infoNotify,
} from 'src/utils/notifications'
import { leaveForm } from 'src/utils/navigation'
import enUS from '../i18n/en-us'

// The stamp chosen for the conversation with the contact; free unless a test says otherwise.
let mockStampWei: bigint | undefined = 0n
// The wallet's payment floor (`directMessages.minimumStamp`); not known unless a test sets it.
let mockFloorWei = 0n
let mockCapacity = {
  loaded: true,
  error: false,
  supported: true,
  formatted: '10.5 MON',
}
const mockPrepare = jest.fn()
const mockSendMessage = jest.fn()
const mockRecoveryReview = jest.fn()
const mockApproveRecovery = jest.fn()
const mockReconcileAttempts = jest.fn()
const mockReconcileOutgoing = jest.fn()
const PREPARED = {
  stampValue: 0n,
  item: { type: 'stealth', amount: 1.5e18, ephemeralPubKey: '02ab' },
  txHash: '0xabc123',
  stealthAddress: '0x9999999999999999999999999999999999999999',
  value: 1500000000000000000n,
}
const mockMessagingWallet = { identity: { displayAddress: '0xmessaging' } }
jest.mock('src/utils/clients', () => ({
  useMonadWallet: () => mockMessagingWallet,
}))
jest.mock('src/stores/chats', () => ({
  useChatStore: () => ({
    sendMessage: mockSendMessage,
    reconcileOutgoing: mockReconcileOutgoing,
    // The stamp chosen for the conversation with the contact: here, free messages.
    getStampWei: () => mockStampWei,
  }),
}))

jest.mock('@frank/wallet/chain', () => ({
  MAX_STEALTH_ITEM_AMOUNT: 2n ** 64n - 1n,
  NativeFeeExceededError: class NativeFeeExceededError extends Error {
    constructor(readonly fee: bigint) {
      super(
        'The network fee rose above the reviewed fee; review the transfer again',
      )
      this.name = 'NativeFeeExceededError'
    }
  },
  ContactPaymentPendingError: class ContactPaymentPendingError extends Error {},
  activeChain: {
    chainIdentifier: 'monad-testnet',
    name: 'monad',
    unit: 'MON',
    toDisplayAmount: (raw: bigint) => {
      const s = raw.toString().padStart(19, '0')
      return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '')
    },
    fromDisplayAmount: (display: string) => {
      const [whole, frac = ''] = display.split('.')
      if (frac.length > 18) throw new Error('too many decimals')
      return BigInt((whole || '0') + frac.padEnd(18, '0'))
    },
    directMessages: {
      recoveryFeeReview: (...args: unknown[]) => mockRecoveryReview(...args),
      approveRecoveryFee: (...args: unknown[]) => mockApproveRecovery(...args),
      reconcileAttempts: (...args: unknown[]) => mockReconcileAttempts(...args),
      minimumStamp: async () => mockFloorWei,
    },
    formatAddress: (addr: { raw: string }) => addr.raw,
    parseAddress: (input: string) => {
      if (input && input.startsWith('0x')) {
        return { raw: input.toLowerCase() }
      }
      return undefined
    },
  },
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    // The shown balance (with the profile address) and what a contact payment can draw on.
    formattedBalance: { value: '10.6 MON' },
    formattedSpendable: { value: mockCapacity.formatted },
    exactSpendable: { value: mockCapacity.formatted },
    availableLoaded: { value: mockCapacity.loaded },
    availableError: { value: mockCapacity.error },
    availableSupported: { value: mockCapacity.supported },
    loaded: { value: true },
  }),
}))

jest.mock('src/utils/notifications', () => ({
  sentTransactionNotify: jest.fn(),
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))

jest.mock('src/utils/navigation', () => ({
  ...jest.requireActual('src/utils/navigation'),
  goBack: jest.fn(),
  leaveForm: jest.fn(),
}))

const mockRoute = { query: {} }
jest.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

function t(
  messages: unknown,
  key: string,
  params: Record<string, unknown> = {},
): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  if (typeof value === 'string') {
    let res = value
    for (const [k, v] of Object.entries(params)) {
      res = res.replaceAll(`{${k}}`, String(v))
    }
    return res
  }
  return key
}

const mockWallet = {
  chainIdentifier: 'monad-testnet',
  prepareContactPayment: (params: unknown) => mockPrepare(params),
  identity: {
    address: { raw: '0x1111111111111111111111111111111111111111' },
    displayAddress: '0x1111111111111111111111111111111111111111',
  },
}

function mountSendContact() {
  return mount(SendContact, {
    global: {
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          t(enUS, key, params ?? {}),
      },
      stubs: {
        QPageContainer: { template: '<div><slot /></div>' },
        QPage: { template: '<div><slot /></div>' },
        QCard: { template: '<div class="q-card"><slot /></div>' },
        QCardSection: {
          template: '<div class="q-card-section"><slot /></div>',
        },
        QCardActions: {
          template: '<div class="q-card-actions"><slot /></div>',
        },
        QList: { template: '<div class="q-list"><slot /></div>' },
        QItem: {
          template:
            '<div class="q-item" @click="$emit(\'click\')"><slot /></div>',
        },
        QItemSection: {
          template: '<div class="q-item-section"><slot /></div>',
        },
        QItemLabel: {
          template: '<div class="q-item-label"><slot /></div>',
        },
        QAvatar: { template: '<div class="q-avatar"><slot /></div>' },
        QInput: {
          props: ['modelValue', 'placeholder', 'disable'],
          emits: ['update:modelValue'],
          template:
            '<input :value="modelValue" :placeholder="placeholder" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QBtn: {
          props: ['label', 'disable', 'loading'],
          template:
            '<button :disabled="disable || loading" @click="$emit(\'click\')">{{ label }}<slot /></button>',
        },
        QBanner: {
          template:
            '<div class="q-banner" role="alert"><slot name="avatar" /><slot /></div>',
        },
        QIcon: {
          props: ['name'],
          template: '<i :data-icon="name">{{ name }}</i>',
        },
      },
    },
  })
}

describe('SendContact.vue (dual-send model)', () => {
  const aliceAddress = '0x2222222222222222222222222222222222222222'

  beforeEach(() => {
    setActivePinia(createPinia())
    jest.clearAllMocks()
    ;(useActiveWallet as jest.Mock).mockResolvedValue(mockWallet)
    mockRoute.query = {}
    mockCapacity = {
      loaded: true,
      error: false,
      supported: true,
      formatted: '10.5 MON',
    }

    const contactStore = useContactStore()
    contactStore.contacts = {
      [aliceAddress]: {
        lastUpdateTime: Date.now(),
        notify: true,
        relayURL: null,
        profile: {
          name: 'Alice',
          signedName: 'Alice',
          bio: '',
          avatar: '',
          pubKey: { toBuffer: () => new Uint8Array(33) } as any,
        },
        inbox: {},
      },
    }
  })

  const recoveryDigest = 'a'.repeat(64)
  const recoveryReview = {
    chainIdentifier: 'monad-testnet',
    payloadDigest: recoveryDigest,
    messageId: '00000000-0000-4000-8000-000000000001',
    recoveryOperationId: 'stamp-original',
    recipientAddress: aliceAddress,
    paidContactAtomic: 1500000000000000000n,
    stampAtomic: 1000000000000000n,
    priorNetworkFeeAtomic: 30000000000000n,
    reservedNetworkFeeAtomic: 0n,
    additionalNetworkFeeAtomic: 50000000000000n,
    maximumTotalNetworkFeeAtomic: 40000000000000n,
    requiredTotalNetworkFeeAtomic: 80000000000000n,
  }
  const mountRecovery = async () => {
    mockRoute.query = { recovery: recoveryDigest, chain: 'monad-testnet' }
    mockRecoveryReview.mockResolvedValue(recoveryReview)
    mockApproveRecovery.mockResolvedValue(undefined)
    mockReconcileAttempts.mockResolvedValue({ [recoveryDigest]: 'delivered' })
    mockReconcileOutgoing.mockResolvedValue({ pending: 0 })
    const wrapper = mountSendContact()
    await flushPromises()
    return wrapper
  }

  it('reviews already paid contact separately and approves/resumes only its original operation', async () => {
    const wrapper = await mountRecovery()
    expect(wrapper.find('[data-test="send-contact-title"]').text()).toBe(
      'Finish delivering payment',
    )
    expect(wrapper.find('[data-test="review-amount"]').text()).toBe('1.5 MON')
    expect(wrapper.find('[data-test="review-total"]').text()).toBe(
      '0.00105 MON',
    )
    expect(
      wrapper.find('[data-test="recovery-maximum-network-fees"]').text(),
    ).toBe('0.00008 MON')
    expect(
      wrapper.find('[data-test="recovery-fee-explanation"]').text(),
    ).toContain('already on chain')
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockApproveRecovery).toHaveBeenCalledWith({
      wallet: mockWallet,
      payloadDigest: recoveryDigest,
      recoveryOperationId: 'stamp-original',
      maximumTotalNetworkFeeAtomic: 80000000000000n,
    })
    expect(mockReconcileAttempts).toHaveBeenCalledWith({
      wallet: mockWallet,
      payloadDigests: [recoveryDigest],
      maxPutAttempts: 2,
    })
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(leaveForm).toHaveBeenCalled()
  })

  it('cancelling fee review leaves the original payment alone', async () => {
    const wrapper = await mountRecovery()
    await wrapper.find('[data-test="review-cancel-button"]').trigger('click')
    expect(mockApproveRecovery).not.toHaveBeenCalled()
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(leaveForm).toHaveBeenCalled()
  })

  it('a changed fee is reviewed again without preparing or sending a contact payment', async () => {
    const wrapper = await mountRecovery()
    const { NativeFeeExceededError } = await import('@frank/wallet/chain')
    mockApproveRecovery.mockRejectedValueOnce(
      new NativeFeeExceededError(90000000000000n),
    )
    mockRecoveryReview.mockResolvedValueOnce({
      ...recoveryReview,
      requiredTotalNetworkFeeAtomic: 90000000000000n,
    })
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="review-fee-changed"]').exists()).toBe(true)
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockReconcileAttempts).not.toHaveBeenCalled()
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(
      mockApproveRecovery.mock.calls[1][0].maximumTotalNetworkFeeAtomic,
    ).toBe(90000000000000n)
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('a wallet switch during fee review cannot authorize either a replacement or a new payment', async () => {
    const wrapper = await mountRecovery()
    ;(useActiveWallet as jest.Mock).mockResolvedValue({ ...mockWallet })
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockApproveRecovery).not.toHaveBeenCalled()
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalled()
  })

  it('renders contact selection list and allows selecting a contact', async () => {
    const wrapper = mountSendContact()
    await flushPromises()

    expect(wrapper.find('[data-test="send-contact-title"]').text()).toBe(
      'Send to Contact',
    )
    expect(wrapper.find('[data-test="contact-item"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="contact-name"]').text()).toBe('Alice')

    // Click contact to select
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await flushPromises()

    // Selected contact card is now shown
    expect(wrapper.find('[data-test="selected-contact-card"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-test="selected-contact-name"]').text()).toBe(
      'Alice',
    )

    // Change button clears contact
    await wrapper.find('[data-test="change-contact-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="selected-contact-card"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-test="contact-item"]').exists()).toBe(true)
  })

  it('validates amount input and opens review state', async () => {
    const wrapper = mountSendContact()
    await flushPromises()

    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await flushPromises()

    const reviewBtn = wrapper.find('[data-test="send-contact-review-button"]')
    expect(reviewBtn.attributes('disabled')).toBeDefined()

    // Enter valid amount
    const amountInput = wrapper.find('[data-test="send-contact-amount-input"]')
    await amountInput.setValue('1.5')
    await flushPromises()

    expect(reviewBtn.attributes('disabled')).toBeUndefined()

    // Enter memo
    const memoInput = wrapper.find('[data-test="send-contact-memo-input"]')
    await memoInput.setValue('Dinner reimbursement')
    await flushPromises()

    // Click review
    await reviewBtn.trigger('click')
    await flushPromises()

    // Review card is displayed
    expect(
      wrapper.find('[data-test="send-contact-review-card"]').exists(),
    ).toBe(true)
    expect(wrapper.find('[data-test="review-recipient"]').text()).toContain(
      'Alice',
    )
    expect(wrapper.find('[data-test="review-amount"]').text()).toBe('1.5 MON')
    expect(wrapper.find('[data-test="review-memo"]').text()).toBe(
      'Dinner reimbursement',
    )
    expect(wrapper.find('[data-test="review-stealth-notice"]').exists()).toBe(
      true,
    )
  })

  const confirm = async () => {
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper
      .find('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
  }

  it('has the wallet prepare the payment, then sends its item as an ordinary message to the contact', async () => {
    mockPrepare.mockResolvedValueOnce(PREPARED)
    mockSendMessage.mockResolvedValueOnce({
      state: 'sent',
      payloadDigest: 'dd',
    })
    await confirm()

    // The wallet is given the contact's address and the amount, nothing else: it finds the
    // contact's key itself and signs from its own funds, without broadcasting.
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    expect(mockPrepare.mock.calls[0][0]).toEqual({
      recipient: { raw: aliceAddress },
      value: 1500000000000000000n,
      memo: undefined,
      // The message carries the stamp chosen for the conversation, not a default of its own.
      stampValue: 0n,
    })
    // The item goes through the conversation's own send (bubble, pending state, Retry).
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith({
      wallet: mockMessagingWallet,
      address: aliceAddress,
      items: [PREPARED.item],
      stampValue: 0n,
    })
    expect(sentTransactionNotify).toHaveBeenCalledWith(
      'monad-testnet',
      '0xabc123',
      'Payment sent',
    )
    expect(leaveForm).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/wallet',
    )
  })

  it('with a stamp chosen for the chat, the payment and its stamp are two separate amounts', async () => {
    mockStampWei = 20_000_000_000_000_000n // 0.02
    try {
      mockPrepare.mockResolvedValueOnce({
        ...PREPARED,
        stampValue: mockStampWei,
      })
      mockSendMessage.mockResolvedValueOnce({
        state: 'sent',
        payloadDigest: 'dd',
      })
      await confirm()
      // The amount typed is the payment; the stamp is the message's price, beside it.
      expect(mockPrepare.mock.calls[0][0]).toEqual({
        recipient: { raw: aliceAddress },
        value: 1500000000000000000n,
        memo: undefined,
        stampValue: 20_000_000_000_000_000n,
      })
      const sent = mockSendMessage.mock.calls[0][0]
      expect(sent.stampValue).toBe(20_000_000_000_000_000n)
      expect(sent.items).toEqual([PREPARED.item])
    } finally {
      mockStampWei = 0n
    }
  })

  it('shows what this payment can draw on, labelled, not the wallet’s shown total', async () => {
    const wrapper = mountSendContact()
    await flushPromises()
    const available = wrapper.get('[data-test="send-contact-available"]').text()
    expect(available).toBe('Available for this payment: 10.5 MON')
    expect(wrapper.text()).not.toContain('10.6 MON')
  })

  it.each(['loading', 'error', 'unsupported'] as const)(
    'hides unavailable capacity (%s) while a supported action quote still permits the send',
    async state => {
      mockCapacity.loaded = state !== 'loading'
      mockCapacity.error = state === 'error'
      mockCapacity.supported = state !== 'unsupported'
      const quoteContactPayment = jest.fn().mockResolvedValue({
        valueWei: PREPARED.value,
        stampWei: 0n,
        networkFeeWei: 100_000_000_000_000n,
        totalWei: PREPARED.value + 100_000_000_000_000n,
        floorWei: 1n,
      })
      ;(useActiveWallet as jest.Mock).mockResolvedValue({
        ...mockWallet,
        quoteContactPayment,
      })
      mockPrepare.mockResolvedValueOnce(PREPARED)
      mockSendMessage.mockResolvedValueOnce({
        state: 'sent',
        payloadDigest: 'dd',
      })
      const wrapper = mountSendContact()
      await flushPromises()
      const capacity = wrapper.get('[data-test="send-contact-available"]')
      expect(capacity.text()).toBe('')
      expect(capacity.attributes('title')).toBeUndefined()
      await wrapper.find('[data-test="contact-item"]').trigger('click')
      await wrapper
        .find('[data-test="send-contact-amount-input"]')
        .setValue('1.5')
      await wrapper
        .find('[data-test="send-contact-review-button"]')
        .trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="review-fee"]').text()).toContain('MON')
      await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
      await flushPromises()
      expect(mockPrepare).toHaveBeenCalledTimes(1)
      expect(mockPrepare.mock.calls[0][0].maxFeeWei).toBe(100_000_000_000_000n)
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
    },
  )

  it('shows a successfully observed zero capacity without blocking the original operation quote', async () => {
    mockCapacity.formatted = '0 MON'
    const wrapper = mountSendContact()
    await flushPromises()
    expect(wrapper.get('[data-test="send-contact-available"]').text()).toBe(
      'Available for this payment: 0 MON',
    )
    wrapper.unmount()
    const recovery = await mountRecovery()
    await recovery.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockApproveRecovery).toHaveBeenCalledTimes(1)
    expect(mockReconcileAttempts).toHaveBeenCalledTimes(1)
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('Confirm never does nothing: details that are no longer a payment are said, and the form returns', async () => {
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper
      .find('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    // The amount is gone while the review is on screen.
    ;(wrapper.vm as unknown as { amount: string }).amount = ''
    await flushPromises()
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendContactDialog.invalidAmount',
    })
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="send-contact-edit-card"]').exists()).toBe(
      true,
    )
  })

  it('a payment whose message is still being delivered is shown as saved, not as a failure', async () => {
    mockPrepare.mockResolvedValueOnce(PREPARED)
    mockSendMessage.mockResolvedValueOnce({ state: 'payment-pending' })
    await confirm()

    expect(infoNotify).toHaveBeenCalledWith(
      'Payment saved. Its message is still being delivered; it is paid when the message arrives. Do not send it again.',
    )
    expect(errorNotify).not.toHaveBeenCalled()
    expect(sentTransactionNotify).not.toHaveBeenCalled()
    // The form is left, so the same payment cannot be confirmed a second time.
    expect(leaveForm).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/wallet',
    )
  })

  it('a message that failed stays in the chat for a retry: the user is told where, and the form is left', async () => {
    mockPrepare.mockResolvedValueOnce(PREPARED)
    mockSendMessage.mockResolvedValueOnce({
      state: 'failed',
      reason: 'rejected',
    })
    await confirm()

    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendContactDialog.messageEnded',
    })
    expect(sentTransactionNotify).not.toHaveBeenCalled()
    expect(leaveForm).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/wallet',
    )
  })

  it('a refusal before anything is signed sends no message and says nothing was sent', async () => {
    mockPrepare.mockRejectedValueOnce(new Error('Insufficient funds'))
    await confirm()

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendContactDialog.notSent',
    })
    expect(leaveForm).not.toHaveBeenCalled()
  })

  it('an amount larger than one contact payment can carry is refused before review, in plain words', async () => {
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper.find('[data-test="send-contact-amount-input"]').setValue('19')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()

    // Said under the amount, and the review cannot be opened.
    expect(wrapper.find('[data-test="send-contact-too-large"]').text()).toBe(
      'This payment is larger than a single contact payment can carry (about 18.4 MON); send it in parts.',
    )
    expect(wrapper.find('[data-test="review-confirm-button"]').exists()).toBe(
      false,
    )
    expect(mockPrepare).not.toHaveBeenCalled()
  })

  it('shows the wallet quote: the payment, the message stamp, the network fee and their total', async () => {
    mockStampWei = 50_000_000_000_000_000n // 0.05
    const quoteContactPayment = jest.fn().mockResolvedValue({
      valueWei: 1_500_000_000_000_000_000n,
      stampWei: 50_000_000_000_000_000n,
      networkFeeWei: 4_242_000_000_000_000n,
      totalWei: 1_554_242_000_000_000_000n,
      floorWei: 21_420_000_000_000_000n,
    })
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      ...mockWallet,
      quoteContactPayment,
    })
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper
      .find('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    // The wallet is asked about this payment with the stamp its message will carry.
    expect(quoteContactPayment).toHaveBeenCalledWith({
      recipient: { raw: aliceAddress },
      value: 1_500_000_000_000_000_000n,
      stampValue: 50_000_000_000_000_000n,
    })
    expect(wrapper.get('[data-test="review-amount"]').text()).toBe('1.5 MON')
    expect(wrapper.get('[data-test="review-stamp"]').text()).toBe('0.05 MON')
    expect(wrapper.get('[data-test="review-fee"]').text()).toBe('0.004242 MON')
    // Everything the wallet takes: the payment, the stamp and the fee.
    expect(wrapper.get('[data-test="review-total"]').text()).toBe(
      '1.554242 MON',
    )
    expect(wrapper.text()).toContain('Total (payment, stamp and network fee)')
    expect(mockPrepare).not.toHaveBeenCalled()
    mockStampWei = 0n
  })

  it('Confirm bounds the payment and its stamp by the network fee the review showed', async () => {
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      ...mockWallet,
      quoteContactPayment: jest.fn().mockResolvedValue({
        valueWei: 1_500_000_000_000_000_000n,
        stampWei: 0n,
        networkFeeWei: 12_852_000_000_000_000n,
        totalWei: 1_512_852_000_000_000_000n,
        floorWei: 1n,
      }),
    })
    mockPrepare.mockResolvedValueOnce(PREPARED)
    mockSendMessage.mockResolvedValueOnce({
      state: 'sent',
      payloadDigest: 'dd',
    })
    await confirm()
    expect(mockPrepare.mock.calls[0][0].maxFeeWei).toBe(12_852_000_000_000_000n)
  })

  it('a fee that rose above the reviewed one is said, and the review shows the new fee and total to confirm again', async () => {
    const { NativeFeeExceededError } = jest.requireMock('@frank/wallet/chain')
    const quotes = [
      {
        valueWei: 1_500_000_000_000_000_000n,
        stampWei: 0n,
        networkFeeWei: 12_852_000_000_000_000n,
        totalWei: 1_512_852_000_000_000_000n,
        floorWei: 1n,
      },
      {
        valueWei: 1_500_000_000_000_000_000n,
        stampWei: 0n,
        networkFeeWei: 23_562_000_000_000_000n,
        totalWei: 1_523_562_000_000_000_000n,
        floorWei: 1n,
      },
    ]
    // The fee the network asks now: the first quote's, until the fee rises.
    let current = quotes[0]
    const quoteContactPayment = jest.fn(async () => current)
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      ...mockWallet,
      quoteContactPayment,
    })
    mockPrepare.mockImplementationOnce(async () => {
      current = quotes[1]
      throw new NativeFeeExceededError(23_562_000_000_000_000n)
    })
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper
      .find('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    // Not the generic "could not be made": the fee went up, nothing was sent, and the review
    // shows the new fee and total.
    expect(errorNotify).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test="review-fee-changed"]').text()).toBe(
      enUS.sendAddressDialog.feeChanged,
    )
    expect(wrapper.get('[data-test="review-fee"]').text()).toBe('0.023562 MON')
    expect(wrapper.get('[data-test="review-total"]').text()).toBe(
      '1.523562 MON',
    )
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(leaveForm).not.toHaveBeenCalled()

    // Confirming again is bounded by the new fee.
    mockPrepare.mockResolvedValueOnce(PREPARED)
    mockSendMessage.mockResolvedValueOnce({
      state: 'sent',
      payloadDigest: 'dd',
    })
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()
    expect(mockPrepare.mock.calls[1][0].maxFeeWei).toBe(23_562_000_000_000_000n)
    expect(wrapper.find('[data-test="review-fee-changed"]').exists()).toBe(
      false,
    )
  })

  it('Confirm sends the stamp the review showed', async () => {
    // No stamp chosen for the chat: the wallet's quote names its default, and that is sent.
    mockStampWei = undefined
    try {
      ;(useActiveWallet as jest.Mock).mockResolvedValue({
        ...mockWallet,
        quoteContactPayment: jest.fn().mockResolvedValue({
          valueWei: 1_500_000_000_000_000_000n,
          stampWei: 70_000_000_000_000_000n,
          networkFeeWei: 1n,
          totalWei: 1_570_000_000_000_000_001n,
          floorWei: 1n,
        }),
      })
      mockPrepare.mockResolvedValueOnce({
        ...PREPARED,
        stampValue: 70_000_000_000_000_000n,
      })
      mockSendMessage.mockResolvedValueOnce({
        state: 'sent',
        payloadDigest: 'dd',
      })
      await confirm()
      expect(mockPrepare.mock.calls[0][0].stampValue).toBe(
        70_000_000_000_000_000n,
      )
    } finally {
      mockStampWei = 0n
    }
  })

  it('names the smallest payment, and refuses one below it before review', async () => {
    mockFloorWei = 21_420_000_000_000_000n // 0.02142
    try {
      const wrapper = mountSendContact()
      await flushPromises()
      await wrapper.find('[data-test="contact-item"]').trigger('click')
      await wrapper
        .find('[data-test="send-contact-amount-input"]')
        .setValue('0.05')
      await flushPromises()
      expect(wrapper.get('[data-test="send-contact-minimum"]').text()).toBe(
        'The smallest payment is 0.02142 MON: ten times the network fee to move it, so your contact can always spend it.',
      )

      await wrapper
        .find('[data-test="send-contact-amount-input"]')
        .setValue('0.01')
      await flushPromises()
      expect(wrapper.get('[data-test="send-contact-below-floor"]').text()).toBe(
        'That is below the smallest payment of 0.02142 MON. Your contact could not move it for less than a tenth of its value: pay at least 0.02142 MON.',
      )
      const review = wrapper.get('[data-test="send-contact-review-button"]')
      expect(review.attributes('disabled')).toBeDefined()
      await review.trigger('click')
      await flushPromises()
      expect(
        wrapper.find('[data-test="send-contact-review-card"]').exists(),
      ).toBe(false)
      expect(mockPrepare).not.toHaveBeenCalled()
    } finally {
      mockFloorWei = 0n
    }
  })

  it('says when the fee cannot be estimated, with the reason', async () => {
    const wrapper = mountSendContact()
    await flushPromises()
    await wrapper.find('[data-test="contact-item"]').trigger('click')
    await wrapper
      .find('[data-test="send-contact-amount-input"]')
      .setValue('1.5')
    await wrapper
      .find('[data-test="send-contact-review-button"]')
      .trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="review-fee"]').text()).toContain(
      'Cannot be estimated: This wallet gives no fee quote.',
    )
  })
})
