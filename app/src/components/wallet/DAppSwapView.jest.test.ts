/** @jest-environment jsdom */
import {
  enableAutoUnmount,
  flushPromises,
  mount,
  shallowMount,
} from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'
import { WALLET_CONFIGS } from '../../utils/wallet-configs'

enableAutoUnmount(afterEach)
const mockReadRoot = jest.fn().mockResolvedValue(new Uint8Array(32))
const mockSign = jest.fn().mockReturnValue({ publicKey: 'test-public-key' })
const mockTransfer = jest.fn()
const mockBroadcast = jest.fn().mockResolvedValue('forbidden-test-receipt')
const mockProvider = jest.fn().mockImplementation(() => ({
  getLatestBlockhash: jest
    .fn()
    .mockResolvedValue({ blockhash: 'test-blockhash' }),
}))
const mockSelfMessage = jest.fn()
const mockLogSwap = jest.fn()
const mockRefresh = jest.fn()
const mockHistory = ref([
  {
    id: 'existing-record',
    chain: 'solana',
    fromAsset: 'SOL',
    toAsset: 'USDC',
    fromAmount: '2',
    toAmount: '50',
    txHash: 'existing-receipt',
    route: 'Existing route',
    timestamp: 1,
    status: 'confirmed',
  },
])
const mockRoute = ref({ path: '/wallet/solana', query: {}, params: {} })

