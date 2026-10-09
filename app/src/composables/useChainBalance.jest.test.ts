/** @jest-environment jsdom */
import { nextTick, ref } from 'vue'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useOracleStore } from '../stores/oracle'

const mockMonadBalance = {
  balance: ref<bigint | null>(1000n),
  formattedBalance: ref('10 MON'),
  loaded: ref(true),
  hasError: ref(false),
  refresh: jest.fn(),
}

jest.mock('./useBalance', () => ({
  useBalance: () => mockMonadBalance,
  APP_STATE_EVENT: 'frank:app-state',
  BALANCE_POLL_MS: 15000,
}))

const mockAccountStatus = {
  status: 'ready',
  revision: 1,
}

const mockGetCachedChainAddress = jest.fn((chain: string) => {
  if (chain === 'solana') return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  return 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7'
})
const mockGetChainAddress = jest.fn(async (chain: string) => {
  if (chain === 'solana') return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
  return 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7'
})

jest.mock('../accounts/session', () => ({
  accountStatus: mockAccountStatus,
  accountSession: {
    getCachedChainAddress: (chain: string) => mockGetCachedChainAddress(chain),
    getChainAddress: (chain: string) => mockGetChainAddress(chain),
  },
}))

const mockFetchEcashBalance = jest.fn().mockResolvedValue({
  sats: 1_000_000n,
  formatted: '10000 tXEC',
  unit: 'tXEC',
  networkId: 'xec-testnet',
})

const mockFetchSolanaBalance = jest.fn().mockResolvedValue({
  lamports: 2_500_000_000n,
  formatted: '2.5 tSOL',
  unit: 'tSOL',
  networkId: 'solana-devnet',
})

const mockFetchSolanaTokenAccounts = jest.fn().mockResolvedValue([
  {
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'tUSDC',
    name: 'USD Coin (Devnet)',
    balanceRaw: 100000000n,
    decimals: 6,
    uiAmount: 100.0,
    formatted: '100.00 tUSDC',
    avuFormatted: '≈ 1,190.5 AVU',
  },
])

jest.mock('@frank/wallet/chain', () => ({
  activeChain: { isTestnet: true },
  fetchEcashBalance: (...args: unknown[]) => mockFetchEcashBalance(...args),
  fetchSolanaBalance: (...args: unknown[]) => mockFetchSolanaBalance(...args),
  fetchSolanaTokenAccounts: (...args: unknown[]) =>
    mockFetchSolanaTokenAccounts(...args),
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'http://127.0.0.1:8098',
  }),
}))

// Keep this integration fixture on the display boundary; no custody, transport or price polling.
jest.mock('vue-router', () => ({
  useRoute: () => ({ path: '/wallet/solana', query: {} }),
  useRouter: () => ({ push: jest.fn() }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))
jest.mock('src/composables/useSwapHistory', () => ({
  useSwapHistory: () => ({ getSwapsForChain: () => ref([]) }),
}))
jest.mock('src/utils/routes', () => ({ openPage: jest.fn() }))
jest.mock('src/utils/native-transfer', () => ({
  nativeSendChainIdentifier: () => 'solana-devnet',
}))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))
jest.mock('quasar', () => ({ copyToClipboard: jest.fn() }))
jest.mock('src/components/wallet/AvuExplainerDialog.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/AvuParityChart.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/DAppSwapView.vue', () => ({
  template: '<div />',
}))
jest.mock('src/components/wallet/RenameWalletDialog.vue', () => ({
  template: '<div />',
}))

import {
  useChainBalance,
  useMultichainBalance,
  fetchChainBalance,
  getChainTokens,
} from './useChainBalance'
import Wallet from '../pages/Wallet.vue'
import WalletPanel from '../components/panels/WalletPanel.vue'

