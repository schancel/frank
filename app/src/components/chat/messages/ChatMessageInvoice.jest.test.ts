/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import {
  INVOICE_PLUGIN_ID,
  InvoiceAttemptStore,
  InvoicePrivateTagStore,
  type InvoiceRequestPayload,
  toInvoiceApplicationItem,
} from '@frank/wallet/message-item-plugins/invoice'
import InvoiceComposeForm from '../InvoiceComposeForm.vue'
import ChatMessageInvoice from './ChatMessageInvoice.vue'

const sampleInvoice: InvoiceRequestPayload = {
  action: 'request',
  schemaVersion: 1,
  invoiceId: 'inv_20261017_abcd1234',
  payeeIdentity: '0x1111111111111111111111111111111111111111',
  chainKey: 'monad',
  networkId: '10143',
  nativeSymbol: 'MON',
  nativeDecimals: 18,
  amountBaseUnits: '2500000000000000000', // 2.5 MON
  receiveAddress: '0x2222222222222222222222222222222222222222',
  description: 'Audit retainer installment',
  expiresAtIso: '2030-06-01T00:00:00.000Z',
}

function makeItem(
  payload: InvoiceRequestPayload = sampleInvoice,
): ApplicationMessageItem {
  return toInvoiceApplicationItem(payload)
}

