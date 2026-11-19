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
  buildOfferIntent: jest.fn(),
  latestOfferExpiry: () =>
    BigInt(Math.floor(Date.now() / 1000)) + 30n * 86400n - 13n * 3600n,
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
test('error survives closing/reopening and a deliberate new offer clears it', async () => {
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
  expect(mockStatus.error).toBe('')
  reopened.unmount()
})
test('expiry preset populates future datetime and successful propose emits close', async () => {
  const { captureNegotiation, buildOfferIntent, sendNegotiation } =
    jest.requireMock('../../swap/negotiation-commands')
  captureNegotiation.mockResolvedValue({ stampValueWei: '0' })
  buildOfferIntent.mockImplementation(
    async (_: unknown, terms: Record<string, bigint>) => ({
      action: 'offer',
      context: { swapId: new Uint8Array(32).fill(1) },
      ...terms,
    }),
  )
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
  // The offer's swap deadlines and swapId come from the writer, from the chosen terms only.
  expect(buildOfferIntent).toHaveBeenCalledTimes(1)
  expect(buildOfferIntent.mock.calls[0][1]).toEqual({
    xecPrincipal: 10000n,
    evmPrincipal: 10n ** 18n,
    expiry: expect.any(BigInt),
  })
  expect(sendNegotiation.mock.calls[0][1]).toMatchObject({ action: 'offer' })
  w.unmount()
})
test('shows the MON (T_B) and XEC (T_A) lock deadlines while drafting and exactly as reviewed', async () => {
  const { captureNegotiation, buildOfferIntent } = jest.requireMock(
    '../../swap/negotiation-commands',
  )
  const local = (s: bigint) =>
    new Date(Number(s) * 1000).toLocaleString(undefined, {
      timeZoneName: 'short',
    })
  captureNegotiation.mockResolvedValue({ stampValueWei: '0' })
  buildOfferIntent.mockImplementation(
    async (_: unknown, terms: Record<string, bigint>) => ({
      action: 'offer',
      context: { swapId: new Uint8Array(32).fill(1) },
      ...terms,
      evmExpiry: terms.expiry + 111n,
      xecRefundTime: terms.expiry + 222n,
    }),
  )
  const w = mountForm()
  expect(w.find('[data-testid="swap-draft-deadlines"]').exists()).toBe(false)
  await w.find('[data-testid="swap-xec-amount"]').setValue('100')
  await w.find('[data-testid="swap-evm-amount"]').setValue('1')
  await w.find('[data-testid="swap-expiry-preset-1h"]').trigger('click')
  const ms = new Date(
    (w.vm as unknown as { expiryInput: string }).expiryInput,
  ).getTime()
  const E = BigInt(Math.floor(ms / 1000))
  // Policy defaults: T_B = E + 12 h, T_A = T_B + 12 h.
  const draft = w.find('[data-testid="swap-draft-deadlines"]').text()
  expect(draft).toContain(local(E + 12n * 3600n))
  expect(draft).toContain(local(E + 24n * 3600n))
  await w.find('[data-testid="swap-review"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="swap-review-evm-expiry"]').text()).toContain(
    local(E + 111n),
  )
  expect(
    w.find('[data-testid="swap-review-xec-refund-time"]').text(),
  ).toContain(local(E + 222n))
  w.unmount()
})
test('caps the expiry so the MON lock fits the 30-day contract maximum', async () => {
  const { captureNegotiation } = jest.requireMock(
    '../../swap/negotiation-commands',
  )
  captureNegotiation.mockClear()
  const w = mountForm()
  const max = w.find('[data-testid="swap-expiry"]').attributes('max')
  expect(max).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  const days = (new Date(max!).getTime() - Date.now()) / 86400000
  expect(days).toBeGreaterThan(29)
  expect(days).toBeLessThan(30)
  await w.find('[data-testid="swap-xec-amount"]').setValue('100')
  await w.find('[data-testid="swap-evm-amount"]').setValue('1')
  const late = new Date(Date.now() + 31 * 86400000)
  const pad = (n: number) => String(n).padStart(2, '0')
  await w
    .find('[data-testid="swap-expiry"]')
    .setValue(
      `${late.getFullYear()}-${pad(late.getMonth() + 1)}-${pad(
        late.getDate(),
      )}T${pad(late.getHours())}:${pad(late.getMinutes())}`,
    )
  await w.find('[data-testid="swap-review"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="swap-review-panel"]').exists()).toBe(false)
  expect(captureNegotiation).not.toHaveBeenCalled()
  w.unmount()
})