jest.mock('@frank/wallet/chain', () => ({
  activeChain: { isTestnet: true },
  getChainExchangeConfig: () => undefined,
}))
jest.mock('@frank/wallet/plugins', () => ({
  defaultPluginRegistry: { get: () => undefined },
}))
jest.mock('@frank/wallet/plugins/jupiter-plugin', () => ({
  JUPITER_PROGRAM_ID: 'test-program',
}))
jest.mock('@solana/web3.js', () => ({
  Keypair: { fromSeed: (...args: unknown[]) => mockSign(...args) },
  Connection: function (...args: unknown[]) {
    return mockProvider(...args)
  },
  Transaction: function () {
    return { add: () => ({}) }
  },
  SystemProgram: { transfer: (...args: unknown[]) => mockTransfer(...args) },
  PublicKey: function () {
    return {}
  },
  LAMPORTS_PER_SOL: 1_000_000_000,
  sendAndConfirmTransaction: (...args: unknown[]) => mockBroadcast(...args),
}))
jest.mock('@solana/codecs-strings', () => ({
  getBase58Decoder: () => ({ decode: () => 'fabricated-test-receipt' }),
}))
jest.mock('src/accounts/session', () => ({
  accountStatus: { status: 'ready', revision: 1 },
  accountSession: {
    getActiveDomainRoot: (...args: unknown[]) => mockReadRoot(...args),
    getCachedChainAddress: () => 'test-address',
    getChainAddress: async () => 'test-address',
  },
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    balance: ref(null),
    loaded: ref(false),
    refresh: mockRefresh,
  }),
}))
jest.mock('src/composables/useChainBalance', () => ({
  useChainBalance: () => ({
    tokens: ref([]),
    balance: ref(null),
    loaded: ref(false),
    refresh: mockRefresh,
    presentation: ref({ status: 'loading' }),
    tokenObservation: ref({ status: 'loading' }),
  }),
}))
jest.mock('src/composables/useSwapHistory', () => ({
  useSwapHistory: () => ({
    getSwapsForChain: () => mockHistory,
    logSwap: (...args: unknown[]) => mockLogSwap(...args),
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({
    identity: { displayAddress: 'test-address' },
    sendSelfDirectMessage: mockSelfMessage,
  }),
}))
jest.mock('src/stores/oracle', () => ({
  useSafeOracleStore: () => ({
    formatUnitRate: () => '',
    snapshot: { constituents: [] },
  }),
}))
jest.mock('vue-router', () => ({
  useRoute: () => ({
    get path() {
      return mockRoute.value.path
    },
    get query() {
      return mockRoute.value.query
    },
    get params() {
      return mockRoute.value.params
    },
  }),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/utils/routes', () => ({ openPage: jest.fn() }))
jest.mock('src/utils/native-transfer', () => ({
  nativeSendChainIdentifier: () => undefined,
}))
jest.mock('src/utils/explorer', () => ({ getExplorerUrl: () => undefined }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('quasar', () => ({ copyToClipboard: jest.fn() }))

import DAppSwapView from './DAppSwapView.vue'
import Wallet from '../../pages/Wallet.vue'

type LegacySwap = {
  executeSwap?: () => Promise<void>
  fromAmount?: string
  lastTxHash?: string | null
}
const translate = (locale: typeof en | typeof fr) => (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[part]
          : undefined,
      locale,
    ) ?? key
const stubs = {
  QBtn: {
    props: ['disable', 'label'],
    template: '<button :disabled="disable">{{ label }}<slot /></button>',
  },
  ...Object.fromEntries(
    [
      'q-header',
      'q-toolbar',
      'q-toolbar-title',
      'q-page-container',
      'q-page',
      'q-scroll-area',
      'q-card',
      'q-card-section',
      'q-card-actions',
      'q-separator',
      'q-badge',
      'q-skeleton',
      'q-tabs',
      'q-tab',
      'q-tab-panels',
      'q-tab-panel',
      'q-icon',
      'q-list',
      'q-item',
      'q-item-section',
      'q-item-label',
    ].map(name => [name, { template: '<div><slot /></div>' }]),
  ),
  QTooltip: true,
  QInput: {
    props: ['modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  QSelect: true,
  QrcodeVue: true,
  AvuParityChart: true,
  AvuExplainerDialog: true,
}
function mountSwap(wallet: string, locale: typeof en | typeof fr = en) {
  return mount(DAppSwapView, {
    props: { selectedWallet: wallet },
    global: { mocks: { $t: translate(locale) }, stubs },
  })
}
function mountWallet() {
  return shallowMount(Wallet, {
    global: {
      mocks: { $t: translate(en) },
      stubs: { ...stubs, DAppSwapView: false },
    },
  })
}
function expectNoEffects() {
  for (const effect of [
    mockReadRoot,
    mockSign,
    mockProvider,
    mockTransfer,
    mockBroadcast,
    mockLogSwap,
    mockSelfMessage,
    mockRefresh,
  ]) {
    expect(effect).not.toHaveBeenCalled()
  }
}
function expectUnavailable(
  view: ReturnType<typeof mountSwap>,
  locale: typeof en | typeof fr = en,
) {
  expect(
    view.get('[data-testid="swap-execute-btn"]').attributes('disabled'),
  ).toBeDefined()
  expect(view.text()).toContain(locale.walletPanel.swapUnavailable)
  expect(view.text()).toContain(locale.walletPanel.swapUnavailableDescription)
  for (const id of [
    'swap-from-amount',
    'swap-to-amount',
    'swap-max-balance',
    'swap-protocol-fee',
    'swap-router-name',
    'swap-success-banner',
  ]) {
    expect(view.find(`[data-testid="${id}"]`).exists()).toBe(false)
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockReadRoot.mockResolvedValue(new Uint8Array(32))
})

describe('Instant Swap containment', () => {
  it.each(WALLET_CONFIGS.map(wallet => wallet.id))(
    'shows unavailable capability through mounted /wallet/%s',
    async wallet => {
      mockRoute.value = { path: `/wallet/${wallet}`, query: {}, params: {} }
      const page = mountWallet()
      await flushPromises()
      const swap = page.getComponent(DAppSwapView)
      expect(swap.props('selectedWallet')).toBe(wallet)
      expectUnavailable(swap)
      expectNoEffects()
    },
  )

  it.each(['query', 'params'])(
    'contains the existing wallet %s route and reactive selection changes',
    async kind => {
      mockRoute.value =
        kind === 'query'
          ? { path: '/wallet', query: { chain: 'solana' }, params: {} }
          : { path: '/wallet', query: {}, params: { wallet: 'solana' } }
      const page = mountWallet()
      const swap = page.getComponent(DAppSwapView)
      expect(swap.props('selectedWallet')).toBe('solana')
      expectUnavailable(swap)
      mockRoute.value = { path: '/wallet/ecash', query: {}, params: {} }
      await nextTick()
      expect(swap.props('selectedWallet')).toBe('ecash')
      expectUnavailable(swap)
      expectNoEffects()
    },
  )

  it.each([
    ['English', en],
    ['French', fr],
  ] as const)('localizes the unavailable capability in %s', (_name, locale) => {
    expectUnavailable(mountSwap('solana', locale), locale)
  })

  it.each([
    ['monad', true],
    ['ecash', true],
    ['solana', true],
    ['solana', false],
  ] as const)(
    'cannot execute or fabricate a receipt for %s (root available: %s)',
    async (wallet, rootAvailable) => {
      mockReadRoot.mockResolvedValue(
        rootAvailable ? new Uint8Array(32) : undefined,
      )
      const view = mountSwap(wallet)
      const vm = view.vm as unknown as LegacySwap
      // Exercise the old callable boundary with a valid amount, as well as a UI attempt.
      // All custody and network dependencies above are isolated spies; no live RPC is possible.
      if (vm.executeSwap) {
        vm.fromAmount = '1'
        await nextTick()
        await vm.executeSwap()
      }
      await view.get('[data-testid="swap-execute-btn"]').trigger('click')
      if (vm.executeSwap) await new Promise(resolve => setTimeout(resolve, 850))
      await flushPromises()
      expectNoEffects()
      expect(vm.lastTxHash == null).toBe(true)
      expect(view.find('[data-testid="swap-success-banner"]').exists()).toBe(
        false,
      )
      expect(vm.executeSwap).toBeUndefined()
    },
  )

  it('keeps existing history visible without modifying it', async () => {
    mockRoute.value = { path: '/wallet/solana', query: {}, params: {} }
    const before = JSON.stringify(mockHistory.value)
    const page = mountWallet()
    await flushPromises()
    expect(page.text()).toContain('Existing route')
    await page
      .getComponent(DAppSwapView)
      .get('[data-testid="swap-execute-btn"]')
      .trigger('click')
    if (
      (page.getComponent(DAppSwapView).vm as unknown as LegacySwap).executeSwap
    )
      await new Promise(resolve => setTimeout(resolve, 850))
    expect(JSON.stringify(mockHistory.value)).toBe(before)
    expectNoEffects()
  })
})
