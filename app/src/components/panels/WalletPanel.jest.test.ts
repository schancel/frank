/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { getActiveChain, setActiveChain } from '@frank/wallet/chain'
import type { BalancePresentation } from '../../composables/useChainBalance'
import Panel from './WalletPanel.vue'
import { useWalletNames } from '../../composables/useWalletNames'
import en from '../../i18n/en-us'

const mockRouterPush = jest.fn()
const mockRoute = ref({ path: '/wallet', query: { chain: 'monad' } })
jest.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useRoute: () => mockRoute.value,
}))
const mockPresentations = ref<Record<string, BalancePresentation>>({})
jest.mock('../../composables/useChainBalance', () => ({
  useMultichainBalance: () => ({
    getPresentation: (wallet: string) =>
      mockPresentations.value[wallet] ?? { status: 'loading' },
  }),
}))
const t = (key: string) =>
  key.split('.').reduce((value: any, part) => value?.[part], en) ?? key

function render() {
  return mount(Panel, {
    global: {
      mocks: { $t: t, $router: { push: mockRouterPush } },
      stubs: {
        QScrollArea: { template: '<div><slot /></div>' },
        QList: { template: '<div><slot /></div>' },
        QItem: { template: '<button><slot /></button>' },
        QItemSection: {
          props: ['avatar', 'side'],
          template:
            "<span :class=\"{ 'q-item-section--side': side, 'q-item-section--avatar': avatar }\"><slot /></span>",
        },
        QItemLabel: { template: '<span><slot /></span>' },
        QSeparator: { template: '<hr />' },
        QIcon: true,
        QTooltip: { template: '<div class="q-tooltip-stub"><slot /></div>' },
        QBtn: {
          props: ['label', 'disable'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        QBadge: true,
        Codex32BackupDialog: true,
        RenameWalletDialog: true,
      },
      directives: { ripple: {} },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  useWalletNames().clearAllCustomNames()
  mockRouterPush.mockClear()
  mockPresentations.value = {}
})

test('renders only available wallets with icon, name and one native balance line', () => {
  const view = render()
  for (const id of ['monad', 'bitcoin', 'bitcoincash', 'ecash', 'solana']) {
    const prefix = id === 'monad' ? '' : `${id}-`
    const row = view.get(`[data-test="${prefix}wallet-row"]`)
    expect(row.find('q-icon-stub').exists()).toBe(true)
    expect(row.findAll('[data-test$="wallet-name-text"]')).toHaveLength(1)
    expect(row.findAll('[data-test$="wallet-chain"]')).toHaveLength(0)
    expect(row.findAll('[data-test$="wallet-balance"]')).toHaveLength(1)
    expect(row.get('[data-test$="wallet-balance"]').text()).toBe(
      'Loading balance…',
    )
    expect(row.findAll('[data-test$="testnet-badge"]')).toHaveLength(1)
    expect(row.get('[data-test$="testnet-badge"]').element.parentElement).toBe(
      row.get('[data-test$="wallet-name"]').element,
    )
    expect(row.findAll('button')).toHaveLength(0)
  }
  for (const id of ['dogecoin', 'ethereum', 'tempo', 'hyperliquid'])
    expect(view.find(`[data-test="${id}-wallet-row"]`).exists()).toBe(false)
  expect(view.text()).not.toContain('Not supported')
  expect(view.find('[data-test="drawer-avu-explainer-link"]').exists()).toBe(
    false,
  )
  expect(view.find('[data-test="portfolio-total-avu"]').exists()).toBe(false)
  expect(view.find('[data-test="balance-stale"]').exists()).toBe(false)
})

test('clicking wallet rows preserves their respective routes', async () => {
  const view = render()
  for (const id of ['monad', 'bitcoin', 'bitcoincash', 'ecash', 'solana']) {
    const prefix = id === 'monad' ? '' : `${id}-`
    await view.get(`[data-test="${prefix}wallet-row"]`).trigger('click')
    expect(mockRouterPush).toHaveBeenLastCalledWith(
      id === 'monad' ? '/wallet' : `/wallet/${id}`,
    )
  }
})

test('renders concise default names with inline testnet badges instead of network subtitles', () => {
  const view = render()
  expect(view.get('[data-test="wallet-name-text"]').text()).toBe('Main wallet')
  expect(view.get('[data-test="bitcoin-wallet-name-text"]').text()).toBe(
    'Bitcoin',
  )
  expect(view.get('[data-test="ecash-wallet-name-text"]').text()).toBe('eCash')
  expect(view.get('[data-test="solana-wallet-name-text"]').text()).toBe(
    'Solana',
  )
})

test('keeps existing custom names and follows their updates', async () => {
  const { setCustomName, resetCustomName } = useWalletNames()
  setCustomName('monad', 'Trading Bot')
  setCustomName('ecash', 'Personal Stash')
  const view = render()
  expect(view.get('[data-test="wallet-name-text"]').text()).toBe('Trading Bot')
  expect(view.get('[data-test="ecash-wallet-name-text"]').text()).toBe(
    'Personal Stash',
  )
  resetCustomName('ecash')
  await flushPromises()
  expect(view.get('[data-test="ecash-wallet-name-text"]').text()).toBe('eCash')
  expect(view.get('[data-test="wallet-name-text"]').text()).toBe('Trading Bot')
})

test('offers no edit button or double-click rename in the sidebar', async () => {
  const view = render()
  expect(view.find('[data-test="rename-monad-btn"]').exists()).toBe(false)
  await view.get('[data-test="wallet-name-text"]').trigger('dblclick')
  expect(view.findComponent({ name: 'RenameWalletDialog' }).exists()).toBe(
    false,
  )
})

test('updates the reserved native balance line without adding rows or hiding a wallet on RPC failure', async () => {
  const view = render()
  const row = view.get('[data-test="wallet-row"]')
  const balance = row.get('[data-test="wallet-balance"]').element
  const names = view
    .findAll('[data-test$="wallet-name-text"]')
    .map(item => item.text())
  mockPresentations.value.monad = {
    status: 'available',
    observation: { balance: 123n, formattedBalance: '1.23456789 MONT' },
  }
  await flushPromises()
  expect(row.get('[data-test="wallet-balance"]').element).toBe(balance)
  expect(row.get('[data-test="wallet-balance"]').text()).toBe('1.2345 MONT')
  expect(row.find('[data-test="monad-balance-stale-indicator"]').exists()).toBe(
    false,
  )
  mockPresentations.value.monad = {
    status: 'unavailable',
    reason: 'fetch-error',
    lastKnown: { balance: 123n, formattedBalance: '1.23456789 MONT' },
  }
  await flushPromises()
  expect(row.get('[data-test="wallet-balance"]').element).toBe(balance)
  expect(row.get('[data-test="wallet-balance"]').text()).toBe('1.2345 MONT')
  expect(row.get('[data-test="wallet-balance"]').attributes('title')).toContain(
    'Last known balance — refresh failed.',
  )
  expect(
    row.get('[data-test="wallet-balance"]').attributes('aria-label'),
  ).toContain('This value may be out of date.')
  expect(
    row
      .get('[data-test="monad-balance-stale-indicator"]')
      .attributes('aria-hidden'),
  ).toBe('true')
  mockPresentations.value.monad = {
    status: 'unavailable',
    reason: 'fetch-error',
  }
  await flushPromises()
  expect(row.get('[data-test="wallet-balance"]').text()).toBe(
    'Balance unavailable.',
  )
  expect(
    view.findAll('[data-test$="wallet-name-text"]').map(item => item.text()),
  ).toEqual(names)
  expect(row.findAll('[data-test$="wallet-balance"]')).toHaveLength(1)
  expect(row.find('[data-test="balance-stale"]').exists()).toBe(false)
  expect(row.find('[data-test="monad-balance-stale-indicator"]').exists()).toBe(
    false,
  )
})

test('marks configured test networks and removes badges when the selected networks are mainnets', async () => {
  const original = getActiveChain()
  const view = render()
  try {
    expect(view.findAll('[data-test$="testnet-badge"]')).toHaveLength(5)
    setActiveChain({
      ...original,
      chainIdentifier: 'monad-mainnet',
      isTestnet: false,
    })
    await flushPromises()
    expect(view.findAll('[data-test$="testnet-badge"]')).toHaveLength(0)
    expect(
      view.findAll('[data-test$="wallet-name-text"]').map(row => row.text()),
    ).toEqual(['Main wallet', 'Solana'])
    expect(view.findAll('[data-test$="wallet-balance"]')).toHaveLength(2)
  } finally {
    view.unmount()
    setActiveChain(original)
  }
})
