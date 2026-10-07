/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import RenameWalletDialog from '../wallet/RenameWalletDialog.vue'
import { useWalletNames } from '../../composables/useWalletNames'
import en from '../../i18n/en-us'

const mockLoaded = ref(true)
const mockError = ref(false)
const mockFormattedBalance = ref('0 MON')
const mockRouterPush = jest.fn()
const mockRoute = ref({ path: '/wallet', query: { chain: 'monad' } })

jest.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useRoute: () => mockRoute.value,
}))

const mockEcashBalance = ref<string | undefined>(undefined)

jest.mock('../../composables/useBalance', () => ({
  useBalance: () => ({
    loaded: mockLoaded,
    hasError: mockError,
    formattedBalance: mockFormattedBalance,
    refresh: jest.fn(),
  }),
}))

jest.mock('../../composables/useChainBalance', () => ({
  useMultichainBalance: () => ({
    getFormattedBalance: (chain: string) =>
      chain === 'ecash' ? mockEcashBalance.value : undefined,
    isChainLoaded: (chain: string) =>
      chain === 'ecash' ? Boolean(mockEcashBalance.value) : false,
    hasChainError: () => false,
    refreshAll: jest.fn(),
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
  const { clearAllCustomNames } = useWalletNames()
  clearAllCustomNames()
})

afterEach(() => {
  mockLoaded.value = true
  mockError.value = false
  mockFormattedBalance.value = '0 MON'
  mockEcashBalance.value = undefined
  const { clearAllCustomNames } = useWalletNames()
  clearAllCustomNames()
})

test('renders list of wallets without recovery banners or demo buttons', () => {
  const view = render()
  expect(view.find('[data-test="wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-wallet-row"]').exists()).toBe(true)
  expect(view.text()).toContain('Wallets')
  expect(view.text()).toContain('Main wallet')
  expect(view.text()).toContain('eCash')
  expect(view.text()).toContain('Solana')
  // No informative text walls or demo buttons
  expect(view.text()).not.toContain('Messaging is unavailable')
  expect(view.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
  expect(view.find('[data-test="testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-testnet-badge"]').exists()).toBe(true)
  expect(view.text()).toContain('0 tXEC')
  expect(view.text()).toContain('0 tSOL')
})

test('displays formatted live balance and handles loading and stale states', async () => {
  const view = render()
  expect(view.find('[data-test="balance-stale"]').exists()).toBe(false)
  expect(view.get('[data-test="wallet-balance"]').text()).toBe('0 MON')

  mockError.value = true
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toBe('0 MON')
  expect(view.get('[data-test="balance-stale"]').text()).toContain(
    'out of date',
  )

  mockLoaded.value = false
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toContain(
    'unavailable',
  )

  mockError.value = false
  await flushPromises()
  expect(view.get('[data-test="wallet-balance"]').text()).toContain('Loading')
})

test('displays fetched non-zero eCash balance when loaded', async () => {
  mockEcashBalance.value = '10000 tXEC'
  const view = render()
  expect(view.get('[data-test="ecash-wallet-balance"]').text()).toBe(
    '10000 tXEC',
  )
})

test('clicking wallet rows navigates to the respective chain', async () => {
  mockRouterPush.mockClear()
  const view = render()

  await view.find('[data-test="wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet')

  await view.find('[data-test="ecash-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/ecash')

  await view.find('[data-test="solana-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/solana')
})

test('reorganizes wallet list item layout: no side section for chain name, chain is caption below name', () => {
  const view = render()

  // Monad row
  const monadRow = view.find('[data-test="wallet-row"]')
  expect(monadRow.find('.q-item-section--side').exists()).toBe(false)
  const monadChain = monadRow.find('[data-test="wallet-chain"]')
  expect(monadChain.exists()).toBe(true)
  expect(monadChain.text()).toBe('Monad Testnet')

  // eCash row
  const ecashRow = view.find('[data-test="ecash-wallet-row"]')
  expect(ecashRow.find('.q-item-section--side').exists()).toBe(false)
  const ecashChain = ecashRow.find('[data-test="ecash-wallet-chain"]')
  expect(ecashChain.exists()).toBe(true)
  expect(ecashChain.text()).toBe('eCash Testnet')

  // Solana row
  const solanaRow = view.find('[data-test="solana-wallet-row"]')
  expect(solanaRow.find('.q-item-section--side').exists()).toBe(false)
  const solanaChain = solanaRow.find('[data-test="solana-wallet-chain"]')
  expect(solanaChain.exists()).toBe(true)
  expect(solanaChain.text()).toBe('Solana Testnet')
})

test('renders clean default names without repeating testnet in name and badge', () => {
  const view = render()

  // Default names should not contain "Testnet"
  expect(view.find('[data-test="wallet-name-text"]').text()).toBe('Main wallet')
  expect(view.find('[data-test="ecash-wallet-name-text"]').text()).toBe('eCash')
  expect(view.find('[data-test="solana-wallet-name-text"]').text()).toBe(
    'Solana',
  )

  // Badges still indicate Testnet
  expect(view.find('[data-test="testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-testnet-badge"]').exists()).toBe(true)
})

test('allows viewing and updating custom wallet names', async () => {
  const { setCustomName, resetCustomName } = useWalletNames()
  setCustomName('monad', 'Trading Bot')
  setCustomName('ecash', 'Personal Stash')
  setCustomName('solana', 'Solana Vault')

  const view = render()
  expect(view.find('[data-test="wallet-name-text"]').text()).toBe('Trading Bot')
  expect(view.find('[data-test="ecash-wallet-name-text"]').text()).toBe(
    'Personal Stash',
  )
  expect(view.find('[data-test="solana-wallet-name-text"]').text()).toBe(
    'Solana Vault',
  )

  // Resetting returns to default concise names
  resetCustomName('monad')
  resetCustomName('ecash')
  await flushPromises()
  expect(view.find('[data-test="wallet-name-text"]').text()).toBe('Main wallet')
  expect(view.find('[data-test="ecash-wallet-name-text"]').text()).toBe('eCash')
  expect(view.find('[data-test="solana-wallet-name-text"]').text()).toBe(
    'Solana Vault',
  )
})

test('opens rename dialog on edit icon click and handles save and reset', async () => {
  const view = render()
  const renameDialog = view.findComponent(RenameWalletDialog)
  expect(renameDialog.exists()).toBe(true)
  expect(renameDialog.props('modelValue')).toBe(false)

  // Clicking rename button for monad opens dialog
  await view.find('[data-test="rename-monad-btn"]').trigger('click')
  expect(renameDialog.props('modelValue')).toBe(true)
  expect(renameDialog.props('chain')).toBe('monad')
  expect(renameDialog.props('defaultName')).toBe('Main wallet')

  // Emitting save from dialog updates wallet name
  await renameDialog.vm.$emit('save', 'Primary Monad')
  await flushPromises()
  expect(view.find('[data-test="wallet-name-text"]').text()).toBe(
    'Primary Monad',
  )

  // Double clicking eCash name opens dialog for eCash
  await view.find('[data-test="ecash-wallet-name-text"]').trigger('dblclick')
  expect(renameDialog.props('modelValue')).toBe(true)
  expect(renameDialog.props('chain')).toBe('ecash')
  expect(renameDialog.props('defaultName')).toBe('eCash')

  // Emitting save for eCash
  await renameDialog.vm.$emit('save', 'Coffee Wallet')
  await flushPromises()
  expect(view.find('[data-test="ecash-wallet-name-text"]').text()).toBe(
    'Coffee Wallet',
  )

  // Emitting reset for eCash restores default
  await renameDialog.vm.$emit('reset')
  await flushPromises()
  expect(view.find('[data-test="ecash-wallet-name-text"]').text()).toBe('eCash')
})