describe('useChainBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAccountStatus.status = 'ready'
  })

  it('does not invent a native Solana row before a successful observation', async () => {
    mockAccountStatus.status = 'loading'
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana')).toEqual([])
    mockAccountStatus.status = 'ready'
    mockFetchSolanaBalance.mockRejectedValueOnce(new Error('offline'))
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    await fetchChainBalance('solana', true)
    expect(getChainTokens('solana')).toEqual([])
    error.mockRestore()
  })

  it.each(['ecash', 'solana'])(
    'shares truthful %s presentation through loading, errors, zero and nonzero',
    async chain => {
      mockAccountStatus.status = 'loading'
      await fetchChainBalance(chain, true)
      const detail = useChainBalance(chain)
      const drawer = useMultichainBalance()
      const expectPresentation = (expected: unknown) => {
        expect(detail.presentation.value).toEqual(expected)
        expect(drawer.getPresentation(chain)).toEqual(expected)
      }
      expectPresentation({ status: 'loading' })
      mockAccountStatus.status = 'ready'
      const fetchBalance =
        chain === 'ecash' ? mockFetchEcashBalance : mockFetchSolanaBalance
      const error = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      try {
        fetchBalance.mockRejectedValueOnce(new Error('offline'))
        await fetchChainBalance(chain, true)
        expectPresentation({
          status: 'unavailable',
          reason: 'fetch-error',
          lastKnown: undefined,
        })
        if (chain === 'solana') expect(detail.tokens.value).toEqual([])
        for (const amount of [0n, 25n]) {
          const formattedBalance = `${amount} ${
            chain === 'ecash' ? 'tXEC' : 'tSOL'
          }`
          fetchBalance.mockResolvedValueOnce(
            chain === 'ecash'
              ? { sats: amount, formatted: formattedBalance }
              : { lamports: amount, formatted: formattedBalance },
          )
          await fetchChainBalance(chain, true)
          const observation = { balance: amount, formattedBalance }
          expectPresentation({ status: 'available', observation })
          if (chain === 'solana')
            expect(detail.tokens.value[0].balanceFormatted).toBe(
              formattedBalance,
            )
          fetchBalance.mockRejectedValueOnce(new Error('offline'))
          await fetchChainBalance(chain, true)
          expectPresentation({
            status: 'unavailable',
            reason: 'fetch-error',
            lastKnown: observation,
          })
        }
      } finally {
        error.mockRestore()
      }
    },
  )

  it.each(['bitcoin', 'bitcoincash', 'dogecoin', 'unknown'])(
    'reports unsupported %s without Monad funds in either view',
    chain => {
      const expected = { status: 'unavailable', reason: 'unsupported' }
      expect(useChainBalance(chain).presentation.value).toEqual(expected)
      expect(useMultichainBalance().getPresentation(chain)).toEqual(expected)
    },
  )

  it('delegates to useBalance for monad', () => {
    const { formattedBalance, loaded } = useChainBalance('monad')
    expect(formattedBalance.value).toBe('10 MON')
    expect(loaded.value).toBe(true)
  })

  it('fetches ecash balance and makes it reactive', async () => {
    await fetchChainBalance('ecash', true)
    expect(mockFetchEcashBalance).toHaveBeenCalledWith({
      address: 'ectest:qre5rmxznz7gm2akscph073dmx5cln89tc5k4q5ah7',
      networkId: 'xec-testnet',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })

    const { formattedBalance, loaded, balance } = useChainBalance('ecash')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(1_000_000n)
    expect(formattedBalance.value).toBe('10000 tXEC')
  })

  it('fetches solana balance and makes it reactive', async () => {
    await fetchChainBalance('solana', true)
    expect(mockFetchSolanaBalance).toHaveBeenCalledWith({
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      networkId: 'solana-devnet',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })

    const { formattedBalance, loaded, balance, tokens } =
      useChainBalance('solana')
    expect(loaded.value).toBe(true)
    expect(balance.value).toBe(2_500_000_000n)
    expect(formattedBalance.value).toBe('2.5 tSOL')
    expect(tokens.value).toHaveLength(2)
    expect(tokens.value[0].symbol).toBe('tSOL')
    expect(tokens.value[1].symbol).toBe('tUSDC')
    expect(tokens.value[1].balanceFormatted).toBe('100.00 tUSDC')
  })

  it('provides multichain helper methods', async () => {
    await fetchChainBalance('ecash', true)
    await fetchChainBalance('solana', true)
    const { getFormattedBalance, isChainLoaded, getTokens } =
      useMultichainBalance()
    expect(getFormattedBalance('monad')).toBe('10 MON')
    expect(getFormattedBalance('ecash')).toBe('10000 tXEC')
    expect(getFormattedBalance('solana')).toBe('2.5 tSOL')
    expect(isChainLoaded('ecash')).toBe(true)
    expect(isChainLoaded('solana')).toBe(true)
    expect(getTokens('solana')).toHaveLength(2)
  })

  it('handles fetch error gracefully', async () => {
    mockFetchEcashBalance.mockRejectedValueOnce(new Error('Network error'))
    await fetchChainBalance('ecash', true)

    const { hasError } = useChainBalance('ecash')
    expect(hasError.value).toBe(true)

    mockFetchSolanaBalance.mockRejectedValueOnce(new Error('Solana error'))
    await fetchChainBalance('solana', true)

    const solanaBalance = useChainBalance('solana')
    expect(solanaBalance.hasError.value).toBe(true)
  })
})

describe('native Solana AVU presentation', () => {
  it('keeps header, asset row and drawer on the reactive oracle snapshot', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const oracle = useOracleStore()
    jest
      .spyOn(oracle, 'startBackgroundWorker')
      .mockImplementation(() => undefined)
    oracle.snapshot.rates.solana = 37
    await fetchChainBalance('solana', true)

    const global = {
      plugins: [pinia],
      mocks: { $t: (key: string) => key },
      directives: { ripple: {} },
      stubs: {
        QTooltip: true,
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
            'q-avatar',
          ].map(name => [name, { template: '<div><slot /></div>' }]),
        ),
      },
    }
    const detail = shallowMount(Wallet, { global })
    const drawer = shallowMount(WalletPanel, { global })
    try {
      await flushPromises()
      const expectAgreement = (expected: string) => {
        expect(oracle.formatAvuAmount('solana', 2_500_000_000n)).toBe(expected)
        expect(detail.get('[data-testid="wallet-balance-avu"]').text()).toBe(
          expected,
        )
        expect(
          detail
            .get(
              '[data-testid="wallet-token-item-tsol"] .text-grey-7.text-right',
            )
            .text(),
        ).toBe(expected)
        expect(drawer.get('[data-test="solana-wallet-avu"]').text()).toBe(
          `· ${expected}`,
        )
        expect(drawer.get('[data-test="subtoken-tsol"]').text()).toContain(
          `(${expected})`,
        )
      }
      expectAgreement('≈ 92.50 AVU')
      oracle.snapshot = {
        ...oracle.snapshot,
        rates: { ...oracle.snapshot.rates, solana: 83 },
      }
      await nextTick()
      expectAgreement('≈ 207.50 AVU')
      // SPL rows keep their existing independently supplied valuation.
      expect(getChainTokens('solana')[1].avuFormatted).toBe('≈ 1,190.5 AVU')
    } finally {
      detail.unmount()
      drawer.unmount()
      oracle.stopBackgroundWorker()
      setActivePinia(undefined)
    }
  })
})
