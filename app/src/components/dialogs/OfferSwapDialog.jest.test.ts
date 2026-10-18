/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import OfferSwapDialog from './OfferSwapDialog.vue'
const mockStatus = reactive({ busy: false, error: '', delivery: '' })
let mockUnavailable = ''
jest.mock('../../swap/negotiation-commands', () => ({
  get negotiationCommandStatus() {
    return mockStatus
  },
  negotiationUnavailable: () => mockUnavailable,
  captureNegotiation: jest.fn(),
  sendNegotiation: jest.fn(),
  negotiationErrorCode: () => 'invalidAmount',
}))
jest.mock('../../utils/negotiation-recovery', () => ({
  negotiationRecoveryStatus: { snapshot: { journals: [] } },
}))
jest.mock('../../accounts/session', () => ({
  accountSession: {
    state: {
      status: 'ready',
      account: { receipt: { context: { accountId: 'a' } } },
    },
  },
}))
jest.mock('../../adapters/level-message-store', () => ({
  store: Promise.resolve({ outgoingApplicationMessages: async () => [] }),
}))
jest.mock('../../swap/SignedNegotiationCard.vue', () => ({ template: '<i />' }))
const mountForm = () =>
  mount(OfferSwapDialog, {
    props: {
      address: 'peer',
      conversationId: '11111111-1111-4111-8111-111111111111',
      swapId: new Uint8Array(32).fill(1),
      stampValue: '0',
      contact: { name: 'Bob' },
    },
    global: {
      mocks: { $t: (key: string) => key },
      directives: { 'close-popup': {} },
      stubs: {
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
        QCardActions: { template: '<div><slot /></div>' },
        QInput: {
          props: ['modelValue'],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}</button>',
        },
        QIcon: { template: '<i />' },
      },
    },
  })
beforeEach(() => {
  mockUnavailable = ''
  mockStatus.error = ''
  mockStatus.busy = false
})
test('requires selected expiry and exact positive amounts; never emits legacy unsigned payload', async () => {
  const w = mountForm()
  await w.find('[data-testid="swap-review"]').trigger('click')
  expect(w.find('[role="alert"]').exists()).toBe(true)
  await w.find('[data-testid="swap-xec-amount"]').setValue('1.234')
  await w.find('[data-testid="swap-evm-amount"]').setValue('1')
  await w.find('[data-testid="swap-review"]').trigger('click')
  expect(w.find('[data-testid="swap-review-panel"]').exists()).toBe(false)
  await w.find('[data-testid="swap-xec-amount"]').setValue('1.23')
  await w.find('[data-testid="swap-review"]').trigger('click')
  expect(w.find('[role="alert"]').exists()).toBe(true)
  expect(w.emitted('offer')).toBeUndefined()
  w.unmount()
})
test.each([
  'unsupported',
  'restoring',
  'incomplete',
  'capacity',
  'storage-error',
])('visibly disables review while %s', async state => {
  mockUnavailable = state
  const w = mountForm()
  await flushPromises()
  expect(w.text()).toContain('signedSwap.states.' + state)
  expect(
    w.find('[data-testid="swap-review"]').attributes('disabled'),
  ).toBeDefined()
  w.unmount()
})
test('error survives closing/reopening and a deliberate new offer requests another swap identity', async () => {
  const w = mountForm()
  await w.find('[data-testid="swap-review"]').trigger('click')
  const error = mockStatus.error
  expect(error).not.toBe('')
  w.unmount()
  const reopened = mountForm()
  expect(reopened.text()).toContain(error)
  await reopened
    .findAll('button')
    .find(b => b.text() === 'signedSwap.newOffer')!
    .trigger('click')
  expect(reopened.emitted('newOffer')).toHaveLength(1)
  reopened.unmount()
})
test('expiry preset populates future datetime and successful propose emits close', async () => {
  const { captureNegotiation, sendNegotiation } = jest.requireMock(
    '../../swap/negotiation-commands',
  )
  captureNegotiation.mockResolvedValue({
    context: { swapId: new Uint8Array(32).fill(1) },
    stampValueWei: '0',
  })
  sendNegotiation.mockResolvedValue(undefined)
  const w = mountForm()
  await w.find('[data-testid="swap-xec-amount"]').setValue('100')
  await w.find('[data-testid="swap-evm-amount"]').setValue('1')
  await w.find('[data-testid="swap-expiry-preset-24h"]').trigger('click')
  await w.find('[data-testid="swap-review"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="swap-review-panel"]').exists()).toBe(true)
  await w.find('[data-testid="swap-propose"]').trigger('click')
  await flushPromises()
  expect(w.emitted('close')).toHaveLength(1)
  expect(w.emitted('newOffer')).toHaveLength(1)
  w.unmount()
})