const quasarStubs = {
  QBadge: {
    template: '<span class="q-badge-stub"><slot /></span>',
  },
  QBtn: {
    props: ['label', 'disable', 'loading'],
    emits: ['click'],
    template:
      '<button type="button" :disabled="disable" @click="!disable && $emit(\'click\', $event)">{{ label }}<slot /></button>',
  },
  QCardSection: {
    template: '<div class="q-card-section-stub"><slot /></div>',
  },
  QInput: {
    props: ['modelValue', 'label', 'placeholder', 'disable'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" :placeholder="placeholder" :disabled="disable" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}

describe('ChatMessageInvoice & InvoiceComposeForm (#679)', () => {
  it('renders invoice request details and open status badge', () => {
    const attemptStore = new InvoiceAttemptStore({ storage: null })
    const privateTagStore = new InvoicePrivateTagStore({ storage: null })

    const wrapper = mount(ChatMessageInvoice, {
      props: {
        item: makeItem(),
        activeChainKey: 'monad',
        activeNetworkId: '10143',
        attemptStore,
        privateTagStore,
      },
      global: { stubs: quasarStubs },
    })

    expect(wrapper.find('[data-testid="invoice-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="invoice-status-badge"]').text()).toBe(
      'open',
    )
    expect(wrapper.find('[data-testid="invoice-amount"]').text()).toBe(
      '2.5 MON',
    )
    expect(wrapper.find('[data-testid="invoice-network"]').text()).toContain(
      'monad (10143)',
    )
    expect(wrapper.find('[data-testid="invoice-description"]').text()).toBe(
      'Audit retainer installment',
    )
    expect(wrapper.find('[data-testid="invoice-pay-btn"]').exists()).toBe(true)
    expect(
      wrapper.find('[data-testid="invoice-confirm-group"]').exists(),
    ).toBe(false)
  })

  it('requires an explicit second confirmation step before signing or broadcasting', async () => {
    const attemptStore = new InvoiceAttemptStore({ storage: null })
    const privateTagStore = new InvoicePrivateTagStore({ storage: null })
    const payHandler = jest.fn(
      async ({ onSigned }: { onSigned: (txHash: string) => void }) => {
        onSigned('0xsigned_tx_hash_123')
        return { txHash: '0xsigned_tx_hash_123' }
      },
    )

    const wrapper = mount(ChatMessageInvoice, {
      props: {
        item: makeItem(),
        activeChainKey: 'monad',
        activeNetworkId: '10143',
        estimatedFeeBaseUnits: '210000000000000', // 0.00021 MON
        attemptStore,
        privateTagStore,
        payHandler,
      },
      global: { stubs: quasarStubs },
    })

    // Step 1: Click Pay -> opens confirmation box without calling payHandler
    await wrapper.find('[data-testid="invoice-pay-btn"]').trigger('click')
    expect(payHandler).not.toHaveBeenCalled()
    expect(attemptStore.get(sampleInvoice.invoiceId)).toBeUndefined()

    const confirmGroup = wrapper.find('[data-testid="invoice-confirm-group"]')
    expect(confirmGroup.exists()).toBe(true)
    expect(
      wrapper.find('[data-testid="invoice-confirm-payee"]').text(),
    ).toContain(sampleInvoice.payeeIdentity)
    expect(
      wrapper.find('[data-testid="invoice-confirm-network"]').text(),
    ).toContain('monad (10143)')
    expect(
      wrapper.find('[data-testid="invoice-confirm-amount"]').text(),
    ).toContain('2.5 MON')
    expect(
      wrapper.find('[data-testid="invoice-confirm-destination"]').text(),
    ).toContain(sampleInvoice.receiveAddress)
    expect(
      wrapper.find('[data-testid="invoice-confirm-fee"]').text(),
    ).toContain('0.00021 MON')

    // Step 2: Click Confirm & Pay -> records durable attempt before broadcast, calls payHandler, emits receipt follow-up
    await wrapper.find('[data-testid="invoice-confirm-pay"]').trigger('click')
    await flushPromises()

    expect(payHandler).toHaveBeenCalledTimes(1)
    const storedAttempt = attemptStore.get(sampleInvoice.invoiceId)
    expect(storedAttempt?.signedTxId).toBe('0xsigned_tx_hash_123')
    expect(storedAttempt?.status).toBe('signing_or_broadcasting')

    const followUps = wrapper.emitted('sendFollowUp')
    expect(followUps).toHaveLength(1)
    expect(followUps?.[0]?.[0]).toEqual({
      items: [
        {
          type: 'application',
          itemType: INVOICE_PLUGIN_ID,
          value: {
            action: 'receipt',
            schemaVersion: 1,
            invoiceId: sampleInvoice.invoiceId,
            txHash: '0xsigned_tx_hash_123',
            chainKey: 'monad',
            networkId: '10143',
            amountBaseUnits: '2500000000000000000',
          },
        },
      ],
    })
  })

  it('blocks payment when active wallet chain/network does not match invoice', async () => {
    const attemptStore = new InvoiceAttemptStore({ storage: null })
    const privateTagStore = new InvoicePrivateTagStore({ storage: null })
    const payHandler = jest.fn()

    const wrapper = mount(ChatMessageInvoice, {
      props: {
        item: makeItem(),
        activeChainKey: 'solana',
        activeNetworkId: 'mainnet-beta',
        attemptStore,
        privateTagStore,
        payHandler,
      },
      global: { stubs: quasarStubs },
    })

    const blockReason = wrapper.find('[data-testid="invoice-block-reason"]')
    expect(blockReason.exists()).toBe(true)
    expect(blockReason.text()).toContain('monad (10143)')

    const payBtn = wrapper.find('[data-testid="invoice-pay-btn"]')
    expect(payBtn.attributes('disabled')).toBeDefined()
    await payBtn.trigger('click')
    expect(
      wrapper.find('[data-testid="invoice-confirm-group"]').exists(),
    ).toBe(false)
    expect(payHandler).not.toHaveBeenCalled()
  })

  it('transitions to outcome_unknown on broadcast failure and blocks duplicate replacement payments', async () => {
    const attemptStore = new InvoiceAttemptStore({ storage: null })
    const privateTagStore = new InvoicePrivateTagStore({ storage: null })
    const failingPayHandler = jest.fn(
      async ({ onSigned }: { onSigned: (txHash: string) => void }) => {
        onSigned('0xambiguous_tx')
        throw new Error('Network disconnected during raw transaction broadcast')
      },
    )

    const wrapper = mount(ChatMessageInvoice, {
      props: {
        item: makeItem(),
        activeChainKey: 'monad',
        activeNetworkId: '10143',
        attemptStore,
        privateTagStore,
        payHandler: failingPayHandler,
      },
      global: { stubs: quasarStubs },
    })

    await wrapper.find('[data-testid="invoice-pay-btn"]').trigger('click')
    await wrapper.find('[data-testid="invoice-confirm-pay"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="invoice-status-badge"]').text()).toBe(
      'outcome_unknown',
    )
    expect(attemptStore.get(sampleInvoice.invoiceId)?.status).toBe(
      'outcome_unknown',
    )
    expect(attemptStore.get(sampleInvoice.invoiceId)?.signedTxId).toBe(
      '0xambiguous_tx',
    )

    const payBtn = wrapper.find('[data-testid="invoice-pay-btn"]')
    expect(payBtn.attributes('disabled')).toBeDefined()
    await payBtn.trigger('click')
    expect(
      wrapper.find('[data-testid="invoice-confirm-group"]').exists(),
    ).toBe(false)
    expect(failingPayHandler).toHaveBeenCalledTimes(1)
  })

  it('edits local private tags on ChatMessageInvoice and InvoiceComposeForm without leaking tags to wire items', async () => {
    const privateTagStore = new InvoicePrivateTagStore({ storage: null })
    const attemptStore = new InvoiceAttemptStore({ storage: null })

    // 1. Compose form stores private tags locally and omits them from emitted payload/item
    const composeWrapper = mount(InvoiceComposeForm, {
      props: {
        payeeIdentity: sampleInvoice.payeeIdentity,
        receiveAddress: sampleInvoice.receiveAddress,
        chainKey: 'monad',
        networkId: '10143',
        nativeSymbol: 'MON',
        nativeDecimals: 18,
        privateTagStore,
      },
      global: { stubs: quasarStubs },
    })

    await composeWrapper
      .find('[data-testid="invoice-compose-amount"]')
      .setValue('1.5')
    await composeWrapper
      .find('[data-testid="invoice-compose-description"]')
      .setValue('Design deliverable')
    await composeWrapper
      .find('[data-testid="invoice-compose-private-tags"]')
      .setValue('q4-budget, tax-deductible')
    await composeWrapper
      .find('[data-testid="invoice-compose-submit"]')
      .trigger('click')

    const submitted = composeWrapper.emitted('submit')?.[0]?.[0] as {
      payload: InvoiceRequestPayload
      item: ApplicationMessageItem
      privateTags: string[]
    }
    expect(submitted).toBeDefined()
    expect(submitted.payload.amountBaseUnits).toBe('1500000000000000000')
    expect(submitted.privateTags).toEqual(['q4-budget', 'tax-deductible'])
    expect('privateTags' in submitted.payload).toBe(false)
    expect('tags' in submitted.payload).toBe(false)
    expect(privateTagStore.getTags(submitted.payload.invoiceId)).toEqual([
      'q4-budget',
      'tax-deductible',
    ])

    // 2. ChatMessageInvoice displays and edits private tags locally
    const cardWrapper = mount(ChatMessageInvoice, {
      props: {
        item: submitted.item,
        attemptStore,
        privateTagStore,
      },
      global: { stubs: quasarStubs },
    })

    expect(
      cardWrapper.findAll('[data-testid="invoice-private-tag-chip"]'),
    ).toHaveLength(2)

    const tagInput = cardWrapper.find(
      '[data-testid="invoice-private-tag-input"]',
    )
    await tagInput.setValue('priority-vendor')
    await cardWrapper
      .find('[data-testid="invoice-private-tag-add"]')
      .trigger('click')

    expect(privateTagStore.getTags(submitted.payload.invoiceId)).toEqual([
      'q4-budget',
      'tax-deductible',
      'priority-vendor',
    ])
    expect(
      cardWrapper.findAll('[data-testid="invoice-private-tag-chip"]'),
    ).toHaveLength(3)
  })
})
