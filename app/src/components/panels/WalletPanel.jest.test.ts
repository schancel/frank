/** @jest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import Panel from './WalletPanel.vue'
import RenameWalletDialog from '../wallet/RenameWalletDialog.vue'
import AvuExplainerDialog from '../wallet/AvuExplainerDialog.vue'
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

// The raw figure each wallet's balance line shows (useMultichainBalance().getRawBalance).
const mockRawBalances = ref<Record<string, bigint>>({})
const mockFormatAvuAmount = jest.fn((_asset: string, _raw: bigint) => '')
const mockGetAvu = jest.fn((_asset: string, _raw: bigint) => 0)
const mockEcashError = ref(false)
const mockEcashBalance = ref<string | undefined>(undefined)

jest.mock('../../composables/useChainBalance', () => ({
  useMultichainBalance: () => ({
    getTokenObservation: () => undefined,
    monad: {
      loaded: mockLoaded,
      hasError: mockError,
      formattedBalance: mockFormattedBalance,
      balance: ref(0n),
    },
    getPresentation: (chain: string) => {
      if (!['monad', 'ecash', 'solana'].includes(chain)) {
        return { status: 'unavailable', reason: 'unsupported' }
      }
      const formatted =
        chain === 'monad'
          ? mockLoaded.value
            ? mockFormattedBalance.value
            : undefined
          : chain === 'ecash'
          ? mockEcashBalance.value
          : undefined
      const observation =
        formatted === undefined
          ? undefined
          : { balance: 0n, formattedBalance: formatted }
      if (
        chain === 'monad'
          ? mockError.value
          : chain === 'ecash' && mockEcashError.value
      ) {
        return {
          status: 'unavailable',
          reason: 'fetch-error',
          lastKnown: observation,
        }
      }
      return observation
        ? { status: 'available', observation }
        : { status: 'loading' }
    },
    getRawBalance: (chain: string) => mockRawBalances.value[chain] ?? null,
  }),
}))

const mockReleaseOracle = jest.fn()
const mockAcquireOracle = jest.fn(() => mockReleaseOracle)

jest.mock('../../stores/oracle', () => ({
  useSafeOracleStore: () => ({
    getAvu: (asset: string, raw: bigint) => mockGetAvu(asset, raw),
    formatAvuAmount: (asset: string, raw: bigint) =>
      mockFormatAvuAmount(asset, raw),
    formatAvuValue: () => '',
    formatUnitRate: (asset: string) => {
      if (asset === 'monad') return '1 MON ≈ 41.67 AVU'
      if (asset === 'ecash') return '1M XEC ≈ 416.67 AVU'
      if (asset === 'solana') return '1 SOL ≈ 1,785.71 AVU'
      if (asset === 'tempo') return '1 TUSD ≈ 11.90 AVU'
      if (asset === 'ethereum') return '1 ETH ≈ 30,952.38 AVU'
      if (asset === 'hyperliquid') return '1 HYPE ≈ 476.19 AVU'
      return ''
    },
    snapshot: { totalConstituents: 0, constituents: [] },
    acquire: mockAcquireOracle,
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
  const { clearAllCustomNames } = useWalletNames()
  clearAllCustomNames()
  mockAcquireOracle.mockClear()
  mockReleaseOracle.mockClear()
})

afterEach(() => {
  mockLoaded.value = true
  mockError.value = false
  mockFormattedBalance.value = '0 MON'
  mockEcashBalance.value = undefined
  mockEcashError.value = false
  const { clearAllCustomNames } = useWalletNames()
  clearAllCustomNames()
})

test('renders list of wallets without recovery banners or demo buttons', () => {
  const view = render()
  expect(view.find('[data-test="wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="bitcoin-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="bitcoincash-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="dogecoin-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-wallet-row"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-wallet-row"]').exists()).toBe(true)
  expect(view.text()).toContain('Wallets')
  expect(view.text()).toContain('Main wallet')
  expect(view.text()).toContain('Bitcoin')
  expect(view.text()).toContain('Bitcoin Cash')
  expect(view.text()).toContain('Dogecoin')
  expect(view.text()).toContain('eCash')
  expect(view.text()).toContain('Solana')
  // No informative text walls or demo buttons
  expect(view.text()).not.toContain('Messaging is unavailable')
  expect(view.find('[data-test="recovery-descriptor"]').exists()).toBe(false)
  expect(view.find('[data-test="testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="bitcoin-testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="bitcoincash-testnet-badge"]').exists()).toBe(
    true,
  )
  expect(view.find('[data-test="dogecoin-testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="ecash-testnet-badge"]').exists()).toBe(true)
  expect(view.find('[data-test="solana-testnet-badge"]').exists()).toBe(true)
  // No balance reader for these networks: a quiet dash that names its reason, not the
  // wording of a failed fetch.
  for (const chain of ['bitcoin', 'bitcoincash', 'dogecoin']) {
    const region = view.get(`[data-test="${chain}-wallet-balance"]`)
    expect(region.text()).toBe('\u2014')
    expect(region.attributes('title')).toBe(t('walletPanel.balanceUnsupported'))
    expect(region.attributes('aria-label')).toBe(
      t('walletPanel.balanceUnsupported'),
    )
  }
  for (const chain of ['ecash', 'solana']) {
    expect(view.get(`[data-test="${chain}-wallet-balance"]`).text()).toBe(
      t('walletPanel.balanceLoading'),
    )
  }
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
  expect(view.get('[data-test="ecash-wallet-balance"]').text()).toBe('10 ktXEC')
})

test('shows secondary loading, initial failure, observed zero and stale value', async () => {
  const view = render()
  const region = view.get('[data-test="ecash-wallet-balance"]')
  expect(region.text()).toBe(t('walletPanel.balanceLoading'))
  mockEcashError.value = true
  await flushPromises()
  expect(region.text()).toBe(t('walletPanel.balanceUnavailable'))
  mockEcashError.value = false
  mockEcashBalance.value = '0 tXEC'
  await flushPromises()
  expect(region.text()).toBe('0 tXEC')
  expect(view.find('[data-test="ecash-balance-stale"]').exists()).toBe(false)
  mockEcashBalance.value = '25 tXEC'
  await flushPromises()
  expect(region.text()).toBe('25 tXEC')
  mockEcashError.value = true
  await flushPromises()
  expect(region.text()).toBe('25 tXEC')
  expect(view.get('[data-test="ecash-balance-stale"]').text()).toBe(
    t('accountRecovery.balance_stale'),
  )
})

test('clicking wallet rows navigates to the respective chain', async () => {
  mockRouterPush.mockClear()
  const view = render()

  await view.find('[data-test="wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet')

  await view.find('[data-test="bitcoin-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/bitcoin')

  await view.find('[data-test="bitcoincash-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/bitcoincash')

  await view.find('[data-test="dogecoin-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/dogecoin')

  await view.find('[data-test="ecash-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/ecash')

  await view.find('[data-test="solana-wallet-row"]').trigger('click')
  expect(mockRouterPush).toHaveBeenCalledWith('/wallet/solana')
})

test('says for each wallet exactly what the app can do with it', () => {
  const view = render()
  const capability = (id: string) => {
    const label = view.find(`[data-test="${id}-wallet-capability"]`)
    return label.exists() ? label.text() : undefined
  }
  // A wallet (balance, receive and send) needs no remark.
  expect(capability('monad')).toBeUndefined()
  expect(capability('solana')).toBeUndefined()
  for (const id of ['ecash', 'bitcoin', 'bitcoincash'])
    expect(capability(id)).toBeUndefined()
  for (const id of ['dogecoin', 'ethereum', 'tempo', 'hyperliquid'])
    expect(capability(id)).toBe('Not supported')
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
  expect(solanaChain.text()).toBe('Solana Devnet')
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

test('omits unit rate in wallet rows (kept for main page) and allows clicking drawer header link to open AvuExplainerDialog', async () => {
  const view = render()

  // Unit rate captions are omitted from drawer wallet rows to save height
  expect(view.find('[data-test="monad-wallet-unit-rate"]').exists()).toBe(false)
  expect(view.find('[data-test="ecash-wallet-unit-rate"]').exists()).toBe(false)
  expect(view.find('[data-test="solana-wallet-unit-rate"]').exists()).toBe(
    false,
  )

  // Drawer header link 1 AVU ≡ 1 kWh (?) is clickable
  const headerLink = view.find('[data-test="drawer-avu-explainer-link"]')
  expect(headerLink.exists()).toBe(true)
  expect(headerLink.text()).toContain('1 AVU ≡ 1 kWh (?)')
  await headerLink.trigger('click')
  expect(view.findComponent(AvuExplainerDialog).props('modelValue')).toBe(true)
})

test('renders universal AVU tooltips on portfolio total and drawer header', () => {
  const view = render()
  const tooltips = view.findAll('.q-tooltip-stub')
  expect(tooltips.length).toBeGreaterThan(0)
  expect(
    tooltips.some(tt =>
      tt.text().includes('1 AVU ≡ 1 kWh (3.6 MJ) of physical compute'),
    ),
  ).toBe(true)
})

test('the main wallet and the portfolio total value the balance its line shows, not another figure', () => {
  // The Monad mock above reports `monad.balance` 0n: the wallet's own narrower figure, which
  // this panel valued on 2026-10-10 while the Wallet page valued the shown total.
  mockRawBalances.value = { monad: 1640n }
  mockFormatAvuAmount.mockImplementation(
    (asset, raw) => `≈ ${asset} ${raw} AVU`,
  )
  mockLoaded.value = true
  try {
    const view = render()
    expect(view.text()).toContain('≈ monad 1640 AVU')
    for (const calls of [
      mockFormatAvuAmount.mock.calls,
      mockGetAvu.mock.calls,
    ]) {
      expect(calls.length).toBeGreaterThan(0)
      expect(
        calls.every(([asset, raw]) => asset === 'monad' && raw === 1640n),
      ).toBe(true)
    }
  } finally {
    mockRawBalances.value = {}
    mockFormatAvuAmount.mockImplementation(() => '')
    mockFormatAvuAmount.mockClear()
    mockGetAvu.mockClear()
  }
})

test('does not hold the oracle feed itself: the app shell holds it for every screen', () => {
  const view = render()
  expect(mockAcquireOracle).not.toHaveBeenCalled()
  view.unmount()
  expect(mockReleaseOracle).not.toHaveBeenCalled()
})

test('the drawer header keeps the title and the AVU note as two unbroken groups of one wrapping row', () => {
  const view = render()
  const row = view.get('.wallet-header-row')
  const [title, note] = Array.from(row.element.children)
  expect(title.classList.contains('wallet-header-title')).toBe(true)
  expect(title.textContent).toContain(t('walletPanel.title'))
  expect(note.getAttribute('data-test')).toBe('drawer-avu-explainer-link')
  expect(note.textContent).toContain(t('walletPanel.avuDrawerHeader'))
  // The note is no longer a side column squeezed beside the title.
  expect(note.closest('.q-item-section--side')).toBeNull()
})
