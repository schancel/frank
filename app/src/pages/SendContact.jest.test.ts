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
import { navigateBack } from 'src/utils/navigate-back'
import enUS from '../i18n/en-us'

// The stamp chosen for the conversation with the contact; free unless a test says otherwise.
let mockStampWei = 0n
const mockPrepare = jest.fn()
const mockSendMessage = jest.fn()
const PREPARED = {
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
    // The stamp chosen for the conversation with the contact: here, free messages.
    getStampWei: () => mockStampWei,
  }),
}))

jest.mock('@frank/wallet/chain', () => ({
  MAX_STEALTH_ITEM_AMOUNT: 2n ** 64n - 1n,
  activeChain: {
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
    formattedSpendable: { value: '10.5 MON' },
    exactSpendable: { value: '10.5 MON' },
    loaded: { value: true },
  }),
}))

jest.mock('src/utils/notifications', () => ({
  sentTransactionNotify: jest.fn(),
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))

jest.mock('src/utils/navigate-back', () => ({
  navigateBack: jest.fn(),
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
      '0xabc123',
      'Payment sent',
    )
    expect(navigateBack).toHaveBeenCalled()
  })

  it('with a stamp chosen for the chat, the payment and its stamp are two separate amounts', async () => {
    mockStampWei = 20_000_000_000_000_000n // 0.02
    try {
      mockPrepare.mockResolvedValueOnce(PREPARED)
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
    expect(navigateBack).toHaveBeenCalled()
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
    expect(navigateBack).toHaveBeenCalled()
  })

  it('a refusal before anything is signed sends no message and says nothing was sent', async () => {
    mockPrepare.mockRejectedValueOnce(new Error('Insufficient funds'))
    await confirm()

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(errorNotify).toHaveBeenCalledWith(expect.any(Error), {
      fallbackKey: 'sendContactDialog.notSent',
    })
    expect(navigateBack).not.toHaveBeenCalled()
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
})
