/** @jest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import enUS from 'src/i18n/en-us'

const mockReconcile = jest.fn()
jest.mock('src/accounts/wallet-reconcile', () => ({
  reconcileAccountWallet: (...args: unknown[]) => mockReconcile(...args),
}))

import WalletReconcileCard from './WalletReconcileCard.vue'

type Messages = Record<string, unknown>
const t = (key: string, values: Record<string, string> = {}): string => {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], enUS)
  if (typeof value !== 'string') return key
  return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
}

const mountCard = () =>
  mount(WalletReconcileCard, {
    global: {
      mocks: { $t: t },
      stubs: {
        QCard: { template: '<article><slot /></article>' },
        QCardSection: { template: '<div><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          emits: ['click'],
          template:
            '<button :disabled="disable" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  })

const summary = {
  chainIdentifier: 'monad-testnet',
  messagesRead: 12,
  mailboxComplete: true,
  receivedCoinsAdded: [
    { address: '0xabc', claimedAmountWei: '1000', state: 'pending' },
  ],
  receivedCoinsChanged: 0,
  accountsAdded: [],
  operationsObserved: 2,
  operationsChanged: [],
  failures: [],
}

describe('WalletReconcileCard', () => {
  beforeEach(() => mockReconcile.mockReset())

  it('shows progress while the pass runs, then its summary', async () => {
    let finish!: (value: typeof summary) => void
    mockReconcile.mockImplementation(
      (onProgress: (p: unknown) => void) =>
        new Promise(resolve => {
          onProgress({
            step: 'mailbox',
            messagesRead: 5,
            operationsObserved: 0,
            operationsTotal: 0,
          })
          finish = resolve
        }),
    )
    const card = mountCard()
    await card.find('[data-test="reconcile-wallet-btn"]').trigger('click')
    await flushPromises()
    expect(card.find('[data-test="reconcile-progress"]').text()).toBe(
      'Reading the mailbox: 5 messages',
    )
    expect(
      card.find('[data-test="reconcile-wallet-btn"]').attributes('disabled'),
    ).toBeDefined()
    // A second press while running starts nothing.
    await card.find('[data-test="reconcile-wallet-btn"]').trigger('click')
    expect(mockReconcile).toHaveBeenCalledTimes(1)

    finish(summary)
    await flushPromises()
    const shown = card.find('[data-test="reconcile-summary"]').text()
    expect(shown).toContain('Reconcile finished')
    expect(shown).toContain('Network: monad-testnet')
    expect(shown).toContain('Messages read: 12')
    expect(shown).toContain('Received payments found: 1')
    expect(shown).toContain('Operations read: 2, changed: 0')
    expect(card.find('[data-test="reconcile-progress"]').exists()).toBe(false)
  })

  it('says when nothing was new, and shows a refusal', async () => {
    mockReconcile.mockResolvedValueOnce({ ...summary, receivedCoinsAdded: [] })
    const card = mountCard()
    await card.find('[data-test="reconcile-wallet-btn"]').trigger('click')
    await flushPromises()
    expect(card.text()).toContain('Nothing new')

    mockReconcile.mockRejectedValueOnce(new Error('No account wallet is open'))
    await card.find('[data-test="reconcile-wallet-btn"]').trigger('click')
    await flushPromises()
    expect(card.find('[data-test="reconcile-error"]').text()).toContain(
      'No account wallet is open',
    )
  })
})
