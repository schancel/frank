/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import SendContact from './SendContact.vue'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useContactStore } from 'src/stores/contacts'
import { sentTransactionNotify, errorNotify } from 'src/utils/notifications'
import { navigateBack } from 'src/utils/navigate-back'
import enUS from '../i18n/en-us'

const mockSendToContact = jest.fn()

jest.mock('@frank/wallet/chain', () => ({
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
    nativeTransfers: {
      sendToContact: (args: unknown) => mockSendToContact(args),
    },
  },
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    formattedBalance: { value: '10.5 MON' },
    loaded: { value: true },
  }),
}))

jest.mock('src/utils/notifications', () => ({
  sentTransactionNotify: jest.fn(),
  errorNotify: jest.fn(),
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

  it('executes sendToContact upon confirmation and notifies success', async () => {
    mockSendToContact.mockResolvedValueOnce({
      txHash: '0xabc123',
      stealthAddress: '0x9999999999999999999999999999999999999999',
      value: 1500000000000000000n,
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

    // Confirm send
    await wrapper.find('[data-test="review-confirm-button"]').trigger('click')
    await flushPromises()

    expect(mockSendToContact).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({
          address: { raw: aliceAddress },
        }),
        value: 1500000000000000000n,
      }),
    )
    expect(sentTransactionNotify).toHaveBeenCalledWith('0xabc123')
    expect(navigateBack).toHaveBeenCalled()
  })

  it('handles sendToContact errors cleanly', async () => {
    mockSendToContact.mockRejectedValueOnce(new Error('Network RPC timeout'))

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

    expect(errorNotify).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        fallbackKey: 'sendAddressDialog.definitelyNotBroadcast',
      }),
    )
  })
})
